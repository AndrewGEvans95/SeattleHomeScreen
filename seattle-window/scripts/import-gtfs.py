#!/usr/bin/env python3
"""Build a small, validated Metro trip/shape index from a local official GTFS ZIP.

No network access or third-party packages are used. Distances in the output are
geodesic meters, regardless of the units in GTFS shape_dist_traveled fields.
Ambiguous stop placement fails the import rather than guessing a route pass.
"""

import argparse
import bisect
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import zipfile


SOURCE_URL = "https://metro.kingcounty.gov/GTFS/google_transit.zip"
DIRECTIONS = {"62": 1, "44": 0}
EARTH_METERS = 6371008.8
MAX_STOP_DISTANCE = 100.0


class InvalidFeed(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidFeed(message)


def number(value, label):
    require(value is not None and str(value).strip() != "", f"Missing {label}")
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise InvalidFeed(f"Invalid {label}") from None
    require(math.isfinite(result), f"Nonfinite {label}")
    return result


def integer(value, label):
    require(isinstance(value, str) and re.fullmatch(r"\d+", value.strip()), f"Invalid {label}")
    return int(value)


def clock(value, label):
    # GTFS times can extend beyond midnight on the same service date.
    match = re.fullmatch(r"(\d{1,2}):([0-5]\d):([0-5]\d)", (value or "").strip())
    require(match, f"Missing or invalid {label}; every selected stop needs a time")
    hours, minutes, seconds = map(int, match.groups())
    return hours * 3600 + minutes * 60 + seconds


def date(value, label):
    require(isinstance(value, str) and re.fullmatch(r"\d{8}", value), f"Invalid {label}")
    try:
        dt.datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise InvalidFeed(f"Invalid {label}") from None
    return value


def coordinates(row, lat_key, lon_key, label):
    lat, lon = number(row.get(lat_key), label + " latitude"), number(row.get(lon_key), label + " longitude")
    require(-90 < lat < 90 and -180 <= lon <= 180, f"Out-of-range {label} coordinates")
    return lon, lat


def meters(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    term = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_METERS * math.asin(min(1, math.sqrt(term)))


class Feed:
    def __init__(self, archive):
        self.archive = archive
        self.files = {}
        for item in archive.infolist():
            if item.is_dir():
                continue
            name = Path(item.filename).name
            if name.endswith(".txt"):
                require(name not in self.files, f"Duplicate GTFS filename: {name}")
                self.files[name] = item
        require(sum(item.file_size for item in self.files.values()) <= 1024 ** 3, "GTFS archive exceeds 1 GiB uncompressed")

    def rows(self, name, required=True):
        item = self.files.get(name)
        if item is None:
            require(not required, f"GTFS archive has no {name}")
            return
        with self.archive.open(item) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
            reader = csv.DictReader(text)
            require(reader.fieldnames, f"Empty GTFS table: {name}")
            for row in reader:
                require(None not in row and None not in row.values(), f"Malformed CSV row in {name}")
                yield row


def shape_index(rows, shape_id):
    rows.sort(key=lambda row: integer(row.get("shape_pt_sequence"), "shape sequence"))
    points, original = [], []
    previous_seq = -1
    distance = 0.0
    for row in rows:
        sequence = integer(row.get("shape_pt_sequence"), "shape sequence")
        require(sequence > previous_seq, f"Duplicate shape sequence in {shape_id}")
        previous_seq = sequence
        coord = coordinates(row, "shape_pt_lat", "shape_pt_lon", "shape")
        if points:
            distance += meters(points[-1], coord)
        points.append([coord[0], coord[1], distance])
        value = row.get("shape_dist_traveled", "").strip()
        original.append(number(value, "shape distance") if value else None)
    require(len(points) >= 2 and distance > 0, f"Shape {shape_id} has no usable geometry")
    if any(value is not None for value in original):
        require(all(value is not None for value in original), f"Shape {shape_id} has incomplete distances")
        require(original[0] >= 0, f"Shape {shape_id} has a negative distance")
        for index in range(1, len(points)):
            require(original[index] >= original[index - 1], f"Shape {shape_id} distances run backward")
            require(original[index] > original[index - 1] or points[index][2] == points[index - 1][2], f"Shape {shape_id} has conflicting distance units")
    else:
        original = None
    return {"points": points, "original": original}


def point_at(shape, distance):
    points = shape["points"]
    index = max(0, min(len(points) - 2, bisect.bisect_right([p[2] for p in points], distance) - 1))
    a, b = points[index], points[index + 1]
    fraction = (distance - a[2]) / (b[2] - a[2]) if b[2] > a[2] else 0
    return [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])]


def map_stop(shape, stop, raw_distance, previous):
    points, original = shape["points"], shape["original"]
    position = [stop["lon"], stop["lat"]]
    if raw_distance and original:
        value = number(raw_distance, "stop shape distance")
        require(original[0] <= value <= original[-1], f"Stop {stop['id']} distance lies outside its shape")
        index = max(0, min(len(original) - 2, bisect.bisect_right(original, value) - 1))
        fraction = (value - original[index]) / (original[index + 1] - original[index]) if original[index + 1] > original[index] else 0
        distance = points[index][2] + fraction * (points[index + 1][2] - points[index][2])
        require(meters(position, point_at(shape, distance)) <= MAX_STOP_DISTANCE, f"Stop {stop['id']} is off its declared shape distance")
    else:
        # Project onto all remaining shape segments. Nearby but distinct route
        # passes (loops, parallel streets) are deliberately not guessed.
        candidates = []
        scale_x = EARTH_METERS * math.cos(math.radians(stop["lat"])) * math.pi / 180
        scale_y = EARTH_METERS * math.pi / 180
        for a, b in zip(points, points[1:]):
            if b[2] < previous:
                continue
            ax, ay = (a[0] - position[0]) * scale_x, (a[1] - position[1]) * scale_y
            bx, by = (b[0] - position[0]) * scale_x, (b[1] - position[1]) * scale_y
            dx, dy = bx - ax, by - ay
            denominator = dx * dx + dy * dy
            if denominator == 0:
                continue
            fraction = max(0, min(1, -(ax * dx + ay * dy) / denominator))
            along = a[2] + fraction * (b[2] - a[2])
            if along + 0.01 < previous:
                continue
            cross = math.hypot(ax + fraction * dx, ay + fraction * dy)
            candidates.append((cross, along))
        require(candidates, f"Stop {stop['id']} cannot be placed in stop order")
        candidates.sort()
        cross, distance = candidates[0]
        require(cross <= MAX_STOP_DISTANCE, f"Stop {stop['id']} is more than {MAX_STOP_DISTANCE:g} m off its shape")
        require(not any(error <= cross + 10 and abs(along - distance) > 75 for error, along in candidates[1:]), f"Stop {stop['id']} has ambiguous shape placement; GTFS shape distances are required")
    require(distance + 0.01 >= previous, f"Stop {stop['id']} distances run backward")
    return max(distance, previous)


def build(archive_path, stop_id, source_url):
    with zipfile.ZipFile(archive_path) as archive:
        feed = Feed(archive)
        routes = {}
        for row in feed.rows("routes.txt"):
            route = row.get("route_short_name", "").strip()
            if route in DIRECTIONS:
                require(row.get("route_id"), "Route has no ID")
                routes[row["route_id"]] = route
        candidates = {}
        for row in feed.rows("trips.txt"):
            route = routes.get(row.get("route_id"))
            if route is None or row.get("direction_id") != str(DIRECTIONS[route]):
                continue
            trip_id = row.get("trip_id")
            require(trip_id and trip_id not in candidates, "Missing or duplicate selected trip ID")
            require(row.get("shape_id") and row.get("service_id"), f"Trip {trip_id} has no shape or service")
            candidates[trip_id] = {"routeId": row["route_id"], "route": route, "directionId": DIRECTIONS[route], "serviceId": row["service_id"], "shapeId": row["shape_id"], "headsign": row.get("trip_headsign", ""), "stops": []}
        for row in feed.rows("stop_times.txt"):
            if row.get("trip_id") in candidates:
                candidates[row["trip_id"]]["stops"].append(row)
        trips = {key: trip for key, trip in candidates.items() if any(row.get("stop_id") == stop_id and row.get("pickup_type", "") in ("", "0") for row in trip["stops"])}
        require(trips, f"No boarding trips for routes 62/44 serve stop {stop_id} in the expected directions")
        stop_ids = {row.get("stop_id") for trip in trips.values() for row in trip["stops"]}
        stops = {}
        for row in feed.rows("stops.txt"):
            if row.get("stop_id") not in stop_ids:
                continue
            stop = row["stop_id"]
            require(stop not in stops, f"Duplicate stop ID {stop}")
            lon, lat = coordinates(row, "stop_lat", "stop_lon", "stop")
            stops[stop] = {"id": stop, "name": row.get("stop_name", ""), "lat": lat, "lon": lon}
        require(stop_ids <= stops.keys(), "Some selected stop IDs are missing from stops.txt")
        shape_ids = {trip["shapeId"] for trip in trips.values()}
        shape_rows = {shape: [] for shape in shape_ids}
        for row in feed.rows("shapes.txt"):
            if row.get("shape_id") in shape_rows:
                shape_rows[row["shape_id"]].append(row)
        shapes = {key: shape_index(rows, key) for key, rows in shape_rows.items()}
        for key, trip in trips.items():
            rows = sorted(trip["stops"], key=lambda row: integer(row.get("stop_sequence"), "stop sequence"))
            require(sum(row.get("stop_id") == stop_id for row in rows) == 1, f"Trip {key} visits target stop more than once")
            output, previous_sequence, previous_time, previous_distance = [], -1, -1, 0.0
            for row in rows:
                sequence = integer(row.get("stop_sequence"), "stop sequence")
                require(sequence > previous_sequence, f"Trip {key} has duplicate stop sequences")
                arrival, departure = clock(row.get("arrival_time"), "arrival time"), clock(row.get("departure_time"), "departure time")
                require(previous_time <= arrival <= departure, f"Trip {key} stop times run backward")
                pickup = row.get("pickup_type", "")
                require(pickup in ("", "0", "1", "2", "3"), f"Trip {key} has invalid pickup_type")
                raw_distance = row.get("shape_dist_traveled", "").strip()
                if raw_distance:
                    require(number(raw_distance, "stop shape distance") >= 0, "Negative stop shape distance")
                distance = map_stop(shapes[trip["shapeId"]], stops[row["stop_id"]], raw_distance, previous_distance)
                output.append({"id": row["stop_id"], "sequence": sequence, "arrival": arrival, "departure": departure, "distance": round(distance, 3), "pickupAllowed": pickup in ("", "0")})
                previous_sequence, previous_time, previous_distance = sequence, departure, distance
            trip["stops"] = output
        service_ids = {trip["serviceId"] for trip in trips.values()}
        calendar, exceptions = {}, {}
        for row in feed.rows("calendar.txt", required=False):
            key = row.get("service_id")
            if key not in service_ids:
                continue
            require(key not in calendar, f"Duplicate calendar service {key}")
            start, end = date(row.get("start_date"), "service start date"), date(row.get("end_date"), "service end date")
            require(start <= end, f"Service {key} date range runs backward")
            flags = [integer(row.get(day), "weekday flag") for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]
            require(all(flag in (0, 1) for flag in flags), "Weekday flag must be zero or one")
            calendar[key] = {"startDate": start, "endDate": end, "weekdays": flags}
        for row in feed.rows("calendar_dates.txt", required=False):
            key = row.get("service_id")
            if key not in service_ids:
                continue
            day, kind = date(row.get("date"), "exception date"), integer(row.get("exception_type"), "exception type")
            require(kind in (1, 2), "Calendar exception must be one or two")
            require(day not in exceptions.setdefault(key, {}), f"Duplicate service exception {key}/{day}")
            exceptions[key][day] = kind
        require(service_ids <= calendar.keys() | exceptions.keys(), "Selected trip service has no calendar or exceptions")
        starts = [value["startDate"] for value in calendar.values()]
        ends = [value["endDate"] for value in calendar.values()]
        additions = [day for days in exceptions.values() for day, kind in days.items() if kind == 1]
        require(starts or additions, "Selected services have no operating dates")
        start, end = min(starts + additions), max(ends + additions)
        info = list(feed.rows("feed_info.txt", required=False))
        if info:
            require(len(info) == 1, "Expected one feed_info row")
            if info[0].get("feed_start_date"):
                start = date(info[0]["feed_start_date"], "feed start date")
            if info[0].get("feed_end_date"):
                end = date(info[0]["feed_end_date"], "feed end date")
        require(start <= end, "Feed validity range runs backward")
        digest = hashlib.sha256()
        with open(archive_path, "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return {"schemaVersion": 1, "source": {"url": source_url, "sha256": digest.hexdigest(), "importedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "feedStartDate": start, "feedEndDate": end}, "stops": stops, "shapes": {key: [[point[0], point[1], round(point[2], 3)] for point in shape["points"]] for key, shape in shapes.items()}, "trips": trips, "calendar": calendar, "exceptions": exceptions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path, help="Locally downloaded official Metro GTFS ZIP")
    parser.add_argument("--output", type=Path, default=Path("var/transit-index.json"))
    parser.add_argument("--stop-id", default="29530", help="Raw GTFS boarding stop ID (default: 29530)")
    parser.add_argument("--source-url", default=SOURCE_URL, help="Provenance URL for this ZIP; no download is performed")
    args = parser.parse_args()
    try:
        result = build(args.zip, args.stop_id.removeprefix("1_"), args.source_url)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, prefix=args.output.name + ".", suffix=".tmp", encoding="utf-8", delete=False) as target:
                temporary = target.name
                json.dump(result, target, separators=(",", ":"), allow_nan=False)
                target.write("\n")
            os.replace(temporary, args.output)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
        print(f"Imported {len(result['trips'])} trips, {len(result['shapes'])} shapes and {len(result['stops'])} stops to {args.output}")
        print(f"Feed validity: {result['source']['feedStartDate']}–{result['source']['feedEndDate']}; source SHA-256: {result['source']['sha256']}")
    except (InvalidFeed, OSError, zipfile.BadZipFile, csv.Error, UnicodeError) as error:
        print(f"GTFS import failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

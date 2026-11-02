# GPS arrival validation — November 1, 2026

This report records evaluation version 1 at commit `82c1041`. The later
[evaluation version 2 follow-up](gps-evaluation-v2-2026-11-01.md) preserves original
forecasts across tracking resets and adds a fresh recording. The original JSON
report is retained as historical evidence.

The official Metro feed imports successfully and the saved public GPS recording
produces trip-specific arrival ranges. This completes the blocked real-feed
import and replay check. It does **not** establish high accuracy: the replay has
only two scored bus crossings, and the schedule-progress baseline performs
better than the pace-adjusted estimator on this sample. Keep the feature
experimental.

## Provenance and reproduction

- Download: `https://metro.kingcounty.gov/GTFS/google_transit.zip`.
- Download/import completed November 1 at 4:57 p.m. PST
  (`2026-11-02T00:57:47Z`).
- Official ZIP SHA-256:
  `ff9b26cf8dc49558b526ad804dc1e41b67007fe84914c60bb3a9779c2e5fa163`.
- Service validity: October 29, 2026–March 26, 2027.
- Imported home-stop subset: 474 trips, four shapes, 89 stops; boarding stop
  `29530` on Downtown-bound 62 and Ballard-bound 44.
- Saved observations: November 1, 4:21:39–4:42:00 p.m. PST
  (`2026-11-02T00:21:39.989Z`–`00:42:00.564Z`), 40 snapshots and 435 vehicle
  records. The recording metadata contains its source and verified checksum.

From `seattle-window/`, run:

```sh
npm run update:gtfs
npm run replay:eta -- --output var/gps-replay.json
# Check the just-downloaded index as well:
npm run replay:eta -- --index data/metro-gtfs.json --output var/gps-replay-current.json
npm test
CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser
```

The default replay uses the immutable, compressed GTFS index
`test/fixtures/metro-gtfs-2026-11-02.json.gz`, derived from the ZIP above, so later
changes to Metro's download do not change this historical experiment. The live
index and downloaded ZIP remain local generated files. The recording and frozen
index are not loaded into the live collector.

Replay starts cold, uses each snapshot's `fetchedAt` as its clock, and exposes
only current and earlier observations to the estimator. Forecasts are evaluated
against later GPS crossing brackets of at most 60 seconds. These are proxies for
passing or stopping at the boarding stop, not independently measured door-opening
times. Different horizon forecasts for the same bus share a crossing and are
correlated. No parameters were tuned to this recording.

## Saved-recording results

Of 435 vehicle records, 291 concern routes 62/44 and 144 concern the separately
displayed routes 31/32. Ten distinct supported-route trips appear, including
already-passed trips and trips that are incomplete within the recording.

The estimator emits 110 arrival rows across five trip instances. There are
estimates in 38 of 40 snapshots; the first two snapshots are warming up. These
counts describe output availability, not independent accuracy samples.

Twelve distinct trip/horizon forecast buckets were issued in 13 attempts (one
bucket was reissued after a track reset). Seven buckets were scored and five
were still pending at the recording's end. Pending forecasts are not successes.

| Metric | All scored forecasts | Route 44 | Route 62 |
| --- | ---: | ---: | ---: |
| Distinct scored bus crossings | 2 | 1 | 1 |
| Scored trip/horizon forecasts | 7 | 3 | 4 |
| Median absolute error | 88.1 s | 44.3 s | 90.2 s |
| P90 absolute error | 180.0 s | 172.1 s | 142.5 s |
| Mean signed error (negative = early) | −74.8 s | −63.7 s | −83.1 s |
| Whole crossing bracket contained by range | 5/7 | 2/3 | 3/4 |
| Schedule-progress baseline median absolute error | 38.2 s | 23.4 s | 58.9 s |
| Progress-speed baseline median absolute error | 109.3 s | 202.3 s | 103.5 s |

The route-44 crossing bracket is 32 seconds wide; route 62 is 45 seconds. Errors
are measured against bracket midpoints, so even the scoring target has temporal
uncertainty. The schedule-progress baseline means observation time plus remaining
GTFS travel time, not the original timetable arrival. The speed baseline
extrapolates remaining shape distance using observed average speed.

Exclusions across all snapshots: 144 unknown/unserved trips (routes 31/32), 126
already arrived, 31 held/stationary, 15 warming up, four insufficient motion, two
off route, two conflicting observations, and one observation too old for its
short remaining ETA. Counts include repeated observations; they are not failure
rates among independent trips. The [full JSON report](metro-gps-2026-11-02.replay.json) includes forecast coverage,
unscored buckets, route/horizon breakdowns, baselines and individual outcomes.

## Fresh live integration checks

The live collector used the newly imported timetable and separate empty learning
state, without replaying historical samples into the server. Required doctor
checks passed for Metro GPS and all three weather locations. The collector warmed
up and emitted estimates with `source: gps_estimate`, `predicted: false` and
`confidence: experimental`; the main transit API selected those estimates.

At 4:59:43 p.m. PST (`2026-11-02T00:59:43Z`), the independent Metro TripUpdates
comparison matched three exact trip/date/vehicle/stop identities. Two estimates
differed by at most 60 seconds and one by more than 120 seconds. This is provider
disagreement, not actual arrival accuracy. A stationary bus was withheld.

Across 11 live snapshots from 4:59:11–5:04:29 p.m. PST, ten contained estimates
for four distinct trips and ten supported exact-identity reference comparisons.
No additional arrival outcome was scored: the first 44's forecast was issued
after the lower bound of its crossing bracket, and the other trips had not yet
crossed. See the [live evidence report](metro-live-2026-11-02.json) and its linked,
compressed public-feed snapshots.

The real browser check exposed horizontal overflow at 320 pixels when a second
62 had a long GPS range label. The countdown can now shrink and its following-bus
label wraps. A regression fixture includes that second bus. Both live transit and
weather views pass at 320, 360 and 1280 pixels.

All **91 automated tests pass**, including six replay tests for recording
integrity/order, historical clocks, future-only scoring, missing matches, trip
identity and the frozen real-data recording. The Chromium suite passes, including
range expiry, multiple-bus narrow layout and 1404×1872 PNG export. The current
download and frozen index produce identical replay results.

With `CHROMIUM_EXECUTABLE=/usr/bin/chromium`, the actual live PNG endpoint also
returned HTTP 200 and a 1404×1872 image. This export was checked after restarting
the server and correctly displayed movement warmup; the browser suite separately
checks PNG rendering with established arrival ranges. Validation servers were
stopped after the checks.

## Interpretation

This is a roughly 20-minute Sunday recording with no independent arrival labels,
no rush-hour coverage and very little learned history. Five of seven ranges
contain the full observed bracket; this is not a calibrated coverage probability.
The sample supports functionality and reveals early prediction bias, but does
not support promoting the estimator as reliable commute advice. Further
evaluation needs more distinct arrivals, days, traffic conditions and held-out
recordings before changing model parameters or confidence claims.

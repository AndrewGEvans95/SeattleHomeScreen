# Seattle Window

A local prototype for Andrew's bus and cycling-weather display at 45th & Woodlawn, Seattle. It preserves the approved isometric maps, terrain dots, bicycle route, Poptart, crow and sailboat.

## Start on your Mac

Install **Node.js 22 or newer** if needed: <https://nodejs.org/en/download>. Check with `node --version`.

Unzip the project, then run these commands in Terminal (adjust the folder if you extracted elsewhere):

```sh
cd ~/Downloads/seattle-window
cp .env.example .env
npm start
```

Open **http://localhost:8787**. The basic app needs no npm dependencies. Keep Terminal running; press Control-C there to stop it. Opening `index.html` directly won't work: use the local server.

Connect the portable monitor to the Mac using a video-capable USB-C cable, move the browser window onto it, and choose **Full screen**. Escape exits. The display keeps its own proportions instead of stretching to the monitor's 16:9 shape.

The initial **Demo** mode works without provider credentials or internet after local assets load. The explicit demo label stays inside the display, including PNG exports. Use the **Vehicle** selector to compare articulated, standard and unknown buses. **Play approach**, the view selector, weather scenarios, and departure slider explore the remaining behavior.

## Turn on live data

Choose **Live** in the top bar. Weather and **Metro GPS positions connect without an API key**. Without a OneBusAway key, the app can estimate arrivals from GPS movement and an exact local Metro route/timetable index (setup below). These estimates are explicitly experimental and appear as ranges. Adding a OneBusAway key switches the main arrival display to that provider's predictions; independent GPS collection and evaluation continue.

1. Request a key by emailing **oba_api_key@soundtransit.org**. Explain that you are building a personal Seattle bus-arrival display. [Sound Transit instructions](https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd/otd-downloads).
2. Edit the local `.env` file and set `OBA_API_KEY=your-key`.
3. Stop and restart `npm start`. Choose Live again.

The key stays on the server; it is never embedded in browser files or returned by the API. Do not share your `.env`.

### Check live-data setup

Run this from the project folder, even while the display server is stopped:

```sh
npm run doctor
```

It checks the real Metro GPS, weather and configured arrival feeds, reports whether a proxy is in use, and checks for PNG export dependencies. It prints no API keys, proxy credentials or raw provider error responses. Experimental GPS estimates or an optional missing PNG renderer produce warnings; missing/expired timetable data or failed feeds make the command exit with status 1. An empty list of buses can be valid between services and does not fail the check. A one-shot doctor run cannot establish movement history: keep `npm start` running for that. PNG dependency detection does not launch Chromium; `npm run test:browser` verifies actual rendering.

The Live connection message now distinguishes loading, missing credentials, network failures, timeouts, access denial, rate limiting and invalid/stale responses. Failed requests retry automatically at the existing feed intervals. Retained data stays marked stale until a successful refresh; it is not used for arrival or ride guidance.

On a network that requires an HTTP(S) proxy, use **Node.js 24.19 or newer**. `npm start` and `npm run doctor` automatically use inherited `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` settings (lowercase versions take precedence), including their existing trust configuration. Set these in the shell or service environment, rather than this app's `.env` file. Local display and image-renderer requests bypass the proxy. Node.js 22+ still works on ordinary direct connections. Proxy-only environments with an older Node version receive an upgrade message instead of silently failing every live request.

Allow outbound HTTPS to `api.open-meteo.com` and `s3.amazonaws.com`. Updating the timetable additionally needs `metro.kingcounty.gov`; OneBusAway predictions need `api.pugetsound.onebusaway.org` when you configure a key. A network allowlist and a valid API key are separate requirements. If the doctor reports access denied, check both the network policy and provider permissions.

### Experimental GPS arrival estimates

First install the exact Metro trip shapes, stops and timetable. This import step requires **Python 3.9+**, using only its standard library; running the app afterward still only requires Node.js.

```sh
npm run update:gtfs
npm start
```

If the download is blocked, download the [official Metro GTFS ZIP](https://metro.kingcounty.gov/GTFS/google_transit.zip) on a permitted network, then run `npm run update:gtfs -- /absolute/path/to/google_transit.zip`. The importer creates `data/metro-gtfs.json` and keeps its source checksum and service dates. It validates the new index before replacing the previous one. Repeat the import after service changes and restart the server. Missing, expired or mismatched data produces no estimate; the illustrative display-map geometry is never substituted for the exact trip shape.

The estimator currently supports boarding at the configured home stop on Downtown-bound 62 and Ballard-bound 44. Routes 31/32 remain GPS markers only unless OneBusAway is configured for their separate stop. Its method is:

- Match the reported trip, service date, direction and current stop sequence to the exact GTFS pattern. Project GPS onto that pattern within the appropriate stop interval, rejecting ambiguous, off-route or implausible motion and buses already past the boarding stop.
- Wait for at least three distinct observations spanning 40 seconds. Repeated polling of an unchanged GPS report adds no evidence. Compute remaining scheduled travel from the observed position, then adjust nearby travel using the bus's recent pace. The correction decays farther along the route. Completed observed stop-to-stop passages gradually supply bounded, time-of-day and weekday/weekend travel profiles.
- Anchor arrival timestamps to the GPS observation time, not the time the server fetched it. Expire estimates after at most 90 seconds and withdraw them for extended holds or insufficient movement. A stopped or missing bus does not quietly become a confident countdown.
- Display an outward-rounded arrival range labeled **GPS estimate · experimental**. These are engineering ranges, not calibrated probabilities or guaranteed bounds. **Aim to leave** guidance uses the unrounded early bound, walking time and buffer. Vehicle markers continue to show observed positions.

The server samples GPS every 30 seconds even with no browser open and shares that work with browser/export requests. It saves bounded learned profiles and completed evaluations in ignored `var/eta-learning.json`. Active bus estimates and pending forecasts reset on restart and must warm up again. Data from a different timetable checksum, boarding stop or evaluation version is not reused. Evaluation version 2 resets version-1 saved learning and outcomes because older evaluations could replace a forecast after a tracking reset. A storage failure keeps learning in memory and is reported by diagnostics.

Inspect **http://localhost:8787/api/estimator** for sample counts, median/P90 timing errors, signed bias, interval containment and schedule/progress-speed baselines, separated by route and forecast horizon. The outcomes are later GPS stop-crossing brackets of at most 60 seconds, **not measured door-opening times**. The first forecast per trip/horizon is kept separately from movement tracking, so a GPS reset cannot substitute a later forecast. It is scored only against a subsequent crossing. A known arrival whose first observation gap is too long stays unscorable; later stopped reports cannot manufacture a shorter arrival bracket. `sessionForecasts` reports pending, scored and unscorable forecasts issued in the current process, separately from saved outcome metrics. No measured accuracy is claimed before those outcomes exist. Check route-specific errors, range containment and how often the estimator abstains before relying on it for a commute.

With the server running, `npm run compare:eta` compares its current estimates with Metro's separately published, key-free trip updates. It matches exact trip/date/vehicle identity and reports **provider disagreement**, not actual error: Metro's prediction is also an estimate. This comparison does not feed Metro predictions into our GPS calculation. The independent estimates remain available at `/api/gps-estimates` after you add an OBA key.

#### Replay the saved live observations

```sh
npm run replay:eta
# Save the full report (create the output directory first):
mkdir -p var
npm run replay:eta -- --output var/gps-replay.json
# Explicitly check the recording against a newly imported timetable:
npm run replay:eta -- --index data/metro-gtfs.json
```

The default replay uses the saved public GPS recording and a compressed, compatible official GTFS subset in `test/fixtures/`. It verifies the recording checksum, counts and chronological timestamps, starts with empty learning, and advances the clock to each recorded fetch. It never reads or writes the live collector's learning state. Custom recordings need matching `.metadata.json` provenance; see `npm run replay:eta -- --help`. Historical fixture data are for offline replay; the live server still requires a current `npm run update:gtfs` import.

To collect another public GPS recording without running the estimator:

```sh
npm run record:gps -- --output var/morning.ndjson.gz --duration-minutes 20
npm run replay:eta -- --recording var/morning.ndjson.gz --index data/metro-gtfs.json
```

The recorder polls at most every 30 seconds, saves compressed observations and adjacent checksum metadata, and refuses to replace existing files. Durations are bounded to 1–120 minutes. Ctrl-C saves completed samples. Unavailable feed samples remain in the recording, so outages are visible during replay. The metadata identifies the normalizer source and collection failures; neither provider predictions nor arrival labels are used. Keep the matching imported GTFS index alongside historical recordings when the timetable changes.

The [November 1, 2026 validation report](docs/validation/gps-arrival-2026-11-01.md) records the real-feed import, saved replay and live checks. Seven scored forecasts came from only two observed bus crossings. Median absolute timing error was **88 seconds**, versus **38 seconds** for the schedule-progress baseline; five of seven ranges contained the entire crossing bracket. This small Sunday sample does not establish commute accuracy, and the feature remains experimental.

### Transit behavior

- Leave-by advice uses the unrounded arrival timestamp, subtracts the selected walking time plus a one-minute buffer, then rounds down. If the bus is due within the walking time, it says **Too close to count on** and shows the following arrival when available. The two-minute default walking time remains an assumption to calibrate.
- Adaptive zoom moves closer for the same approaching trip, and holds that framing through small increases in its ETA. A new trip resets the camera. The running image renderer retains the same state between live transit PNGs.
- Offscreen buses are never pulled onto a different street inside the map. The caption says **bus outside view** when the next bus is beyond the frame.
- Live frames print the last data-fetch timestamp, with the actual GPS observation time when the next bus has a position. An old frame can therefore be identified even if image updates stop.
- Home stop defaults to **1_29530**, westbound N 45th St & Woodlawn Ave N.
- Route **62** is filtered toward Downtown; **44** toward Ballard via Upper Fremont.
- Arrivals and direct Metro GPS are fetched at most once every 30 seconds, with concurrent requests coalesced. GPS does not depend on a OneBusAway key. GPS markers reject observations older than two minutes; independent arrival estimates expire after at most 90 seconds.
- Predicted arrivals and timetable-only arrivals are visibly distinguished. Stale predictions fall back to the schedule, labeled as scheduled. Provider failures hide arrival guidance.
- Markers use Metro’s GTFS-RT vehicle-position feed. If a matching Metro position is absent, an arrival may use OneBusAway’s recent `lastKnownLocation` for that exact active trip. A scheduled/extrapolated OBA `position` is never presented as observed GPS. Markers can legitimately be absent while an ETA is available.
- The direct GPS filter includes Downtown-bound 62, Ballard-bound 44, and westbound 31/32 through Fremont. Route and direction IDs were verified against Metro GTFS on October 13, 2026; revalidate them after relevant service changes.
- A known standard vehicle gets a short silhouette; an articulated vehicle gets an accordion joint. Unknown fleet numbers use compact rectangular markers, distinct from circular stop symbols. At wider scales all bus markers simplify; vehicle type stays beside the main arrival. Silhouettes face one consistent direction and convey type, not travel bearing.
- Vehicle type is a **partial fleet-roster lookup**, not a live telemetry field. `public/fleet.js` records the source: Metro’s April 2018 Route Facilities Guidelines, Appendix B, pages AP-3–AP-5. It includes only explicitly documented ranges and uses nominal 40/60-foot classes. This is not a verified complete 2026 roster; unknown or later ranges are deliberately not guessed.
- The next-bus marker requires either a provider arrival or a qualifying trip-specific GPS estimate. No vehicle assignment is inferred solely from geographic distance to home.
- Routes 31/32 remain in the map geometry, and their GPS markers can appear in Live mode. Their arrival rows are hidden in Demo and remain hidden in Live unless you set `FREMONT_STOP_ID` to a **verified Fremont-bound boarding stop**. Their separate stop has not been verified in this release. Don't use the home stop as a substitute.
- Full route/service-alert interpretation, detours and cancellation narratives are not yet implemented. The view excludes arrivals explicitly marked canceled but is not a replacement for checking service alerts.

### Weather behavior and limits

- Open-Meteo serves NOAA HRRR forecasts for Home, Fremont (N 34th & Fremont Ave N), and an **assumed SLU endpoint at 9th & Republican**.
- Forecasts are fetched every 10 minutes and sampled in **15-minute intervals**. Rain totals are converted from mm per preceding 15 minutes to equivalent mm/hour. The app does not interpolate rain into spurious minute-level measurements.
- Nearby neighborhoods may share a forecast grid cell. The display says **shared forecast grid** when that happens. These are regional model estimates, not three outdoor weather stations or a radar rain nowcast.
- The default passage times are **Home +0, Fremont +9, SLU +22 minutes**. Set both legs separately under **Ride timing & preferences**, along with your gust comfort limit. The map, rain timeline and planning use those values. Your actual office location and ride timing still need calibration.
- The suggested departure, map callouts and timeline line show **the same ride**. A clearly labeled dotted line always traces leaving now, with a marker at each neighborhood. When the shown departure is later, its solid line stays alongside that reference, including while moving the slider or when weather is unsuitable. If the shown ride leaves now, the two coincide as one dotted line. Moving the slider chooses a departure manually; **Use suggested time** returns to automatic guidance.
- The planner looks for contiguous acceptable departure windows over the next 45 minutes, checking each minute against the unchanged 15-minute forecast blocks. It requires at least five minutes of departure flexibility and rounds displayed window edges inward to five-minute marks. The window is approximate, not a guarantee or an increase in forecast resolution. The map illustrates the window's first suggested departure.
- An optional **Arrive at SLU by** time limits the window using ride duration plus a three-minute arrival allowance. It refers to today in Seattle (the example morning in Demo); a passed deadline is not rolled into tomorrow. A deadline can reduce an otherwise flexible weather window to a single departure. The display does not claim that the 62 will meet that deadline: a bus journey time to SLU is not yet calculated.
- Rain and gusts are checked across a **±3-minute allowance** around each checkpoint (clipped at now), using the worst value in that window. This allows for the assumed ride timing; it is not a forecast confidence interval. Conditions take priority over temperature on the map.
- Missing/null/stale weather pauses ride guidance. Question-mark bands mark missing intervals anywhere on the timeline. It never silently becomes zero rainfall. Drizzle and rain use different hatch spacing that survives monochrome output.
- The ride suggestion compares three checkpoints, not every meter of the route. It uses rain preference thresholds of 0.1 or 0.5 mm/hour and a 25 mph gust preference. These are configurable design assumptions, not assurances of safe cycling conditions. Road wetness is not measured.
- The weather footer shows the next home-stop 62 when the arrival feed is configured and fresh, with scheduled and predicted arrivals labeled. Forecast retrieval uses an absolute Seattle timestamp so a frozen e-ink frame can be recognized.
- The bike corridor follows sourced street/bicycle geometry with generalized connections. It is illustrative, not turn-by-turn navigation.
- The departure slider is relative to the current Seattle time in Live mode; Demo uses a fixed example morning. Timestamps use `America/Los_Angeles`, including daylight saving changes.

Transit walking controls remain temporary preview settings; exported transit frames use the default two-minute walk and one-minute buffer. The walking-time constant can be changed in `public/transit.js` for all views and exports.
Weather ride duration, rain preference and gust limit are saved in this browser. The current deadline and chosen departure are retained in the page URL, but are not stored as a permanent daily schedule. **Export E1003 PNG** carries all current weather options, including the Demo scenario. Direct image URLs without options use defaults. Keep the generated image URL when configuring future display firmware; preferences are not stored on the server.

Weather image options: `wxHome` (home-to-Fremont minutes, 1–30), `wxSlu` (Fremont-to-SLU minutes, 1–40), `wxGust` (mph, 1–50), `wxRain` (`dry` or `drizzle`), `wxArrive` (optional `HH:MM`), `wxDepart` (`auto` or delay minutes 0–45), and `wxScenario` (`showers`, `clear`, `wind`, `stale`, Demo only). The image cache includes these options, so changing the plan cannot return an image for an old setting.

### Neighborhood observations: researched, not connected

Keep **observed now** separate from **forecast when you pass**. As of October 13, 2026, these are candidates for a future observations adapter, not verified live inputs:

- Weather Underground lists [Wallingford KWASEATT418](https://www.wunderground.com/dashboard/pws/KWASEATT418), [Fremont Townie KWASEATT2471](https://www.wunderground.com/dashboard/pws/KWASEATT2471), and [South Lake Union KWASEATT329](https://www.wunderground.com/dashboard/pws/KWASEATT329). The retrieved public pages did not establish fresh observations. A listed station is not proof of current operation or permission to consume its API.
- [Synoptic](https://docs.synopticdata.com/services/latest) offers station discovery by radius, observations, timestamps and quality flags, requiring an API token. Confirm plan eligibility and station coverage before choosing it; current [Open Access eligibility](https://synopticdata.com/open-access-program/) is scoped to academic users.
- [Seattle road-weather data](https://dev.socrata.com/foundry/data.seattle.gov/egc4-d24i) includes Aurora Bridge air and road temperatures. An aggregate query of this dataset returned June 16, 2026 as the newest timestamp for its stations during this check, so it was not connected as a live source. It does not supply the rain and wind needed for the ride decision.
- A personal outdoor [Tempest](https://weatherflow.github.io/Tempest/api/) supports authenticated REST/WebSocket access and a local UDP interface. Its self-service API is for the owner's stations; access to the wider neighborhood network is a separate arrangement. Outdoor mounting and exposure matter, especially for wind and rain.

Before enabling a station, verify its coordinates, sensor fields/units, exposure, authorized access, and recent reporting. Display its location and observation time; expire stale data. A station observation must never replace a future rain forecast or imply dry pavement.

## Native E1003 image output

This is optional; the browser prototype works without it.

```sh
npm run install:renderer
```

That installs pinned Playwright and its Chromium browser. Then use **Export E1003 PNG**, or request:

```text
http://localhost:8787/api/frame.png?view=transit&mode=live
http://localhost:8787/api/frame.png?view=weather&mode=live
```

Use `mode=demo` for clearly labeled simulated frames. Each image is **1404 × 1872**, with 16 neutral gray levels. The service reuses Chromium, serializes render work and caches each frame for 25 seconds. If an export is already rendering, another request receives 503 and can retry. If Chromium is missing, a helpful 503 response explains installation; normal browser use continues.

**E1003 firmware is not included yet.** This establishes the image interface for it. Decoding, Wi-Fi provisioning, refresh waveforms, partial refresh/cleanup, hardware buttons, power behavior and physical contrast still need device integration. PNG previews do not simulate pigment behavior or ghosting.

## Move to the Raspberry Pi 4 later

The same project and `npm start` command work on Node.js 22+ on a current 64-bit Raspberry Pi OS. Start with the data service; no monitor is required. For Chromium export on ARM, install the distribution's Chromium package plus Playwright and set `CHROMIUM_EXECUTABLE` in `.env` to the actual executable path, commonly `/usr/bin/chromium`.

Set `HOST=0.0.0.0` only when you want your E1003 or other devices on your trusted home LAN to access it. The default `127.0.0.1` is Mac-only. Use the Pi's LAN address for image URLs. There is no authentication, TLS or internet-facing hardening in this personal prototype; do not port-forward it.

`deploy/seattle-window.service` is an optional systemd template. Replace `YOUR_USER`, the working directory and Node path before installing it. The Pi does not run the HTML on the E1003: it produces images that future display firmware will retrieve over Wi-Fi.

## Checks

```sh
npm test
# Optional, after installing the renderer:
npm run test:browser
```

The dependency-free suite tests provider timestamps, direction filtering, cancellations, observed versus extrapolated locations, precipitation intervals, missing data, departure windows, arrival deadlines, option validation, cache failure/recovery, HTTP boundaries, fleet classification, direct GPS filtering, and both actual SVG renderers at desktop and narrow widths. The optional browser suite also checks saved settings, browser/export consistency, image-cache separation, narrow layout and exported PNG dimensions.

## Project layout

```text
src/server.mjs       Local HTTP server and configuration
src/network.mjs      Native proxy setup and localhost bypass
src/doctor.mjs       Live-data setup diagnostics (npm run doctor)
src/eta-estimator.mjs Exact-trip GPS estimator, learned travel profiles and evaluation
src/gps-service.mjs  Shared background collector and atomic learning-state storage
src/metro-reference.mjs Independent Metro prediction comparison (not ground truth)
src/data.mjs         OneBusAway, Metro and Open-Meteo caching
src/vehicles.mjs     Direct Metro GPS adapter and direction filtering
public/fleet.js      Partial sourced roster and vehicle silhouettes
src/renderer.mjs     Optional Chromium → 16-gray PNG export
public/app.js        Mode switching, data polling, full-screen behavior
public/transit.js    Isometric transit map and departure display
public/weather.js    Bike route, weather and passage-time rain timeline
public/ride-weather.js Passage windows, comfort preferences and departure planning
public/weather-options.js Validated browser/frame settings and Seattle deadlines
public/live-utils.js Timestamp, interval and projection helpers
public/assets/      Local geography, bike corridor and illustration
scripts/            Official GTFS import/update and reference comparison commands
data/metro-gtfs.json Generated exact route/timetable index (npm run update:gtfs)
test/               Automated checks
```

## Sources and attribution

- Metro direct GPS: <https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions_enhanced.json>
- Metro developer resources and terms: <https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps>
- Fleet specification source: <https://cdn.kingcounty.gov/-/media/king-county/depts/metro/documents/about/data-and-reports/2018/trf_guidelines_final_2020.pdf>
- OneBusAway API: <https://developer.onebusaway.org/api/where/methods/arrivals-and-departures-for-stop>
- Observed versus inferred positions: <https://developer.onebusaway.org/api/where/elements/trip-status>
- Open-Meteo / HRRR: <https://open-meteo.com/en/docs/gfs-api>. Personal/non-commercial use; review provider terms before other uses. Weather data attribution: Open-Meteo, NOAA.
- Map snapshot prepared October 9, 2026: Seattle SDOT streets, Seattle Building Outlines 2023, King County water and transit-route geometry, USGS 3DEP bare-earth elevations. Source identifiers and projection details are retained in `public/assets/geography.json`.
- Bicycle facilities: <https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Bike_Facilities/FeatureServer/2>. Source metadata is retained in `public/assets/bike-route.json`.
- Projection: precomputed D3 Mercator coordinates centered at home, in local meters. Building heights are illustrative; terrain relief is exaggerated for legibility.
- The small animal/boat illustration was AI-generated for this project. Poptart is a generic stylized dog, not a portrait.

This ZIP contains your home-centered geography. Keep it private if you don't want to share that location.

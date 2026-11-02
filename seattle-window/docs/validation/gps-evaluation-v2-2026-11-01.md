# GPS evaluation follow-up — November 1, 2026

PR #1 was published and merged into `main` at `114f351c`. Follow-up review found
that movement resets also erased pending evaluations. A later forecast could then
replace the first forecast for the same trip and horizon, selecting a different
prediction for scoring. Evaluation version 2 keeps the original forecast in a
separate bounded ledger. The prediction formula and tuning parameters are
unchanged.

## Correctness changes

In a synthetic regression, the original forecast predicts arrival 330 seconds
after the scenario begins. A reset produces a later prediction at 345 seconds.
The later GPS crossing bracket is 330–360 seconds: version 1 scores the replacement
as zero error, while version 2 correctly scores the original as 15 seconds early.
The original issue time, GPS observation time, arrival bounds and subsequent
crossing bounds are now included in completed outcomes so this can be audited.

The forecast ledger survives conflicting, off-route and implausible movement
resets. If the crossing cannot be bounded, or the forecast was issued after the
crossing bracket began, the forecast remains explicitly unscorable. Ten minutes
without valid trip observations also makes it unscorable. Current and previous
service-date keys remain reserved so later observations cannot replace them;
when the 4,096-entry ledger is full, new evaluation attempts are reported as
skipped rather than evicting an existing forecast. This does not prevent live
arrival predictions for otherwise qualified buses.

Known arrivals also survive movement resets. Previously, an off-route sample
could erase a completed track and contradictory earlier-position telemetry could
make the same bus appear to approach the stop again. A separate bounded set of
completed trip identities now prevents this, including trips that arrived before
any forecast was issued. If that set fills, estimates for the affected service
date are withheld and diagnostics explain the capacity limit.

Pending forecasts remain local to the current process, matching the existing
restart behavior. `sessionForecasts` is therefore separate from persisted outcome
metrics. Version-1 saved learning and outcomes are not loaded under version 2.
Old recording and report artifacts are preserved.

## Original recording under version 2

The [version-2 replay report](metro-gps-2026-11-02.replay-v2.json) retains 12 first
forecast buckets: seven scored across two trips and five pending. The earlier
13th issuance attempt no longer replaces its original forecast. All arrival
predictions across the original 40 snapshots are identical to revision
`114f351c`; its seven scored outcomes and 88.1-second median error are unchanged.
The reset bug is demonstrated by the synthetic regression, not claimed as an
accuracy improvement on the original recording.

All **104 automated tests pass**, including recorder integrity, interruption and
collision handling; original-forecast retention; unscorable crossing reasons;
arrival revival; bounded identity retention; and report audit fields. Independent
review also reran the 39 estimator/replay/recorder tests successfully.

The [live version-2 check](metro-live-v2-2026-11-02.json) started with separate
empty learning state, warmed up and emitted three valid estimates. Both API
endpoints reported version 2 and agreed on the session ledger (three pending
forecasts, none scored yet). The live PNG endpoint returned HTTP 200 at
1404×1872, and the server stopped gracefully with version-2 state saved. This
90-second integration check adds no arrival-accuracy outcomes.

## Fresh recording results

The fixed implementation was committed at `32f612d` before scoring the fresh
recording. The 12-minute collection produced 24 snapshots and 243 vehicle records
with no fetch failures, spanning November 1, 5:11:41–5:23:11 p.m. PST
(`2026-11-02T01:11:41.270Z`–`01:23:11.022Z`). The observed span is 11.5 minutes
because samples are taken every 30 seconds, excluding the collection deadline.

Replay emits 53 arrival rows across four trip instances, with estimates in 22 of
24 snapshots. Of nine first trip/horizon forecasts, six are scored across two
new bus crossings and three remain pending. None are censored and no capacity
limits were reached. The two crossing trip identities differ from those scored
in the original recording: there are now four distinct scored crossings across
the two recordings, not 13 independent arrival samples.

| Metric | All scored forecasts | Route 44 | Route 62 |
| --- | ---: | ---: | ---: |
| Distinct scored crossings | 2 | 1 | 1 |
| Scored trip/horizon forecasts | 6 | 3 | 3 |
| Median absolute error | 59.8 s | 24.3 s | 75.1 s |
| P90 absolute error | 110.4 s | 119.1 s | 77.3 s |
| Mean signed error (negative = early) | −0.8 s | +34.7 s | −36.2 s |
| Whole crossing bracket contained | 5/6 | 3/3 | 2/3 |
| Schedule-progress baseline median absolute error | 25.5 s | 10.0 s | 42.7 s |
| Progress-speed baseline median absolute error | 92.4 s | 21.0 s | 97.9 s |

The route-44 crossing bracket is 20 seconds wide and route 62 is 35 seconds.
Independent replay verified the recording checksum, all counts and these
metrics. The [full report](metro-gps-heldout-2026-11-02.replay-v2.json) preserves
every original forecast and scored crossing. Reproduce it with:

```sh
npm run replay:eta -- --recording test/fixtures/metro-gps-heldout-2026-11-02.ndjson.gz
```

The schedule-progress baseline again has lower error on this small sample.
These results support the evaluation and recording tools; they do not establish
that pace adjustment improves prediction accuracy. No tuning followed this
recording, and the arrival feature remains experimental.

## Recording and reproduction

`npm run record:gps` records public normalized Metro GPS without running the
estimator or loading its saved state. It retains unavailable samples and sanitized
failure counts, pins the normalizer source checksum, and publishes compressed
observations plus metadata without replacing existing files. A bounded duration
and graceful interruption make it suitable for collecting further evidence.

```sh
npm run record:gps -- --output var/morning.ndjson.gz --duration-minutes 20
npm run replay:eta -- --recording var/morning.ndjson.gz --index data/metro-gtfs.json
```

The fresh recording in this follow-up was collected after the first validation;
it was not used to tune estimator parameters. Both recordings use the same
official Metro GTFS subset whose source ZIP checksum is
`ff9b26cf8dc49558b526ad804dc1e41b67007fe84914c60bb3a9779c2e5fa163`.

GPS stop-crossing brackets remain proxies, not measured door-opening times.
Forecasts for multiple horizons on one trip share a crossing, and two short
Sunday recordings cannot establish performance across commute conditions.

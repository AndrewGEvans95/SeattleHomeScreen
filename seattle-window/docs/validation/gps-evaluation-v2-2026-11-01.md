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

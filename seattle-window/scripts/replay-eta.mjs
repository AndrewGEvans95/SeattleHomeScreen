import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GpsEstimator} from '../src/eta-estimator.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const increment=(counts,key,amount=1)=>{counts[key]=(counts[key]||0)+amount;};
const tripKey=v=>[v.serviceDate,v.rawTripId||String(v.tripId).replace(/^1_/,''),v.startTime||'',v.vehicleId].join('|');

export function decodeRecording(bytes,{compressed=false,metadata}={}){
  let decoded;
  try{decoded=compressed?gunzipSync(bytes,{maxOutputLength:64*1024*1024}):Buffer.from(bytes);}
  catch{throw new Error('Recording could not be decompressed.');}
  if(!metadata||!/^([a-f0-9]{64})$/.test(metadata.sha256Uncompressed||''))throw new Error('Recording metadata must include its uncompressed SHA-256.');
  const sha256Uncompressed=digest(decoded);
  if(sha256Uncompressed!==metadata.sha256Uncompressed)throw new Error('Recording SHA-256 does not match its metadata.');
  let snapshots;
  try{snapshots=decoded.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));}
  catch{throw new Error('Recording must contain one JSON snapshot per line.');}
  let previous=-Infinity,observations=0;
  for(const [i,snapshot] of snapshots.entries()){
    if(!snapshot||!Number.isFinite(snapshot.fetchedAt)||!Array.isArray(snapshot.vehicles))throw new Error(`Recording snapshot ${i+1} needs a finite fetchedAt and vehicles array.`);
    if(snapshot.fetchedAt<=previous)throw new Error('Recording fetchedAt timestamps must be strictly increasing; do not sort or repeat samples.');
    previous=snapshot.fetchedAt;observations+=snapshot.vehicles.length;
  }
  if(metadata.snapshots!==snapshots.length||metadata.observations!==observations)throw new Error('Recording counts do not match its metadata.');
  if(Date.parse(metadata.recordedStartUTC)!==snapshots[0].fetchedAt||Date.parse(metadata.recordedEndUTC)!==snapshots.at(-1).fetchedAt)throw new Error('Recording time bounds do not match its metadata.');
  return {snapshots,sha256Uncompressed};
}

// A replay always starts with no learned state. The only clock is fetchedAt;
// later snapshots are never visible while a forecast is being issued.
export function replayRecording({index,snapshots,stopId='1_29530',provenance={}}){
  if(!snapshots?.length)throw new Error('The recording is empty.');
  let now=snapshots[0].fetchedAt;
  const estimator=new GpsEstimator({index,stopId,now:()=>now});
  if(!estimator.indexValid)throw new Error('The GTFS index is invalid for this boarding stop.');
  const statuses={},excluded={},observationsByRoute={},qualifyingByRoute={};
  const observedTrips=new Set(),knownTrips=new Set(),qualifiedTrips=new Set(),forecastBuckets=new Map(),outcomes=new Map();
  let observations=0,knownObservations=0,qualifyingSnapshots=0,arrivalReports=0,previous=-Infinity;
  for(const snapshot of snapshots){
    if(!Number.isFinite(snapshot.fetchedAt)||snapshot.fetchedAt<=previous)throw new Error('Replay snapshots must have strictly increasing fetchedAt timestamps.');
    now=snapshot.fetchedAt;previous=now;
    for(const vehicle of snapshot.vehicles){
      const key=tripKey(vehicle);
      observedTrips.add(key);observations++;increment(observationsByRoute,vehicle.route);
      if(estimator.prepare(String(vehicle.rawTripId||String(vehicle.tripId).replace(/^1_/,'')))){knownTrips.add(key);knownObservations++;}
    }
    const result=estimator.observe(snapshot);
    increment(statuses,result.estimator.status);
    for(const [reason,count] of Object.entries(result.estimator.excluded||{}))increment(excluded,reason,count);
    if(result.arrivals.length)qualifyingSnapshots++;
    for(const arrival of result.arrivals){
      const vehicle=snapshot.vehicles.find(v=>v.vehicleId===arrival.vehicleId&&v.rawTripId===arrival.rawTripId&&v.serviceDate===arrival.serviceDate);
      qualifiedTrips.add(tripKey(vehicle||arrival));arrivalReports++;increment(qualifyingByRoute,arrival.route);
    }
    for(const [key,forecast] of estimator.forecastLedger)forecastBuckets.set(key,{...forecast,key});
    // Long replays can outlive the bounded in-memory ledger. Preserve that
    // missing evidence as censoring, never as a successful forecast.
    for(const [key,forecast] of forecastBuckets)if(forecast.status==='pending'&&!estimator.forecastLedger.has(key)){
      forecast.status='censored';forecast.censorReason='retention_evicted';
    }
    // Keep every completed outcome even if a long replay exceeds the live
    // estimator's bounded retention. Metrics below explicitly describe retention.
    for(const outcome of estimator.outcomes)outcomes.set(outcome.key,{...outcome});
  }
  const scored=[...outcomes.values()];
  const forecastDetails=[...forecastBuckets.values()].map(forecast=>({...forecast,horizon:forecast.bucket,firstIssuedAt:forecast.issuedAt,status:outcomes.has(forecast.key)?'scored':forecast.status==='pending'?'pending_at_recording_end':'no_scorable_crossing'}));
  const pendingAtEnd=forecastDetails.filter(f=>f.status==='pending_at_recording_end').length;
  const censorReasons={};
  for(const forecast of forecastDetails)if(forecast.status==='no_scorable_crossing')increment(censorReasons,forecast.censorReason||'unknown');
  return {
    schemaVersion:2,
    method:{evaluationVersion:estimator.exportState().modelVersion,clock:'Each snapshot fetchedAt, in recorded order',initialState:'Cold start; no persisted learning loaded or saved',evaluation:'Later GPS stop-crossing brackets of at most 60 seconds, not measured door-opening times',forecastUnit:'First immutable forecast per service-date/trip/start-time/vehicle/horizon; movement resets cannot replace it',limitations:['Repeated snapshots and horizon forecasts from the same bus are correlated, not independent accuracy samples.','A short recording cannot establish commute reliability; unscored forecasts are not counted as successful predictions.','GPS crossing proxies and forecasts use the same position source. No independent observed-arrival ground truth is available.']},
    provenance:{...provenance,gtfsSource:index.source,stopId:estimator.stopId},
    recording:{startUTC:new Date(snapshots[0].fetchedAt).toISOString(),endUTC:new Date(now).toISOString(),durationSeconds:(now-snapshots[0].fetchedAt)/1000,snapshots:snapshots.length,observations,observationsByRoute,uniqueTripInstances:observedTrips.size,knownHomeServingTripInstances:knownTrips.size,knownHomeServingObservations:knownObservations},
    coverage:{snapshotsWithEstimates:qualifyingSnapshots,snapshotsWithoutEstimates:snapshots.length-qualifyingSnapshots,qualifyingSnapshotFraction:qualifyingSnapshots/snapshots.length,arrivalReports,arrivalReportsByRoute:qualifyingByRoute,uniqueTripInstancesWithEstimates:qualifiedTrips.size,statuses,excluded},
    forecasts:{issuedBuckets:forecastBuckets.size,scoredBuckets:outcomes.size,unscoredBuckets:forecastBuckets.size-outcomes.size,pendingAtRecordingEnd:pendingAtEnd,withoutScorableCrossing:forecastBuckets.size-outcomes.size-pendingAtEnd,censorReasons,distinctScoredTripInstances:new Set(scored.map(o=>o.key.slice(0,o.key.lastIndexOf('|')))).size,buckets:forecastDetails},
    metrics:estimator.metrics(),
    metricsRetention:{description:'Metrics use the estimator retention window (28 days, at most 600 outcomes); outcomes lists every completed replay outcome.',retainedOutcomes:estimator.outcomes.length,allReplayOutcomes:outcomes.size},
    outcomes:scored
  };
}

const usage=`Usage: npm run replay:eta -- [--index PATH] [--recording PATH] [--metadata PATH] [--stop-id ID] [--output PATH]

Defaults: test/fixtures/metro-gtfs-2026-11-02.json.gz, test/fixtures/metro-gps-2026-11-02.ndjson.gz,
and the recording's adjacent .metadata.json. Writes a JSON report to stdout;
--output additionally saves that report. No network or live state is accessed.`;

export async function main(args=process.argv.slice(2)){
  const options={index:path.join(root,'test/fixtures/metro-gtfs-2026-11-02.json.gz'),recording:path.join(root,'test/fixtures/metro-gps-2026-11-02.ndjson.gz'),'stop-id':'1_29530'};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log(usage);return;}
    const name=args[i].replace(/^--/,'');
    if(!args[i].startsWith('--')||!['index','recording','metadata','stop-id','output'].includes(name)||!args[i+1]||args[i+1].startsWith('--'))throw new Error(usage);
    options[name]=args[++i];
  }
  const metadataPath=options.metadata||options.recording.replace(/\.ndjson(?:\.gz)?$/,'.metadata.json');
  if(metadataPath===options.recording)throw new Error('Use --metadata for recording names without an .ndjson or .ndjson.gz suffix.');
  if(options.output&&[options.index,options.recording,metadataPath].some(file=>path.resolve(file)===path.resolve(options.output)))throw new Error('The report output must not overwrite a replay input.');
  const [indexBytes,recordingBytes,metadataBytes]=await Promise.all([readFile(options.index),readFile(options.recording),readFile(metadataPath)]);
  const metadata=JSON.parse(metadataBytes);
  const {snapshots,sha256Uncompressed}=decodeRecording(recordingBytes,{compressed:options.recording.endsWith('.gz'),metadata});
  const decodedIndex=options.index.endsWith('.gz')?gunzipSync(indexBytes,{maxOutputLength:64*1024*1024}):indexBytes;
  const report=replayRecording({index:JSON.parse(decodedIndex),snapshots,stopId:options['stop-id'],provenance:{recording:{file:path.basename(options.recording),sha256Uncompressed,source:metadata.source,normalizer:metadata.normalizer,metadataVerified:true},gtfsIndex:{file:path.basename(options.index),sha256:digest(indexBytes),sha256Uncompressed:digest(decodedIndex)}}});
  const output=JSON.stringify(report,null,2)+'\n';
  if(options.output)await writeFile(options.output,output);
  process.stdout.write(output);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(`Replay failed: ${error.message}`);process.exitCode=1;}
}

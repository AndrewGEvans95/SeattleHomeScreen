import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {decodeRecording,replayRecording} from '../scripts/replay-eta.mjs';

const START=Date.parse('2026-11-02T16:00:00Z');
const LAT=47.66,LON=-122.34,METER_LON=1/(6371008.8*Math.cos(LAT*Math.PI/180)*Math.PI/180);
const coordinate=s=>[LON+s*METER_LON,LAT,s];
function fixture(){
  const stops=[0,200,400,600,800,1000].map((distance,i)=>({id:i===4?'29530':String(i+1),sequence:i+1,arrival:28800+i*60,departure:28805+i*60,distance,pickupAllowed:true}));
  const index={schemaVersion:1,source:{sha256:'fixture-v1',feedStartDate:'20261101',feedEndDate:'20261231'},stops:{29530:{id:'29530',name:'Home',lat:LAT,lon:coordinate(800)[0]}},shapes:{shape:Array.from({length:21},(_,i)=>coordinate(i*50))},trips:{trip:{routeId:'100252',route:'62',directionId:1,serviceId:'daily',shapeId:'shape',stops}},calendar:{daily:{startDate:'20261101',endDate:'20261231',weekdays:[1,1,1,1,1,1,1]}},exceptions:{}};
  const snapshots=[100,200,300,400,500,600,700,810].map((s,i)=>({status:'ok',fetchedAt:START+i*30000+1000,vehicles:[{route:'62',tripId:'1_trip',rawTripId:'trip',vehicleId:'1_8012',routeId:'100252',directionId:1,serviceDate:'20261102',startTime:'08:00:00',stopSequence:Math.max(2,Math.ceil(s/200)+1),currentStatus:'IN_TRANSIT_TO',location:{lat:LAT,lon:coordinate(s)[0],updatedAt:START+i*30000}}]}));
  return {index,snapshots};
}
function encoded(snapshots){
  const bytes=Buffer.from(snapshots.map(snapshot=>JSON.stringify(snapshot)).join('\n')+'\n');
  const metadata={source:'https://example.test/gps',normalizer:'test',snapshots:snapshots.length,observations:snapshots.reduce((count,s)=>count+s.vehicles.length,0),recordedStartUTC:new Date(snapshots[0].fetchedAt).toISOString(),recordedEndUTC:new Date(snapshots.at(-1).fetchedAt).toISOString(),sha256Uncompressed:createHash('sha256').update(bytes).digest('hex')};
  return {bytes,metadata};
}

test('replay validates compressed recording integrity, counts, time bounds and order before estimation',()=>{
  const {snapshots}=fixture(),{bytes,metadata}=encoded(snapshots);
  assert.deepEqual(decodeRecording(gzipSync(bytes),{compressed:true,metadata}).snapshots,snapshots);
  assert.throws(()=>decodeRecording(Buffer.from('corrupt'),{compressed:true,metadata}),/decompressed/);
  assert.throws(()=>decodeRecording(Buffer.concat([bytes,Buffer.from(' ')]),{metadata}),/SHA-256/);
  assert.throws(()=>decodeRecording(bytes,{metadata:{...metadata,observations:0}}),/counts/);
  assert.throws(()=>decodeRecording(bytes,{metadata:{...metadata,recordedStartUTC:'2026-11-01T00:00:00Z'}}),/time bounds/);
  assert.throws(()=>decodeRecording(bytes,{metadata:null}),/metadata/);
  for(const bad of [[snapshots[1],snapshots[0]],[snapshots[0],snapshots[0]]]){
    const data=encoded(bad);
    assert.throws(()=>decodeRecording(data.bytes,{metadata:data.metadata}),/strictly increasing/);
  }
});

test('replay uses recorded clocks from cold state and scores only subsequent crossing evidence',()=>{
  const {index,snapshots}=fixture();
  const before=replayRecording({index,snapshots:snapshots.slice(0,5)});
  assert.equal(before.coverage.statuses.warming_up,2);
  assert.equal(before.forecasts.scoredBuckets,0);
  assert(before.forecasts.pendingAtRecordingEnd>0);
  assert.equal(before.forecasts.unscoredBuckets,before.forecasts.issuedBuckets);
  const result=replayRecording({index,snapshots});
  assert(result.forecasts.scoredBuckets>0);
  assert.equal(result.forecasts.distinctScoredTripInstances,1);
  assert.equal(result.recording.uniqueTripInstances,1);
  assert.equal(result.coverage.uniqueTripInstancesWithEstimates,1);
  assert.equal(result.coverage.snapshotsWithEstimates,5);
  assert.equal(result.method.evaluationVersion,2);
  assert.equal(result.metrics.samples,result.forecasts.scoredBuckets);
  assert.equal(result.metrics.byRoute['62'].samples,result.forecasts.scoredBuckets);
  assert.equal(result.forecasts.issuedBuckets,result.forecasts.scoredBuckets+result.forecasts.unscoredBuckets);
  assert(result.forecasts.buckets.every(f=>f.firstIssuedAt>=snapshots[2].fetchedAt));
  assert(result.outcomes.every(o=>o.at===snapshots.at(-1).vehicles[0].location.updatedAt));
  assert.match(result.method.evaluation,/not measured door-opening/);
  assert.deepEqual(replayRecording({index,snapshots}),result,'Replaying again cannot inherit learned state from the first replay');
});

test('recording end and unmatched GTFS do not fabricate successful arrival outcomes',()=>{
  const {index,snapshots}=fixture();
  index.trips={};
  const result=replayRecording({index,snapshots});
  assert.equal(result.recording.knownHomeServingTripInstances,0);
  assert.equal(result.coverage.excluded.unknown_or_unserved_trip,snapshots.length);
  assert.equal(result.forecasts.issuedBuckets,0);
  assert.equal(result.metrics.samples,0);
  assert.equal(result.metrics.medianAbsoluteErrorSeconds,null);
  assert.throws(()=>replayRecording({index,snapshots:[snapshots[1],snapshots[0]]}),/strictly increasing/);
});

test('different start times on one trip and vehicle retain separate qualified trip identities',()=>{
  const {index,snapshots}=fixture();
  const second=snapshots.map(snapshot=>({...snapshot,fetchedAt:snapshot.fetchedAt+600000,vehicles:snapshot.vehicles.map(vehicle=>({...vehicle,startTime:'08:10:00',location:{...vehicle.location,updatedAt:vehicle.location.updatedAt+600000}}))}));
  const result=replayRecording({index,snapshots:[...snapshots,...second]});
  assert.equal(result.recording.uniqueTripInstances,2);
  assert.equal(result.coverage.uniqueTripInstancesWithEstimates,2);
  assert.equal(result.forecasts.distinctScoredTripInstances,2);
});

test('replay audits the original forecast after movement tracking resets',()=>{
  const {index,snapshots}=fixture();
  const first=replayRecording({index,snapshots:snapshots.slice(0,3)}).forecasts.buckets[0];
  assert(first);
  snapshots[3].vehicles[0].location.lat+=.02;
  const report=replayRecording({index,snapshots});
  const forecast=report.forecasts.buckets.find(item=>item.key===first.key);
  const outcome=report.outcomes.find(item=>item.key===first.key);
  assert.equal(report.coverage.excluded.off_route,1);
  assert.equal(forecast.firstIssuedAt,first.firstIssuedAt);
  assert.equal(forecast.arrivalTime,first.arrivalTime);
  assert.equal(outcome.issuedAt,first.issuedAt);
  assert.equal(outcome.arrivalTime,first.arrivalTime);
  assert(outcome.issuedAt<=outcome.crossingLow);
  assert.equal(outcome.errorSeconds,(first.arrivalTime-(outcome.crossingLow+outcome.crossingHigh)/2)/1000);
});

test('frozen Metro feed replays the saved recording with explicit unscored and reset coverage',async()=>{
  const [indexBytes,recordingBytes,metadataBytes]=await Promise.all([
    readFile(new URL('fixtures/metro-gtfs-2026-11-02.json.gz',import.meta.url)),
    readFile(new URL('fixtures/metro-gps-2026-11-02.ndjson.gz',import.meta.url)),
    readFile(new URL('fixtures/metro-gps-2026-11-02.metadata.json',import.meta.url))
  ]);
  const {snapshots}=decodeRecording(recordingBytes,{compressed:true,metadata:JSON.parse(metadataBytes)});
  const report=replayRecording({index:JSON.parse(gunzipSync(indexBytes)),snapshots});
  assert.equal(report.recording.snapshots,40);
  assert.equal(report.recording.observations,435);
  assert.equal(report.recording.knownHomeServingObservations,291);
  assert.equal(report.recording.knownHomeServingTripInstances,10);
  assert.equal(report.coverage.uniqueTripInstancesWithEstimates,5);
  assert.equal(report.coverage.snapshotsWithEstimates,38);
  assert.equal(report.forecasts.issuedBuckets,12);
  assert.equal(report.forecasts.scoredBuckets,7);
  assert.equal(report.forecasts.distinctScoredTripInstances,2);
  assert.equal(report.forecasts.unscoredBuckets,5);
  assert.equal(report.forecasts.pendingAtRecordingEnd,5);
  assert.equal(report.metrics.byRoute['44'].samples,3);
  assert.equal(report.metrics.byRoute['62'].samples,4);
  assert(report.outcomes.every(outcome=>outcome.bracketSeconds>0&&outcome.bracketSeconds<=60));
  assert.equal(report.outcomes.filter(outcome=>outcome.bracketContained).length,5);
});

test('CLI accepts gzip GTFS, saves provenance and refuses to overwrite an input',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'seattle-replay-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const {index,snapshots}=fixture(),{bytes,metadata}=encoded(snapshots);
  const indexFile=path.join(dir,'index.json.gz'),recordingFile=path.join(dir,'recording.ndjson.gz'),metadataFile=path.join(dir,'recording.metadata.json'),outputFile=path.join(dir,'report.json');
  const indexBytes=gzipSync(Buffer.from(JSON.stringify(index)));
  await Promise.all([writeFile(indexFile,indexBytes),writeFile(recordingFile,gzipSync(bytes)),writeFile(metadataFile,JSON.stringify(metadata))]);
  const script=fileURLToPath(new URL('../scripts/replay-eta.mjs',import.meta.url));
  const args=[script,'--index',indexFile,'--recording',recordingFile];
  const run=spawnSync(process.execPath,[...args,'--output',outputFile],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.deepEqual(JSON.parse(await readFile(outputFile,'utf8')),report);
  assert.equal(report.provenance.recording.metadataVerified,true);
  assert.equal(report.provenance.recording.sha256Uncompressed,metadata.sha256Uncompressed);
  assert.equal(report.provenance.gtfsIndex.sha256,createHash('sha256').update(indexBytes).digest('hex'));
  const overwrite=spawnSync(process.execPath,[...args,'--output',indexFile],{encoding:'utf8',timeout:10000});
  assert.equal(overwrite.status,1);assert.match(overwrite.stderr,/must not overwrite/);
  assert.deepEqual(await readFile(indexFile),indexBytes);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordGps,recordingOptions} from '../scripts/record-gps.mjs';
import {decodeRecording} from '../scripts/replay-eta.mjs';

const START=Date.parse('2026-11-02T01:15:00Z');
function payload(at){return {header:{timestamp:at/1000},entity:[{vehicle:{trip:{trip_id:'trip',route_id:'100252',direction_id:1,start_date:'20261101'},vehicle:{id:'8012'},timestamp:at/1000,current_stop_sequence:5,current_status:'IN_TRANSIT_TO',position:{latitude:47.66,longitude:-122.33}}}]};}
async function setup(t){
  const dir=await mkdtemp(path.join(tmpdir(),'seattle-gps-record-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let clock=START;
  return {dir,output:path.join(dir,'recording.ndjson.gz'),durationMinutes:1,now:()=>clock,sleep:async ms=>{clock+=ms},advance:ms=>{clock+=ms},fetchImpl:async()=>({ok:true,json:async()=>payload(clock)})};
}
async function decoded(result){return decodeRecording(await readFile(result.output),{compressed:true,metadata:JSON.parse(await readFile(result.metadataPath,'utf8'))}).snapshots;}

test('recorder saves normalized snapshots and verified replay metadata using completed fetch times',async t=>{
  const options=await setup(t),requested=[];
  options.fetchImpl=async(url,request)=>{
    requested.push({url,at:options.now()});
    assert(request.signal instanceof AbortSignal);
    options.advance(2000);
    return {ok:true,json:async()=>payload(options.now())};
  };
  const result=await recordGps(options),snapshots=await decoded(result);
  assert.deepEqual(requested.map(r=>r.at),[START,START+30000]);
  assert(requested.every(r=>r.url==='https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions_enhanced.json'));
  assert.deepEqual(snapshots.map(s=>s.fetchedAt),[START+2000,START+32000]);
  assert.deepEqual(snapshots.map(s=>s.vehicles[0].tripId),['1_trip','1_trip']);
  assert.equal(result.metadata.snapshots,2);assert.equal(result.metadata.observations,2);
  assert.equal(result.metadata.successfulSnapshots,2);assert.equal(result.metadata.failedSnapshots,0);
  assert.equal(result.metadata.interrupted,false);
  assert.match(result.metadata.normalizer,/^src\/vehicles\.mjs sha256:[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(options.dir)).sort(),['recording.metadata.json','recording.ndjson.gz']);
});

test('recording retains network, HTTP, timeout and malformed-feed failures without raw provider errors',async t=>{
  const options=await setup(t),secret='provider-secret-must-not-be-written';let attempt=0,canceled=false;
  options.durationMinutes=3;
  options.fetchImpl=async()=>{
    attempt++;
    if(attempt===1)throw new Error(secret);
    if(attempt===2)return {ok:false,body:{cancel:async()=>{canceled=true;}}};
    if(attempt===3)throw Object.assign(new Error(secret),{name:'TimeoutError'});
    if(attempt===4)return {ok:true,json:async()=>{throw new Error(secret);}};
    if(attempt===5)return {ok:true,json:async()=>({header:{timestamp:0},entity:[]})};
    return {ok:true,json:async()=>payload(options.now())};
  };
  const result=await recordGps(options),snapshots=await decoded(result);
  assert.equal(canceled,true);
  assert.equal(result.metadata.failedSnapshots,5);assert.equal(result.metadata.successfulSnapshots,1);
  assert.deepEqual(result.metadata.failureCounts,{network_error:1,http_error:1,timeout:1,invalid_feed:2});
  assert(snapshots.slice(0,5).every(s=>s.status==='unavailable'&&s.vehicles.length===0));
  assert.equal(snapshots.at(-1).vehicles.length,1);
  assert(!JSON.stringify({snapshots,metadata:result.metadata}).includes(secret));
});

test('interruption finalizes completed samples and never fabricates a canceled request',async t=>{
  const options=await setup(t),controller=new AbortController();
  options.signal=controller.signal;
  options.sleep=async()=>{controller.abort();throw new Error('Interrupted');};
  const result=await recordGps(options);
  assert.equal(result.metadata.interrupted,true);assert.equal(result.metadata.snapshots,1);
  assert.equal(result.metadata.failedSnapshots,0);
  assert.equal((await decoded(result)).length,1);
  const empty=await setup(t),alreadyAborted=new AbortController();alreadyAborted.abort();
  await assert.rejects(recordGps({...empty,signal:alreadyAborted.signal}),/No snapshots/);
  assert.deepEqual(await readdir(empty.dir),[]);
});

test('recorder never replaces existing or concurrently created recordings and metadata',async t=>{
  for(const target of ['recording.ndjson.gz','recording.metadata.json']){
    const options=await setup(t),existing=path.join(options.dir,target);
    await writeFile(existing,'prior-recording');
    await assert.rejects(recordGps(options),/already exists/);
    assert.equal(await readFile(existing,'utf8'),'prior-recording');
  }
  for(const target of ['recording.ndjson.gz','recording.metadata.json']){
    const options=await setup(t),existing=path.join(options.dir,target);let first=true;
    options.fetchImpl=async()=>{if(first){first=false;await writeFile(existing,'concurrent-recording');}return {ok:true,json:async()=>payload(options.now())};};
    await assert.rejects(recordGps(options),{code:'EEXIST'});
    assert.equal(await readFile(existing,'utf8'),'concurrent-recording');
    assert.deepEqual(await readdir(options.dir),[target]);
  }
});

test('recorder bounds collection and refuses clocks that go backward',async t=>{
  assert.throws(()=>recordingOptions([]),/explicit new/);
  assert.throws(()=>recordingOptions(['--output','file.json']),/ndjson/);
  for(const duration of ['0','121','NaN'])assert.throws(()=>recordingOptions(['--output','file.ndjson.gz','--duration-minutes',duration]),/Duration/);
  for(const interval of ['0','29','301','NaN'])assert.throws(()=>recordingOptions(['--output','file.ndjson.gz','--interval-seconds',interval]),/Interval/);
  assert.deepEqual(recordingOptions(['--output','file.ndjson.gz','--duration-minutes','12']),{output:'file.ndjson.gz',durationMinutes:12,intervalSeconds:30});
  const options=await setup(t);
  options.sleep=async()=>{options.advance(-1);};
  await assert.rejects(recordGps(options),/clock did not advance/);
  assert.deepEqual(await readdir(options.dir),[]);
});

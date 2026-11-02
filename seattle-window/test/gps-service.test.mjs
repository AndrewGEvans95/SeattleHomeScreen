import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createGpsService,fileStateStore} from '../src/gps-service.mjs';

function fixture(overrides={}){
  let observations=0;
  return {loadIndex:async()=>({schemaVersion:1}),loadVehicles:async()=>({status:'ok',fetchedAt:10000,vehicles:[]}),
    createEstimator:()=>({observe(snapshot){observations++;return {...snapshot,source:'gps_estimate',arrivals:[],estimator:{status:'warming_up',message:'Learning movement',metrics:{samples:observations}}};},exportState(){return {samples:observations};}}),
    ...overrides};
}

test('parallel view and export requests share one observation and one state write',async()=>{
  let loads=0,saves=0;
  const service=createGpsService(fixture({loadVehicles:async()=>{loads++;await Promise.resolve();return {status:'ok',fetchedAt:10000};},store:{load:async()=>null,save:async()=>{saves++;}}}));
  const snapshots=await Promise.all([service.get(),service.get(),service.get()]);
  assert.equal(loads,1);assert.equal(saves,1);
  assert.equal(snapshots[0],snapshots[2]);
  await service.stop();
});
test('one-shot diagnostics cannot overwrite a running collector’s learning state',async()=>{
  let saves=0,loads=0;
  const service=createGpsService(fixture({saveLearning:false,store:{load:async()=>{loads++;return {samples:3};},save:async()=>{saves++;}}}));
  await service.get();await service.stop();
  assert.equal(loads,1);assert.equal(saves,0);
});

test('missing timetable abstains and retries after data is installed',async()=>{
  let time=10000,missing=true,loads=0;
  const service=createGpsService(fixture({now:()=>time,loadIndex:async()=>{loads++;if(missing)throw new Error('missing');return {schemaVersion:1};}}));
  const absent=await service.get();
  assert.equal(absent.status,'unavailable');assert.equal(absent.estimator.status,'index_missing');
  missing=false;time+=1000;
  assert.equal((await service.get()).status,'unavailable');assert.equal(loads,1);
  time+=60000;
  assert.equal((await service.get()).status,'ok');assert.equal(loads,2);
  await service.stop();
});

test('storage failures preserve in-memory estimates and are reported without raw paths',async()=>{
  const service=createGpsService(fixture({store:{load:async()=>{throw new Error('/private/credentials');},save:async()=>{throw new Error('/private/credentials');}}}));
  const snapshot=await service.get();
  assert.equal(snapshot.status,'ok');assert.match(snapshot.estimator.storageWarning,/could not be saved/);
  assert(!JSON.stringify(snapshot).includes('/private/credentials'));
  await service.stop();
});

test('background collector keeps observing without browser requests and stops cleanly',{timeout:2000},async()=>{
  let calls=0,secondObservation;
  const twice=new Promise(resolve=>{secondObservation=resolve;});
  const service=createGpsService(fixture({pollInterval:10,loadVehicles:async()=>{calls++;if(calls===2)secondObservation();return {status:'ok',fetchedAt:Date.now()};}}));
  service.start();service.start();
  await twice;
  await service.stop();
  assert.equal(calls,2);
});

test('learning state is atomically replaced and can be read after restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'seattle-eta-state-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'var','eta.json'),store=fileStateStore(filename);
  assert.equal(await store.load(),null);
  await store.save({samples:3});assert.deepEqual(await store.load(),{samples:3});
  await store.save({samples:4});assert.deepEqual(JSON.parse(await readFile(filename,'utf8')),{samples:4});
  await writeFile(filename,'bad json');await assert.rejects(()=>store.load(),/could not be read/);
});

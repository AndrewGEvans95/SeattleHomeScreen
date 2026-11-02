import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {GpsEstimator} from './eta-estimator.mjs';

export function fileStateStore(filename){
  return {
    async load(){
      try{
        if((await stat(filename)).size>4*1024*1024)throw new Error('state too large');
        return JSON.parse(await readFile(filename,'utf8'));
      }catch(error){if(error.code==='ENOENT')return null;throw new Error('Saved learning data could not be read. Learning will restart.');}
    },
    async save(state){
      await mkdir(path.dirname(filename),{recursive:true});
      const temporary=filename+'.tmp';
      await writeFile(temporary,JSON.stringify(state),{mode:0o600});
      await rename(temporary,filename);
    }
  };
}

// One collector serves every browser and PNG request. It keeps learning even
// when no page is open; the upstream vehicle cache still caps network requests.
export function createGpsService({loadVehicles,loadIndex,store,saveLearning=true,stopId='1_29530',now=Date.now,pollInterval=30000,createEstimator=options=>new GpsEstimator(options)}){
  let estimator=null,pending=null,timer=null,running=false,indexAttemptedAt=-Infinity,lastSavedAt=-Infinity,storageWarning=null;
  let latest=null;
  const unavailable=(code,message)=>({status:'unavailable',source:'gps_estimate',arrivals:[],fetchedAt:null,extraStatus:'not_configured',error:{code,message},estimator:{status:code,message,metrics:null}});
  async function initialize(){
    if(estimator)return true;
    if(now()-indexAttemptedAt<60000)return false;
    indexAttemptedAt=now();
    let index;
    try{index=await loadIndex();}
    catch{
      latest=unavailable('index_missing','GPS estimates need Metro route and timetable data. Run npm run update:gtfs, then restart the server.');
      return false;
    }
    let state=null;
    try{state=await store?.load();}catch{storageWarning='Saved learning data could not be read. Learning restarted.';}
    try{estimator=createEstimator({index,stopId,now,state});return true;}
    catch{
      latest=unavailable('index_invalid','Metro route and timetable data are invalid. Run npm run update:gtfs, then restart the server.');
      return false;
    }
  }
  async function save(force=false){
    if(!estimator||!store||!saveLearning||(!force&&now()-lastSavedAt<60000))return;
    lastSavedAt=now();
    try{await store.save(estimator.exportState());storageWarning=null;}
    catch{storageWarning='Learning is working in memory, but could not be saved for the next restart.';}
  }
  function get(){
    if(pending)return pending;
    pending=Promise.resolve().then(async()=>{
      if(!await initialize())return latest;
      try{latest=estimator.observe(await loadVehicles());}
      catch{latest=unavailable('estimator_unavailable','GPS estimates are temporarily unavailable. The collector will retry automatically.');}
      await save();
      if(storageWarning)latest={...latest,estimator:{...latest.estimator,storageWarning}};
      return latest;
    }).finally(()=>{pending=null;});
    return pending;
  }
  async function tick(){
    try{await get();}finally{if(running){timer=setTimeout(tick,pollInterval);timer.unref?.();}}
  }
  return {
    get,
    start(){if(running)return;running=true;void tick();},
    async stop(){running=false;clearTimeout(timer);await pending;await save(true);},
    async diagnostics(){const snapshot=await get();return {source:'gps_estimate',fetchedAt:snapshot.fetchedAt,...snapshot.estimator};}
  };
}

import {readFile,open,mkdir,mkdtemp,link,rm,stat,writeFile} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeVehicles,vehicleFeedURL} from '../src/vehicles.mjs';
import {configureNetwork} from '../src/network.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Fingerprint at module startup, alongside the imported normalizer. A source
// edit while a long recording runs must not relabel its already-loaded code.
const normalizerSourceSha256=sha256(await readFile(new URL('../src/vehicles.mjs',import.meta.url)));
const exists=async filename=>{try{await stat(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const usage='Usage: node scripts/record-gps.mjs --output PATH.ndjson.gz [--duration-minutes 20] [--interval-seconds 30]\nDuration: 1–120 minutes; interval: 30–300 seconds. Existing recordings are never replaced. Ctrl-C saves samples already collected.';

export function recordingOptions(args){
  const options={durationMinutes:20,intervalSeconds:30};
  const flags={'--output':'output','--duration-minutes':'durationMinutes','--interval-seconds':'intervalSeconds'};
  for(let i=0;i<args.length;i++){
    const key=flags[args[i]];
    if(!key||!args[i+1]||args[i+1].startsWith('--'))throw new Error(usage);
    options[key]=key==='output'?args[++i]:Number(args[++i]);
  }
  validateOptions(options);return options;
}

function validateOptions({output,durationMinutes,intervalSeconds}){
  if(typeof output!=='string'||!output.endsWith('.ndjson.gz'))throw new Error('Use an explicit new --output path ending in .ndjson.gz.');
  if(!Number.isFinite(durationMinutes)||durationMinutes<1||durationMinutes>120)throw new Error('Duration must be between 1 and 120 minutes.');
  if(!Number.isFinite(intervalSeconds)||intervalSeconds<30||intervalSeconds>300)throw new Error('Interval must be between 30 and 300 seconds.');
}

// Only public normalized observations are saved. Failures remain visible as
// unavailable snapshots, so replay cannot silently interpolate across outages.
export async function recordGps({output,durationMinutes=20,intervalSeconds=30,fetchImpl=fetch,now=Date.now,sleep=(ms,signal)=>delay(ms,undefined,{signal}),signal,onSnapshot=()=>{}}){
  validateOptions({output,durationMinutes,intervalSeconds});
  output=path.resolve(output);
  const metadataPath=output.replace(/\.ndjson\.gz$/,'.metadata.json');
  if(await exists(output)||await exists(metadataPath))throw new Error('Recording or metadata already exists; choose a new output path.');
  await mkdir(path.dirname(output),{recursive:true});
  await mkdir(path.join(root,'var'),{recursive:true});
  const temporary=await mkdtemp(path.join(root,'var','gps-recording-'));
  const raw=path.join(temporary,'samples.ndjson');
  const file=await open(raw,'wx');
  const hash=createHash('sha256'),startedAt=now(),deadline=startedAt+durationMinutes*60000;
  let snapshots=0,observations=0,successfulSnapshots=0,firstAt=null,lastAt=null,bytes=0;
  const failureCounts={};let publicationDirectory;
  try{
    while(!signal?.aborted&&now()<deadline){
      const requestedAt=now();let snapshot;
      try{
        const timeout=AbortSignal.timeout(15000);
        const response=await fetchImpl(vehicleFeedURL,{signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{Accept:'application/json','User-Agent':'SeattleWindow/0.5 gps-recording'}});
        if(!response.ok){await response.body?.cancel().catch(()=>{});throw Object.assign(new Error('HTTP'),{recordingCode:'http_error'});}
        let payload;
        try{payload=await response.json();}catch(error){if(error.name==='AbortError'||error.name==='TimeoutError')throw error;throw Object.assign(new Error('JSON'),{recordingCode:'invalid_feed'});}
        const fetchedAt=now();let normalized;
        try{normalized=normalizeVehicles(payload,{now:fetchedAt});}catch{throw Object.assign(new Error('Invalid feed'),{recordingCode:'invalid_feed'});}
        snapshot={status:'ok',fetchedAt,...normalized};
      }catch(error){
        if(signal?.aborted)break;
        const code=error.recordingCode||(error.name==='TimeoutError'||error.name==='AbortError'?'timeout':'network_error');
        snapshot={status:'unavailable',fetchedAt:now(),vehicles:[],source:'King County Metro',error:{code,message:'Public GPS observation unavailable; no retained vehicle positions were substituted.'}};
      }
      if(!Number.isFinite(snapshot.fetchedAt)||(lastAt!==null&&snapshot.fetchedAt<=lastAt))throw new Error('Recording clock did not advance; refusing to invent observation times.');
      const line=JSON.stringify(snapshot)+'\n';bytes+=Buffer.byteLength(line);
      if(bytes>64*1024*1024)throw new Error('Recording exceeded the 64 MiB replay limit.');
      await file.writeFile(line);hash.update(line);
      snapshots++;observations+=snapshot.vehicles.length;firstAt??=snapshot.fetchedAt;lastAt=snapshot.fetchedAt;
      if(snapshot.status==='ok')successfulSnapshots++;else failureCounts[snapshot.error.code]=(failureCounts[snapshot.error.code]||0)+1;
      onSnapshot({snapshots,observations,fetchedAt:lastAt,status:snapshot.status});
      const wait=Math.min(Math.max(0,intervalSeconds*1000-(now()-requestedAt)),Math.max(0,deadline-now()));
      if(wait>0){try{await sleep(wait,signal);}catch(error){if(signal?.aborted)break;throw error;}}
    }
    await file.close();
    if(!snapshots)throw new Error('No snapshots collected; no recording was created.');
    const metadata={source:vehicleFeedURL,normalizer:'src/vehicles.mjs sha256:'+normalizerSourceSha256,recordedStartUTC:new Date(firstAt).toISOString(),recordedEndUTC:new Date(lastAt).toISOString(),snapshots,observations,successfulSnapshots,failedSnapshots:snapshots-successfulSnapshots,failureCounts,requestedDurationMinutes:durationMinutes,intervalSeconds,interrupted:!!signal?.aborted,sha256Uncompressed:hash.digest('hex'),description:'Normalized public Metro GPS snapshots. Replay with a compatible official GTFS index using each snapshot fetchedAt as the estimator clock. Unavailable snapshots preserve collection failures; no arrival ground truth is included.'};
    // Stage final files beside their destination so atomic publication also
    // works when that destination lives on another filesystem.
    publicationDirectory=await mkdtemp(path.join(path.dirname(output),'.gps-recording-'));
    const compressed=path.join(publicationDirectory,'samples.ndjson.gz'),metadataTemporary=path.join(publicationDirectory,'metadata.json');
    await pipeline(createReadStream(raw),createGzip({mtime:0}),createWriteStream(compressed,{flags:'wx'}));
    await writeFile(metadataTemporary,JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
    // Hard links publish complete files with no replacement, even if another
    // recorder creates the destination between the initial check and this step.
    await link(compressed,output);
    try{await link(metadataTemporary,metadataPath);}catch(error){await rm(output);throw error;}
    return {output,metadataPath,metadata};
  }finally{
    await file.close().catch(()=>{});
    await rm(temporary,{recursive:true,force:true});
    if(publicationDirectory)await rm(publicationDirectory,{recursive:true,force:true});
  }
}

export async function main(args=process.argv.slice(2)){
  if(args.length===1&&args[0]==='--help'){console.log(usage);return;}
  const options=recordingOptions(args),controller=new AbortController();
  configureNetwork();
  const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    const result=await recordGps({...options,signal:controller.signal,onSnapshot:sample=>console.log(`${new Date(sample.fetchedAt).toISOString()} ${sample.status}: ${sample.snapshots} snapshots, ${sample.observations} vehicle observations`)});
    console.log(`Saved ${result.metadata.snapshots} snapshots (${result.metadata.failedSnapshots} unavailable) to ${result.output}\nMetadata: ${result.metadataPath}`);
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(error.code==='EEXIST'?'Recording destination already exists; no existing recording was replaced.':`Recording failed: ${['EACCES','EPERM','EXDEV'].includes(error.code)?'Check output directory permissions and keep the output on the workspace filesystem.':error.message}`);process.exitCode=1;}
}

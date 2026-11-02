import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {configureNetwork} from '../src/network.mjs';
import {loadConfig} from '../src/server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source='https://metro.kingcounty.gov/GTFS/google_transit.zip';
const args=process.argv.slice(2);
if(args.length>1){console.error('Usage: npm run update:gtfs -- [path/to/google_transit.zip]');process.exitCode=1;}
else{
  const config=await loadConfig();
  const destination=path.resolve(root,config.GTFS_INDEX||'data/metro-gtfs.json');
  const temporary=destination+'.tmp';
  const archive=args[0]?path.resolve(args[0]):path.join(root,'var','google_transit.zip');
  try{
    if(!args[0]){
      configureNetwork();
      console.log('Downloading official Metro route and timetable data…');
      const response=await fetch(source,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error('download');
      const limit=120*1024*1024,parts=[];let length=0;
      for await(const chunk of response.body){length+=chunk.length;if(length>limit)throw new Error('download');parts.push(chunk);}
      await mkdir(path.dirname(archive),{recursive:true});
      await writeFile(archive,Buffer.concat(parts));
    }
    await mkdir(path.dirname(destination),{recursive:true});
    await new Promise((resolve,reject)=>{
      const child=spawn('python3',[path.join(root,'scripts','import-gtfs.py'),archive,'--output',temporary,'--stop-id',config.HOME_STOP_ID],{stdio:'inherit'});
      child.on('error',()=>reject(new Error('python')));
      child.on('exit',code=>code===0?resolve():reject(new Error('import')));
    });
    // Validate the expected output before replacing the last working snapshot.
    const index=JSON.parse(await readFile(temporary,'utf8'));
    if(index.schemaVersion!==1||!Object.keys(index.trips||{}).length)throw new Error('import');
    await rename(temporary,destination);
    console.log(`Installed ${Object.keys(index.trips).length} home-serving trips. Restart npm start to use the new timetable.`);
  }catch(error){
    await rm(temporary,{force:true}).catch(()=>{});
    const messages={python:'Python 3 is required only to import GTFS. Install it and rerun this command.',import:'Metro GTFS could not be validated. The previous timetable was kept.',download:'Could not download Metro GTFS. Allow metro.kingcounty.gov in the network policy, or download the official ZIP and run npm run update:gtfs -- /path/to/google_transit.zip.'};
    console.error(messages[error.message]||'Could not update Metro GTFS. Check network and file permissions. The previous timetable was kept.');
    process.exitCode=1;
  }
}

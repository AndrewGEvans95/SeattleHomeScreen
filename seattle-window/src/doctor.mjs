import {access,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFeeds} from './data.mjs';
import {loadConfig,projectRoot} from './server.mjs';
import {configureNetwork} from './network.mjs';

export async function checkRenderer(config){
  try{
    const {chromium}=await import('playwright');
    await access(config.CHROMIUM_EXECUTABLE||chromium.executablePath(),constants.X_OK);
    return {id:'renderer',status:'ok',message:'PNG export dependencies found. Run npm run test:browser to verify rendering.'};
  }catch{
    return {id:'renderer',status:'warning',message:'PNG export is optional. Run npm run install:renderer, or set CHROMIUM_EXECUTABLE to an installed Chromium executable. The browser display still works.'};
  }
}

export async function diagnose({feeds,network,rendererCheck}){
  const checks=[{id:'network',status:'ok',message:network.mode==='proxy'?'Using the configured HTTP(S) proxy; local display requests bypass it.':'Using direct connections; no HTTP(S) proxy configured.'}];
  const labels={transit:'Arrival predictions',vehicles:'Metro GPS',weather:'Weather'};
  const snapshots={};
  const results=await Promise.all(Object.keys(labels).map(async id=>{
    let snapshot;
    try{snapshot=await feeds[id]();snapshots[id]=snapshot;}catch{return {id,status:'error',message:labels[id]+': check failed. Run npm test and check the local configuration.'};}
    if(snapshot.status==='unconfigured')return {id,status:'warning',message:labels[id]+': add OBA_API_KEY to .env and restart to enable arrival countdowns. Weather and Metro GPS do not require this key.'};
    if(snapshot.status!=='ok')return {id,status:'error',message:labels[id]+': '+(snapshot.error?.message||'No fresh data available. Check internet access and provider availability.')};
    const count=id==='weather'?`${snapshot.points?.length||0} forecast locations`:id==='vehicles'?`${snapshot.vehicles?.length||0} matching vehicles`:`${snapshot.arrivals?.length||0} arrivals`;
    return {id,status:'ok',message:`${labels[id]} connected (${count}).`};
  }));
  checks.push(...results);
  // An optional Fremont stop can fail independently while the home stop works.
  const transit=snapshots.transit;
  if(transit?.status==='ok'&&transit.extraStatus==='unavailable')checks.push({id:'fremont',status:'warning',message:'Fremont stop arrivals: '+(transit.extraError?.message||'Verify FREMONT_STOP_ID and provider access.')});
  if(rendererCheck)checks.push(await rendererCheck());
  return {ok:!checks.some(check=>check.status==='error'),checks};
}

export function formatReport(report){
  return ['Seattle Window live-data check',`Node ${process.versions.node}`,...report.checks.map(check=>`[${check.status.toUpperCase()}] ${check.message}`),report.ok?'Required live-feed checks passed.':'Some live-feed checks failed; fix the errors above and run npm run doctor again.'].join('\n');
}

async function main(){
  let config,network;
  try{config=await loadConfig();}
  catch{console.error('Could not load configuration. Check .env permissions and PORT (1–65535).');process.exitCode=1;return;}
  try{network=configureNetwork();}
  catch(error){
    console.error(error.code==='PROXY_UNSUPPORTED'?'Proxy support needs Node.js 24.19 or newer. Upgrade Node and run npm run doctor again.':'Could not configure networking. Check HTTP_PROXY, HTTPS_PROXY and NO_PROXY.');
    process.exitCode=1;return;
  }
  try{
    const places=JSON.parse(await readFile(path.join(projectRoot,'public/assets/places.json'),'utf8'));
    const report=await diagnose({feeds:createFeeds(config,places),network,rendererCheck:()=>checkRenderer(config)});
    console.log(formatReport(report));
    if(!report.ok)process.exitCode=1;
  }catch{console.error('The live-data check could not finish. Verify project assets and run npm test.');process.exitCode=1;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();

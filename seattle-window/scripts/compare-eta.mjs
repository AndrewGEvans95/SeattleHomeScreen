import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureNetwork} from '../src/network.mjs';
import {loadConfig} from '../src/server.mjs';
import {compareGpsToReference,metroReferenceURL,normalizeMetroReference} from '../src/metro-reference.mjs';

async function readJSON(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','User-Agent':'SeattleWindow/0.5 reference-comparison'}});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error('Reference comparison request unavailable.');}
  return response.json();
}

export function formatComparison(report){
  const lines=[report.label,`Fresh GPS estimates: ${report.ownEstimates}; active Metro reference arrivals: ${report.referenceArrivals}.`];
  if(report.status==='reference_unavailable')lines.push('Metro reference data are unavailable or stale. No comparison measured.');
  else if(report.status==='warming_up')lines.push('Warming up or abstaining: no fresh valid GPS estimates to compare. Keep the server running and retry when a qualifying bus approaches. No comparison measured.');
  else if(report.status==='no_matches')lines.push('No exact trip, service-date, vehicle and stop matches. No comparison measured.');
  else lines.push(
    `Exact identity matches: ${report.matched}. Unmatched GPS: ${report.unmatchedOwnEstimates}; unmatched reference: ${report.unmatchedReferenceArrivals}.`,
    `Absolute disagreement: at most 60 seconds: ${report.within60Seconds}; over 60 through 120 seconds: ${report.between60And120Seconds}; over 120 seconds: ${report.over120Seconds}.`,
    `GPS prediction earlier than reference: ${report.earlierThanReference}; later: ${report.laterThanReference}; equal: ${report.sameAsReference}.`
  );
  return lines.join('\n');
}

async function main(){
  let config;
  try{config=await loadConfig();}
  catch{console.error('Could not load configuration. Check PORT (1–65535) and local .env access.');process.exitCode=1;return;}
  try{configureNetwork();}
  catch(error){
    console.error(error.code==='PROXY_UNSUPPORTED'?'Proxy support needs Node.js 24.19 or newer. Upgrade Node and retry.':'Could not configure networking. Check HTTP_PROXY, HTTPS_PROXY and NO_PROXY.');
    process.exitCode=1;return;
  }
  const [gps,metro]=await Promise.allSettled([readJSON(`http://127.0.0.1:${config.PORT}/api/gps-estimates`),readJSON(metroReferenceURL)]);
  if(gps.status==='rejected')console.error('Could not read the local GPS estimator. Start the server with npm start and verify PORT.');
  if(metro.status==='rejected')console.error('Could not read Metro TripUpdates. Check internet access and the s3.amazonaws.com allowlist, then retry.');
  if(gps.status==='rejected'||metro.status==='rejected'){process.exitCode=1;return;}
  let reference;
  const now=Date.now();
  try{reference=normalizeMetroReference(metro.value,{now,stopId:config.HOME_STOP_ID});}
  catch{console.error('Metro reference data are missing, invalid or stale. No comparison measured; retry later.');process.exitCode=1;return;}
  const report=compareGpsToReference(gps.value,reference,{now});
  console.log(formatComparison(report));
  // Exit 2 distinguishes insufficient evidence from a measured comparison.
  process.exitCode=report.status==='compared'?0:report.status==='reference_unavailable'?1:2;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();

import {normalizeVehicles,vehicleFeedURL} from './vehicles.mjs';
// Provider adapters deliberately separate reported locations from inferred ones.
export const MAX_TRANSIT_AGE = 120_000;
const feedErrors={
  timeout:'The provider timed out. Check connectivity and retry.',
  network_error:'Could not reach the provider. Check internet access, proxy settings and allowed hosts.',
  unauthorized:'The provider rejected authentication. Check the configured API key.',
  access_denied:'The provider or network proxy denied access. Check permissions and allowed hosts.',
  rate_limited:'The provider is rate limiting requests. Wait for the next automatic retry.',
  provider_unavailable:'The provider is unavailable. The app will retry automatically.',
  invalid_response:'The provider returned an incomplete or unexpected response. Guidance remains paused until valid data returns.',
  stale_data:'The provider returned stale data. Check the system clock; the app will retry automatically.'
};
export class FeedError extends Error {
  constructor(code){super(feedErrors[code]||feedErrors.invalid_response);this.code=Object.hasOwn(feedErrors,code)?code:'invalid_response';}
}
function safeFeedError(error){
  const code=error instanceof FeedError&&Object.hasOwn(feedErrors,error.code)?error.code:'invalid_response';
  // Never expose raw fetch errors: they can contain a URL with the API key.
  return {code,message:feedErrors[code]};
}
const finite = x => typeof x === 'number' && Number.isFinite(x);
export function normalizeTransit(payload, {now=Date.now(),stopId='1_29530',routes=['62','44']}={}) {
  if(payload.code===401||payload.code===403)throw new FeedError(payload.code===401?'unauthorized':'access_denied');
  if (payload.code !== 200 || !payload.data?.entry) throw new Error('Transit provider rejected the request. Check your API key.');
  if (!finite(payload.currentTime) || Math.abs(now-payload.currentTime)>MAX_TRANSIT_AGE) throw new FeedError('stale_data');
  const {entry,references={}}=payload.data;
  if (entry.stopId && entry.stopId!==stopId) throw new Error('Transit provider returned a different stop.');
  if (!Array.isArray(entry.arrivalsAndDepartures)) throw new Error('Transit response has no arrivals list.');
  const stop=references.stops?.find(s=>s.id===stopId);
  if (stopId==='1_29530' && stop?.direction && !['W','SW','NW'].includes(stop.direction)) throw new Error('Home stop direction differs from the configured westbound stop.');
  const arrivals=[];
  for (const a of entry.arrivalsAndDepartures) {
    const route=String(a.routeShortName || references.routes?.find(r=>r.id===a.routeId)?.shortName || '').trim();
    if (!routes.includes(route) || a.arrivalEnabled===false || /cancel/i.test(a.status||'') || /cancel/i.test(a.tripStatus?.status||'')) continue;
    const headsign=String(a.tripHeadsign||'');
    if (route==='62' && headsign && !/downtown/i.test(headsign)) continue;
    if (route==='44' && headsign && !/ballard/i.test(headsign)) continue;
    const updated=a.lastUpdateTime||a.tripStatus?.lastUpdateTime;
    const predictedTime=a.predictedArrivalTime||a.predictedDepartureTime;
    const predicted=!!a.predicted && finite(predictedTime) && predictedTime>0 && finite(updated) && now-updated<=MAX_TRANSIT_AGE && updated<=now+60_000;
    const arrivalTime=predicted?predictedTime:(a.scheduledArrivalTime||a.scheduledDepartureTime);
    if (!finite(arrivalTime) || arrivalTime<now-30_000 || arrivalTime>now+90*60_000) continue;
    const ts=a.tripStatus,loc=ts?.lastKnownLocation,locationTime=ts?.lastLocationUpdateTime;
    // Never use tripStatus.position: OBA may synthesize it from the timetable.
    const locationValid=ts?.activeTripId===a.tripId && finite(locationTime) && locationTime>0 && now-locationTime<=MAX_TRANSIT_AGE && locationTime<=now+60_000 && finite(loc?.lat) && finite(loc?.lon) && loc.lat>47 && loc.lat<48.5 && loc.lon>-123.5 && loc.lon<-121.5;
    arrivals.push({route,tripId:a.tripId,vehicleId:a.vehicleId||ts?.vehicleId||null,headsign,stopId,arrivalTime,predicted,updatedAt:predicted?updated:null,location:locationValid?{lat:loc.lat,lon:loc.lon,updatedAt:locationTime}:null});
  }
  arrivals.sort((a,b)=>a.arrivalTime-b.arrivalTime);
  const seen=new Set();
  return {arrivals:arrivals.filter(a=>{const k=a.tripId+'|'+a.stopId+'|'+a.arrivalTime;if(seen.has(k))return false;seen.add(k);return true;}),stop:stop?{id:stop.id,name:stop.name,direction:stop.direction}:null};
}

export function normalizeWeather(payload,places,now=Date.now()) {
  const list=Array.isArray(payload)?payload:[payload];
  if(list.length!==places.length) throw new Error('Weather provider returned incomplete locations.');
  const points=list.map((p,i)=>{
    const s=p.minutely_15,u=p.minutely_15_units;
    if(!s?.time?.length || !u || u.precipitation!=='mm' || u.temperature_2m!=='°F' || !['mp/h','mph'].includes(u.wind_gusts_10m)) throw new Error('Weather response has unexpected units or missing intervals.');
    const samples=s.time.map((time,j)=>({end:time*1000,rain:finite(s.precipitation?.[j])?s.precipitation[j]*4:null,temp:finite(s.temperature_2m?.[j])?s.temperature_2m[j]:null,gust:finite(s.wind_gusts_10m?.[j])?s.wind_gusts_10m[j]:null}));
    if(!samples.some(s=>s.end>=now && s.end<=now+900_000)) throw new FeedError('stale_data');
    return {...places[i],grid:{lat:p.latitude,lon:p.longitude},samples};
  });
  const grids=new Set(points.map(p=>p.grid.lat+','+p.grid.lon));
  return {points,sharedGrid:grids.size<points.length,intervalMinutes:15,source:'Open-Meteo / NOAA HRRR',fetchedAt:now};
}

export class CachedFeed {
  constructor(loader,ttl,{now=Date.now,retry=30_000}={}){this.loader=loader;this.ttl=ttl;this.now=now;this.retry=retry;this.value=null;this.fetchedAt=0;this.attemptedAt=-Infinity;this.failed=false;this.pending=null;this.error=null;}
  async get(){
    const now=this.now();
    if(this.pending)return this.pending;
    if((this.value&&!this.failed&&now-this.fetchedAt<this.ttl)||now-this.attemptedAt<this.retry)return this.snapshot();
    this.attemptedAt=now;
    this.pending=(async()=>{
      try{this.value=await this.loader();this.fetchedAt=this.now();this.failed=false;this.error=null;}
      catch(error){this.failed=true;this.error=safeFeedError(error);}
      finally{this.pending=null;}
      return this.snapshot();
    })();
    return this.pending;
  }
  snapshot(){return {status:this.failed?(this.value?'stale':'unavailable'):'ok',fetchedAt:this.fetchedAt||null,...(this.value||{}),error:this.error};}
}

export async function getJSON(url){
  let response;
  try{response=await fetch(url,{signal:AbortSignal.timeout(12_000),headers:{'User-Agent':'SeattleWindow/0.1 personal-display','Accept':'application/json'}});}
  catch(error){throw new FeedError(['TimeoutError','AbortError'].includes(error.name)?'timeout':'network_error');}
  if(!response.ok){
    const code=({401:'unauthorized',403:'access_denied',429:'rate_limited'})[response.status]||(response.status>=500?'provider_unavailable':'invalid_response');
    // Release the upstream body without reading or reporting provider error text.
    await response.body?.cancel().catch(()=>{});
    throw new FeedError(code);
  }
  try{return await response.json();}
  catch(error){throw new FeedError(['TimeoutError','AbortError'].includes(error.name)?'timeout':'invalid_response');}
}

export function createFeeds(config,places){
  const vehicles=new CachedFeed(async()=>normalizeVehicles(await getJSON(vehicleFeedURL)),30_000);
  const transit=new CachedFeed(async()=>{
    const read=async(stopId,routes)=>{
      const url=new URL('https://api.pugetsound.onebusaway.org/api/where/arrivals-and-departures-for-stop/'+encodeURIComponent(stopId)+'.json');
      url.search=new URLSearchParams({key:config.OBA_API_KEY,minutesBefore:'0',minutesAfter:'90'}).toString();
      return normalizeTransit(await getJSON(url),{stopId,routes});
    };
    const home=await read(config.HOME_STOP_ID,['62','44']);
    let extra={arrivals:[]},extraStatus='not_configured',extraError=null;
    if(config.FREMONT_STOP_ID){try{extra=await read(config.FREMONT_STOP_ID,['31','32']);extraStatus='ok';}catch(error){extraStatus='unavailable';extraError=safeFeedError(error);}}
    return {arrivals:[...home.arrivals,...extra.arrivals],stop:home.stop,extraStatus,extraError};
  },30_000);
  const weather=new CachedFeed(async()=>{
    const url=new URL('https://api.open-meteo.com/v1/forecast');
    url.search=new URLSearchParams({latitude:places.map(p=>p.lat).join(','),longitude:places.map(p=>p.lon).join(','),models:'gfs_hrrr',minutely_15:'temperature_2m,precipitation,wind_gusts_10m',temperature_unit:'fahrenheit',wind_speed_unit:'mph',timeformat:'unixtime',past_minutely_15:'1',forecast_minutely_15:'12'}).toString();
    return normalizeWeather(await getJSON(url),places);
  },600_000,{retry:60_000});
  return {
    transit:()=>config.OBA_API_KEY?transit.get():Promise.resolve({status:'unconfigured',arrivals:[],fetchedAt:null,extraStatus:'not_configured',message:'Add OBA_API_KEY to .env and restart.'}),
    vehicles:()=>vehicles.get(),
    weather:()=>weather.get()
  };
}

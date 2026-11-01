export const WEATHER_DEFAULTS={homeMinutes:9,sluMinutes:13,gustLimit:25,preference:'dry',arriveBy:'',departure:'auto',scenario:'showers'};
const weatherQueryKeys={homeMinutes:'wxHome',sluMinutes:'wxSlu',gustLimit:'wxGust',preference:'wxRain',arriveBy:'wxArrive',departure:'wxDepart',scenario:'wxScenario'};

export function normalizeWeatherOptions(raw={}){
  const out={...WEATHER_DEFAULTS};
  for(const [key,max] of [['homeMinutes',30],['sluMinutes',40],['gustLimit',50]]){
    const n=raw[key]===undefined?out[key]:Number(raw[key]);
    if(!Number.isInteger(n)||n<1||n>max)throw new RangeError('Invalid '+key);
    out[key]=n;
  }
  for(const [key,allowed] of [['preference',['dry','drizzle']],['scenario',['showers','clear','wind','stale']]]){
    if(raw[key]!==undefined){if(!allowed.includes(raw[key]))throw new RangeError('Invalid '+key);out[key]=raw[key];}
  }
  if(raw.arriveBy!==undefined){
    if(raw.arriveBy!==''&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.arriveBy))throw new RangeError('Invalid arrival time');
    out.arriveBy=raw.arriveBy;
  }
  if(raw.departure!==undefined&&raw.departure!=='auto'){
    const n=Number(raw.departure);
    if(raw.departure===''||!Number.isInteger(n)||n<0||n>45)throw new RangeError('Invalid departure');
    out.departure=n;
  }
  return out;
}

export function readWeatherOptions(params,defaults={}){
  const raw={...defaults};for(const [key,param] of Object.entries(weatherQueryKeys))if(params.has(param))raw[key]=params.get(param);
  return normalizeWeatherOptions(raw);
}

export function weatherQuery(options){
  const normalized=normalizeWeatherOptions(options);
  return new URLSearchParams(Object.entries(weatherQueryKeys).map(([key,param])=>[param,String(normalized[key])]));
}

// The optional deadline is for TODAY in Seattle. Do not silently roll a missed
// deadline into tomorrow, or treat a browser's local timezone as Seattle time.
export function arrivalOffset(arriveBy,baseTime,{demo=false}={}){
  if(!arriveBy)return null;
  const [h,m]=arriveBy.split(':').map(Number);
  const parts=demo?null:new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(baseTime);
  const now=demo?490:Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
  return h*60+m-now;
}

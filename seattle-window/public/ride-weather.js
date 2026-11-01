// These are comfort preferences, not safety thresholds or forecast confidence.
export const RIDE_OFFSETS = [0, 9, 22];
export const RIDE_MARGIN = 3;
export const GUST_LIMIT = 25;

export function rainClass(rain) {
  if (!Number.isFinite(rain)) return 'unknown';
  return rain >= .5 ? 'rain' : rain >= .1 ? 'drizzle' : 'dry';
}

// Check a small passage-time window so one favorable instant does not decide
// the ride. This accounts for assumed riding time, not model uncertainty.
export function assessRide(read, departure, {preference='dry', offsets=RIDE_OFFSETS, margin=RIDE_MARGIN, gustLimit=GUST_LIMIT}={}) {
  const limit=preference==='drizzle'?.5:.1;
  const values=offsets.map((offset,index)=>{
    const samples=[];
    for(let delta=-margin;delta<=margin;delta++) samples.push(read(index,Math.max(0,departure+offset+delta)));
    const at=read(index,departure+offset);
    const complete=samples.every(w=>[w.rain,w.temp,w.gust].every(Number.isFinite));
    const max=key=>samples.every(w=>Number.isFinite(w[key]))?Math.max(...samples.map(w=>w[key])):null;
    return {rain:max('rain'),gust:max('gust'),temp:at.temp,complete};
  });
  const wetAt=values.findIndex(w=>Number.isFinite(w.rain)&&w.rain>=limit);
  const windAt=values.findIndex(w=>Number.isFinite(w.gust)&&w.gust>gustLimit);
  const unknown=values.some(w=>!w.complete);
  return {state:unknown?'unknown':wetAt>=0||windAt>=0?'bus':'bike',values,wetAt,windAt,
    maxRain:unknown?null:Math.max(...values.map(w=>w.rain))};
}

export function planRide(read,{earliest=0,latest=45,preference='dry',offsets=RIDE_OFFSETS,margin=RIDE_MARGIN,gustLimit=GUST_LIMIT,arriveByMinutes=null}={}) {
  const options={preference,offsets,margin,gustLimit},first=assessRide(read,earliest,options);
  const result={departure:earliest,assessment:first,initial:first,window:null,deadlineBlocked:false,brief:false};
  if(first.state==='unknown')return result;
  // The model values stay discrete. Minute sampling checks departure flexibility,
  // not minute-resolution weather. Label the resulting window approximate.
  const runs=[];let start=null;
  for(let t=earliest;t<=latest+1;t++){
    const good=t<=latest&&assessRide(read,t,options).state==='bike';
    if(good&&start===null)start=t;
    if(!good&&start!==null){runs.push({start,end:t-1});start=null;}
  }
  const latestForArrival=arriveByMinutes===null?latest:Math.floor(arriveByMinutes-offsets.at(-1)-margin);
  const candidate=runs.find(run=>run.end-run.start>=5&&Math.ceil(run.start/5)*5<=Math.min(run.end,latestForArrival));
  if(candidate){
    const departure=Math.ceil(candidate.start/5)*5;
    const end=Math.max(departure,Math.floor(Math.min(candidate.end,latestForArrival)/5)*5);
    return {...result,departure,assessment:assessRide(read,departure,options),window:{start:departure,end},limitedByArrival:latestForArrival<candidate.end};
  }
  result.deadlineBlocked=arriveByMinutes!==null&&(latestForArrival<earliest||runs.some(run=>run.end-run.start>=5&&run.start>latestForArrival));
  result.brief=first.state==='bike'&&!result.deadlineBlocked;
  return result;
}

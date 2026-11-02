// Experimental, trip-specific GPS estimates. No I/O: the feed owner supplies
// observations and persists only bounded profiles and completed evaluations.
const MODEL_VERSION=1;
const MAX_AGE=90_000,MAX_TRACK_GAP=90_000,MAX_SPEED=25;
const MAX_PROFILES=600,MAX_PROFILE_SAMPLES=32,MAX_OUTCOMES=600;
const HISTORY_AGE=28*86400_000;
const finite=Number.isFinite;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const median=values=>quantile(values,.5);
function quantile(values,q){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),p=(sorted.length-1)*q,i=Math.floor(p);
  return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(p-i);
}
const rawStop=id=>String(id||'').replace(/^1_/,'');
const rawTrip=id=>String(id||'').replace(/^1_/,'');
function dateParts(at){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return {date:values.year+values.month+values.day,hour:Number(values.hour)};
}
function dateNumber(value){
  value=String(value||'');
  if(!/^\d{8}$/.test(String(value)))return null;
  const y=+value.slice(0,4),m=+value.slice(4,6),d=+value.slice(6,8),at=Date.UTC(y,m-1,d);
  return new Date(at).toISOString().slice(0,10).replaceAll('-','')===value?at:null;
}
function activeService(index,trip,date){
  const stamp=dateNumber(date);
  if(stamp===null)return false;
  const exception=index.exceptions?.[trip.serviceId]?.[date];
  if(exception===1)return true;
  if(exception===2)return false;
  const service=index.calendar?.[trip.serviceId];
  return !!service&&date>=service.startDate&&date<=service.endDate&&!!service.weekdays?.[(new Date(stamp).getUTCDay()+6)%7];
}
function scheduleAt(trip,s,status,sequence){
  const stops=trip.stops;
  const current=stops.find(stop=>stop.sequence===sequence);
  if(status==='STOPPED_AT'&&current&&Math.abs(s-current.distance)<=35)return current.arrival;
  if(s<=stops[0].distance)return stops[0].arrival;
  for(let i=1;i<stops.length;i++)if(s<=stops[i].distance){
    const a=stops[i-1],b=stops[i],f=clamp((s-a.distance)/(b.distance-a.distance||1),0,1);
    return a.departure+(b.arrival-a.departure)*f;
  }
  return stops.at(-1).arrival;
}
function statusName(value){
  return ({0:'INCOMING_AT',1:'STOPPED_AT',2:'IN_TRANSIT_TO'})[value]||value;
}
function horizon(seconds){return seconds<=120?'0–2 min':seconds<=300?'2–5 min':seconds<=600?'5–10 min':'10+ min';}
function profileKey(trip,from,to,at){
  const parts=dateParts(at),weekday=new Date(dateNumber(parts.date)).getUTCDay();
  return [trip.shapeId,from.id,to.id,from.sequence,to.sequence,weekday===0||weekday===6?'weekend':'weekday',Math.floor(parts.hour/3)].join('|');
}

// Map matching is constrained by the provider's exact next/current stop
// sequence. Similar nearby points on a loop must not be silently interchanged.
function match(shape,location,from,to){
  const rad=Math.PI/180,xScale=6371008.8*Math.cos(location.lat*rad)*rad,yScale=6371008.8*rad;
  const candidates=[];
  for(let i=1;i<shape.length;i++){
    const a=shape[i-1],b=shape[i];
    if(b[2]<from||a[2]>to||b[2]<=a[2])continue;
    const ax=(a[0]-location.lon)*xScale,ay=(a[1]-location.lat)*yScale;
    const bx=(b[0]-location.lon)*xScale,by=(b[1]-location.lat)*yScale;
    const dx=bx-ax,dy=by-ay,den=dx*dx+dy*dy;
    if(den===0)continue;
    const f=clamp(-(ax*dx+ay*dy)/den,0,1),s=a[2]+(b[2]-a[2])*f;
    if(s<from||s>to)continue;
    candidates.push({s,offset:Math.hypot(ax+f*dx,ay+f*dy)});
  }
  candidates.sort((a,b)=>a.offset-b.offset);
  const best=candidates[0];
  if(!best||best.offset>55)return {reason:'off_route'};
  if(candidates.some(c=>c.offset<=best.offset+12&&Math.abs(c.s-best.s)>120))return {reason:'ambiguous_position'};
  return best;
}

function summary(outcomes){
  const errors=outcomes.map(o=>Math.abs(o.errorSeconds));
  const baselines=name=>{
    const values=outcomes.map(o=>o[name]).filter(finite);
    return {samples:values.length,medianAbsoluteErrorSeconds:median(values.map(Math.abs)),p90AbsoluteErrorSeconds:quantile(values.map(Math.abs),.9)};
  };
  return {
    samples:outcomes.length,
    medianAbsoluteErrorSeconds:median(errors),
    p90AbsoluteErrorSeconds:quantile(errors,.9),
    meanSignedErrorSeconds:outcomes.length?outcomes.reduce((sum,o)=>sum+o.errorSeconds,0)/outcomes.length:null,
    bracketContainedFraction:outcomes.length?outcomes.filter(o=>o.bracketContained).length/outcomes.length:null,
    medianCrossingBracketSeconds:median(outcomes.map(o=>o.bracketSeconds)),
    scheduleBaseline:baselines('scheduleErrorSeconds'),
    speedBaseline:baselines('speedErrorSeconds')
  };
}

export class GpsEstimator {
  constructor({index,stopId='1_29530',now=Date.now,state=null}={}){
    this.index=index;this.stopId=rawStop(stopId);this.now=now;
    this.tracks=new Map();this.prepared=new Map();this.profiles=new Map();this.outcomes=[];
    this.indexValid=index?.schemaVersion===1&&typeof index.source?.sha256==='string'&&!!index.stops?.[this.stopId]&&!!index.trips&&!!index.shapes;
    this.hasOvernight=this.indexValid&&Object.values(index.trips).some(trip=>trip.stops?.at(-1)?.arrival>=86400);
    if(this.indexValid&&state?.modelVersion===MODEL_VERSION&&state.indexHash===index.source.sha256&&state.stopId===this.stopId){
      const cutoff=now()-HISTORY_AGE;
      for(const [key,samples] of Object.entries(state.profiles||{}).slice(-MAX_PROFILES)){
        if(!Array.isArray(samples))continue;
        const valid=samples.filter(s=>finite(s?.ratio)&&s.ratio>=.2&&s.ratio<=5&&finite(s.at)&&s.at>=cutoff&&s.at<=now()).slice(-MAX_PROFILE_SAMPLES);
        if(valid.length)this.profiles.set(key,valid);
      }
      if(Array.isArray(state.outcomes))this.outcomes=state.outcomes.filter(o=>typeof o?.key==='string'&&typeof o.route==='string'&&typeof o.horizon==='string'&&finite(o.at)&&o.at>=cutoff&&o.at<=now()&&finite(o.errorSeconds)&&finite(o.bracketSeconds)&&o.bracketSeconds>=0&&o.bracketSeconds<=60&&typeof o.bracketContained==='boolean').slice(-MAX_OUTCOMES);
    }
  }

  prepare(id){
    if(this.prepared.has(id))return this.prepared.get(id);
    const t=this.index.trips[id],shape=this.index.shapes[t?.shapeId];
    let result=null;
    if(t&&Array.isArray(shape)&&shape.length>=2&&Array.isArray(t.stops)&&t.stops.length>=2){
      const validShape=shape.every((p,i)=>Array.isArray(p)&&p.length>=3&&p.every(finite)&&p[0]>=-180&&p[0]<=180&&p[1]>=-90&&p[1]<=90&&p[2]>=0&&(!i||p[2]>=shape[i-1][2]));
      const validStops=t.stops.every((s,i)=>typeof s.id==='string'&&Number.isInteger(s.sequence)&&finite(s.distance)&&s.distance>=0&&s.distance<=shape.at(-1)[2]+50&&finite(s.arrival)&&finite(s.departure)&&s.departure>=s.arrival&&(!i||s.sequence>t.stops[i-1].sequence&&s.distance>=t.stops[i-1].distance&&s.arrival>=t.stops[i-1].departure));
      // Repeated target visits require an explicit visit selection; abstain.
      const targets=t.stops.filter(s=>s.id===this.stopId&&s.pickupAllowed===true);
      if(validShape&&validStops&&targets.length===1)result={...t,shape,target:targets[0]};
    }
    this.prepared.set(id,result);return result;
  }

  metrics(){
    const result={evaluation:'GPS stop-crossing brackets, not door-opening times',experimental:true,...summary(this.outcomes),byHorizon:{},byRoute:{},learnedSegments:this.profiles.size};
    for(const name of ['0–2 min','2–5 min','5–10 min','10+ min'])result.byHorizon[name]=summary(this.outcomes.filter(o=>o.horizon===name));
    for(const route of ['62','44']){
      const outcomes=this.outcomes.filter(o=>o.route===route);
      result.byRoute[route]={...summary(outcomes),byHorizon:{}};
      for(const name of ['0–2 min','2–5 min','5–10 min','10+ min'])result.byRoute[route].byHorizon[name]=summary(outcomes.filter(o=>o.horizon===name));
    }
    return result;
  }

  prune(now){
    for(const [key,track] of this.tracks)if(now-track.lastAt>10*60000)this.tracks.delete(key);
    while(this.tracks.size>256)this.tracks.delete(this.tracks.keys().next().value);
    for(const [key,items] of this.profiles){
      const fresh=items.filter(item=>now-item.at<=HISTORY_AGE);
      if(fresh.length)this.profiles.set(key,fresh);else this.profiles.delete(key);
    }
    while(this.profiles.size>MAX_PROFILES)this.profiles.delete(this.profiles.keys().next().value);
    this.outcomes=this.outcomes.filter(item=>now-item.at<=HISTORY_AGE).slice(-MAX_OUTCOMES);
  }

  observe(snapshot){
    const now=this.now();this.prune(now);
    const base={source:'gps_estimate',arrivals:[],fetchedAt:snapshot?.fetchedAt||null,extraStatus:'not_configured'};
    const report=(status,message,extra={})=>({status,message,experimental:true,metrics:this.metrics(),...extra});
    if(!this.indexValid)return {...base,status:'unavailable',estimator:report('unavailable','Import valid Metro GTFS data for this boarding stop before estimating arrivals.')};
    const today=dateParts(now).date,day=dateNumber(today),end=dateNumber(this.index.source.feedEndDate),start=dateNumber(this.index.source.feedStartDate);
    if(end!==null&&day>end+(this.hasOvernight?86400_000:0))return {...base,status:'unavailable',estimator:report('expired_gtfs','The Metro schedule has expired. Refresh GTFS data before estimating arrivals.')};
    if(start!==null&&day<start)return {...base,status:'unavailable',estimator:report('inactive_gtfs','The imported Metro schedule has not started yet.')};
    if(snapshot?.status!=='ok'||!finite(snapshot.fetchedAt)||now-snapshot.fetchedAt>MAX_AGE||snapshot.fetchedAt>now+10_000||!Array.isArray(snapshot.vehicles))return {...base,status:'unavailable',estimator:report('waiting_for_gps','Waiting for fresh Metro GPS observations.')};
    const excluded={},arrivals=[];
    for(const vehicle of snapshot.vehicles){
      const result=this.observeVehicle(vehicle,now,today);
      if(result.arrival)arrivals.push(result.arrival);
      else excluded[result.reason]=(excluded[result.reason]||0)+1;
    }
    arrivals.sort((a,b)=>a.arrivalTime-b.arrivalTime);
    const status=arrivals.length?'ready':excluded.warming_up?'warming_up':'no_qualified_arrivals';
    const message=arrivals.length?'Experimental GPS estimates use matched trips, observed movement and scheduled stop timing. Ranges are not guaranteed.':excluded.warming_up?'Learning this bus’s movement. Estimates need at least three distinct GPS observations over 40 seconds.':'No bus currently has enough reliable evidence for an arrival estimate.';
    return {...base,status:'ok',arrivals,stop:this.index.stops[this.stopId],estimator:report(status,message,{excluded,observedVehicles:snapshot.vehicles.length})};
  }

  observeVehicle(v,now,today){
    const fail=reason=>({reason});
    const id=String(v.rawTripId||rawTrip(v.tripId)),trip=this.prepare(id),loc=v.location,at=loc?.updatedAt;
    if(!trip)return fail('unknown_or_unserved_trip');
    const serviceDate=String(v.serviceDate||'');
    const date=dateNumber(serviceDate),day=dateNumber(today);
    const start=dateNumber(this.index.source.feedStartDate),end=dateNumber(this.index.source.feedEndDate);
    if(date===null||date>day||day-date>86400_000||(start!==null&&date<start)||(end!==null&&date>end)||(date<day&&trip.stops.at(-1).arrival<86400)||!activeService(this.index,trip,serviceDate))return fail('inactive_service');
    if(String(v.routeId)!==String(trip.routeId)||Number(v.directionId)!==Number(trip.directionId)||String(v.route)!==String(trip.route))return fail('trip_mismatch');
    if(['CANCELED','DELETED',3,7].includes(v.scheduleRelationship))return fail('canceled');
    if(!finite(at)||at<=0||at>now+5_000||now-at>=MAX_AGE||!finite(loc?.lat)||!finite(loc?.lon))return fail('stale_observation');
    const sequence=v.stopSequence,status=statusName(v.currentStatus),stopIndex=trip.stops.findIndex(stop=>stop.sequence===sequence);
    if(!Number.isInteger(sequence)||stopIndex<0||!['INCOMING_AT','STOPPED_AT','IN_TRANSIT_TO'].includes(status))return fail('missing_stop_sequence');
    const currentStop=trip.stops[stopIndex];
    if(v.stopId&&rawStop(v.stopId)!==currentStop.id)return fail('stop_mismatch');
    const key=[serviceDate,id,v.startTime||'',v.vehicleId].join('|');
    // A vehicle changing trips cannot borrow the old trip's movement history.
    for(const [otherKey,other] of this.tracks)if(other.vehicleId===v.vehicleId&&otherKey!==key)this.tracks.delete(otherKey);
    let track=this.tracks.get(key);
    const matched=match(trip.shape,loc,(trip.stops[Math.max(0,stopIndex-1)].distance)-60,currentStop.distance+60);
    if(matched.reason){this.tracks.delete(key);return fail(matched.reason);}
    const point={at,s:matched.s,lat:loc.lat,lon:loc.lon,sequence,status,scheduled:scheduleAt(trip,matched.s,status,sequence)};
    if(track&&at<track.lastAt)return fail('out_of_order');
    if(track&&at===track.lastAt){
      const prior=track.points.at(-1);
      if(point.lat!==prior.lat||point.lon!==prior.lon||point.sequence!==prior.sequence||point.status!==prior.status){
        this.tracks.delete(key);return fail('conflicting_observation');
      }
      if(track.prediction&&track.prediction.validUntil>now&&track.prediction.latestArrivalTime>now)return {arrival:track.prediction};
      return fail(track.reason||'warming_up');
    }
    let previous=track?.points.at(-1);
    if(previous){
      const dt=(at-previous.at)/1000,delta=point.s-previous.s;
      if(point.sequence<previous.sequence||delta< -45||delta>MAX_SPEED*dt+50){this.tracks.delete(key);return fail('implausible_movement');}
      if(at-previous.at>MAX_TRACK_GAP){this.tracks.delete(key);track=null;previous=null;}
      // Small GPS backtracking is noise, not reverse travel.
      else {point.s=Math.max(point.s,previous.s);point.scheduled=Math.max(previous.scheduled,scheduleAt(trip,point.s,status,sequence));}
    }
    if(!track){
      track={vehicleId:v.vehicleId,points:[],lastAt:at,prediction:null,pending:new Map(),crossings:new Map(),completed:false,reason:'warming_up'};
      this.tracks.set(key,track);
    }
    track.lastAt=at;
    this.recordCrossings(track,trip,previous,point,key,now);
    track.points.push(point);track.points=track.points.filter(p=>at-p.at<=300_000).slice(-12);
    track.prediction=null;
    if(track.completed||sequence>trip.target.sequence||point.s>=trip.target.distance-10||status==='STOPPED_AT'&&sequence===trip.target.sequence){track.reason='already_arrived';return fail(track.reason);}
    if(track.points.length<3||at-track.points[0].at<40_000){track.reason='warming_up';return fail(track.reason);}
    const recent=track.points.filter(p=>at-p.at<=90_000);
    if(recent.length>=3&&at-recent[0].at>=60_000&&point.s-recent[0].s<20){track.reason='held_or_stationary';return fail(track.reason);}
    // Rolling windows all end at the current observation. Their elapsed time
    // includes red lights, dwell and stop-and-go pauses; excluding stationary
    // sample pairs would systematically overestimate a bus's effective speed.
    const rates=track.points.filter(p=>at-p.at>=40_000&&at-p.at<=180_000).map(p=>Math.max(0,point.scheduled-p.scheduled)/((at-p.at)/1000));
    const first=track.points[0];
    if(!rates.length||point.s-first.s<40||median(rates)<=0){track.reason='insufficient_motion';return fail(track.reason);}
    const rate=median(rates),recentFactor=clamp(1/rate,.4,3),scheduleRemaining=trip.target.arrival-point.scheduled;
    if(!finite(scheduleRemaining)||scheduleRemaining<=0){track.reason='invalid_schedule_progress';return fail(track.reason);}
    let remaining=0,priorSchedule=point.scheduled,priorDistance=point.s;
    for(let i=1;i<trip.stops.length;i++){
      const to=trip.stops[i],from=trip.stops[i-1];
      if(to.distance<=point.s||to.sequence>trip.target.sequence)continue;
      const scheduled=Math.max(0,to.arrival-priorSchedule),samples=this.profiles.get(profileKey(trip,from,to,at))||[];
      const learned=samples.length>=5?median(samples.map(sample=>sample.ratio)):1;
      const weight=.65*Math.exp(-Math.max(0,priorDistance-point.s)/1000);
      remaining+=scheduled*clamp(learned*(1-weight)+recentFactor*weight,.35,4);
      priorSchedule=to.arrival;priorDistance=to.distance;
    }
    const distance=trip.target.distance-point.s;
    remaining=Math.max(remaining,distance/MAX_SPEED);
    if(!finite(remaining)||remaining<=0||remaining>45*60){track.reason='outside_prediction_horizon';return fail(track.reason);}
    const arrivalTime=at+remaining*1000;
    const bucket=horizon((arrivalTime-now)/1000),errors=this.outcomes.filter(o=>o.route===String(trip.route)&&o.horizon===bucket).map(o=>Math.abs(o.errorSeconds));
    const disagreement=median(rates.map(r=>Math.abs(r-rate)))/(rate||1);
    // This is an experimental engineering range, not a calibrated confidence
    // interval. Existing observed errors can widen it but cannot erase its floor.
    const uncertainty=Math.max(60,remaining*.4,errors.length>=20?quantile(errors,.9):0)+Math.min(120,remaining*disagreement*.3)+matched.offset/2;
    const earliestArrivalTime=at+Math.max(distance/MAX_SPEED,remaining-uncertainty)*1000;
    const latestArrivalTime=at+(remaining+uncertainty)*1000;
    if(arrivalTime<=now||latestArrivalTime<=now){track.reason='observation_too_old_for_eta';return fail(track.reason);}
    const arrival={source:'gps_estimate',predicted:false,confidence:'experimental',route:String(trip.route),tripId:v.tripId||'1_'+id,rawTripId:id,routeId:trip.routeId,directionId:trip.directionId,serviceDate,vehicleId:v.vehicleId,headsign:trip.headsign,stopId:'1_'+this.stopId,arrivalTime,earliestArrivalTime,latestArrivalTime,updatedAt:at,validUntil:at+MAX_AGE,location:{...loc},method:'gtfs-progress-with-observed-pace',observationCount:track.points.length};
    const speed=(point.s-first.s)/((at-first.at)/1000);
    // One immutable forecast per trip/horizon prevents repeated polling from
    // dominating evaluation. These are scored only on a later observed crossing.
    if(!track.pending.has(bucket))track.pending.set(bucket,{bucket,issuedAt:now,observedAt:at,arrivalTime,earliestArrivalTime,latestArrivalTime,scheduleArrivalTime:at+scheduleRemaining*1000,speedArrivalTime:speed>0?at+distance/speed*1000:null});
    track.prediction=arrival;track.reason=null;
    return {arrival};
  }

  recordCrossings(track,trip,previous,current,key,now){
    const gap=previous?current.at-previous.at:null;
    for(let i=0;i<trip.stops.length;i++){
      const stop=trip.stops[i];
      const stopped=current.status==='STOPPED_AT'&&current.sequence===stop.sequence&&Math.abs(current.s-stop.distance)<=35;
      if((current.s<stop.distance&&!stopped)||track.crossings.has(stop.sequence))continue;
      const previouslyStopped=previous?.status==='STOPPED_AT'&&previous.sequence===stop.sequence&&Math.abs(previous.s-stop.distance)<=35;
      const scoreable=previous&&gap>0&&gap<=60_000&&previous.s<stop.distance&&current.s>=previous.s&&!previouslyStopped;
      if(!scoreable){
        // Arrival/passage is already known, but its timing cannot be bounded
        // tightly. A later dwell sample must not fabricate a new arrival time.
        track.crossings.set(stop.sequence,null);
        if(stop.sequence===trip.target.sequence){track.completed=true;track.pending.clear();}
        continue;
      }
      const f=stopped?1:clamp((stop.distance-previous.s)/(current.s-previous.s||1),0,1);
      const observed={at:previous.at+gap*f,low:previous.at,high:current.at};
      track.crossings.set(stop.sequence,observed);
      const from=trip.stops[i-1],prior=from&&track.crossings.get(from.sequence);
      // Do not invent link-specific training times by splitting one GPS jump
      // across several stops. Both crossing brackets must be non-overlapping.
      if(prior&&prior.high<=observed.low&&stop.arrival>from.arrival){
        const ratio=(observed.at-prior.at)/1000/(stop.arrival-from.arrival);
        if(ratio>=.2&&ratio<=5){
          const profile=profileKey(trip,from,stop,prior.at),samples=this.profiles.get(profile)||[];
          samples.push({ratio,at:current.at});
          // Refresh insertion order to bound least recently observed profiles.
          this.profiles.delete(profile);this.profiles.set(profile,samples.slice(-MAX_PROFILE_SAMPLES));
        }
      }
      if(stop.sequence!==trip.target.sequence)continue;
      track.completed=true;
      const midpoint=(observed.low+observed.high)/2;
      for(const forecast of track.pending.values()){
        const outcomeKey=key+'|'+forecast.bucket;
        if(forecast.issuedAt>previous.at||forecast.observedAt>=current.at||this.outcomes.some(outcome=>outcome.key===outcomeKey))continue;
        this.outcomes.push({key:outcomeKey,route:String(trip.route),horizon:forecast.bucket,at:current.at,errorSeconds:(forecast.arrivalTime-midpoint)/1000,scheduleErrorSeconds:(forecast.scheduleArrivalTime-midpoint)/1000,speedErrorSeconds:finite(forecast.speedArrivalTime)?(forecast.speedArrivalTime-midpoint)/1000:null,bracketSeconds:gap/1000,bracketContained:forecast.earliestArrivalTime<=observed.low&&forecast.latestArrivalTime>=observed.high});
      }
      track.pending.clear();
    }
    this.prune(now);
  }

  exportState(){
    this.prune(this.now());
    return {modelVersion:MODEL_VERSION,indexHash:this.index?.source?.sha256||null,stopId:this.stopId,profiles:Object.fromEntries(this.profiles),outcomes:this.outcomes};
  }
}

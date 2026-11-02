import test from 'node:test';
import assert from 'node:assert/strict';
import {GpsEstimator} from '../src/eta-estimator.mjs';

const START=Date.parse('2026-11-02T16:00:00Z');
const LAT=47.66,LON=-122.34,METER_LON=1/(6371008.8*Math.cos(LAT*Math.PI/180)*Math.PI/180);
const coordinate=s=>[LON+s*METER_LON,LAT,s];
function fixture(){
  const stops=[0,200,400,600,800,1000].map((distance,i)=>({id:i===4?'29530':String(i+1),sequence:i+1,arrival:28800+i*60,departure:28805+i*60,distance,pickupAllowed:true}));
  return {
    schemaVersion:1,source:{sha256:'fixture-v1',feedStartDate:'20261101',feedEndDate:'20261231'},
    stops:{29530:{id:'29530',name:'Home stop',lat:LAT,lon:coordinate(800)[0]}},
    shapes:{shape:Array.from({length:21},(_,i)=>coordinate(i*50))},
    trips:{trip:{routeId:'100252',route:'62',directionId:1,serviceId:'daily',shapeId:'shape',headsign:'Downtown',stops}},
    calendar:{daily:{startDate:'20261101',endDate:'20261231',weekdays:[1,1,1,1,1,1,1]}},exceptions:{}
  };
}
function harness(index=fixture(),state=null){
  let time=START;
  const estimator=new GpsEstimator({index,now:()=>time,state});
  const vehicle=(s,seconds,overrides={})=>({route:'62',tripId:'1_trip',rawTripId:'trip',vehicleId:'1_8012',routeId:'100252',directionId:1,serviceDate:'20261102',startTime:'08:00:00',stopSequence:Math.max(2,Math.ceil(s/200)+1),currentStatus:'IN_TRANSIT_TO',location:{lat:LAT,lon:coordinate(s)[0],updatedAt:START+seconds*1000},...overrides});
  const observe=(s,seconds,overrides={},latency=0)=>{
    time=START+(seconds+latency)*1000;
    return estimator.observe({status:'ok',fetchedAt:time,vehicles:[vehicle(s,seconds,overrides)]});
  };
  return {estimator,vehicle,observe,setTime:value=>{time=value;},now:()=>time};
}
function warm(h,latency=0){h.observe(100,0,{},latency);h.observe(200,30,{},latency);return h.observe(300,60,{},latency);}

test('exact trip progress warms up from distinct observations and yields a bounded experimental estimate',()=>{
  const h=harness();
  assert.equal(h.observe(100,0).estimator.status,'warming_up');
  assert.equal(h.observe(200,30).arrivals.length,0);
  const result=h.observe(300,60),a=result.arrivals[0];
  assert.equal(result.status,'ok');assert.equal(result.estimator.status,'ready');
  assert.equal(a.route,'62');assert.equal(a.serviceDate,'20261102');assert.equal(a.source,'gps_estimate');
  assert.equal(a.predicted,false);assert.equal(a.confidence,'experimental');
  assert(a.earliestArrivalTime>=a.updatedAt);assert(a.earliestArrivalTime<=a.arrivalTime);assert(a.arrivalTime<=a.latestArrivalTime);
  assert.equal(a.validUntil,a.updatedAt+90000);assert.equal(a.observationCount,3);
  assert.equal(result.estimator.metrics.samples,0);
  assert.match(result.estimator.metrics.evaluation,/not door-opening/);
});

test('delayed telemetry does not push ETA later or refresh its validity',()=>{
  const timely=harness(),delayed=harness();
  const a=warm(timely).arrivals[0],b=warm(delayed,20).arrivals[0];
  assert.equal(a.arrivalTime,b.arrivalTime);assert.equal(a.validUntil,b.validUntil);
  delayed.setTime(b.updatedAt+89999);
  let out=delayed.estimator.observe({status:'ok',fetchedAt:delayed.now(),vehicles:[delayed.vehicle(300,60)]});
  assert.equal(out.arrivals[0].observationCount,3);assert.equal(out.arrivals[0].arrivalTime,b.arrivalTime);
  delayed.setTime(b.updatedAt+90001);
  out=delayed.estimator.observe({status:'ok',fetchedAt:delayed.now(),vehicles:[delayed.vehicle(300,60)]});
  assert.equal(out.arrivals.length,0);assert.equal(out.estimator.excluded.stale_observation,1);
});

test('repeated and out-of-order positions cannot manufacture warmup evidence',()=>{
  const h=harness();h.observe(100,0);
  for(let i=1;i<=5;i++)assert.equal(h.observe(100,0,{},i*10).arrivals.length,0);
  h.observe(200,30);assert.equal(h.observe(150,15).estimator.excluded.out_of_order,1);
  assert.equal(h.observe(300,60).arrivals[0].observationCount,3);
});

test('conflicting position, status or stop sequence at the same timestamp invalidates a cached prediction',()=>{
  for(const [position,overrides] of [
    [800,{stopSequence:5,currentStatus:'STOPPED_AT'}],
    [310,{}],
    [300,{currentStatus:'INCOMING_AT'}],
    [395,{stopSequence:4}]
  ]){
    const h=harness();warm(h);
    const out=h.observe(position,60,overrides);
    assert.equal(out.arrivals.length,0);assert.equal(out.estimator.excluded.conflicting_observation,1);
    assert.equal(h.observe(350,75).arrivals.length,0,'A corrected later observation must rebuild movement history');
  }
});

test('rejects inactive, wrong-direction, unserved and missing-sequence trips',()=>{
  for(const overrides of [{directionId:0},{routeId:'other'},{serviceDate:'20261103'},{serviceDate:'20261031'},{serviceDate:'20260230'},{serviceDate:''},{stopSequence:null},{currentStatus:'unknown'},{scheduleRelationship:'CANCELED'},{stopId:'wrong-stop'}]){
    const h=harness();warm(h);
    assert.equal(h.observe(350,75,overrides).arrivals.length,0,JSON.stringify(overrides));
  }
  const index=fixture();index.trips.trip.stops[4].pickupAllowed=false;
  assert.equal(warm(harness(index)).arrivals.length,0);
  index.trips.trip.stops[4].pickupAllowed=true;index.exceptions.daily={'20261102':2};
  assert.equal(warm(harness(index)).arrivals.length,0);
  index.exceptions.daily={'20261102':1};index.calendar.daily.weekdays=[0,0,0,0,0,0,0];
  assert.equal(warm(harness(index)).arrivals.length,1,'Explicit added service overrides the weekly calendar');
});

test('trip or service identity changes require their own movement history',()=>{
  const index=fixture();index.trips.another={...index.trips.trip};
  const h=harness(index);warm(h);
  const result=h.observe(350,75,{rawTripId:'another',tripId:'1_another'});
  assert.equal(result.arrivals.length,0);assert.equal(result.estimator.excluded.warming_up,1);
});

test('GPS detours, backtracking, impossible jumps and long gaps reset movement evidence',()=>{
  for(const [position,seconds,overrides,reason] of [
    [350,75,{location:{lat:LAT+.01,lon:coordinate(350)[0],updatedAt:START+75000}},'off_route'],
    [100,75,{},'implausible_movement'],
    [900,65,{},'implausible_movement'],
    [350,151,{},'warming_up']
  ]){
    const h=harness();warm(h);
    const result=h.observe(position,seconds,overrides);
    assert.equal(result.arrivals.length,0);assert.equal(result.estimator.excluded[reason],1);
  }
});

test('stationary or held buses do not produce an arrival countdown',()=>{
  const h=harness();warm(h);
  h.observe(300,90);h.observe(300,120);
  const result=h.observe(300,150);
  assert.equal(result.arrivals.length,0);assert.equal(result.estimator.excluded.held_or_stationary,1);
  const stopped=harness();stopped.observe(200,0,{currentStatus:'STOPPED_AT',stopSequence:2});stopped.observe(201,30,{currentStatus:'STOPPED_AT',stopSequence:2});
  assert.equal(stopped.observe(200,60,{currentStatus:'STOPPED_AT',stopSequence:2}).arrivals.length,0);
});

test('stop-and-go pauses are included in pace instead of treating only moving samples as travel',()=>{
  const steady=harness(),paused=harness();
  warm(steady);warm(paused);
  const steadyArrival=steady.observe(400,90).arrivals[0];
  paused.observe(300,90);
  const pausedArrival=paused.observe(400,120).arrivals[0];
  assert(pausedArrival&&steadyArrival);
  const steadyRemaining=steadyArrival.arrivalTime-steadyArrival.updatedAt;
  const pausedRemaining=pausedArrival.arrivalTime-pausedArrival.updatedAt;
  assert(pausedRemaining>steadyRemaining+10000,'The 30-second pause slows the effective pace at the same route position');
});

test('range ordering survives unrealistically short schedules and every output respects the physical floor',()=>{
  const index=fixture();
  for(const [i,stop] of index.trips.trip.stops.entries()){stop.arrival=28800+i;stop.departure=stop.arrival;}
  const h=harness(index),a=warm(h).arrivals[0];
  assert(a);
  assert(a.arrivalTime>=a.earliestArrivalTime);assert(a.arrivalTime<=a.latestArrivalTime);
  assert(a.arrivalTime-a.updatedAt>=500/25*1000-1);
  for(const stamp of [0,-1,NaN,Infinity]){
    const result=h.observe(350,75,{location:{lat:LAT,lon:coordinate(350)[0],updatedAt:stamp}});
    assert.equal(result.arrivals.length,0);
  }
});

test('a loop with equally plausible shape positions is rejected even inside the same stop interval',()=>{
  const index=fixture();
  index.shapes.shape=[[LON,LAT,0],[coordinate(200)[0],LAT,200],[LON,LAT,400],[coordinate(200)[0],LAT,600],[coordinate(800)[0],LAT,1200]];
  index.trips.trip.stops=[{id:'start',sequence:1,arrival:28800,departure:28800,distance:0,pickupAllowed:true},{id:'29530',sequence:2,arrival:29160,departure:29160,distance:1200,pickupAllowed:true}];
  const h=harness(index),out=h.observe(100,0,{stopSequence:2});
  assert.equal(out.arrivals.length,0);assert.equal(out.estimator.excluded.ambiguous_position,1);
});

test('a passed target or observed stop arrival cannot be presented as an upcoming bus',()=>{
  const h=harness();warm(h);h.observe(600,120);
  assert.equal(h.observe(810,180).arrivals.length,0);
  assert.equal(h.observe(850,195).arrivals.length,0);
  const stopped=harness();warm(stopped);stopped.observe(600,120);
  assert.equal(stopped.observe(785,180,{stopSequence:5,currentStatus:'STOPPED_AT'}).arrivals.length,0);
});

test('fresh feed failures, malformed/expired schedules and future observations withhold estimates',()=>{
  const h=harness();warm(h);
  assert.equal(h.estimator.observe({status:'stale',fetchedAt:h.now(),vehicles:[h.vehicle(300,60)]}).status,'unavailable');
  assert.equal(h.estimator.observe({status:'ok',fetchedAt:START-100000,vehicles:[]}).status,'unavailable');
  assert.equal(h.observe(350,75,{location:{lat:LAT,lon:coordinate(350)[0],updatedAt:START+81000}}).arrivals.length,0);
  assert.equal(new GpsEstimator({now:()=>START}).observe({status:'ok',fetchedAt:START,vehicles:[]}).status,'unavailable');
  const index=fixture();index.source.feedEndDate='20261101';
  assert.equal(harness(index).observe(100,0).estimator.status,'expired_gtfs');
});

test('later GPS crossing brackets score immutable forecasts and learn bounded travel profiles',()=>{
  const h=harness();const first=warm(h).arrivals[0];
  for(const [s,t] of [[400,90],[500,120],[600,150],[700,180],[820,210]])h.observe(s,t);
  const state=h.estimator.exportState(),metrics=h.estimator.metrics();
  assert(metrics.samples>=1);assert(metrics.samples<=2,'At most one forecast per horizon bucket per trip');
  const firstOutcome=state.outcomes.find(o=>o.horizon==='2–5 min');
  assert.equal(firstOutcome.errorSeconds,(first.arrivalTime-(START+195000))/1000);
  assert.equal(firstOutcome.bracketSeconds,30);
  assert.equal(metrics.scheduleBaseline.samples,metrics.samples);assert.equal(metrics.speedBaseline.samples,metrics.samples);
  assert(Object.keys(state.profiles).length>=2);
  h.observe(850,225);assert.equal(h.estimator.metrics().samples,metrics.samples,'Repeated post-arrival observations cannot rescore');
});

test('movement resets cannot replace the first forecast for a trip and horizon',()=>{
  const index=fixture();
  index.shapes.shape=Array.from({length:33},(_,i)=>coordinate(i*50));
  index.trips.trip.stops=Array.from({length:9},(_,i)=>({id:i===6?'29530':String(i),sequence:i+1,arrival:28800+i*60,departure:28800+i*60,distance:i*200,pickupAllowed:true}));
  const h=harness(index);warm(h);
  const key='20261102|trip|08:00:00|1_8012|2–5 min';
  const original={...h.estimator.forecastLedger.get(key)};
  assert.equal(original.arrivalTime,START+330000);
  const reset=h.observe(350,75,{location:{lat:LAT+.01,lon:coordinate(350)[0],updatedAt:START+75000}});
  assert.equal(reset.estimator.excluded.off_route,1);
  h.observe(350,90);h.observe(450,120);
  assert.equal(h.observe(550,150).arrivals[0].arrivalTime,START+345000,'A new live estimate can legitimately differ after warmup');
  assert.equal(h.estimator.forecastLedger.get(key).issuedAt,original.issuedAt);
  assert.equal(h.estimator.forecastLedger.get(key).arrivalTime,original.arrivalTime);
  for(const [s,t] of [[650,180],[750,210],[850,240],[950,270],[1050,300],[1150,330],[1210,360]])h.observe(s,t);
  const outcome=h.estimator.outcomes.find(item=>item.key===key);
  assert.equal(outcome.errorSeconds,-15,'Score the original forecast, not the replacement that would score zero error');
  assert.equal(outcome.issuedAt,original.issuedAt);assert.equal(outcome.observedAt,original.observedAt);
  assert.equal(outcome.arrivalTime,original.arrivalTime);
  assert.equal(outcome.earliestArrivalTime,original.earliestArrivalTime);
  assert.equal(outcome.latestArrivalTime,original.latestArrivalTime);
  assert.equal(outcome.crossingLow,START+330000);assert.equal(outcome.crossingHigh,START+360000);
  assert.equal(h.estimator.forecastLedger.get(key).status,'scored');
});

test('an arrival first observed after a reset permanently censors the original forecast',()=>{
  const h=harness();warm(h);
  const forecast=[...h.estimator.forecastLedger.values()][0],issuedAt=forecast.issuedAt;
  h.observe(350,75,{location:{lat:LAT+.01,lon:coordinate(350)[0],updatedAt:START+75000}});
  h.observe(785,120,{stopSequence:5,currentStatus:'STOPPED_AT'});
  assert.equal(forecast.status,'censored');assert.equal(forecast.censorReason,'crossing_unscorable');
  h.observe(785,150,{stopSequence:5,currentStatus:'STOPPED_AT'});
  h.observe(810,180);
  assert.equal(forecast.issuedAt,issuedAt);assert.equal(forecast.status,'censored');
  assert.equal(h.estimator.metrics().samples,0);
  assert.equal(h.estimator.metrics().sessionForecasts.censoredByReason.crossing_unscorable,1);
});

test('known arrivals cannot revive after movement resets even when no forecast preceded the crossing',()=>{
  for(const scored of [true,false]){
    const h=harness();
    if(scored){warm(h);for(const [s,t] of [[400,90],[500,120],[600,150],[700,180]])h.observe(s,t);}
    h.observe(820,210);
    const outcomesBefore=h.estimator.metrics().samples,forecastsBefore=h.estimator.forecastLedger.size;
    assert.equal(h.estimator.completedTrips.size,1);
    h.observe(850,240,{location:{lat:LAT+.02,lon:coordinate(850)[0],updatedAt:START+240000}});
    for(const [s,t] of [[100,270],[200,300],[300,330]]){
      const result=h.observe(s,t);
      assert.equal(result.arrivals.length,0);
      assert.equal(result.estimator.excluded.already_arrived,1);
    }
    h.observe(820,360);
    assert.equal(h.estimator.metrics().samples,outcomesBefore,'A second apparent crossing is not a new outcome');
    assert.equal(h.estimator.forecastLedger.size,forecastsBefore,'No new horizon can be issued after a known arrival');
  }
});

test('forecasts issued after a crossing bracket starts are explicitly censored',()=>{
  const h=harness();warm(h,20);
  h.observe(810,90);
  const forecast=[...h.estimator.forecastLedger.values()][0];
  assert.equal(forecast.status,'censored');
  assert.equal(forecast.censorReason,'issued_after_crossing_bracket');
  assert.equal(h.estimator.metrics().samples,0);
  assert.equal(h.estimator.metrics().sessionForecasts.pending,0);
});

test('inactivity censors forecasts without allowing later movement to rewrite them',()=>{
  const h=harness();warm(h);
  const forecast=[...h.estimator.forecastLedger.values()][0],issuedAt=forecast.issuedAt;
  h.setTime(START+661000);
  h.estimator.observe({status:'ok',fetchedAt:h.now(),vehicles:[]});
  assert.equal(forecast.status,'censored');assert.equal(forecast.censorReason,'observation_gap');
  h.observe(300,670);h.observe(400,700);h.observe(500,730);
  for(const [s,t] of [[600,760],[700,790],[810,820]])h.observe(s,t);
  assert.equal(forecast.issuedAt,issuedAt);assert.equal(forecast.status,'censored');
  assert(!h.estimator.outcomes.some(item=>item.key===forecast.key));
  h.setTime(Date.parse('2026-11-03T16:00:00Z'));h.estimator.exportState();
  assert(h.estimator.forecastLedger.has(forecast.key),'Yesterday remains an eligible overnight service date');
  h.setTime(Date.parse('2026-11-04T16:00:00Z'));h.estimator.exportState();
  assert(!h.estimator.forecastLedger.has(forecast.key),'Expired service identities can be released without enabling a rewrite');
});

test('forecast capacity refuses new evaluation entries instead of evicting eligible identities',()=>{
  const h=harness();warm(h);
  const first=[...h.estimator.forecastLedger.values()][0];
  for(let i=1;i<4096;i++)h.estimator.forecastLedger.set('occupied-'+i,{...first,key:'occupied-'+i,tripInstance:'occupied-'+i,status:'censored',censorReason:'crossing_unscorable'});
  h.observe(500,120);
  assert.equal(h.estimator.forecastLedger.size,4096);
  assert.equal(h.estimator.forecastLedger.get(first.key),first);
  assert.equal(h.estimator.metrics().sessionForecasts.capacitySkippedAttempts,1);
  assert.equal(first.issuedAt,START+60000);
});

test('arrival identity capacity abstains instead of forgetting a current service arrival',()=>{
  const h=harness();
  for(let i=0;i<4096;i++)h.estimator.completedTrips.set('occupied-'+i,'20261102');
  h.observe(820,0);
  assert.equal(h.estimator.completedTrips.size,4096);
  assert.deepEqual(h.estimator.metrics().sessionForecasts.arrivalTrackingBlockedDates,['20261102']);
  assert.equal(h.observe(100,30).estimator.excluded.arrival_tracking_capacity,1);
  h.setTime(Date.parse('2026-11-03T16:00:00Z'));h.estimator.exportState();
  assert(h.estimator.arrivalTrackingBlockedDates.has('20261102'),'The previous service date may still be active overnight');
  h.setTime(Date.parse('2026-11-04T16:00:00Z'));h.estimator.exportState();
  assert.equal(h.estimator.completedTrips.size,0);assert.equal(h.estimator.arrivalTrackingBlockedDates.size,0);
});

test('missing or long-gap arrival observations are not fabricated into evaluation outcomes',()=>{
  const h=harness();warm(h);h.observe(650,150);
  h.observe(850,220);
  assert.equal(h.estimator.metrics().samples,0,'A 70-second crossing gap is too imprecise to score');
  assert.equal(h.estimator.metrics().sessionForecasts.pending,0);
  assert(h.estimator.metrics().sessionForecasts.censoredByReason.crossing_unscorable>0);
});

test('an unscorable arrival cannot turn into a falsely precise crossing during later dwell',()=>{
  for(const [position,firstStatus] of [[785,'STOPPED_AT'],[800,'IN_TRANSIT_TO'],[805,'IN_TRANSIT_TO']]){
    const h=harness();warm(h);h.observe(600,120);
    h.observe(position,190,{stopSequence:5,currentStatus:firstStatus});
    assert.equal(h.estimator.metrics().samples,0);
    const profilesBefore=h.estimator.exportState().profiles;
    h.observe(position,220,{stopSequence:5,currentStatus:'STOPPED_AT'});
    assert.equal(h.estimator.metrics().samples,0,'Later dwell is not a new arrival');
    assert.deepEqual(h.estimator.exportState().profiles,profilesBefore,'Later dwell cannot supply a training traversal');
  }
  const firstAtStop=harness();firstAtStop.observe(200,0,{stopSequence:2,currentStatus:'STOPPED_AT'});
  firstAtStop.observe(200,30,{stopSequence:2,currentStatus:'STOPPED_AT'});
  firstAtStop.observe(300,60);firstAtStop.observe(400,90);
  assert.equal(Object.keys(firstAtStop.estimator.exportState().profiles).length,0,'A first observed stationary stop has unknown arrival time');
});

test('accuracy summaries keep routes and forecast horizons separate',()=>{
  const h=harness();warm(h);
  for(const [s,t] of [[400,90],[500,120],[600,150],[700,180],[820,210]])h.observe(s,t);
  const metrics=h.estimator.metrics();
  assert.equal(metrics.byRoute['62'].samples,metrics.samples);
  assert.equal(metrics.byRoute['44'].samples,0);
  assert.equal(metrics.byRoute['44'].medianAbsoluteErrorSeconds,null);
  assert(metrics.byRoute['62'].byHorizon['2–5 min'].samples>0);
});

test('persisted learning is tied to GTFS and excludes active GPS tracks and forecasts',()=>{
  const h=harness();warm(h);
  for(const [s,t] of [[400,90],[500,120],[600,150],[700,180],[820,210]])h.observe(s,t);
  const state=h.estimator.exportState();assert(state.outcomes.length>0);
  assert(!('tracks' in state));assert(!('pending' in state));
  const restart=new GpsEstimator({index:fixture(),now:()=>START+220000,state});
  assert.equal(restart.metrics().samples,state.outcomes.length);
  assert.equal(restart.metrics().sessionForecasts.issued,0,'Session forecast coverage does not include saved outcomes');
  assert.equal(restart.metrics().modelVersion,2);
  assert.equal(new GpsEstimator({index:fixture(),now:()=>START+220000,state:{...state,modelVersion:1}}).metrics().samples,0,'Outcomes from reset-replaceable forecasts are not mixed with this evaluation version');
  const fresh=restart.observe({status:'ok',fetchedAt:START+220000,vehicles:[h.vehicle(300,220)]});
  assert.equal(fresh.arrivals.length,0);
  const updated=fixture();updated.source.sha256='fixture-v2';
  assert.equal(new GpsEstimator({index:updated,now:()=>START+220000,state}).metrics().samples,0);
});

test('overnight trips use their explicit service date across the daylight-saving boundary',()=>{
  const index=fixture();
  for(const stop of index.trips.trip.stops){stop.arrival+=17*3600;stop.departure+=17*3600;}
  let now=Date.parse('2026-11-02T08:30:00Z'); // 00:30 Seattle, previous service day.
  const estimator=new GpsEstimator({index,now:()=>now}),h=harness(index);
  for(const [s,t] of [[100,0],[200,30],[300,60]]){
    now=Date.parse('2026-11-02T08:30:00Z')+t*1000;
    const v=h.vehicle(s,t,{serviceDate:'20261101',location:{lat:LAT,lon:coordinate(s)[0],updatedAt:now}});
    const out=estimator.observe({status:'ok',fetchedAt:now,vehicles:[v]});
    if(t===60)assert.equal(out.arrivals.length,1);
  }
});

test('the final service day can finish overnight, but a future or expired service date cannot be used',()=>{
  const index=fixture();index.source.feedEndDate='20261101';
  index.calendar.daily.endDate='20261101';
  for(const stop of index.trips.trip.stops){stop.arrival+=17*3600;stop.departure+=17*3600;}
  let now=Date.parse('2026-11-02T08:30:00Z');
  const estimator=new GpsEstimator({index,now:()=>now}),h=harness(index);
  let out;
  for(const [s,t] of [[100,0],[200,30],[300,60]]){
    now=Date.parse('2026-11-02T08:30:00Z')+t*1000;
    out=estimator.observe({status:'ok',fetchedAt:now,vehicles:[h.vehicle(s,t,{serviceDate:'20261101',location:{lat:LAT,lon:coordinate(s)[0],updatedAt:now}})]});
  }
  assert.equal(out.arrivals.length,1);
  now=Date.parse('2026-11-03T08:30:00Z');
  assert.equal(estimator.observe({status:'ok',fetchedAt:now,vehicles:[]}).estimator.status,'expired_gtfs');
  const future=fixture();future.source.feedStartDate='20261103';
  assert.equal(harness(future).observe(100,0).estimator.status,'inactive_gtfs');
});

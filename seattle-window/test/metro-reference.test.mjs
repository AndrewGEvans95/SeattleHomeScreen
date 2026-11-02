import test from 'node:test';
import assert from 'node:assert/strict';
import {compareGpsToReference,normalizeMetroReference} from '../src/metro-reference.mjs';
import {formatComparison} from '../scripts/compare-eta.mjs';

const now=1793578325000;
function entity(){
  return {id:'active-62',trip_update:{trip:{trip_id:'840009051',direction_id:1,route_id:'100252',start_date:'20261101',schedule_relationship:'SCHEDULED'},vehicle:{id:'8025'},timestamp:(now-24000)/1000,stop_time_update:[{stop_sequence:34,stop_id:'29530',arrival:{delay:17,time:(now+300000)/1000},departure:{time:(now+300000)/1000},schedule_relationship:'SCHEDULED'}]}};
}
const payload=(entities=[entity()])=>({header:{timestamp:now/1000},entity:entities});
function own(reference,overrides={}){
  return {...reference,source:'gps_estimate',validUntil:now+60000,...overrides};
}
function snapshot(arrivals,overrides={}){return {status:'ok',fetchedAt:now,arrivals,...overrides};}

test('Metro reference retains exact active home-stop trip identity and both intended directions',()=>{
  const other=entity();Object.assign(other.trip_update.trip,{trip_id:'629474831',route_id:'100224',direction_id:0});other.trip_update.vehicle.id='8229';
  const result=normalizeMetroReference(payload([entity(),other]),{now});
  assert.equal(result.arrivals.length,2);
  assert.deepEqual(result.arrivals[0],{route:'62',routeId:'100252',directionId:1,rawTripId:'840009051',tripId:'1_840009051',serviceDate:'20261101',vehicleId:'1_8025',stopId:'1_29530',arrivalTime:now+300000,updatedAt:now-24000});
  assert.equal(result.providerTime,now);
});

test('reference rejects stale/future headers and never borrows header time for scheduled trips',()=>{
  for(const stamp of [undefined,NaN,(now-120001)/1000,(now+1000)/1000]){
    const p=payload();p.header.timestamp=stamp;
    assert.throws(()=>normalizeMetroReference(p,{now}),/missing or stale/);
  }
  for(const edit of [
    e=>{delete e.trip_update.timestamp;},
    e=>{delete e.trip_update.vehicle;},
    e=>{e.trip_update.timestamp=(now-121000)/1000;},
    e=>{e.trip_update.timestamp=(now+1000)/1000;}
  ]){
    const e=entity();edit(e);
    assert.equal(normalizeMetroReference(payload([e]),{now}).arrivals.length,0);
  }
});

test('wrong route, direction, service identity, cancellation and unavailable stop updates abstain',()=>{
  const edits=[
    e=>{e.is_deleted=true;},
    e=>{e.trip_update.trip.route_id='100184';},
    e=>{e.trip_update.trip.route_id='__proto__';delete e.trip_update.trip.direction_id;},
    e=>{e.trip_update.trip.direction_id=0;},
    e=>{delete e.trip_update.trip.start_date;},
    e=>{e.trip_update.trip.start_date='20260231';},
    e=>{e.trip_update.stop_time_update[0].stop_id='29531';},
    ...['CANCELED','DELETED',3,7].map(value=>e=>{e.trip_update.trip.schedule_relationship=value;}),
    ...['SKIPPED','NO_DATA',1,2].map(value=>e=>{e.trip_update.stop_time_update[0].schedule_relationship=value;})
  ];
  for(const edit of edits){const e=entity();edit(e);assert.equal(normalizeMetroReference(payload([e]),{now}).arrivals.length,0);}
});

test('missing, nonfinite, past and distant arrivals do not become departure-based references',()=>{
  for(const time of [undefined,null,NaN,Infinity,'not-a-time',now/1000,(now-1000)/1000,(now+91*60000)/1000]){
    const e=entity();e.trip_update.stop_time_update[0].arrival.time=time;
    assert.equal(normalizeMetroReference(payload([e]),{now}).arrivals.length,0);
  }
});

test('duplicates cannot inflate a comparison and conflicting duplicate predictions abstain',()=>{
  const a=entity(),b=entity();
  assert.equal(normalizeMetroReference(payload([a,b]),{now}).arrivals.length,1);
  b.trip_update.stop_time_update[0].arrival.time+=60;
  assert.equal(normalizeMetroReference(payload([a,b]),{now}).arrivals.length,0);
  b.trip_update.timestamp+=1;
  assert.equal(normalizeMetroReference(payload([a,b]),{now}).arrivals[0].arrivalTime,now+360000);
});

test('comparison requires identical trip, service date, vehicle and boarding stop',()=>{
  const reference=normalizeMetroReference(payload(),{now}),arrival=reference.arrivals[0];
  for(const override of [{tripId:'1_other'},{serviceDate:'20261031'},{vehicleId:'1_8037'},{stopId:'1_29531'}]){
    const report=compareGpsToReference(snapshot([own(arrival,override)]),reference,{now});
    assert.equal(report.status,'no_matches');assert.equal(report.matched,0);
  }
  const report=compareGpsToReference(snapshot([own(arrival,{arrivalTime:arrival.arrivalTime+61000})]),reference,{now});
  assert.equal(report.status,'compared');assert.equal(report.matched,1);assert.equal(report.between60And120Seconds,1);assert.equal(report.laterThanReference,1);
  assert.match(formatComparison(report),/not measured arrival accuracy/);
  assert(!formatComparison(report).includes(arrival.tripId));
});

test('missing or expired own estimates report warming instead of a passed measurement',()=>{
  const reference=normalizeMetroReference(payload(),{now}),arrival=reference.arrivals[0];
  for(const gps of [
    snapshot([]),snapshot([null]),snapshot([own(arrival,{validUntil:now})]),snapshot([own(arrival,{updatedAt:now-121000})]),snapshot([own(arrival,{serviceDate:null})]),snapshot([own(arrival,{source:'onebusaway'})]),snapshot([own(arrival)],{fetchedAt:now-121000}),snapshot([own(arrival)],{status:'stale'})
  ]){
    const report=compareGpsToReference(gps,reference,{now});
    assert.equal(report.status,'warming_up');assert.equal(report.matched,0);
    assert.match(formatComparison(report),/Warming up or abstaining/);
    assert.match(formatComparison(report),/No comparison measured/);
  }
  const stale=compareGpsToReference(snapshot([own(arrival)]),{...reference,providerTime:now-121000},{now});
  assert.equal(stale.status,'reference_unavailable');assert.equal(stale.matched,0);
});

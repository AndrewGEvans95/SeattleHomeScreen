import test from 'node:test';
import assert from 'node:assert/strict';
import {departureAdvice,gpsEstimateRange,arrivalsFor,arrivalLabel} from '../public/live-utils.js';
test('departure advice never spends time created by rounding the arrival up',()=>{
  const now=1_700_000_000_000;
  const at=seconds=>departureAdvice({arrivalTime:now+seconds*1000,predicted:true},{now});
  assert.equal(at(299).headline,'Leave in 1 min');
  assert.equal(at(239).headline,'Leave now');
  assert.equal(at(180).headline,'Leave now');
  assert.equal(at(120).state,'tight');
  assert.equal(at(119).headline,'Too close to count on');
  assert.equal(at(0).headline,'Due now');
});
test('scheduled and missing arrivals do not produce confident leave-now advice',()=>{
  const now=1_700_000_000_000;
  assert.equal(departureAdvice({arrivalTime:now+180000,predicted:false},{now}).state,'scheduled');
  assert.equal(departureAdvice(null,{now}).state,'stale');
});
test('GPS ranges round outward and leave guidance uses the unrounded earliest arrival',()=>{
  const now=1_700_000_000_000;
  const arrival={source:'gps_estimate',route:'62',predicted:false,arrivalTime:now+600000,earliestArrivalTime:now+299000,latestArrivalTime:now+901000,updatedAt:now,validUntil:now+90000};
  assert.equal(gpsEstimateRange(arrival,now).label,'4–16');
  assert.equal(arrivalLabel(arrival,now),'4–16 min');
  const advice=departureAdvice(arrival,{now});
  assert.equal(advice.headline,'Aim to leave in 1 min');
  assert.equal(advice.state,'estimate');
  assert.match(advice.context,/early end of GPS range/);
  assert.equal(departureAdvice({...arrival,earliestArrivalTime:now+120000},{now}).headline,'Too close to count on');
  assert.equal(departureAdvice({...arrival,earliestArrivalTime:now+239000},{now}).headline,'Aim to leave now');
});
test('fresh API fetches cannot renew expired, malformed or stale GPS estimates',()=>{
  const now=1_700_000_000_000;
  const arrival={source:'gps_estimate',route:'62',predicted:false,arrivalTime:now+300000,earliestArrivalTime:now+180000,latestArrivalTime:now+420000,updatedAt:now-30000,validUntil:now+60000};
  const snapshot=a=>({status:'ok',fetchedAt:now,arrivals:[a]});
  assert.equal(arrivalsFor(snapshot(arrival),'62',now).length,1);
  for(const changes of [
    {validUntil:now},
    {updatedAt:now-90000,validUntil:now+90000},
    {updatedAt:now+5001},
    {earliestArrivalTime:now+400000},
    {latestArrivalTime:now+200000},
    {latestArrivalTime:NaN},
    {earliestArrivalTime:now-60000}
  ]){
    const invalid={...arrival,...changes};
    assert.equal(gpsEstimateRange(invalid,now),null);
    assert.equal(arrivalsFor(snapshot(invalid),'62',now).length,0);
    assert.equal(departureAdvice(invalid,{now}).state,'stale');
  }
  const approaching={...arrival,earliestArrivalTime:now-10000,arrivalTime:now+10000,latestArrivalTime:now+61000};
  assert.equal(gpsEstimateRange(approaching,now).label,'0–2');
  assert.equal(departureAdvice(approaching,{now}).headline,'Too close to count on');
});

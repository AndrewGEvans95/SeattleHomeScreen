import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTransit,normalizeWeather,CachedFeed} from '../src/data.mjs';
import {weatherAt,arrivalsFor,worldPoint} from '../public/live-utils.js';
const now=1791909300000;
function arrival(overrides={}){return {routeShortName:'62',tripId:'trip-1',tripHeadsign:'Downtown Seattle',scheduledArrivalTime:now+600000,predictedArrivalTime:now+240000,predicted:true,lastUpdateTime:now-10000,tripStatus:{activeTripId:'trip-1',lastLocationUpdateTime:now-10000,lastKnownLocation:{lat:47.662,lon:-122.338},position:{lat:47.7,lon:-122.4}},...overrides};}
function payload(arrivals){return {code:200,currentTime:now,data:{entry:{stopId:'1_29530',arrivalsAndDepartures:arrivals},references:{stops:[{id:'1_29530',name:'N 45th St & Woodlawn Ave N',direction:'W'}]}}};}
test('live arrivals use fresh predictions and reported coordinates',()=>{
  const a=normalizeTransit(payload([arrival()]),{now}).arrivals[0];assert.equal(a.arrivalTime,now+240000);assert.equal(a.predicted,true);assert.equal(a.location.lon,-122.338);
});
test('wrong direction, cancelled and expired buses are excluded',()=>{
  const a=normalizeTransit(payload([arrival({tripHeadsign:'Sand Point'}),arrival({status:'CANCELED'}),arrival({predictedArrivalTime:now-60000})]),{now});assert.equal(a.arrivals.length,0);
});
test('stale predictions fall back to clearly labeled schedules; no invented GPS',()=>{
  const a=normalizeTransit(payload([arrival({lastUpdateTime:now-300000,tripStatus:{activeTripId:'trip-1',position:{lat:47.6,lon:-122.3}}})]),{now}).arrivals[0];
  assert.equal(a.predicted,false);assert.equal(a.arrivalTime,now+600000);assert.equal(a.location,null);
});
test('GPS from a previous trip in a vehicle block is not plotted',()=>{
  const a=arrival();a.tripStatus.activeTripId='previous-trip';assert.equal(normalizeTransit(payload([a]),{now}).arrivals[0].location,null);
});
test('stale provider payloads and wrong stop responses are rejected',()=>{
  const p=payload([]);p.currentTime-=180000;assert.throws(()=>normalizeTransit(p,{now}),/stale/);
  p.currentTime=now;p.data.entry.stopId='other';assert.throws(()=>normalizeTransit(p,{now}),/different stop/);
});
test('null weather stays unknown and rain uses preceding 15-minute totals',()=>{
  const p={latitude:47.65,longitude:-122.34,minutely_15_units:{precipitation:'mm',temperature_2m:'°F',wind_gusts_10m:'mp/h'},minutely_15:{time:[now/1000,now/1000+900,now/1000+1800],precipitation:[0,.25,null],temperature_2m:[50,51,null],wind_gusts_10m:[10,11,null]}};
  const data={status:'ok',...normalizeWeather([p,p,p],[{name:'Home'},{name:'Fremont'},{name:'SLU'}],now)};
  assert.equal(data.sharedGrid,true);assert.equal(weatherAt(data,0,now+1,now).rain,1);
  assert.equal(weatherAt(data,0,now,now).rain,0);
  assert.equal(weatherAt(data,0,now+900001,now).rain,null);
  assert.equal(weatherAt({...data,status:'stale'},0,now+1,now).rain,null);
});
test('cached feeds coalesce requests and mark retained data stale after failure',async()=>{
  let time=10000,calls=0,fail=false;
  const feed=new CachedFeed(async()=>{calls++;await Promise.resolve();if(fail)throw new Error('offline');return {arrivals:[1]};},100,{now:()=>time,retry:50});
  await Promise.all([feed.get(),feed.get()]);assert.equal(calls,1);
  time+=101;fail=true;const result=await feed.get();assert.equal(result.status,'stale');assert.equal(result.fetchedAt,10000);assert.deepEqual(result.arrivals,[1]);
  await feed.get();assert.equal(calls,2);
});
test('client expires cached arrivals without depending on a server poll',()=>{
  assert.deepEqual(arrivalsFor({status:'ok',fetchedAt:now-121000,arrivals:[{route:'62',arrivalTime:now+1000}]},'62',now),[]);
  assert.deepEqual(worldPoint(-122.34,47.66,[-122.34,47.66]),[0,0]);
});

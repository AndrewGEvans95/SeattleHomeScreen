import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleType} from '../public/fleet.js';
import {normalizeVehicles} from '../src/vehicles.mjs';
test('fleet lookup is agency-specific, partial and does not guess adjacent ranges',()=>{
  assert.equal(vehicleType('1_8012').kind,'articulated');
  assert.equal(vehicleType('4380').kind,'standard');
  for(const id of ['40_8012','8200','8085','6812','bogus'])assert.equal(vehicleType(id).kind,'unknown');
});
test('Metro GPS keeps fresh target-direction vehicles and rejects stale observations',()=>{
  const now=1791915065000;
  const make=(id,route='100252',dir=1,age=0)=>({vehicle:{trip:{trip_id:'trip'+id,route_id:route,direction_id:dir},vehicle:{id},position:{latitude:47.66,longitude:-122.34},timestamp:now/1000-age}});
  const payload={header:{timestamp:now/1000},entity:[make('8012'),make('8008','100252',0),make('8070','100252',1,121),make('4380','100224',0),make('8200')]};
  const out=normalizeVehicles(payload,{now});
  assert.deepEqual(out.vehicles.map(v=>v.fleetNumber),['8012','4380','8200']);
  assert.equal(out.vehicles[0].tripId,'1_trip8012');assert.equal(out.vehicles[2].type.kind,'unknown');
  assert.throws(()=>normalizeVehicles(payload,{now:now+121000}),/stale/);
});
test('Metro GPS preserves exact trip and stop identity for independent arrival estimates',()=>{
  const now=Date.now();
  const payload={header:{timestamp:now/1000},entity:[{vehicle:{
    trip:{trip_id:'629474831',route_id:'100224',direction_id:0,start_date:'20261101',schedule_relationship:'SCHEDULED'},
    vehicle:{id:'8229'},position:{latitude:47.6613,longitude:-122.3195},
    timestamp:now/1000,current_stop_sequence:8,stop_id:'29480',current_status:'IN_TRANSIT_TO'
  }}]};
  const vehicle=normalizeVehicles(payload,{now}).vehicles[0];
  assert.equal(vehicle.rawTripId,'629474831');assert.equal(vehicle.serviceDate,'20261101');
  assert.equal(vehicle.routeId,'100224');assert.equal(vehicle.directionId,0);
  assert.equal(vehicle.stopSequence,8);assert.equal(vehicle.stopId,'29480');
  assert.equal(vehicle.currentStatus,'IN_TRANSIT_TO');
  assert.equal(vehicle.speed,null,'Absent speed must not become a stationary observation');
});

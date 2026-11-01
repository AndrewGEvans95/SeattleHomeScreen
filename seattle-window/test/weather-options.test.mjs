import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWeatherOptions,weatherQuery,readWeatherOptions,arrivalOffset} from '../public/weather-options.js';

test('weather options round-trip from browser to frame URL without losing the selected ride',()=>{
  const state={homeMinutes:12,sluMinutes:18,gustLimit:19,preference:'drizzle',arriveBy:'08:50',departure:20,scenario:'wind'};
  assert.deepEqual(readWeatherOptions(weatherQuery(state)),state);
  for(const bad of [{homeMinutes:0},{sluMinutes:500},{gustLimit:Infinity},{departure:-1},{arriveBy:'25:15'},{preference:'<script>'}])assert.throws(()=>normalizeWeatherOptions(bad));
});
test('arrival deadlines use Seattle time and do not silently become tomorrow',()=>{
  const at=Date.parse('2026-10-13T15:10:00Z');
  assert.equal(arrivalOffset('08:50',at),40);
  assert.equal(arrivalOffset('07:50',at),-20);
  assert.equal(arrivalOffset('',at),null);
  assert.equal(arrivalOffset('08:50',0,{demo:true}),40);
});

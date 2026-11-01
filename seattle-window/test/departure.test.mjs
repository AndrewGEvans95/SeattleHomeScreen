import test from 'node:test';
import assert from 'node:assert/strict';
import {departureAdvice} from '../public/live-utils.js';
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

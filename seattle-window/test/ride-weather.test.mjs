import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRide,planRide} from '../public/ride-weather.js';
const clear={rain:0,temp:52,gust:12};

test('departure avoids rain just before an assumed passage, not only at its exact minute',()=>{
  const read=(i,t)=>({...clear,rain:i===1&&t<=20?.65:0});
  assert.equal(assessRide(read,10).state,'bus');
  assert.equal(planRide(read).departure,15);
  assert.equal(assessRide(read,15).state,'bike');
});
test('missing data in a passage window pauses guidance and never creates a dry window',()=>{
  const read=(i,t)=>({...clear,rain:i===2&&t===24?null:0});
  assert.equal(assessRide(read,0).state,'unknown');
  assert.equal(planRide(read).departure,0);
  const rainThenMissing=(i,t)=>({...clear,rain:t>20?null:.8});
  assert.notEqual(planRide(rainThenMissing).assessment.state,'bike');
});
test('preferences apply to raw gust values and drizzle separately',()=>{
  assert.equal(assessRide(()=>({...clear,gust:25.1}),0).state,'bus');
  assert.equal(assessRide(()=>({...clear,rain:.2}),0).state,'bus');
  assert.equal(assessRide(()=>({...clear,rain:.2}),0,{preference:'drizzle'}).state,'bike');
});

test('a departure window excludes later rain and respects the arrival allowance',()=>{
  const read=(i,t)=>({...clear,rain:i===1&&(t<=20||t>50)?.65:0});
  const plan=planRide(read);
  assert.deepEqual(plan.window,{start:15,end:35});
  const limited=planRide(read,{arriveByMinutes:40});
  assert.deepEqual(limited.window,{start:15,end:15});
  assert.equal(limited.departure+22+3,40);
  assert.equal(planRide(read,{arriveByMinutes:30}).deadlineBlocked,true);
});

test('custom ride timing changes which rain interval is encountered',()=>{
  const read=(i,t)=>({...clear,rain:i===1&&t<=20?.65:0});
  assert.equal(planRide(read,{offsets:[0,20,35]}).departure,5);
  assert.equal(planRide(read,{offsets:[0,9,22]}).departure,15);
});

test('a short dry slot is not promoted into a flexible departure window',()=>{
  const read=(i,t)=>({...clear,rain:i===0&&(t<10||t>19)?.65:0});
  assert.equal(planRide(read).window,null);
});

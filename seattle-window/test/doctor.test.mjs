import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose,formatReport} from '../src/doctor.mjs';

function feeds(overrides={}){
  return {
    transit:async()=>({status:'unconfigured'}),
    vehicles:async()=>({status:'ok',vehicles:[]}),
    weather:async()=>({status:'ok',points:[{},{},{}]}),
    ...overrides
  };
}

test('missing arrival key and optional renderer do not fail working public feeds',async()=>{
  const report=await diagnose({feeds:feeds(),network:{mode:'proxy'},rendererCheck:async()=>({id:'renderer',status:'warning',message:'Optional renderer missing.'})});
  assert.equal(report.ok,true);
  assert.equal(report.checks.find(c=>c.id==='transit').status,'warning');
  assert.equal(report.checks.find(c=>c.id==='vehicles').status,'ok');
  assert.match(formatReport(report),/3 forecast locations/);
  assert.match(formatReport(report),/OBA_API_KEY/);
  assert.match(formatReport(report),/local display requests bypass/);
});

test('doctor fails unavailable or stale required feeds, and preserves actionable details',async()=>{
  for(const status of ['unavailable','stale']){
    const report=await diagnose({feeds:feeds({weather:async()=>({status,error:{code:'timeout',message:'The provider timed out.'}})}),network:{mode:'direct'}});
    assert.equal(report.ok,false);
    assert.equal(report.checks.find(c=>c.id==='weather').status,'error');
    assert.match(formatReport(report),/provider timed out/);
  }
});

test('doctor checks each feed once and reports a partial Fremont failure separately',async()=>{
  const calls={transit:0,vehicles:0,weather:0};
  const sources=feeds({transit:async()=>({status:'ok',arrivals:[],extraStatus:'unavailable'})});
  const report=await diagnose({feeds:Object.fromEntries(Object.entries(sources).map(([id,read])=>[id,async()=>{calls[id]++;return read();}])),network:{mode:'direct'}});
  assert.deepEqual(calls,{transit:1,vehicles:1,weather:1});
  assert.equal(report.ok,true);
  assert.equal(report.checks.find(c=>c.id==='fremont').status,'warning');
});

test('unexpected feed errors do not stop other checks or print raw exception text',async()=>{
  const report=await diagnose({feeds:feeds({transit:async()=>{throw new Error('secret-api-key');}}),network:{mode:'direct'}});
  assert.equal(report.ok,false);
  assert.equal(report.checks.find(c=>c.id==='weather').status,'ok');
  assert(!formatReport(report).includes('secret-api-key'));
});

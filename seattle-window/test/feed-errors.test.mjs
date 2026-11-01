import test from 'node:test';
import assert from 'node:assert/strict';
import {CachedFeed,FeedError,getJSON,normalizeTransit} from '../src/data.mjs';

test('provider HTTP failures expose useful categories without response text or API keys',async t=>{
  const secret='private-key-not-for-browser';
  for(const [status,code] of [[401,'unauthorized'],[403,'access_denied'],[429,'rate_limited'],[503,'provider_unavailable'],[404,'invalid_response']]){
    t.mock.method(globalThis,'fetch',async()=>new Response(secret,{status}));
    const feed=new CachedFeed(()=>getJSON('https://provider.invalid/?key='+secret),30000);
    const result=await feed.get();
    assert.equal(result.status,'unavailable');
    assert.equal(result.error.code,code);
    assert(!JSON.stringify(result).includes(secret));
    t.mock.restoreAll();
  }
});

test('network, timeout and malformed JSON failures have distinct sanitized diagnoses',async t=>{
  const secret='private-proxy-password';
  for(const [loader,code] of [
    [async()=>{throw new TypeError('fetch failed at https://user:'+secret+'@proxy.invalid');},'network_error'],
    [async()=>{throw new DOMException(secret,'TimeoutError');},'timeout'],
    [async()=>new Response(secret),'invalid_response']
  ]){
    t.mock.method(globalThis,'fetch',loader);
    const result=await new CachedFeed(()=>getJSON('https://provider.invalid'),30000).get();
    assert.equal(result.error.code,code);
    assert(!JSON.stringify(result).includes(secret));
    t.mock.restoreAll();
  }
  assert.throws(()=>normalizeTransit({code:401}),error=>error.code==='unauthorized');
});

test('retained data stays stale during backoff and successful recovery clears the error',async()=>{
  let time=10000,fail=false,calls=0;
  const feed=new CachedFeed(async()=>{calls++;if(fail)throw new FeedError('timeout');return {arrivals:[{tripId:'one'}]};},100,{now:()=>time,retry:50});
  assert.equal((await feed.get()).error,null);
  time+=101;fail=true;
  const stale=await feed.get();
  assert.equal(stale.status,'stale');assert.equal(stale.fetchedAt,10000);
  assert.equal(stale.error.code,'timeout');assert.equal(stale.arrivals[0].tripId,'one');
  time+=20;fail=false;
  assert.equal((await feed.get()).status,'stale');assert.equal(calls,2);
  time+=30;
  const recovered=await feed.get();
  assert.equal(recovered.status,'ok');assert.equal(recovered.error,null);
  assert.equal(recovered.fetchedAt,time);assert.equal(calls,3);
});

test('unexpected adapter errors cannot leak credentials into API snapshots',async()=>{
  const result=await new CachedFeed(async()=>{throw new Error('key=private-key');},30000).get();
  assert.equal(result.error.code,'invalid_response');
  assert(!JSON.stringify(result).includes('private-key'));
});

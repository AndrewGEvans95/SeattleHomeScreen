import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.mjs';
test('server serves app and APIs without exposing configuration or accepting writes',async t=>{
  const secret='test-secret-must-stay-server-side';
  const server=createServer({config:{OBA_API_KEY:secret,PORT:'8787'},feeds:{transit:async()=>({status:'unconfigured',arrivals:[]}),weather:async()=>({status:'unavailable'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/Seattle Window/);
  const health=await fetch(base+'/api/health').then(r=>r.text());assert(!health.includes(secret));
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/%2e%2e%2fsrc/server.mjs')).status,403);
  assert.equal((await fetch(base+'/api/transit',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/transit').then(r=>r.json())).status,'unconfigured');
  assert.equal((await fetch(base+'/api/frame.png?view=invalid')).status,400);
  assert.equal((await fetch(base+'/api/frame.png?view=weather&wxHome=10000')).status,400);
  assert.equal((await fetch(base+'/api/frame.png?view=weather&wxArrive=25%3A10')).status,400);
});

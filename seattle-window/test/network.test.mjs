import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {configureNetwork} from '../src/network.mjs';

test('direct connections still work on Node versions without native proxy support',()=>{
  const result=configureNetwork({env:{},setProxyFromEnv:null});
  assert.equal(result.mode,'direct');
  assert.equal(result.proxyConfigured,false);
  assert.equal(result.proxySupported,false);
  assert.doesNotThrow(result.restore);
});

test('proxy configuration preserves environment precedence and local bypasses',()=>{
  const env={HTTP_PROXY:'http://proxy.example:8080',http_proxy:'http://lower.example:8080',HTTPS_PROXY:'http://secure.example:8080',NO_PROXY:'ignored.example',no_proxy:'private.example'};
  let received;
  const restore=()=>{};
  const result=configureNetwork({env,setProxyFromEnv:value=>{received=value;return restore;}});
  assert.equal(result.mode,'proxy');
  assert.equal(result.restore,restore);
  assert.equal(received.http_proxy,env.http_proxy);
  assert.equal(received.HTTPS_PROXY,env.HTTPS_PROXY);
  assert.equal(received.no_proxy,'private.example,localhost,127.0.0.1,[::1]');
  assert.equal(received.NO_PROXY,received.no_proxy);
  assert.equal(env.no_proxy,'private.example');
});

test('unsupported and invalid proxy setup have actionable errors without secrets',()=>{
  const env={HTTPS_PROXY:'http://private-user:secret-password@proxy.example:8080'};
  assert.throws(()=>configureNetwork({env,setProxyFromEnv:null}),error=>error.code==='PROXY_UNSUPPORTED'&&/Node.js 24.19/.test(error.message)&&!error.message.includes('secret-password'));
  assert.throws(()=>configureNetwork({env,setProxyFromEnv:()=>{throw new Error(env.HTTPS_PROXY);}}),error=>error.code==='PROXY_INVALID'&&!error.message.includes('secret-password'));
});

test('native proxy setup routes fetch through the proxy and bypasses localhost', {skip:typeof http.setGlobalProxyFromEnv!=='function'}, async t=>{
  const sockets=new Set(),targets=[];
  const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));};
  const upstream=http.createServer((req,res)=>res.end('live fixture'));
  const proxy=http.createServer((req,res)=>{res.writeHead(500);res.end();});
  for(const server of [upstream,proxy])server.on('connection',track);
  let restore=()=>{};
  t.after(async()=>{
    restore();
    for(const socket of sockets)socket.destroy();
    await Promise.all([upstream,proxy].map(server=>new Promise(resolve=>server.close(resolve))));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const upstreamPort=upstream.address().port;
  proxy.on('connect',(req,client,head)=>{
    targets.push(req.url);
    if(req.url!==`provider.invalid:${upstreamPort}`){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
    const target=net.connect(upstreamPort,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)target.write(head);
      client.pipe(target);target.pipe(client);
    });
    track(target);
    target.on('error',()=>client.destroy());
    client.on('error',()=>target.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  ({restore}=configureNetwork({env:{HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,NO_PROXY:'existing.internal'}}));
  const proxied=await fetch(`http://provider.invalid:${upstreamPort}/data`,{signal:AbortSignal.timeout(5000)});
  assert.equal(await proxied.text(),'live fixture');
  const direct=await fetch(`http://127.0.0.1:${upstreamPort}/health`,{signal:AbortSignal.timeout(5000)});
  assert.equal(await direct.text(),'live fixture');
  assert.deepEqual(targets,[`provider.invalid:${upstreamPort}`]);
});

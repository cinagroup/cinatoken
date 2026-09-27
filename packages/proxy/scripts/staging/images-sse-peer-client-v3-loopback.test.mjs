import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import WebSocket,{WebSocketServer} from 'ws';
import {observeImagesSseCapacityPeerV3} from './images-sse-capacity-peer-observation-v3.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseCapacityPeerClientV3} from '../../../../scripts/deploy/staging-sse-capacity-peer-client-v3.mjs';
import {captureSseCapacityPrimaryV3,PEER_V3_PRIMARY_URL,PEER_V3_WATCH_URL,PEER_V3_STAGES} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol-v3.mjs';

// Real Node HTTP/WebSocket transport, actual frozen observer server/pool, and
// explicit WebSocketPair/101 adaptation. Still NOT workerd/native/D1 evidence.
for(const foreignFirst of [false,true])test('actual V3 server over real loopback socket, foreign first='+foreignFirst,async t=>{
  const runtime=installPeerV3TestRuntime(t),env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'},ctx={waitUntil(){assert.fail('No background diagnostic');}};
  const calls=[0,0],pools=[],leases=[];
  const apps=[0,1].map(i=>observeImagesSseCapacityPeerV3(policy=>{pools[i]=policy.pool;return {async fetch(){
    calls[i]++;leases[i]=policy.pool.tryAcquire(1024);assert.ok(leases[i]);
    return new Response('unread SSE',{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-generation-id':'gen-'+randomUUID()}});
  }};}));
  const response=await apps[0].fetch(new Request(PEER_V3_PRIMARY_URL,{method:'POST',headers:{'x-c02-capacity-primary':'v3'}}),env,ctx);
  const clock=createSseOperatorClock(),primary=captureSseCapacityPrimaryV3(response,clock.sample(),clock.clockId);
  const server=createServer(),wss=new WebSocketServer({noServer:true}),upgrades=new WeakMap(),sockets=new Set(),clients=[];
  let attempts=0,reserved=0;const journal=[];
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  wss.on('headers',(headers,request)=>{for(const [k,v] of upgrades.get(request).headers)headers.push(k+': '+v);});
  server.on('upgrade',(request,socket,head)=>{
    void (async()=>{
      attempts++;const app=foreignFirst&&attempts===1?apps[1]:apps[0];
      const result=await app.fetch(new Request(PEER_V3_WATCH_URL.replace('wss:','https:'),{headers:request.headers}),env,ctx);
      if(result.status!==101){
        const body=Buffer.from(await result.text());socket.end('HTTP/1.1 '+result.status+' Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: '+body.length+'\r\n\r\n'+body);return;
      }
      upgrades.set(request,result);const local=runtime.pairs.at(-1)[1];
      wss.handleUpgrade(request,socket,head,ws=>{
        ws.on('error',()=>{});ws.on('message',(data,binary)=>{assert.equal(binary,false);local.incoming(data.toString());});
        ws.on('close',()=>local.close(1000,'loopback_closed'));local.addEventListener('close',()=>ws.close(1000,'local_closed'));
        for(const raw of local.messages.splice(0))ws.send(raw);local.send=raw=>ws.send(raw);
      });
    })().catch(()=>socket.destroy());
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const client=createSseCapacityPeerClientV3({clock,reserve(){reserved++;},persist(row){journal.push(structuredClone(row));},
    socketFactory:(url,options)=>{assert.equal(url,PEER_V3_WATCH_URL);const ws=new WebSocket('ws://127.0.0.1:'+server.address().port,options);clients.push(ws);return ws;}});
  t.after(async()=>{client.stop();leases.forEach(lease=>lease?.release());await response.body.cancel();
    clients.forEach(ws=>ws.terminate());for(const ws of wss.clients)ws.terminate();for(const s of sockets)s.destroy();
    await new Promise(resolve=>server.close(resolve));wss.close();});
  const first=await client.open(primary,{'cf-access-client-id':'local-id','cf-access-client-secret':'local-secret'});
  assert.equal(first.sample.requests,1);assert.equal(primary.before,'0/0');assert.equal(response.bodyUsed,false);
  for(const [i,stage] of PEER_V3_STAGES.entries()){
    if(i===1)leases[0].release(); // Modeled owner release, never relabeled native.
    const row=await client.phase(stage,{after:clock.sample()});assert.equal(row.sample.requests,i===0?1:0);
    assert.equal(row.barrier.barrier,i+1);assert.equal(row.sample.barrier,i+1);
  }
  const report=client.stop();assert.equal(report.failed,false);assert.equal(report.nativeVerified,false);
  assert.equal(report.c02GatePassed,false);assert.equal(reserved,foreignFirst?2:1);assert.equal(attempts,reserved);
  assert.equal(runtime.pairs.length,1);assert.deepEqual(calls,[1,0]);assert.equal(pools[0].snapshot().requests,0);
  assert.equal(report.records.length,4);assert.ok(journal.every(row=>!JSON.stringify(row).includes('local-secret')));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {observeImagesSseCapacityPeerV3} from './images-sse-capacity-peer-observation-v3.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {PEER_V3_PRIMARY_URL, PEER_V3_WATCH_URL, PEER_V3_STAGES, captureSseCapacityPrimaryV3,
  createSseCapacityPeerV3Parser, isSseCapacityPeerV3Mismatch} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol-v3.mjs';

// Actual frozen server and pool, locally modeled WebSocketPair/101. This is NOT
// a live socket, Workers/native host, D1 financial or physical-memory oracle.
function fixture(t) {
  const runtime=installPeerV3TestRuntime(t);let pool,lease,calls=0;
  const app=observeImagesSseCapacityPeerV3(policy=>{pool=policy.pool;return {async fetch(){
    calls++;lease=pool.tryAcquire(1024);assert.ok(lease);
    return new Response('unread synthetic SSE',{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-generation-id':'gen-'+randomUUID()}});
  }};});
  const env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'}, ctx={waitUntil(){assert.fail('No diagnostic background work');}};
  t.after(()=>lease?.release());
  return {runtime,start:()=>app.fetch(new Request(PEER_V3_PRIMARY_URL,{method:'POST',headers:{'x-c02-capacity-primary':'v3'}}),env,ctx),
    watch:peer=>app.fetch(new Request(PEER_V3_WATCH_URL.replace('wss:','https:'),{headers:{upgrade:'websocket','x-c02-capacity-watch':'v3','x-c02-capacity-peer':peer}}),env,ctx),
    get pool(){return pool;},get lease(){return lease;},get calls(){return calls;}};
}
const drain=(socket,parser)=>socket.messages.splice(0).map(raw=>parser.pushMessage(Buffer.from(raw),false));

test('new parser consumes frozen V3 server bytes and observes release only by business owner',async t=>{
  const f=fixture(t),r=await f.start(),clock=createSseOperatorClock();
  const primary=captureSseCapacityPrimaryV3(r,clock.sample(),clock.clockId),parser=createSseCapacityPeerV3Parser(primary.peer);
  assert.equal((await f.watch(primary.peer)).status,101);const socket=f.runtime.pairs[0][1];
  assert.equal(drain(socket,parser)[0].requests,1);
  for(let i=0;i<3;i++){
    if(i===1)f.lease.release(); // Explicit local release, never labeled native.
    socket.incoming(parser.mark(PEER_V3_STAGES[i]));const [ack,sample]=drain(socket,parser);
    assert.equal(ack.barrier,i+1);assert.equal(sample.barrier,i+1);assert.equal(sample.requests,i===0?1:0);
  }
  assert.equal(f.calls,1);assert.equal(r.bodyUsed,false);socket.close(1000,'test');
  assert.throws(()=>parser.finish()); // A local socket close cannot synthesize end/native.
  await r.body.cancel();
});
test('frozen server maximum real message sequence fits parser without retaining history',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),r=await f.start(),peer=r.headers.get('x-c02-capacity-peer');
  await f.watch(peer);const socket=f.runtime.pairs[0][1],parser=createSseCapacityPeerV3Parser(peer);drain(socket,parser);
  for(const stage of PEER_V3_STAGES){socket.incoming(parser.mark(stage));drain(socket,parser);}
  for(let i=0;i<180;i++){t.mock.timers.tick(1000);drain(socket,parser);}
  parser.finish();assert.equal(parser.stats().frames,184);assert.equal(socket.closed,true);assert.equal(f.pool.snapshot().requests,1);
  await r.body.cancel();
});
test('frozen rejection bytes distinguish foreign peer from consumed observer without dispatch replay',async t=>{
  const f=fixture(t),r=await f.start(),peer=r.headers.get('x-c02-capacity-peer');
  const foreign=await f.watch(randomUUID()+':1');
  assert.equal(isSseCapacityPeerV3Mismatch({status:foreign.status,headers:foreign.headers,body:new Uint8Array(await foreign.arrayBuffer()),complete:true}),true);
  assert.equal(f.runtime.pairs.length,0);assert.equal((await f.watch(peer)).status,101);f.runtime.pairs[0][1].close(1000,'test');
  const used=await f.watch(peer);
  assert.equal(isSseCapacityPeerV3Mismatch({status:used.status,headers:used.headers,body:new Uint8Array(await used.arrayBuffer()),complete:true}),false);
  assert.equal(f.calls,1);assert.equal(f.pool.snapshot().requests,1);await r.body.cancel();
});

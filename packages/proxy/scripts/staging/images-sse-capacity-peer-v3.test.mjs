import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {observeImagesSseCapacityPeerV3,SSE_PEER_V3_PROFILE as profile,SSE_PEER_V3_PATH as path,SSE_PEER_V3_PRIMARY as primary,
  SSE_PEER_V3_HEADER as peerHeader,SSE_PEER_V3_WATCH as watchHeader,SSE_PEER_V3_BASELINE as beforeHeader} from './images-sse-capacity-peer-observation-v3.ts';
import {SSE_CAPACITY_ORIGIN as origin} from './images-sse-capacity-observation.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {imagesSseCapacityPeerV3StagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity-peer-v3.mjs';
import {imagesSseCapacityPeerStagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity-peer.mjs';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
const env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'},ctx={waitUntil(){assert.fail('No diagnostic background promise');}};
const command=(barrier,stage)=>JSON.stringify({profile,kind:'mark',barrier,stage});
function fixture(t,handle){
  const runtime=installPeerV3TestRuntime(t);let calls=0,pool,lease,requestSeen;
  const app=observeImagesSseCapacityPeerV3(policy=>{pool=policy.pool;return {async fetch(request){calls++;requestSeen=request;
    if(handle)return handle(request,pool);
    lease=pool.tryAcquire(1024);assert.ok(lease);return new Response('unread SSE',{headers:{'Content-Type':'text/event-stream'}});
  }};});
  const start=(patch={})=>app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',headers:{[primary]:'v3'},...patch}),env,ctx);
  const watch=(peer,patch={})=>app.fetch(new Request(origin+path,{headers:{Upgrade:'websocket',[watchHeader]:'v3',[peerHeader]:peer},...patch}),env,ctx);
  return {app,start,watch,runtime,get pool(){return pool;},get calls(){return calls;},get lease(){return lease;},get requestSeen(){return requestSeen;}};
}
test('primary-first response remains unread and all markers use one socket',async t=>{
  const f=fixture(t),r=await f.start({body:'unread input'});assert.equal(r.status,200);assert.equal(r.bodyUsed,false);
  assert.equal(f.requestSeen.bodyUsed,false);assert.equal(r.headers.get(beforeHeader),'0/0');assert.equal(f.calls,1);
  const peer=r.headers.get(peerHeader),upgrade=await f.watch(peer);assert.equal(upgrade.status,101);assert.equal(upgrade.headers.get(peerHeader),peer);
  const socket=f.runtime.pairs[0][1];assert.equal(socket.accepted,true);const first=socket.read()[0];assert.equal(first.requests,1);assert.equal(first.sequence,1);
  for(const [i,stage] of ['held','post-native','post-recovery'].entries()){
    socket.incoming(command(i+1,stage));const [ack,sample]=socket.read();assert.equal(ack.kind,'barrier');assert.equal(ack.stage,stage);
    assert.equal(sample.barrier,i+1);assert.equal(sample.requests,1);assert.equal(sample.instanceId,first.instanceId);assert.equal(sample.watchEpoch,first.watchEpoch);
  }
  assert.equal(f.calls,1);socket.close(1000,'test');assert.equal(f.pool.snapshot().requests,1);f.lease.release();
  assert.equal(f.pool.snapshot().requests,0);await r.body.cancel();
});
test('foreign target does not create a socket or call business code',async t=>{
  const f=fixture(t),r=await f.start();const peer=r.headers.get(peerHeader);const wrong=randomUUID()+':'+peer.split(':')[1];
  const rejected=await f.watch(wrong);assert.equal(rejected.status,409);assert.equal((await rejected.json()).reason,'peer_not_active_here');
  assert.equal(f.runtime.pairs.length,0);assert.equal(f.calls,1);assert.equal((await f.watch(peer)).status,101);f.lease.release();
});
test('same primary epoch never reconnects after observed socket closes',async t=>{
  const f=fixture(t),r=await f.start(),peer=r.headers.get(peerHeader);await f.watch(peer);f.runtime.pairs[0][1].close(1000,'test');
  const rejected=await f.watch(peer);assert.equal(rejected.status,409);assert.equal((await rejected.json()).reason,'watch_already_used');f.lease.release();
});
test('another primary cannot overwrite an active observer even if business lease released',async t=>{
  const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));f.lease.release();assert.equal((await f.start()).status,409);assert.equal(f.calls,1);
  f.runtime.pairs[0][1].close(1000,'test');const second=await f.start();assert.notEqual(second.headers.get(peerHeader),r.headers.get(peerHeader));
  assert.equal((await f.watch(r.headers.get(peerHeader))).status,409);f.lease.release();
});
test('concurrent business preparation excluded before actual pool admission',async t=>{
  const ready=Promise.withResolvers(),release=Promise.withResolvers();const f=fixture(t,async()=>{ready.resolve();await release.promise;return new Response('ok');});
  const first=f.start();await ready.promise;assert.equal((await f.start()).status,409);assert.equal(f.calls,1);release.resolve();assert.equal((await first).status,200);
});
test('business throw releases only diagnostic preparation exclusion',async t=>{
  const f=fixture(t,async()=>{throw Error('expected');});await assert.rejects(f.start());await assert.rejects(f.start());assert.equal(f.calls,2);assert.equal(f.pool.snapshot().requests,0);
});
test('non-200 business response cannot produce eligible watch',async t=>{
  const f=fixture(t,async()=>new Response('rejected',{status:400})),r=await f.start();assert.equal((await f.watch(r.headers.get(peerHeader))).status,409);assert.equal(f.runtime.pairs.length,0);
});
test('already released primary cannot start a misleading baseline watch',async t=>{
  const f=fixture(t),r=await f.start();f.lease.release();const rejected=await f.watch(r.headers.get(peerHeader));
  assert.equal((await rejected.json()).reason,'primary_not_held');assert.equal(f.runtime.pairs.length,0);
});
for(const bad of ['{}',command(2,'post-native'),command(1,'held')+' ',command(1,'held').replace('"mark"','"reset"'),'x'.repeat(129),new ArrayBuffer(2)])
test('invalid marker closes only observer: '+String(bad).slice(0,40),async t=>{
  const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));const socket=f.runtime.pairs[0][1];socket.read();socket.incoming(bad);
  assert.equal(socket.closed,true);assert.equal(socket.closeCalls[0].code,1008);assert.deepEqual(socket.read(),[]);assert.equal(f.pool.snapshot().requests,1);f.lease.release();
});
test('duplicate marker has no second acknowledgement',async t=>{
  const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));const socket=f.runtime.pairs[0][1];socket.read();
  socket.incoming(command(1,'held'));assert.equal(socket.read().length,2);socket.incoming(command(1,'held'));assert.equal(socket.closed,true);assert.equal(socket.read().length,0);f.lease.release();
});
test('abort/error/send failure are request-owned and preserve lease',async t=>{
  for(const mode of ['abort','error','send']){
    const f=fixture(t),r=await f.start(),ac=new AbortController();await f.watch(r.headers.get(peerHeader),{signal:ac.signal});const socket=f.runtime.pairs.at(-1)[1];
    if(mode==='abort')ac.abort();else if(mode==='error')socket.dispatchEvent(new Event('error'));else {socket.failSend=true;socket.incoming(command(1,'held'));}
    assert.equal(socket.closed,true);assert.equal(f.pool.snapshot().requests,1);f.lease.release();
  }
});
for(const [name,patch] of [
  ['missing primary',{headers:{}}],['legacy peer',{headers:{[primary]:'v3',[peerHeader]:randomUUID()+':1'}}],
  ['upgrade on primary',{headers:{[primary]:'v3',Upgrade:'websocket'}}],['wrong method',{method:'GET'}],
  ['watch header',{headers:{[primary]:'v3',[watchHeader]:'v3'}}],['forged baseline',{headers:{[primary]:'v3',[beforeHeader]:'0/0'}}],
])test('invalid primary does not enter handler: '+name,async t=>{const f=fixture(t);assert.equal((await f.start(patch)).status,400);assert.equal(f.calls,0);});
for(const [name,patch] of [
  ['no upgrade',{headers:{[watchHeader]:'v3',[peerHeader]:randomUUID()+':1'}}],['POST',{method:'POST'}],
  ['body',{method:'POST',body:'unread'}],['wrong version',{headers:{Upgrade:'websocket',[watchHeader]:'v2',[peerHeader]:randomUUID()+':1'}}],
  ['unsafe epoch',{headers:{Upgrade:'websocket',[watchHeader]:'v3',[peerHeader]:randomUUID()+':9007199254740992'}}],
])test('invalid watch is rejected without upgrade: '+name,async t=>{const f=fixture(t);assert.equal((await f.watch(randomUUID()+':1',patch)).status,400);assert.equal(f.runtime.pairs.length,0);assert.equal(f.calls,0);});
test('fixed profile rejects production origin and old HTTP barrier path',async t=>{
  const f=fixture(t);assert.equal((await f.app.fetch(new Request('https://production.invalid/v1/images/generations',{method:'POST',headers:{[primary]:'v3'}}),env,ctx)).status,404);
  assert.equal((await f.app.fetch(new Request(origin+'/__staging/sse-capacity/barrier-v2',{method:'POST'}),env,ctx)).status,400);assert.equal(f.calls,0);
});
test('closed V3 config changes only entry',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'),production=readJsonc('packages/proxy/wrangler.base.jsonc');
  assert.deepEqual(imagesSseCapacityPeerV3StagingConfig(staging,production),{...imagesSseCapacityPeerStagingConfig(staging,production),main:'scripts/staging/images-sse-capacity-peer-gateway-v3.ts'});
});
test('concurrent matching upgrades consume exactly one observation epoch',async t=>{
  const f=fixture(t),r=await f.start(),peer=r.headers.get(peerHeader);
  const upgrades=await Promise.all([f.watch(peer),f.watch(peer)]);assert.deepEqual(upgrades.map(r=>r.status).sort(),[101,409]);
  assert.equal(f.runtime.pairs.length,1);f.lease.release();
});
test('sample and output bounds are enforced for a non-reading observer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));const socket=f.runtime.pairs[0][1];
  for(let i=0;i<180;i++)t.mock.timers.tick(1000);
  assert.equal(socket.closed,true);const raw=[...socket.messages],rows=socket.read();
  assert.equal(rows.filter(r=>r.kind==='sample').length,180);assert.equal(rows.at(-1).reason,'sample-limit');
  assert.ok(raw.every(s=>Buffer.byteLength(s)<=512));assert.ok(raw.reduce((n,s)=>n+Buffer.byteLength(s),0)<=184*512);
  assert.equal(f.pool.snapshot().requests,1);f.lease.release();
});
test('absolute watch deadline closes even when timer delivery is delayed',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));const socket=f.runtime.pairs[0][1];
  t.mock.timers.tick(180000);assert.equal(socket.closed,true);assert.equal(socket.read().at(-1).reason,'deadline');
  assert.equal(f.pool.snapshot().requests,1);f.lease.release();
});
test('closed observation has no late timer samples or marker acknowledgements',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),r=await f.start();await f.watch(r.headers.get(peerHeader));const socket=f.runtime.pairs[0][1];
  socket.close(1000,'test');socket.read();t.mock.timers.tick(240000);socket.incoming(command(1,'held'));assert.deepEqual(socket.read(),[]);f.lease.release();
});
for(const endpoint of ['primary','watch'])test('pre-aborted '+endpoint+' does not create business or socket work',async t=>{
  const f=fixture(t),ac=new AbortController();ac.abort();const r=endpoint==='primary'?await f.start({signal:ac.signal}):await f.watch(randomUUID()+':1',{signal:ac.signal});
  assert.equal(r.status,409);assert.equal(f.calls,0);assert.equal(f.runtime.pairs.length,0);
});
for(const endpoint of ['primary','watch'])for(const suffix of ['?x=1','#x'])test('strict '+endpoint+' URL rejects '+suffix,async t=>{
  const f=fixture(t),r=await f.app.fetch(new Request(origin+(endpoint==='primary'?'/v1/images/generations':path)+suffix,
    endpoint==='primary'?{method:'POST',headers:{[primary]:'v3'}}:{headers:{Upgrade:'websocket',[watchHeader]:'v3',[peerHeader]:randomUUID()+':1'}}),env,ctx);
  assert.equal(r.status,400);assert.equal(f.calls,0);assert.equal(f.runtime.pairs.length,0);
});

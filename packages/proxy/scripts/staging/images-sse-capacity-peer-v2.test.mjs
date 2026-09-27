import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {observeImagesSseCapacityPeerV2,SSE_CAPACITY_WATCH_PATH as watchPath,SSE_CAPACITY_WATCH_HEADER as watchHeader,
  SSE_CAPACITY_PEER_HEADER as peerHeader,SSE_CAPACITY_BARRIER_PATH as barrierPath,SSE_CAPACITY_BARRIER_HEADER as barrierHeader,
} from './images-sse-capacity-peer-observation-v2.ts';
import {SSE_CAPACITY_ORIGIN as origin} from './images-sse-capacity-observation.ts';
import {createSseCapacityPeerClient,classifySseCapacityPeerSequence} from '../../../../scripts/deploy/staging-sse-capacity-peer-client.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {imagesSseCapacityPeerV2StagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity-peer-v2.mjs';
import {imagesSseCapacityPeerStagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity-peer.mjs';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
const env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
const context={waitUntil(){assert.fail('Diagnostic must not schedule background work');}};
const request=(path,init)=>new Request(origin+path,init);
const watch=app=>app.fetch(request(watchPath,{headers:{[watchHeader]:'v2'}}),env,context);
const barrier=(app,peer,stage,patch={})=>app.fetch(request(barrierPath,{method:'POST',headers:{[peerHeader]:peer,[barrierHeader]:stage},...patch}),env,context);
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture(){let pool,calls=0;const app=observeImagesSseCapacityPeerV2(p=>{pool=p.pool;return {async fetch(){calls++;return new Response();}};});return {app,get pool(){return pool;},get calls(){return calls;}};}
test('same-pool barrier changes only future samples; queued baseline is never relabeled',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),r=await watch(f.app),peer=r.headers.get(peerHeader),reader=r.body.getReader();
  t.after(()=>reader.cancel());const lease=f.pool.tryAcquire(1024);
  assert.equal((await barrier(f.app,peer,'held')).status,200);
  const first=JSON.parse(new TextDecoder().decode((await reader.read()).value));assert.equal(first.barrier,0);assert.equal(first.requests,0);
  const pending=reader.read();await flush();t.mock.timers.tick(1000);
  const held=JSON.parse(new TextDecoder().decode((await pending).value));assert.equal(held.barrier,1);assert.equal(held.requests,1);
  for(const stage of ['post-native','post-recovery'])assert.equal((await barrier(f.app,peer,stage)).status,200);
  assert.equal(f.calls,0);assert.equal(f.pool.snapshot().requests,1);await reader.cancel();assert.equal(f.pool.snapshot().requests,1);lease.release();
});
test('duplicate, skipped and concurrent barriers cannot advance twice',async t=>{
  const f=fixture(),r=await watch(f.app),peer=r.headers.get(peerHeader);t.after(()=>r.body.cancel());
  assert.equal((await barrier(f.app,peer,'post-native')).status,409);
  const replies=await Promise.all([barrier(f.app,peer,'held'),barrier(f.app,peer,'held')]);
  assert.deepEqual(replies.map(v=>v.status).sort(),[200,409]);
  assert.equal((await barrier(f.app,peer,'held')).status,409);assert.equal((await barrier(f.app,peer,'post-native')).status,200);
  assert.equal(f.calls,0);
});
test('foreign and ended peers reject markers without changing capacity',async t=>{
  const f=fixture(),g=fixture(),r=await watch(f.app),other=await watch(g.app),peer=r.headers.get(peerHeader);t.after(()=>other.body.cancel());
  assert.equal((await barrier(g.app,peer,'held')).status,409);await r.body.cancel();assert.equal((await barrier(f.app,peer,'held')).status,409);
  const next=await watch(f.app);t.after(()=>next.body.cancel());assert.equal((await barrier(f.app,peer,'held')).status,409);
  assert.equal((await barrier(f.app,next.headers.get(peerHeader),'held')).status,200);assert.equal(f.pool.snapshot().requests,0);
});
for(const [label,make] of [
  ['body',p=>request(barrierPath,{method:'POST',body:'unread',headers:{[peerHeader]:p,[barrierHeader]:'held'}})],
  ['GET',p=>request(barrierPath,{headers:{[peerHeader]:p,[barrierHeader]:'held'}})],
  ['query',p=>request(barrierPath+'?x=1',{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'held'}})],
  ['fragment',p=>request(barrierPath+'#x',{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'held'}})],
  ['Upgrade',p=>request(barrierPath,{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'held',Upgrade:''}})],
  ['watch header',p=>request(barrierPath,{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'held',[watchHeader]:'v2'}})],
  ['invalid stage',p=>request(barrierPath,{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'reset'}})],
  ['missing peer',()=>request(barrierPath,{method:'POST',headers:{[barrierHeader]:'held'}})],
  ['barrier on inference',p=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:p,[barrierHeader]:'held'}})],
  ['barrier on health',()=>request('/health',{headers:{[barrierHeader]:'held'}})],
  ['legacy watch header',()=>request(watchPath,{headers:{[watchHeader]:'v1'}})],
])test('marker rejects '+label+' before handler',async t=>{
  const f=fixture(),r=await watch(f.app);t.after(()=>r.body.cancel());
  assert.equal((await f.app.fetch(make(r.headers.get(peerHeader)),env,context)).status,400);assert.equal(f.calls,0);
});
test('real v2 observer and operator client interoperate without external fetch',async t=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No external network'));
  const f=fixture(),clock=createSseOperatorClock(),journal=[];let calls=0,budget=0;
  const client=createSseCapacityPeerClient({clock,reserve(){budget++;},persist:r=>journal.push(r),
    fetchImpl:(url,init)=>{calls++;return f.app.fetch(new Request(url,init),env,context);}});
  t.after(()=>client.stop());await client.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-only'});
  const lease=f.pool.tryAcquire(1024);await client.phase('held',{after:clock.sample()});lease.release();
  await client.phase('post-native',{after:clock.sample()});await client.phase('post-recovery',{after:clock.sample()});
  assert.equal(calls,4);assert.equal(budget,4);assert.equal(journal.length,8);assert.equal(f.calls,0);
  assert.equal(classifySseCapacityPeerSequence(client.report(),client.getPeer().split(':')[0]).result,'LOGICAL_SEQUENCE_PASS');
});
test('cross-instance barrier in actual composition stops the operator with no retry',async t=>{
  const a=fixture(),b=fixture(),clock=createSseOperatorClock();let calls=0;
  const client=createSseCapacityPeerClient({clock,reserve(){},persist(){},fetchImpl:(url,init)=>{
    calls++;return (calls===1?a:b).app.fetch(new Request(url,init),env,context);
  }});t.after(()=>client.stop());
  await client.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-only'});
  await assert.rejects(client.phase('held',{after:clock.sample()}));assert.equal(calls,2);assert.equal(client.report().failed,true);
});
test('pure v2 config changes only entry and preserves closed staging resources',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'),production=readJsonc('packages/proxy/wrangler.base.jsonc');
  const base=imagesSseCapacityPeerStagingConfig(staging,production),v2=imagesSseCapacityPeerV2StagingConfig(staging,production);
  assert.deepEqual(v2,{...base,main:'scripts/staging/images-sse-capacity-peer-gateway-v2.ts'});
});

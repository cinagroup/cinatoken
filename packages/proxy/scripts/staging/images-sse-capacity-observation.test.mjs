import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {observeImagesSseCapacity,SSE_CAPACITY_ORIGIN as origin,SSE_CAPACITY_PATH as path,SSE_CAPACITY_INSTANCE_HEADER as header} from './images-sse-capacity-observation.ts';
import {createImagesSseCapacityHostGateway} from './images-sse-capacity-host-handler.ts';
import {imagesSseCapacityStagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity.mjs';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
import {assertSseCapacityObservation,classifySseCapacityObservation} from '../../../../scripts/deploy/staging-sse-capacity-evidence.mjs';
const env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
const context={waitUntil(p){p.catch(()=>{});}};
const request=(suffix=path,options={})=>new Request(origin+suffix,options);
const sample=()=>({profile:'c02-sse-ownership-v1',instanceId:randomUUID(),maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0});

test('one pool identity survives saturation; census never calls handler or resets leases',async()=>{
  let pool,calls=0,builds=0;
  const app=observeImagesSseCapacity(policy=>{builds++;pool=policy.pool;return {async fetch(){calls++;return new Response('synthetic',{headers:{[header]:'spoofed-upstream'}});}};});
  const first=await app.fetch(request(),env,context),idle=await first.json();assertSseCapacityObservation(idle);
  assert.equal(first.headers.get('Cache-Control'),'no-store');assert.equal(first.headers.get(header),idle.instanceId);
  const lease=pool.tryAcquire(1024),release=lease.retain();lease.release();
  for(let i=0;i<3;i++){
    const r=await app.fetch(request(path,{headers:{[header]:randomUUID(),'X-Request-Capacity':'0'}}),env,context);
    const observed=await r.json();assert.equal(observed.instanceId,idle.instanceId);
    assert.equal(classifySseCapacityObservation(idle.instanceId,observed).state,'occupied');
  }
  assert.equal(calls,0);assert.equal(builds,1);assert.equal(pool.snapshot().requests,1);
  release();release();assert.equal((await (await app.fetch(request(),env,context)).json()).requests,0);
  const normal=await app.fetch(request('/health'),env,context);assert.equal(normal.headers.get(header),idle.instanceId);
  assert.equal(await normal.text(),'synthetic');assert.equal(calls,1);
});

test('different module instances are explicitly inconclusive, not recovered capacity',async()=>{
  const make=()=>observeImagesSseCapacity(()=>({fetch:async()=>new Response('unused')}));
  const a=await (await make().fetch(request(),env,context)).json(),b=await (await make().fetch(request(),env,context)).json();
  assert.notEqual(a.instanceId,b.instanceId);
  assert.equal(classifySseCapacityObservation(a.instanceId,b).state,'different-instance');
});

for(const [label,make,bindings,status] of [
  ['POST',()=>request(path,{method:'POST',body:'do-not-read'}),env,400],
  ['HEAD',()=>request(path,{method:'HEAD'}),env,400],
  ['query',()=>request(path+'?reset=1'),env,400],
  ['fragment',()=>request(path+'#reset'),env,400],
  ['Upgrade',()=>request(path,{headers:{Upgrade:''}}),env,400],
  ['wrong origin',()=>new Request('https://api.cinatoken.com'+path),env,404],
  ['wrong driver',()=>request(),{...env,DATABASE_DRIVER:'postgres'},404],
  ['logging enabled',()=>request(),{...env,REQUEST_BODY_LOGGING:'on'},404],
  ['batch enabled',()=>request(),{...env,BATCH_API_ENABLED:'true'},404],
])test('census rejects '+label+' without downstream I/O',async()=>{
  const app=observeImagesSseCapacity(()=>({fetch:async()=>{assert.fail('No handler I/O');}}));
  assert.equal((await app.fetch(make(),bindings,context)).status,status);
});

test('response instrumentation preserves backpressure and cancel ownership',async()=>{
  let pulls=0,cancels=0;
  const app=observeImagesSseCapacity(()=>({fetch:async()=>new Response(new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}))}));
  const r=await app.fetch(request('/v1/images/generations'),env,context);
  assert.equal(pulls,0);await r.body.cancel();assert.equal(cancels,1);assert.equal(pulls,0);
});

test('actual capacity host handler has census, real maintenance and no non-HTTP exports',async()=>{
  const app=createImagesSseCapacityHostGateway(async()=>{assert.fail('No upstream dispatch');});
  assert.deepEqual(Object.keys(app),['fetch']);
  const r=await app.fetch(request(),env,context),id=(await r.json()).instanceId;
  const maintenance=await app.fetch(request('/health'),{...env,CINATOKEN_MAINTENANCE_MODE:'true'},context);
  assert.equal(maintenance.status,503);assert.equal(maintenance.headers.get(header),id);
  assert.equal((await (await app.fetch(request(),env,context)).json()).requests,1);
  assert.match(await maintenance.text(),/maintenance_mode/);
  assert.equal((await (await app.fetch(request(),env,context)).json()).requests,0);
});

for(const [label,mutate] of [
  ['extra request state',v=>v.request='sensitive'],['wrong profile',v=>v.profile='production'],
  ['missing id',v=>delete v.instanceId],['malformed id',v=>v.instanceId='same-instance'],
  ['wrong limit',v=>v.maxRequests=2],['wrong weight',v=>v.maxReservedBytes=2048],
  ['negative requests',v=>v.requests=-1],['fractional requests',v=>v.requests=.5],
  ['over-admitted',v=>v.requests=2],['zero bytes while held',v=>v.requests=1],
  ['bytes without request',v=>v.reservedBytes=1024],['numeric string',v=>v.requests='0'],
])test('observation oracle rejects '+label,()=>{
  const v=sample();mutate(v);assert.throws(()=>assertSseCapacityObservation(v));
});

test('candidate config is closed, isolated, fixed and non-mutating',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'),production=readJsonc('packages/proxy/wrangler.base.jsonc');
  const before=structuredClone(staging),r=imagesSseCapacityStagingConfig(staging,production);
  assert.deepEqual(staging,before);assert.equal(r.main,'scripts/staging/images-sse-capacity-host-gateway.ts');
  assert.equal(r.workers_dev,false);assert.equal(r.preview_urls,false);assert.deepEqual(r.routes,[]);assert.deepEqual(r.triggers,{crons:[]});
  assert.deepEqual(r.services,[{binding:'IMAGE_UPSTREAM',service:'cinatoken-staging-images-upstream'}]);assert.equal(r.queues,undefined);
  for(const patch of [{name:production.name},{workers_dev:true},{preview_urls:true},{queues:{consumers:[{queue:'unsafe'}]}}])
    assert.throws(()=>imagesSseCapacityStagingConfig({...staging,...patch},production));
});

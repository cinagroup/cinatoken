import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {observeImagesSseCapacityPeer, SSE_CAPACITY_WATCH_PATH as watchPath,
  SSE_CAPACITY_WATCH_HEADER as watchHeader, SSE_CAPACITY_PEER_HEADER as peerHeader,
  SSE_CAPACITY_WATCH_LIFETIME_MS, SSE_CAPACITY_WATCH_MAX_SAMPLES,
} from './images-sse-capacity-peer-observation.ts';
import {SSE_CAPACITY_ORIGIN as origin, SSE_CAPACITY_PATH as censusPath} from './images-sse-capacity-observation.ts';
import {createImagesSseCapacityPeerGateway} from './images-sse-capacity-peer-handler.ts';
import {SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler.ts';
import {imagesSseCapacityPeerStagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity-peer.mjs';
import {imagesSseCapacityStagingConfig} from '../../../../scripts/deploy/prepare-staging-sse-capacity.mjs';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';

const env = {DATABASE_DRIVER:'d1', REQUEST_BODY_LOGGING:'off', BATCH_API_ENABLED:'false'};
const context = {waitUntil() { assert.fail('Observer must not schedule background work'); }};
const request = (path, init) => new Request(origin + path, init);
const watch = (app, options = {}) => app.fetch(request(watchPath, {
  ...options, headers:{[watchHeader]:'v1', ...options.headers},
}), env, context);
const primary = (app, peer, options = {}) => app.fetch(request('/v1/images/generations', {
  method:'POST', ...options, headers:{[peerHeader]:peer, ...options.headers},
}), env, context);
const decode = value => JSON.parse(new TextDecoder().decode(value));
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
function fixture(t) {
  let pool, calls=0, builds=0;
  const app = observeImagesSseCapacityPeer(policy => {
    builds++; pool=policy.pool;
    return {async fetch() { calls++; return new Response('business'); }};
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No external I/O'));
  return {app, get pool() {return pool;}, get calls() {return calls;}, get builds() {return builds;}};
}

test('one pool, one active peer, immutable identity; watch leaves business ownership intact', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t), response=await watch(f.app), reader=response.body.getReader();
  t.after(()=>reader.cancel());
  const peer=response.headers.get(peerHeader), first=decode((await reader.read()).value);
  assert.equal(first.sequence,1); assert.equal(first.requests,0); assert.equal(first.kind,'sample');
  assert.equal(first.profile,'c02-sse-peer-v1'); assert.equal(peer,`${first.instanceId}:1`);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('Content-Type'),'application/x-ndjson');
  assert.equal((await watch(f.app)).status,409);
  const census=await (await f.app.fetch(request(censusPath),env,context)).json();
  assert.equal(census.instanceId,first.instanceId); assert.equal(f.calls,0); assert.equal(f.builds,1);
  const lease=f.pool.tryAcquire(1024), release=lease.retain(); lease.release();
  const next=reader.read(); await flush(); t.mock.timers.tick(999); await flush();
  let resolved=false; next.then(()=>resolved=true); await flush(); assert.equal(resolved,false);
  t.mock.timers.tick(1); const held=decode((await next).value);
  assert.equal(held.instanceId,first.instanceId); assert.equal(held.watchEpoch,1);
  assert.equal(held.sequence,2); assert.equal(held.requests,1); assert.equal(held.reservedBytes,1024);
  assert.equal((await primary(f.app,peer)).status,200); assert.equal(f.calls,1);
  await reader.cancel(); assert.equal(f.pool.snapshot().requests,1);
  assert.equal((await primary(f.app,peer)).status,409); assert.equal(f.calls,1);
  release(); assert.equal(f.pool.snapshot().requests,0);
  const replacement=await watch(f.app); t.after(()=>replacement.body.cancel());
  assert.equal(replacement.headers.get(peerHeader),`${first.instanceId}:2`);
  assert.equal((await primary(f.app,peer)).status,409);
  assert.equal((await primary(f.app,replacement.headers.get(peerHeader))).status,200);
});

test('simultaneous watches cannot both claim the numeric slot', async t => {
  const f=fixture(t), results=await Promise.all([watch(f.app),watch(f.app),watch(f.app)]);
  t.after(()=>Promise.all(results.map(r=>r.body.cancel())));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409,409]); assert.equal(f.calls,0);
});

test('same epoch in another pool is rejected before handler or body consumption', async t => {
  const a=fixture(t), b=fixture(t), ar=await watch(a.app), br=await watch(b.app);
  t.after(()=>Promise.all([ar.body.cancel(),br.body.cancel()]));
  let pulls=0;
  const body=new ReadableStream({pull(){pulls++;}},{highWaterMark:0});
  const r=await primary(b.app,ar.headers.get(peerHeader),{body,duplex:'half'});
  assert.equal(r.status,409); assert.equal(pulls,0); assert.equal(b.calls,0);
  assert.equal((await r.json()).dispatch_started,false); assert.equal(b.pool.snapshot().requests,0);
  await body.cancel();
});

test('pending pull cancellation wakes safely and does not release a retained lease', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t), r=await watch(f.app), reader=r.body.getReader(), lease=f.pool.tryAcquire(1024);
  await reader.read(); const pending=reader.read(); await flush();
  await reader.cancel(); assert.equal((await pending).done,true);
  t.mock.timers.tick(SSE_CAPACITY_WATCH_LIFETIME_MS*2); await flush();
  assert.equal(f.pool.snapshot().requests,1); lease.release();
  assert.equal((await primary(f.app,r.headers.get(peerHeader))).status,409);
});

test('local Request signal abort errors watch and preserves business lease (not native Workers evidence)', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t), abort=new AbortController(), r=await watch(f.app,{signal:abort.signal});
  const reader=r.body.getReader(), lease=f.pool.tryAcquire(1024);
  await reader.read(); const pending=reader.read(); await flush();
  const rejected=assert.rejects(pending,/observation aborted/); abort.abort(); await rejected;
  t.mock.timers.tick(SSE_CAPACITY_WATCH_LIFETIME_MS*2); await flush();
  assert.equal(f.pool.snapshot().requests,1); lease.release();
  const replacement=await watch(f.app); await replacement.body.cancel();
});

test('already aborted request cannot occupy the watch slot', async t => {
  const f=fixture(t), abort=new AbortController(); abort.abort();
  assert.equal((await watch(f.app,{signal:abort.signal})).status,409);
  const r=await watch(f.app); assert.equal(r.headers.get(peerHeader).endsWith(':1'),true); await r.body.cancel();
});

test('unread watch queues only initial sample and deadline end, never replay history or DONE', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t), r=await watch(f.app), lease=f.pool.tryAcquire(1024);
  t.mock.timers.tick(SSE_CAPACITY_WATCH_LIFETIME_MS); await flush();
  const text=await r.text(), frames=text.trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(frames.length,2); assert.equal(frames[0].sequence,1);
  assert.equal(frames[1].kind,'end'); assert.equal(frames[1].reason,'deadline');
  assert.ok(Buffer.byteLength(text)<=1024); assert.equal(text.includes('[DONE]'),false);
  assert.equal(f.pool.snapshot().requests,1); lease.release();
  assert.equal((await primary(f.app,r.headers.get(peerHeader))).status,409);
});

test('continuously read stream is bounded by 180 samples, each at most 512 bytes', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t), r=await watch(f.app), reader=r.body.getReader();
  t.after(()=>reader.cancel());
  let total=0;
  for(let i=1;i<=SSE_CAPACITY_WATCH_MAX_SAMPLES;i++) {
    const pending=reader.read(); await flush();
    if(i>1)t.mock.timers.tick(1000);
    const row=await pending; total+=row.value.byteLength;
    assert.ok(row.value.byteLength<=512); assert.equal(decode(row.value).sequence,i);
  }
  const end=decode((await reader.read()).value);
  assert.equal(end.reason,'sample-limit'); assert.equal((await reader.read()).done,true);
  assert.ok(total+512<128*1024); assert.equal(f.calls,0);
});

for(const [label,make,status] of [
  ['missing watch header',()=>request(watchPath),400],
  ['wrong watch header',()=>request(watchPath,{headers:{[watchHeader]:'v2'}}),400],
  ['query',()=>request(watchPath+'?reset=1',{headers:{[watchHeader]:'v1'}}),400],
  ['fragment',()=>request(watchPath+'#reset',{headers:{[watchHeader]:'v1'}}),400],
  ['POST',()=>request(watchPath,{method:'POST',body:'unread',headers:{[watchHeader]:'v1'}}),400],
  ['HEAD',()=>request(watchPath,{method:'HEAD',headers:{[watchHeader]:'v1'}}),400],
  ['Upgrade',()=>request(watchPath,{headers:{[watchHeader]:'v1',Upgrade:''}}),400],
  ['unexpected peer',()=>request(watchPath,{headers:{[watchHeader]:'v1',[peerHeader]:'x'}}),400],
  ['production origin',()=>new Request('https://api.cinatoken.com'+watchPath,{headers:{[watchHeader]:'v1'}}),404],
  ['peer on health',()=>request('/health',{headers:{[peerHeader]:'x'}}),400],
  ['watch on health',()=>request('/health',{headers:{[watchHeader]:'v1'}}),400],
  ['missing peer',()=>request('/v1/images/generations',{method:'POST',body:'unread'}),400],
  ['malformed peer',()=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:'x'}}),400],
  ['unsafe epoch',()=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:randomUUID()+':9007199254740992'}}),400],
  ['zero epoch',()=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:randomUUID()+':0'}}),400],
  ['leading zero epoch',()=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:randomUUID()+':01'}}),400],
  ['oversized peer',()=>request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:'x'.repeat(10000)}}),400],
  ['GET inference',()=>request('/v1/images/generations',{headers:{[peerHeader]:randomUUID()+':1'}}),400],
])test('rejects '+label+' before downstream I/O',async t=>{
  const f=fixture(t), r=await f.app.fetch(make(),env,context);
  assert.equal(r.status,status); assert.equal((await r.json()).dispatch_started,false);
  assert.equal(f.calls,0); assert.equal(f.pool.snapshot().requests,0);
});

for(const patch of [{DATABASE_DRIVER:'postgres'},{REQUEST_BODY_LOGGING:'on'},{BATCH_API_ENABLED:'true'}])
  test('rejects non-profile bindings '+JSON.stringify(patch),async t=>{
    const f=fixture(t), r=await f.app.fetch(request(watchPath,{headers:{[watchHeader]:'v1'}}),{...env,...patch},context);
    assert.equal(r.status,404); assert.equal(f.calls,0);
  });

test('real gateway exposes only HTTP and census/watch bypass all database and upstream I/O', async t=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No network'));
  const app=createImagesSseCapacityPeerGateway(async()=>assert.fail('No upstream'));
  assert.deepEqual(Object.keys(app),['fetch']);
  const r=await watch(app); t.after(()=>r.body.cancel());
  assert.equal((await primary(app,randomUUID()+':1',{body:'unread'})).status,409);
  const invalidProbe=await primary(app,r.headers.get(peerHeader),{headers:{[SSE_HOST_EXPIRY_HEADER]:'wrong'}});
  assert.equal(invalidProbe.status,400);
  // Real maintenance proves matched entry still traverses business capacity.
  await invalidProbe.body?.cancel();
  const tasks=[], businessContext={waitUntil(p){tasks.push(p);p.catch(()=>{});}};
  t.after(async()=>{for(const task of tasks)await task.catch(()=>{});});
  const maintenance=await app.fetch(request('/v1/images/generations',{method:'POST',headers:{[peerHeader]:r.headers.get(peerHeader)}}),
    {...env,CINATOKEN_MAINTENANCE_MODE:'true'},businessContext);
  assert.equal(maintenance.status,503); assert.match(await maintenance.text(),/maintenance_mode/);
});

test('pure candidate changes only main; retains every closed isolated binding',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'), production=readJsonc('packages/proxy/wrangler.base.jsonc');
  const before=structuredClone(staging), base=imagesSseCapacityStagingConfig(staging,production);
  const candidate=imagesSseCapacityPeerStagingConfig(staging,production);
  assert.deepEqual(candidate,{...base,main:'scripts/staging/images-sse-capacity-peer-gateway.ts'});
  assert.deepEqual(staging,before); assert.equal(candidate.workers_dev,false); assert.equal(candidate.preview_urls,false);
  assert.deepEqual(candidate.routes,[]); assert.deepEqual(candidate.triggers,{crons:[]});
  for(const patch of [{name:production.name},{workers_dev:true},{preview_urls:true}])
    assert.throws(()=>imagesSseCapacityPeerStagingConfig({...staging,...patch},production));
});

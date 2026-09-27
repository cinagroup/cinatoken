import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { withUndeliveredImageSuccess, UNDELIVERED_IMAGE_GATE_MS } from './images-undelivered-handler.ts';
import { imageStorageFaultHeader, IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import { imagesUndeliveredStagingConfig } from '../../../../scripts/deploy/prepare-staging-undelivered.mjs';
import { imagesFencingStagingConfig } from '../../../../scripts/deploy/prepare-proxy-staging-images.mjs';
import { readJsonc } from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const header=mode=>imageStorageFaultHeader({runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode});
function context(){const holds=[],ctx={waitUntil(p){assert.equal(this,ctx);holds.push(p);p.catch(()=>undefined);}};return{ctx,holds};}
function request(value,path='/v1/images/generations',method='POST'){return new Request('https://example.invalid'+path,{method,headers:value?{[IMAGE_STORAGE_FAULT_HEADER]:value}:{}});}

for(const operation of ['generations','edits'])for(const mode of ['before-abort','after-abort'])test(operation+' '+mode+': no success response escapes; fixed timeout fails closed and cancels without reading',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0,pulls=0,cancels=0;
  const {ctx,holds}=context(),env={},req=request(header(mode),'/v1/images/'+operation);
  const original=new Response(new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}),{headers:{'X-Generation-Id':'gen-sensitive','X-Upstream-Request-Id':'private-result'}});
  const handler=withUndeliveredImageSuccess({fetch(r,e,c){calls++;assert.equal(r,req);assert.equal(e,env);assert.equal(c,ctx);return original;}});
  let returned=false;const pending=handler.fetch(req,env,ctx).then(r=>{returned=true;return r;});
  assert.equal(holds.length,1);assert.equal(calls,0);
  await flush();assert.equal(calls,1);assert.equal(returned,false);assert.equal(pulls,0);
  t.mock.timers.tick(UNDELIVERED_IMAGE_GATE_MS-1);await flush();assert.equal(returned,false);
  t.mock.timers.tick(1);const result=await pending;assert.equal(result.status,503);
  assert.equal(await result.text(),'C02_STAGING_DELIVERY_GATE_EXPIRED');
  assert.equal(result.headers.get('X-Generation-Id'),null);assert.equal(result.headers.get('X-Upstream-Request-Id'),null);
  assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal(pulls,0);assert.equal(cancels,1);
  await Promise.all(holds);assert.equal(holds.length,2);
});

test('ordinary, malformed, non-native and out-of-scope requests keep the original response identity',async()=>{
  for(const req of [request(null),request('bad'),request(header('before-fail')),request(header('before-abort'),'/health'),request(header('before-abort'),'/v1/images/edits','GET')]){
    const {ctx,holds}=context(),response=new Response('control');let calls=0;
    const h=withUndeliveredImageSuccess({fetch(){calls++;return response;}});
    assert.equal(await h.fetch(req,{},ctx),response);assert.equal(calls,1);assert.equal(holds.length,0);
  }
});
test('native-probe admission errors retain status and response identity; no gate timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const status of [400,401,403,413,429,499,500,503]){
    const {ctx,holds}=context(),response=new Response('original',{status});
    const h=withUndeliveredImageSuccess({fetch(){return response;}});
    assert.equal(await h.fetch(request(header('before-abort')),{},ctx),response);await Promise.all(holds);
  }
});
test('dispatch rejection stays rejected in both delivery and its registered host hold',async()=>{
  const {ctx,holds}=context(),failure=new Error('original error');
  const h=withUndeliveredImageSuccess({fetch(){throw failure;}});
  await assert.rejects(h.fetch(request(header('before-abort')),{},ctx),e=>e===failure);
  assert.equal(holds.length,1);await assert.rejects(holds[0],e=>e===failure);
});
test('independent requests cannot open each other\'s response gate',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {ctx}=context();
  const h=withUndeliveredImageSuccess({fetch(){return new Response('private');}});
  let first=false,second=false;
  const a=h.fetch(request(header('before-abort')),{},ctx).then(r=>{first=true;return r;});await flush();
  t.mock.timers.tick(5000);
  const b=h.fetch(request(header('after-abort')),{},ctx).then(r=>{second=true;return r;});await flush();
  t.mock.timers.tick(5000);await a;assert.equal(first,true);assert.equal(second,false);
  t.mock.timers.tick(5000);await b;assert.equal(second,true);
});
test('undelivered config changes only the explicit entry; keeps staging closed and rejects production resource reuse',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'),production=readJsonc('packages/proxy/wrangler.base.jsonc');
  const old=imagesFencingStagingConfig(staging,production),candidate=imagesUndeliveredStagingConfig(staging,production);
  assert.equal(candidate.main,'scripts/staging/images-undelivered-gateway.ts');
  assert.deepEqual({...candidate,main:old.main},old);
  assert.equal(candidate.workers_dev,false);assert.equal(candidate.preview_urls,false);assert.deepEqual(candidate.routes,[]);
  assert.throws(()=>imagesUndeliveredStagingConfig({...staging,name:production.name},production));
});

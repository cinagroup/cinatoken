import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withSsePeerV3InstanceDiagnostic as wrap} from './images-sse-capacity-peer-diagnostic-handler.ts';
import {observeImagesSseCapacityPeerV3} from './images-sse-capacity-peer-observation-v3.ts';
import {SSE_CAPACITY_ORIGIN as origin,SSE_CAPACITY_PATH as censusPath} from './images-sse-capacity-observation.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {captureSseCapacityPrimaryV3,isSseCapacityPeerV3Mismatch} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol-v3.mjs';
import {classifySsePeerV3MismatchDiagnostic as classify} from '../../../../scripts/deploy/staging-sse-peer-mismatch-diagnostic.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
const path='/__staging/sse-capacity/watch-v3',diag='x-c02-peer-diagnostic',observed='x-c02-peer-observed-instance';
const env={DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'},ctx={waitUntil(){assert.fail('No new background work');}};
function fixture(t){
  const runtime=installPeerV3TestRuntime(t);let calls=0,lease,pool,status=200;
  const inner=observeImagesSseCapacityPeerV3(policy=>{pool=policy.pool;return {async fetch(){calls++;
    if(status!==200)return new Response('rejected',{status});
    lease=pool.tryAcquire(1024);assert.ok(lease);
    return new Response('unread SSE',{headers:{'content-type':'text/event-stream','x-generation-id':'gen-'+randomUUID()}});
  }};});
  const app=wrap(inner),clock=createSseOperatorClock();
  const start=async()=>{const response=await app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',headers:{'x-c02-capacity-primary':'v3'}}),env,ctx);
    return {response,primary:response.status===200?captureSseCapacityPrimaryV3(response,clock.sample(),clock.clockId):null};};
  const watch=(primary,patch={})=>app.fetch(new Request(origin+path,{headers:{Upgrade:'websocket','x-c02-capacity-watch':'v3','x-c02-capacity-peer':primary.peer},...patch}),env,ctx);
  t.after(()=>lease?.release());
  return {app,inner,start,watch,runtime,get calls(){return calls;},get pool(){return pool;},release(){lease?.release();},setStatus(value){status=value;}};
}
async function evidence(primary,response){return {primary,status:response.status,headers:response.headers,body:new Uint8Array(await response.arrayBuffer()),complete:true};}

test('actual foreign composed instance narrows canonical mismatch without business work',async t=>{
  const f=fixture(t),g=fixture(t),{primary,response}=await f.start();
  const rejected=await g.watch(primary),value=await evidence(primary,rejected),result=classify(value);
  assert.equal(isSseCapacityPeerV3Mismatch(value),true);assert.equal(result.classification,'instance_mismatch');
  assert.notEqual(result.observedInstance,primary.instanceId);assert.equal(g.calls,0);assert.equal(g.pool.snapshot().requests,0);
  assert.equal(f.pool.snapshot().requests,1);assert.equal(response.bodyUsed,false);
  assert.equal(result.capacityProof,false);assert.equal(result.nativeProof,false);assert.equal(result.retryAuthorization,false);
  assert.equal(Object.isFrozen(result),true);await response.body.cancel();
});
test('same instance actual older primary narrows to epoch mismatch',async t=>{
  const f=fixture(t),first=await f.start();f.release();const second=await f.start();
  assert.equal(first.primary.instanceId,second.primary.instanceId);assert.notEqual(first.primary.peer,second.primary.peer);
  const result=classify(await evidence(first.primary,await f.watch(first.primary)));
  assert.equal(result.classification,'epoch_mismatch');assert.equal(result.sameInstance,true);assert.equal(result.epochValueKnown,false);
  assert.equal(f.calls,2);assert.equal(f.pool.snapshot().requests,1);
});
test('failed later primary invalidates prior eligible epoch without claiming epoch value',async t=>{
  const f=fixture(t),first=await f.start();f.release();f.setStatus(400);assert.equal((await f.start()).response.status,400);
  assert.equal(classify(await evidence(first.primary,await f.watch(first.primary))).classification,'epoch_mismatch');
});
test('actual successful upgrade is unchanged and no diagnostics are added',async t=>{
  const f=fixture(t),{primary,response}=await f.start(),upgrade=await f.watch(primary);
  assert.equal(upgrade.status,101);assert.equal(upgrade.webSocket,f.runtime.pairs[0][0]);
  assert.equal(upgrade.headers.has(diag),false);assert.equal(response.headers.has(diag),false);assert.equal(response.bodyUsed,false);
  assert.equal(f.calls,1);assert.equal(f.pool.snapshot().requests,1);
});
for(const mode of ['released','already-watched','aborted'])test('different rejection never classified as mismatch: '+mode,async t=>{
  const f=fixture(t),{primary}=await f.start();let patch={};
  if(mode==='released')f.release();
  if(mode==='already-watched')await f.watch(primary);
  if(mode==='aborted'){const ac=new AbortController();ac.abort();patch={signal:ac.signal};}
  const value=await evidence(primary,await f.watch(primary,patch));assert.equal(value.status,409);assert.throws(()=>classify(value));
});
for(const header of [diag,observed])test('reserved input cannot be reflected or forwarded: '+header,async()=>{
  let calls=0;const app=wrap({async fetch(){calls++;assert.fail('No delegation');}});
  const request=new Request(origin+'/v1/images/generations',{method:'POST',headers:{[header]:'forged'},body:'unread'});
  const r=await app.fetch(request,env,ctx);assert.equal(r.status,400);assert.equal(calls,0);assert.equal(request.bodyUsed,false);
  assert.equal(r.headers.has(diag),false);assert.equal((await r.json()).dispatch_started,false);
});
test('wrapper preserves original body ownership and exact request/context',async()=>{
  let pulls=0,cancels=0,censusCancels=0,calls=0;
  const body=new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0});
  const original=new Response(body,{status:409,statusText:'Conflict',headers:{'cache-control':'no-store'}});
  original.clone=()=>assert.fail('No clone');body.tee=()=>assert.fail('No tee');body.getReader=()=>assert.fail('No body reader');
  const request=new Request(origin+path),id=randomUUID();
  const app=wrap({async fetch(r,e,c){assert.equal(e,env);assert.equal(c,ctx);calls++;
    if(calls===1){assert.equal(r,request);return original;}
    assert.equal(r.url,origin+censusPath);return new Response(new ReadableStream({cancel(){censusCancels++;}},{highWaterMark:0}),{headers:{'x-c02-capacity-instance':id}});
  }});
  const result=await app.fetch(request,env,ctx);assert.equal(result.body,body);assert.equal(result.status,409);assert.equal(result.statusText,'Conflict');
  assert.equal(result.headers.get(observed),id);assert.equal(pulls+cancels,0);assert.equal(censusCancels,1);assert.equal(calls,2);
  assert.equal(original.bodyUsed,false);assert.equal(original.headers.has(diag),false);await result.body.cancel();
});
for(const [name,url,method,status] of [
  ['success',origin+path,'GET',200],['other rejection',origin+path,'GET',400],['foreign origin','https://other.invalid'+path,'GET',409],
  ['other path',origin+'/v1/images/generations','GET',409],['query',origin+path+'?x=1','GET',409],['fragment',origin+path+'#x','GET',409],['POST',origin+path,'POST',409],
])test('no extra census or replacement outside scope: '+name,async()=>{
  const original=new Response('original',{status});let calls=0;
  const app=wrap({async fetch(){calls++;return original;}});
  assert.equal(await app.fetch(new Request(url,{method}),env,ctx),original);assert.equal(calls,1);
});
for(const id of [null,'',randomUUID()+', '+randomUUID(),'x'.repeat(4096),'00000000-0000-0000-0000-000000000000'])
test('invalid census UUID retains exact original response: '+String(id).slice(0,45),async()=>{
  const original=new Response('original',{status:409});let calls=0;
  const app=wrap({async fetch(){if(++calls===1)return original;return new Response(null,{headers:id===null?{}:{'x-c02-capacity-instance':id}});}});
  assert.equal(await app.fetch(new Request(origin+path),env,ctx),original);assert.equal(calls,2);
});
for(const [name,mutate] of [
  ['missing version',v=>v.headers.delete(diag)],['wrong version',v=>v.headers.set(diag,'v2')],['duplicate version',v=>v.headers.append(diag,'instance-v1')],
  ['missing UUID',v=>v.headers.delete(observed)],['bad UUID',v=>v.headers.set(observed,'x')],['oversized UUID',v=>v.headers.set(observed,'x'.repeat(4096))],
  ['duplicate UUID',v=>v.headers.append(observed,randomUUID())],['incomplete',v=>v.complete=false],['wrong status',v=>v.status=200],
  ['truncated',v=>v.body=v.body.subarray(0,20)],['extra body field',v=>v.body=Buffer.from(v.body.toString().replace('}',',"extra":1}'))],
  ['duplicate body field',v=>v.body=Buffer.from(v.body.toString().replace('"status":','"status":"rejected","status":'))],
  ['cacheable',v=>v.headers.set('cache-control','public')],['wrong media',v=>v.headers.set('content-type','text/html')],
  ['altered primary baseline',v=>v.primary={...v.primary,before:'1/1024'}],['extra primary field',v=>v.primary={...v.primary,extra:1}],
])test('fail closed on invalid diagnostic evidence: '+name,async t=>{
  const f=fixture(t),{primary}=await f.start();f.release();await f.start();
  const value=await evidence(primary,await f.watch(primary));value.body=Buffer.from(value.body);mutate(value);assert.throws(()=>classify(value));
});

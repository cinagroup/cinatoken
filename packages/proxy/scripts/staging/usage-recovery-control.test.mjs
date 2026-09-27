import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createUsageRecoveryControl, RECOVERY_COMMAND_BODY_TIMEOUT_MS } from '../../src/runtime/usage-recovery-control.ts';
import worker from './usage-recovery-control-worker.ts';

const aud='a'.repeat(64), path='https://control.example.invalid/_control/usage-recovery/run';
const command={'X-CinaToken-Recovery-Command':'run-once-v1'};
const settings={RECOVERY_CONTROL_ENVIRONMENT:'staging',RECOVERY_CONTROL_ENABLED:'true',RECOVERY_CONTROL_ACCESS_AUD:aud};
const result={status:'finished',runId:'00000000-0000-4000-8000-000000000001',result:{scanned:1,claimed:1,committed:1,blocked:0,deferred:0,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false}};
const request=(init={})=>new Request(path,{method:'POST',headers:command,...init});
function context(access={aud,getIdentity(){assert.fail('No identity/PII lookup');}}) {
  const tasks=[];return {access,tasks,waitUntil(task){assert.equal(this.tasks,tasks);tasks.push(task);}};
}
function fixture(t,run=async()=>result) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No public HTTP/provider/KMS calls'));
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>assert.fail('Unexpected local test log '+method+': '+String(args[0])));
  let calls=0;
  const service={async run(...args){assert.equal(this,service);assert.deepEqual(args,[]);calls++;return run();}};
  return {env:{...settings,USAGE_RECOVERY:service},control:createUsageRecoveryControl(),ctx:context(),get calls(){return calls;}};
}
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('actual control Worker wiring authenticates native context and calls one argument-free RPC',async t=>{
  const f=fixture(t);assert.deepEqual(Object.keys(worker),['fetch']);
  const response=await worker.fetch(request(),f.env,f.ctx);await Promise.all(f.ctx.tasks);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{...result,retry_safe:false});
  assert.equal(f.calls,1);assert.equal(f.ctx.tasks.length,1);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
});
for(const [name,change] of [
  ['disabled',e=>e.RECOVERY_CONTROL_ENABLED='false'],['unset flag',e=>delete e.RECOVERY_CONTROL_ENABLED],
  ['truthy flag',e=>e.RECOVERY_CONTROL_ENABLED='1'],['production',e=>e.RECOVERY_CONTROL_ENVIRONMENT='production'],
  ['no audience',e=>e.RECOVERY_CONTROL_ACCESS_AUD=''],['bad audience',e=>e.RECOVERY_CONTROL_ACCESS_AUD='synthetic'],
  ['overlong audience',e=>e.RECOVERY_CONTROL_ACCESS_AUD='a'.repeat(65)],
])test('closed without RPC: '+name,async t=>{
  const f=fixture(t);change(f.env);assert.equal((await f.control.fetch(request(),f.env,f.ctx)).status,503);assert.equal(f.calls,0);assert.equal(f.ctx.tasks.length,0);
});
for(const access of [undefined,null,{aud:'b'.repeat(64)},{aud:aud+'x'},{}])test('missing/wrong native Access context rejects forged headers: '+String(access?.aud),async t=>{
  const f=fixture(t),ctx=context();ctx.access=access;
  const response=await f.control.fetch(request({headers:{...command,Authorization:'Bearer fake','Cf-Access-Jwt-Assertion':'forged','Cf-Access-Client-Id':'fake','Cf-Access-Client-Secret':'fake','Cookie':'CF_Authorization=forged','X-User-Role':'admin'}}),f.env,ctx);
  assert.equal(response.status,403);assert.equal(f.calls,0);assert.equal(ctx.tasks.length,0);
});
for(const [name,req] of [
  ['GET',()=>request({method:'GET'})],['OPTIONS',()=>request({method:'OPTIONS'})],['wrong path',()=>new Request(path+'/extra',{method:'POST',headers:command})],
  ['tenant query',()=>new Request(path+'?tenant=other',{method:'POST',headers:command})],['fragment',()=>new Request(path+'#run',{method:'POST',headers:command})],
  ['insecure HTTP',()=>new Request(path.replace('https:','http:'),{method:'POST',headers:command})],
  ['overlong URL',()=>new Request(path+'?'+ 'a'.repeat(2048),{method:'POST',headers:command})],
])test('unsupported invocation has no RPC: '+name,async t=>{
  const f=fixture(t);assert.equal((await f.control.fetch(req(),f.env,f.ctx)).status,404);assert.equal(f.calls,0);
});
for(const [name,init] of [
  ['no command',{headers:{}}],['wrong command',{headers:{...command,'X-CinaToken-Recovery-Command':'run-all'}}],
  ['browser origin',{headers:{...command,Origin:'https://evil.invalid'}}],['null origin',{headers:{...command,Origin:'null'}}],
  ['JSON parameters',{body:'{"tenant":"other","maxItems":50}'}],
  ['positive content length',{headers:{...command,'Content-Length':'1'}}],['ambiguous content length',{headers:{...command,'Content-Length':'00'}}],
  ['chunked',{headers:{...command,'Transfer-Encoding':'chunked'}}],
])test('no-body machine command contract: '+name,async t=>{
  const f=fixture(t);assert.equal((await f.control.fetch(request(init),f.env,f.ctx)).status,400);assert.equal(f.calls,0);
});
test('zero Content-Length with absent body is accepted',async t=>{
  const f=fixture(t);assert.equal((await f.control.fetch(request({headers:{...command,'Content-Length':'0'}}),f.env,f.ctx)).status,200);assert.equal(f.calls,1);
});

for(const [reason,init] of [
  ['browser_origin',{headers:{...command,Origin:'https://private.invalid'}}],
  ['command_header',{headers:{'X-CinaToken-Recovery-Command':'private-command'}}],
  ['transfer_encoding',{headers:{...command,'Transfer-Encoding':'private-coding'}}],
  ['content_length',{headers:{...command,'Content-Length':'12345'}}],
  ['body_not_empty',{body:'private-body'}],
])test('authorized command rejection exposes only fixed reason: '+reason,async t=>{
  const f=fixture(t),response=await f.control.fetch(request(init),f.env,f.ctx);
  assert.deepEqual(await response.json(),{status:'invalid_command',reason});
  assert.equal(f.calls,0);assert.equal(f.ctx.tasks.length,reason==='body_not_empty'?1:0);
  const anonymous=context();anonymous.access=undefined;
  assert.deepEqual(await (await f.control.fetch(request(init),f.env,anonymous)).json(),{status:'forbidden'});
});

for(const [name,init] of [
  ['explicit empty string',()=>({body:''})],
  ['closed byte stream',()=>({body:new ReadableStream({type:'bytes',start(c){c.close();}}),duplex:'half'})],
  ['empty with length zero',()=>({body:'',headers:{...command,'Content-Length':'0'}})],
])test('zero-byte body accepts EOF independent of null identity: '+name,async t=>{
  const f=fixture(t),req=request(init());assert.notEqual(req.body,null);
  assert.equal((await f.control.fetch(req,f.env,f.ctx)).status,200);assert.equal(f.calls,1);await Promise.all(f.ctx.tasks);
  assert.equal(req.body.locked,false);
});

test('one-byte BYOB probe rejects a forged zero length without draining or default-reader fallback',async t=>{
  const f=fixture(t);let pulls=0,cancels=0;
  const body=new ReadableStream({type:'bytes',pull(c){pulls++;assert.equal(c.byobRequest.view.byteLength,1);c.byobRequest.view[0]=120;c.byobRequest.respond(1);},cancel(){cancels++;}},{highWaterMark:0});
  const req=request({body,duplex:'half',headers:{...command,'Content-Length':'0'}});
  const getReader=req.body.getReader.bind(req.body);t.mock.method(req.body,'getReader',options=>{assert.deepEqual(options,{mode:'byob'});return getReader(options);});
  const response=await f.control.fetch(req,f.env,f.ctx);
  assert.deepEqual(await response.json(),{status:'invalid_command',reason:'body_not_empty'});
  assert.equal(pulls,1);assert.equal(cancels,1);assert.equal(f.calls,0);assert.equal(req.body.locked,false);
});

test('waitUntil and busy admission precede any byte read; delayed EOF alone permits RPC',async t=>{
  const entered=latch(),f=fixture(t);let controller;
  const body=new ReadableStream({type:'bytes',start(c){controller=c;},pull(){assert.equal(f.ctx.tasks.length,1);assert.equal(f.calls,0);entered.resolve();}},{highWaterMark:0});
  const first=f.control.fetch(request({body,duplex:'half'}),f.env,f.ctx);await entered.promise;
  const second=context();assert.deepEqual(await (await f.control.fetch(request(),f.env,second)).json(),{status:'control_busy'});assert.equal(second.tasks.length,0);
  const pending=controller.byobRequest;controller.close();pending.respond(0);
  assert.equal((await first).status,200);assert.equal(f.calls,1);await Promise.all(f.ctx.tasks);
});

for(const cause of ['timeout','abort'])test('body '+cause+' never mistakes cancel EOF for success or frees a pending cancel',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const entered=latch(),cancelEntered=latch(),release=latch(),f=fixture(t),abort=new AbortController();let cancels=0;
  const body=new ReadableStream({type:'bytes',pull(){entered.resolve();},cancel(){cancels++;cancelEntered.resolve();return release.promise;}},{highWaterMark:0});
  let resolved=false;const first=f.control.fetch(request({body,duplex:'half',signal:abort.signal}),f.env,f.ctx).then(r=>{resolved=true;return r;});
  await entered.promise;if(cause==='timeout')t.mock.timers.tick(RECOVERY_COMMAND_BODY_TIMEOUT_MS);else abort.abort('private abort reason');
  await cancelEntered.promise;await tick();assert.equal(resolved,false);assert.equal(f.calls,0);assert.equal(cancels,1);
  assert.deepEqual(await (await f.control.fetch(request(),f.env,context())).json(),{status:'control_busy'});
  assert.equal((await f.control.fetch(request(),{...f.env,RECOVERY_CONTROL_ENABLED:'false'},context())).status,503);
  if(cause==='abort')abort.abort();t.mock.timers.tick(RECOVERY_COMMAND_BODY_TIMEOUT_MS);assert.equal(cancels,1);
  release.resolve();const response=await first;assert.equal(response.status,cause==='timeout'?408:409);
  assert.equal(f.calls,0);await Promise.all(f.ctx.tasks);assert.equal(body.locked,false);
  assert.equal((await f.control.fetch(request(),f.env,context())).status,200);assert.equal(f.calls,1);
});

test('body read error is fixed/redacted, unlocks and never reaches RPC',async t=>{
  const f=fixture(t),body=new ReadableStream({type:'bytes',pull(){throw new Error('private provider credential');}},{highWaterMark:0});
  const response=await f.control.fetch(request({body,duplex:'half'}),f.env,f.ctx);
  assert.deepEqual(await response.json(),{status:'invalid_command',reason:'body_unreadable'});assert.equal(f.calls,0);assert.equal(body.locked,false);
  assert.equal((await f.control.fetch(request(),f.env,context())).status,200);
});

test('rejected cancel is handled before release and does not permit an RPC',async t=>{
  const f=fixture(t);let cancelled=0;
  const body=new ReadableStream({type:'bytes',pull(c){c.byobRequest.view[0]=1;c.byobRequest.respond(1);},cancel(){cancelled++;throw new Error('private cancel error');}},{highWaterMark:0});
  assert.equal((await f.control.fetch(request({body,duplex:'half'}),f.env,f.ctx)).status,400);
  assert.equal(cancelled,1);assert.equal(f.calls,0);assert.equal(body.locked,false);await Promise.all(f.ctx.tasks);
});

test('registration failure cannot acquire or read a body; borrowed reader remains untouched',async t=>{
  const f=fixture(t);let pulls=0;const body=new ReadableStream({type:'bytes',pull(){pulls++;}},{highWaterMark:0});
  const ctx=context();ctx.waitUntil=function(task){this.tasks.push(task);throw new Error('host rejection');};
  assert.equal((await f.control.fetch(request({body,duplex:'half'}),f.env,ctx)).status,503);assert.equal(pulls,0);assert.equal(body.locked,false);
  const req=request({body,duplex:'half'}),other=body.getReader({mode:'byob'});
  const response=await f.control.fetch(req,f.env,f.ctx);
  assert.deepEqual(await response.json(),{status:'invalid_command',reason:'body_unreadable'});assert.equal(body.locked,true);assert.equal(pulls,0);
  other.releaseLock();await body.cancel();await Promise.all(ctx.tasks);assert.equal(f.calls,0);
});

test('pre-aborted or unauthorized byte bodies never acquire a reader or start a pull',async t=>{
  const f=fixture(t);let pulls=0;const body=new ReadableStream({type:'bytes',pull(){pulls++;}},{highWaterMark:0}),abort=new AbortController();abort.abort();
  const req=request({body,duplex:'half',signal:abort.signal});assert.equal((await f.control.fetch(req,f.env,f.ctx)).status,409);
  const ctx=context();ctx.access=undefined;assert.equal((await f.control.fetch(request({body,duplex:'half'}),f.env,ctx)).status,403);
  assert.equal(pulls,0);assert.equal(body.locked,false);assert.equal(f.calls,0);await body.cancel();
});

test('body deadline ends at verified EOF and never times out an in-flight RPC',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const entered=latch(),release=latch(),f=fixture(t,async()=>{entered.resolve();await release.promise;return result;});
  const abort=new AbortController(),req=request({body:'',signal:abort.signal});let settled=false;
  const first=f.control.fetch(req,f.env,f.ctx).then(r=>{settled=true;return r;});await entered.promise;
  t.mock.timers.tick(RECOVERY_COMMAND_BODY_TIMEOUT_MS*2);abort.abort();await tick();assert.equal(settled,false);
  assert.equal(req.body.locked,false);assert.deepEqual(await (await f.control.fetch(request(),f.env,context())).json(),{status:'control_busy'});
  release.resolve();assert.equal((await first).status,200);assert.equal(f.calls,1);await Promise.all(f.ctx.tasks);
});
test('unbounded stream is rejected without reading it',async t=>{
  const f=fixture(t);let pulls=0;
  const body=new ReadableStream({pull(){pulls++;throw new Error('Must not read');}},{highWaterMark:0});
  const response=await f.control.fetch(request({body,duplex:'half'}),f.env,f.ctx);
  assert.equal(response.status,400);assert.equal(f.calls,0);assert.equal(pulls,0);await body.cancel();
});
test('waitUntil registration precedes RPC and registration failure performs no IO',async t=>{
  const f=fixture(t),ctx=context();ctx.waitUntil=function(task){assert.equal(f.calls,0);this.tasks.push(task);throw new Error('private host error');};
  const response=await f.control.fetch(request(),f.env,ctx);assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'host_rejected'});
  await Promise.all(ctx.tasks);assert.equal(f.calls,0);
  assert.equal((await f.control.fetch(request(),f.env,f.ctx)).status,200);assert.equal(f.calls,1);
});
for(const timing of ['before call','after registration'])test('abort before dispatch starts zero RPC: '+timing,async t=>{
  const f=fixture(t),abort=new AbortController();if(timing==='before call')abort.abort();
  const task=f.control.fetch(request({signal:abort.signal}),f.env,f.ctx);if(timing==='after registration')abort.abort();
  assert.equal((await task).status,409);assert.equal(f.calls,0);await Promise.all(f.ctx.tasks);
});
test('hung RPC retains isolate gate across disconnect and disable; busy does not enqueue',async t=>{
  const entered=latch(),release=latch(),f=fixture(t,async()=>{entered.resolve();await release.promise;return result;}),abort=new AbortController();
  let settled=false;const first=f.control.fetch(request({signal:abort.signal}),f.env,f.ctx).then(r=>{settled=true;return r;});
  await entered.promise;abort.abort();await tick();assert.equal(settled,false);
  assert.equal((await f.control.fetch(request(),{...f.env,RECOVERY_CONTROL_ENABLED:'false'},context())).status,503);
  for(let i=0;i<20;i++){const ctx=context(),res=await f.control.fetch(request(),f.env,ctx);assert.deepEqual(await res.json(),{status:'control_busy'});assert.equal(ctx.tasks.length,0);}
  assert.equal(f.calls,1);release.resolve();assert.equal((await first).status,200);await Promise.all(f.ctx.tasks);
  assert.equal((await f.control.fetch(request(),f.env,context())).status,200);assert.equal(f.calls,2);
});
test('each accepted invocation uses its own service binding; caller parameters never cross RPC',async t=>{
  const f=fixture(t),task=f.control.fetch(request(),f.env,f.ctx);f.env.USAGE_RECOVERY={run(){assert.fail('Do not reread mutable env during dispatch');}};
  assert.equal((await task).status,200);assert.equal(f.calls,1);
  let second=0;assert.equal((await f.control.fetch(request(),{...f.env,USAGE_RECOVERY:{async run(){second++;return result;}}},context())).status,200);assert.equal(second,1);
});
for(const status of ['disabled','invalid_configuration','profile_changed','busy','host_rejected','invalid_arguments'])test('receiver status has fixed unavailable response: '+status,async t=>{
  const f=fixture(t,async()=>({status,runId:'private',payload:'private'}));const response=await f.control.fetch(request(),f.env,f.ctx);
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'recovery_unavailable',retry_safe:false});assert.equal(f.calls,1);
});
for(const [name,run] of [
  ['transport reject',async()=>{throw new Error('SQL credentials private snapshot');}],['null',async()=>null],
  ['execution failure',async()=>({status:'execution_failed',runId:'private'})],['invalid result',async()=>({...result,result:{}})],
  ['overlong run ID',async()=>({...result,runId:'x'.repeat(10000)})],['overbound counter',async()=>({...result,result:{...result.result,scanned:51}})],
  ['negative counter',async()=>({...result,result:{...result.result,blocked:-1}})],['fractional counter',async()=>({...result,result:{...result.result,blocked:0.5}})],
  ['nonfinite counter',async()=>({...result,result:{...result.result,blocked:NaN}})],['invalid flag',async()=>({...result,result:{...result.result,capacityLimited:'false'}})],
  ['impossible counts',async()=>({...result,result:{...result.result,claimed:0}})],['throwing field',async()=>({get status(){throw new Error('private');}})],
  ['no object string coercion',async()=>({status:{toString(){assert.fail('Do not coerce arbitrary objects');}}})],
])test('ambiguous RPC has redacted outcome_unknown without retry: '+name,async t=>{
  const f=fixture(t,run);const response=await f.control.fetch(request(),f.env,f.ctx);await Promise.all(f.ctx.tasks);
  assert.equal(response.status,502);assert.deepEqual(await response.json(),{status:'outcome_unknown',retry_safe:false});assert.equal(f.calls,1);
});
test('projection never reads extra audit fields or toJSON; unfinished jobs are visible in counters',async t=>{
  const rich={...result,result:{...result.result,committed:0,deferred:1}};
  for(const value of [rich,rich.result])for(const name of ['privatePayload','toJSON'])Object.defineProperty(value,name,{enumerable:true,get(){assert.fail('Do not inspect extra fields');}});
  const f=fixture(t,async()=>rich),response=await f.control.fetch(request(),f.env,f.ctx);assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.result.committed,0);assert.equal(data.result.deferred,1);assert.equal(data.retry_safe,false);assert.ok(JSON.stringify(data).length<512);
});

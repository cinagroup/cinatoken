import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {byokMaintenanceFixture,TOKEN,context,deferred,destructive} from './byok-d1-maintenance-fixture.mjs';
import {BYOK_MAINTENANCE_ORIGIN,BYOK_MAINTENANCE_PATH} from './byok-d1-maintenance-contract.ts';
const {createByokD1MaintenanceControl:create}=await import(process.env.BYOK_MAINTENANCE_CONTROL_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_MAINTENANCE_CONTROL_MODULE)).href:new URL('./byok-d1-maintenance-control.ts',import.meta.url).href);
const {runByokD1Maintenance}=await import(process.env.BYOK_MAINTENANCE_HOST_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_MAINTENANCE_HOST_MODULE)).href:new URL('./byok-d1-maintenance-host.ts',import.meta.url).href);
const endpoint=BYOK_MAINTENANCE_ORIGIN+BYOK_MAINTENANCE_PATH,aud='a'.repeat(64);
const headers={Authorization:'Bearer '+TOKEN,'X-CinaToken-BYOK-Command':'cleanup-once-v1'};
const request=(init={})=>new Request(endpoint,{method:'POST',headers,...init});
const good={status:'cleaned',runId:'c02-byok-a1b2c3d4e5f6',removedRows:7,statementCount:143};
function fixture(t,run=async()=>good){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  let calls=0;const service={async run(token){assert.equal(this,service);assert.equal(token,TOKEN);calls++;return run();}};
  const ctx=context();ctx.access={aud};return {control:create(),ctx,env:{BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',
    BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:aud,USAGE_RECOVERY:service},get calls(){return calls;}};
}
test('control projects a bounded receipt, never unknown RPC fields',async t=>{
  const f=fixture(t,async()=>({...good,get private(){assert.fail('must not enumerate unknown RPC fields');}}));
  const r=await f.control.fetch(request(),f.env,f.ctx);assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{status:'cleaned',retry_safe:false,receipt:{runId:good.runId,removedRows:7,statementCount:143}});
  assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);assert.equal(f.calls,1);
});
for(const fault of ['disabled','production','missing-audience','wrong-audience','missing-access','forged-access-headers','bad-bearer','missing-bearer'])test('no RPC without explicit enable, native Access and bearer / '+fault,async t=>{
  const f=fixture(t);let h={...headers};
  if(fault==='disabled')f.env.BYOK_MAINTENANCE_CONTROL_ENABLED='false';
  if(fault==='production')f.env.BYOK_MAINTENANCE_CONTROL_ENVIRONMENT='production';
  if(fault==='missing-audience')f.env.BYOK_MAINTENANCE_ACCESS_AUD='';
  if(fault==='wrong-audience')f.ctx.access.aud='b'.repeat(64);
  if(fault==='missing-access'||fault==='forged-access-headers')delete f.ctx.access;
  if(fault==='forged-access-headers')h={...h,'Cf-Access-Jwt-Assertion':'forged','X-User-Role':'admin'};
  if(fault==='bad-bearer')h.Authorization='Bearer private-invalid';
  if(fault==='missing-bearer')delete h.Authorization;
  assert.notEqual((await f.control.fetch(request({headers:h}),f.env,f.ctx)).status,200);assert.equal(f.calls,0);assert.equal(f.ctx.tasks.length,0);
});
for(const [name,req] of [
  ['GET',()=>request({method:'GET'})],['wrong-host',()=>new Request(endpoint.replace('cinatoken-staging-recovery-control','cinatoken-proxy'),{method:'POST',headers})],
  ['path',()=>new Request(endpoint+'/other',{method:'POST',headers})],['query',()=>new Request(endpoint+'?sql=DELETE',{method:'POST',headers})],
  ['Origin',()=>request({headers:{...headers,Origin:'https://browser.invalid'}})],['command',()=>request({headers:{...headers,'X-CinaToken-BYOK-Command':'reset'}})],
  ['length',()=>request({headers:{...headers,'Content-Length':'1'}})],['transfer',()=>request({headers:{...headers,'Transfer-Encoding':'chunked'}})],
  ['data',()=>request({headers:{...headers,'Content-Length':'0'},body:'private-data'})],
])test('fixed command surface rejects / '+name,async t=>{
  const f=fixture(t),r=await f.control.fetch(req(),f.env,f.ctx);assert.ok([400,404].includes(r.status));assert.equal(f.calls,0);
  assert.doesNotMatch(await r.text(),/private-data|DELETE|browser/);
});
for(const mode of ['empty-string','empty-byte-stream','null'])test('genuine empty HTTP body accepted / '+mode,async t=>{
  const f=fixture(t),init=mode==='null'?{}:mode==='empty-string'?{body:''}:{body:new ReadableStream({type:'bytes',start(c){c.close();}}),duplex:'half'};
  assert.equal((await f.control.fetch(request(init),f.env,f.ctx)).status,200);assert.equal(f.calls,1);
});
for(const mode of ['registration-failure','pre-abort'])test('no dispatch before lifetime ownership / '+mode,async t=>{
  const f=fixture(t),abort=new AbortController();if(mode==='pre-abort')abort.abort();else f.ctx.waitUntil=()=>{throw Error('private');};
  assert.notEqual((await f.control.fetch(request({signal:abort.signal}),f.env,f.ctx)).status,200);assert.equal(f.calls,0);
});
test('body timeout cancels bounded read without dispatching or retrying',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);let cancelled=0;
  const body=new ReadableStream({type:'bytes',pull(){},cancel(){cancelled++;}},{highWaterMark:0});
  const pending=f.control.fetch(request({body,duplex:'half'}),f.env,f.ctx);await tick();t.mock.timers.tick(1000);
  assert.equal((await pending).status,408);assert.equal(f.calls,0);assert.equal(cancelled,1);
});
for(const bad of [null,{status:'cleaned',runId:[]}, {...good,removedRows:Infinity},{...good,statementCount:257},{...good,runId:['c02-byok-a1b2c3d4e5f6']}])test('malformed RPC result fails closed / '+JSON.stringify(bad),async t=>{
  const f=fixture(t,async()=>bad),r=await f.control.fetch(request(),f.env,f.ctx);assert.equal(r.status,502);assert.equal(f.calls,1);
  assert.deepEqual(await r.json(),{status:'outcome_unknown',retry_safe:false});
});
test('RPC failure never exposes raw exception or retries',async t=>{
  const f=fixture(t,async()=>{throw Error('private SQL / credential');}),r=await f.control.fetch(request(),f.env,f.ctx);
  assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/private|SQL|credential/);assert.equal(f.calls,1);
});

for(const mode of ['normal','disconnect-after-claim','lost-rpc-ack','second-context'])test('controller to durable receiver chain / '+mode,async t=>{
  const f=await byokMaintenanceFixture(t),abort=new AbortController(),entered=deferred(),release=deferred();t.after(()=>release.resolve());
  f.hooks.beforeBatch=async items=>{if(destructive(items)&&mode!=='normal'){entered.resolve();await release.promise;}};
  let calls=0;const service={async run(token){calls++;const r=await runByokD1Maintenance(f.raw,true,token,f.ctx);
    if(mode==='lost-rpc-ack')throw Error('transport ACK lost');return r;}};
  const env={BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:aud,USAGE_RECOVERY:service};
  const controller=create(),ctx=context();ctx.access={aud};const running=controller.fetch(request({signal:abort.signal}),env,ctx);
  if(mode!=='normal'){
    await entered.promise;assert.equal(f.getPermit().state,'pending');
    if(mode==='disconnect-after-claim')abort.abort();
    if(mode==='second-context'){const other=context();other.access={aud};
      assert.equal((await create().fetch(request(),env,other)).status,409);await Promise.all(other.tasks);}
    else assert.equal((await controller.fetch(request(),env,ctx)).status,503);
    release.resolve();
  }
  const r=await running;await Promise.all(ctx.tasks);await Promise.all(f.ctx.tasks);
  assert.equal(r.status,mode==='lost-rpc-ack'?502:200);assert.equal(f.getPermit().state,'finished');assert.deepEqual(f.restoreRows(),f.before);
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);assert.equal(calls,mode==='second-context'?2:1);
});

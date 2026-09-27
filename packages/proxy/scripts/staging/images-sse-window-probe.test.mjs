import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseDurableStagingGateway} from './images-sse-durable-gateway-handler.ts';
import upstream from './images-sse-window-upstream.ts';
import {imageSseWindowProbeResponse,IMAGE_SSE_HOLD_MS} from './images-sse-window-probe.ts';
import {imageSsePrompt,imageSseRow} from './images-sse-probe-contract.ts';
import {reconcileDurableSseStagingRun} from '../../../../scripts/deploy/staging-sse-durable-reconciliation.mjs';
import {SSE_STAGING_SCOPE} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {RequestExecutionStoppedError} from '../../src/services/request-deadline.ts';

async function setup(t,mode){
  const db=createSqliteD1(),tasks=[],messages=[],key='synthetic-sse-client-'+randomUUID();
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...a)=>messages.push(a));
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const counts=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{assert.match(name,/^[a-z][a-z0-9_]*$/);return [name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n];}));
  const baseline=counts();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const probe={runId:fixture.ids.runId,probeId:randomUUID(),mode:mode==='cancel'||mode==='deadline'?'hold':mode},row=imageSseRow(probe);
  db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>undefined);}};
  let sends=0;const app=createImagesSseDurableStagingGateway((input,init)=>{sends++;return upstream.fetch(new Request(input,init),{PROBE_DB:db.binding},context);});
  const abort=new AbortController();
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();};
  t.after(async()=>{abort.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  return {db,fixture,probe,row,baseline,counts,abort,drain,messages,get sends(){return sends;},
    request:()=>app.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:abort.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-Generation-Id':'spoofed-client'},
      body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:imageSsePrompt(probe),stream:true})}),env,context)};
}
const profiles=[...['success','provider-error','partial-provider-error','invalid-json','early-eof','usage-limit','property-limit','cancel','deadline'].map(mode=>({mode,action:mode})),
  ...['done-cancel','done-abort','done-cancel-after-turn','done-abort-after-turn'].map(action=>({mode:'success',action})),{mode:'cancel',action:'completed-abort'}];
for(const {mode,action} of profiles)test('completed-window real handler + durable cleanup: '+action,{timeout:15000},async t=>{
  const f=await setup(t,mode),response=await f.request();
  if(response.status!==200)assert.fail(JSON.stringify({status:response.status,body:await response.text(),messages:f.messages}));
  const id=response.headers.get('X-Generation-Id');assert.match(id,/^gen-[a-f0-9-]{36}$/);
  let wire;
  if(action.startsWith('done-')){
    const reader=response.body.getReader();wire='';
    for(;;){const r=await reader.read();assert.equal(r.done,false,'Must act at DONE, before explicit EOF');wire+=new TextDecoder().decode(r.value);if(wire.includes('data: [DONE]'))break;}
    if(action.endsWith('after-turn'))await nextTurn();
    if(action.includes('abort'))f.abort.abort();else await reader.cancel();
  }else if(mode==='cancel'||mode==='deadline'){
    const reader=response.body.getReader(),head=await reader.read();wire=new TextDecoder().decode(head.value);assert.match(wire,/image_generation.completed/);assert.doesNotMatch(wire,/\[DONE\]/);
    if(mode==='cancel'){if(action==='completed-abort')f.abort.abort();else await reader.cancel();}
    else {
      f.abort.abort(new RequestExecutionStoppedError('deadline_exceeded'));
      wire='';for(;;){const r=await reader.read();if(r.done)break;wire+=new TextDecoder().decode(r.value);}
    }
  }else wire=await response.text();
  await f.drain();assert.ok(wire.length<4096);assert.doesNotMatch(wire,/spoofed-|PRIVATE_DETAIL/);
  const records=wire.split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6));
  if(mode!=='cancel'){
    assert.equal(records.at(-1),'[DONE]');assert.equal(records.filter(s=>s==='[DONE]').length,1);
    const errors=records.filter(s=>s!=='[DONE]').map(JSON.parse).filter(s=>s.type==='error');
    assert.equal(errors.length,mode==='success'?0:1);
    if(errors.length)assert.deepEqual(errors[0].error.metadata,{retry_safe:false,...(mode==='provider-error'?{}:{outcome_unknown:true}),request_id:id});
  }
  const log=f.db.sqlite.prepare('SELECT id,status,charged_cost FROM api_key_request_logs').all();assert.equal(log.length,1);
  assert.deepEqual({...log[0]},{id,status:mode==='success'?'success':'error',charged_cost:mode==='success'?0.1:0});
  const budget=f.db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(f.fixture.ids.user);
  assert.deepEqual({...budget},{budget_spent_micros:['success','usage-limit','property-limit'].includes(mode)?100000:0,budget_reserved_micros:0});
  for(const table of ['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs'])assert.equal(f.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
  assert.equal(f.sends,1);
  const observer=JSON.parse(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(f.row.key).value);
  if(['success','cancel','deadline'].includes(mode)){
    assert.equal(observer.windowProfile,mode==='success'?'completed-and-done':'completed-without-done');
    assert.equal(observer.events.filter(e=>e.phase==='completed-enqueued').length,1);
    assert.equal(observer.events.filter(e=>e.phase==='done-enqueued').length,mode==='success'?1:0);
    assert.ok(['request_abort','response_cancel'].includes(observer.events.at(-1).reason));
  }
  assert.equal(observer.phase,'terminal');assert.equal(observer.events.filter(e=>e.phase==='terminal').length,1);
  // Gateway reader cancellation aborts its upstream request before cancelling the provider reader.
  // Direct provider-reader cancellation is covered independently in images-sse-probe.test.mjs.
  if(mode==='cancel')assert.equal(observer.events.at(-1).reason,'request_abort');
  if(mode==='deadline')assert.equal(observer.events.at(-1).reason,'request_abort');
  const scope=SSE_STAGING_SCOPE;
  const api=async path=>{
    if(path===`/workers/scripts/${scope.worker}/subdomain`)return {enabled:false,previews_enabled:false};
    if(path===`/access/apps/${scope.app}`)return {id:scope.app,type:'self_hosted',domain:scope.domain,aud:scope.audience,
      destinations:[{type:'public',uri:scope.domain}],policies:[{id:scope.policy,name:'CinaToken staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    if(path===`/d1/database/${scope.database}`)return {uuid:scope.database,name:'cinatoken-staging'};
    assert.fail('Unexpected API call '+path);
  };
  const keyRow=f.db.sqlite.prepare('SELECT key_hash,expires_at FROM api_keys WHERE id=?').get(f.fixture.ids.key);
  const journal={runId:f.fixture.ids.runId,keyHash:keyRow.key_hash,expiresAt:keyRow.expires_at,probes:[f.probe],
    requests:[{id,mode,startedAt:new Date().toISOString()}]};
  const saved=[],batch=async statements=>(await f.db.binding.batch(statements.map(s=>f.db.binding.prepare(s.sql).bind(...s.params)))).map(r=>r.results);
  const clean=()=>reconcileDurableSseStagingRun({api,batch,journal,nowMs:Date.now()+360000,persist:async e=>saved.push(e)});
  assert.equal((await clean()).alreadyRemoved,false);
  assert.equal(saved.find(e=>e.step==='durable-sse-terminal-observed').observed[5][0].state,['usage-limit','property-limit'].includes(mode)?'expired':'settled');
  assert.deepEqual(f.counts(),f.baseline);
  assert.equal((await clean()).alreadyRemoved,true);
  assert.deepEqual(f.counts(),f.baseline);
});

function rawProbe(t,mode,hooks={}){
  const db=createSqliteD1(hooks),abort=new AbortController(),tasks=[];
  const probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode},row=imageSseRow(probe);
  db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const options={probe,request:new Request('https://example.invalid',{signal:abort.signal}),db:db.binding,
    context:{waitUntil(p){tasks.push(p);p.catch(()=>undefined);}},receipt:'synthetic-window'};
  const read=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value);
  t.after(async()=>{abort.abort();await Promise.allSettled(tasks);db.sqlite.close();});
  return {db,abort,tasks,probe,row,options,read};
}
for(const mode of ['success','hold'])for(const action of ['cancel','abort','expire'])test('raw window stays open until '+action+': '+mode,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});assert.equal(IMAGE_SSE_HOLD_MS,315000);
  const f=rawProbe(t,mode),response=await imageSseWindowProbeResponse(f.options),reader=response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/image_generation.completed/);
  if(mode==='success')assert.equal(new TextDecoder().decode((await reader.read()).value),'data: [DONE]\n\n');
  let resolved=false;const waiting=reader.read().finally(()=>{resolved=true;});waiting.catch(()=>undefined);
  await nextTurn();assert.equal(resolved,false,'No automatic EOF after completed or DONE');
  if(action==='cancel'){await reader.cancel();assert.equal((await waiting).done,true);}
  else {if(action==='abort')f.abort.abort();else t.mock.timers.tick(IMAGE_SSE_HOLD_MS);await assert.rejects(waiting,{name:'AbortError'});}
  await Promise.all(f.tasks);const observed=f.read();assert.equal(observed.phase,'terminal');
  assert.equal(observed.events.at(-1).reason,action==='cancel'?'response_cancel':action==='abort'?'request_abort':'expired');
  assert.equal(observed.events.filter(e=>e.phase==='completed-enqueued').length,1);
  assert.equal(observed.events.filter(e=>e.phase==='done-enqueued').length,mode==='success'?1:0);
  assert.ok(observed.events.length<=5);
  await assert.rejects(imageSseWindowProbeResponse(f.options),/not armed/);
});
for(const fault of ['missing','owner','state','unsupported'])test('window CAS rejects '+fault,async t=>{
  const f=rawProbe(t,'success');
  if(fault==='missing')f.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run(f.row.key);
  if(fault==='owner'||fault==='state')f.db.sqlite.prepare(`UPDATE system_config SET ${fault==='owner'?'description':'value'}=? WHERE key=?`).run('unrelated',f.row.key);
  const before=f.db.sqlite.prepare('SELECT * FROM system_config').all();
  await assert.rejects(imageSseWindowProbeResponse({...f.options,probe:fault==='unsupported'?{...f.probe,mode:'early-eof'}:f.probe}),/not armed|Unsupported/);
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM system_config').all(),before);
});
test('window cancellation during prefix CAS never enqueues a completed image',async t=>{
  let release,entered;const ready=new Promise(r=>{entered=r;});
  const f=rawProbe(t,'success',{afterStatement:async(sql,values)=>{
    if(sql.startsWith('UPDATE system_config')&&JSON.parse(values[0]).phase==='body-prefix'){
      entered();await new Promise(r=>{release=r;});
    }
  }});
  const response=await imageSseWindowProbeResponse(f.options),reader=response.body.getReader(),reading=reader.read();
  await ready;const cancelling=reader.cancel();release();await cancelling;assert.equal((await reading).done,true);
  await Promise.all(f.tasks);assert.deepEqual(f.read().events.map(e=>e.phase),['started','body-prefix','terminal']);
});

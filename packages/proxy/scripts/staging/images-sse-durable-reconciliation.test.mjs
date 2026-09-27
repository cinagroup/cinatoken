import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseDurableStagingGateway} from './images-sse-durable-gateway-handler.ts';
import upstream from './images-sse-upstream.ts';
import {imageSsePrompt,imageSseRow} from './images-sse-probe-contract.ts';
import {reconcileDurableSseStagingRun,durableSseCleanupStatements} from '../../../../scripts/deploy/staging-sse-durable-reconciliation.mjs';
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
for(const mode of ['success','provider-error','partial-provider-error','invalid-json','early-eof','usage-limit','property-limit','cancel','deadline'])test('SSE public handler + durable reconciliation + full SQLite baseline: '+mode,{timeout:15000},async t=>{
  const f=await setup(t,mode),response=await f.request();
  if(response.status!==200)assert.fail(JSON.stringify({status:response.status,body:await response.text(),messages:f.messages}));
  const id=response.headers.get('X-Generation-Id');assert.match(id,/^gen-[a-f0-9-]{36}$/);
  let wire;
  if(mode==='cancel'||mode==='deadline'){
    const reader=response.body.getReader(),head=await reader.read();assert.match(new TextDecoder().decode(head.value),/partial_image/);
    if(mode==='cancel'){await reader.cancel();wire='';}
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

async function completedFixture(t){
  const f=await setup(t,'success'),response=await f.request();await response.text();await f.drain();
  const id=response.headers.get('X-Generation-Id'),scope=SSE_STAGING_SCOPE;
  const key=f.db.sqlite.prepare('SELECT key_hash,expires_at FROM api_keys WHERE id=?').get(f.fixture.ids.key);
  const journal={runId:f.fixture.ids.runId,keyHash:key.key_hash,expiresAt:key.expires_at,probes:[f.probe],requests:[{id,mode:'success',startedAt:new Date().toISOString()}]};
  const api=async path=>{
    if(path===`/workers/scripts/${scope.worker}/subdomain`)return {enabled:false,previews_enabled:false};
    if(path===`/access/apps/${scope.app}`)return {id:scope.app,type:'self_hosted',domain:scope.domain,aud:scope.audience,destinations:[{type:'public',uri:scope.domain}],
      policies:[{id:scope.policy,name:'CinaToken staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    if(path===`/d1/database/${scope.database}`)return {uuid:scope.database,name:'cinatoken-staging'};
    assert.fail(path);
  };
  const batch=async statements=>{
    for(const s of statements){assert.ok(s.params.length<=100);assert.ok(Buffer.byteLength(s.sql)<=100000);}
    return (await f.db.binding.batch(statements.map(s=>f.db.binding.prepare(s.sql).bind(...s.params)))).map(r=>r.results);
  };
  const options={api,batch,journal,nowMs:Date.now()+360000,persist:async()=>{}};
  return {f,options,id};
}
const corruptions={
  pending:o=>o[2][0].state='pending',blocked:o=>o[2][0].state='blocked',
  charge:o=>o[4][0].charged_cost=0.2,logBudget:o=>o[4][0].budget_charged_micros=0,
  imageCount:o=>o[4][0].output_image_count=2,attemptCount:o=>o[4][0].upstream_attempt_count=2,
  otherUser:o=>o[1][0].user_id='other',otherWorkspace:o=>o[2][0].workspace_id='other',
  badDigest:o=>o[1][0].payload_sha256='0'.repeat(64),badReceipt:o=>o[3][0].payload_sha256='0'.repeat(64),
  staleLease:o=>o[3][0].lease_revision++,missing:o=>o[3].pop(),extra:o=>o[0].push({...o[0][0],attempt_index:2}),
  onlyIntent:o=>{for(let i=1;i<6;i++)o[i]=[];},
};
test('durable cleanup rejects inconsistent and unfinished observations',async t=>{
  const {f,options}=await completedFixture(t);let observed;
  await assert.rejects(reconcileDurableSseStagingRun({...options,persist:async e=>{if(e.step==='durable-sse-terminal-observed'){observed=structuredClone(e.observed);throw Error('capture-only');}}}),/capture-only/);
  assert.ok(observed);
  for(const [name,mutate] of Object.entries(corruptions))await t.test(name,()=>{
    const copy=structuredClone(observed);mutate(copy);assert.throws(()=>durableSseCleanupStatements(options.journal,copy));
  });
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM request_usage_commit_receipts').get().n,1);
  await reconcileDurableSseStagingRun(options);assert.deepEqual(f.counts(),f.baseline);
});
for(const fault of ['save-failure','changed-log','delete-rollback','delete-ack-lost','wrong-database','not-quiescent'])test('durable cleanup atomic safety: '+fault,async t=>{
  const {f,options,id}=await completedFixture(t),before=f.counts();let hit=false;
  const persisted=async e=>{
    if(e.step!=='durable-sse-terminal-observed')return;
    if(fault==='save-failure'){hit=true;throw Error('synthetic_observation_save_failed');}
    if(fault==='changed-log'){hit=true;f.db.sqlite.prepare('UPDATE api_key_request_logs SET charged_cost=0.2 WHERE id=?').run(id);}
  };
  if(fault==='delete-rollback')f.db.hooks.beforeStatement=sql=>{if(sql.startsWith('DELETE FROM request_usage_settlements')){hit=true;throw Error('synthetic_delete_failure');}};
  if(fault==='delete-ack-lost')f.db.hooks.afterBatch=sql=>{if(sql.some(s=>s.startsWith('DELETE FROM request_usage_settlements'))){hit=true;throw Error('synthetic_delete_ack_lost');}};
  const api=async path=>{const value=await options.api(path);if(fault==='wrong-database'&&path.startsWith('/d1/')){hit=true;return {...value,uuid:'not-staging'};}return value;};
  await assert.rejects(reconcileDurableSseStagingRun({...options,api,persist:persisted,nowMs:fault==='not-quiescent'?Date.now():options.nowMs}));
  if(fault!=='not-quiescent')assert.equal(hit,true);
  assert.deepEqual(f.counts(),fault==='delete-ack-lost'?f.baseline:before);
  f.db.hooks.beforeStatement=undefined;f.db.hooks.afterBatch=undefined;
  if(fault==='changed-log')f.db.sqlite.prepare('UPDATE api_key_request_logs SET charged_cost=0.1 WHERE id=?').run(id);
  const result=await reconcileDurableSseStagingRun(options);assert.equal(result.alreadyRemoved,fault==='delete-ack-lost');
  assert.deepEqual(f.counts(),f.baseline);assert.equal(f.sends,1);
});

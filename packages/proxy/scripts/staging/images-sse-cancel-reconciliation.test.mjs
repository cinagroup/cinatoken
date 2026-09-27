import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {imageSseRow,imageSsePrompt} from './images-sse-probe-contract.ts';
import {sseSnapshotFaultRow,SSE_SNAPSHOT_FAULT_MODES} from './images-sse-snapshot-fault-v2.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import {createImagesSseCancelStagingGateway,SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {assertCancelObservation,reconcileCancelledSseStagingRun} from '../../../../scripts/deploy/staging-sse-cancel-reconciliation.mjs';
import upstream from './images-sse-window-upstream.ts';
import {reconcileSnapshotSseStagingRun,snapshotSseCleanupStatements,snapshotSseCleanupNotBefore} from '../../../../scripts/deploy/staging-sse-snapshot-reconciliation-v2.mjs';
import {SSE_STAGING_SCOPE} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';

import {sqliteTotalChangesBinding} from './sqlite-total-changes-binding.mjs';

async function setup(t){
  const db=createSqliteD1(),tasks=[],controllers=[],key='synthetic-snapshot-client-'+randomUUID(),saved=[],apiCalls=[];
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const counts=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>{assert.match(name,/^[a-z][a-z0-9_]*$/);return [name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n];}));
  // A second, unrelated fixture must remain byte-for-byte unchanged throughout reconciliation.
  const other=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+'b'.repeat(64),new Date(Date.now()+3600000).toISOString());
  for(const s of other.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const otherRows=()=>['users','workspaces','api_keys','models','providers','model_routes','model_endpoints'].map(table=>
    db.sqlite.prepare(`SELECT * FROM ${table} WHERE id LIKE ? ORDER BY id`).all(other.ids.runId+'%').map(r=>({...r})));
  const unrelated=otherRows(),baseline=counts();
  const keyHash='sha256:'+createHash('sha256').update(key).digest('hex'),expiresAt=new Date(Date.now()+3600000).toISOString();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),keyHash,expiresAt);
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const journal={runId:fixture.ids.runId,keyHash,expiresAt,requests:[],probes:[]};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  let sends=0;
  const app=createImagesSseCancelStagingGateway((input,init)=>{
    sends++;assert.equal(new Headers(init.headers).has(SSE_SNAPSHOT_HEADER),false);
    return upstream.fetch(new Request(input,init),{PROBE_DB:db.binding},context);
  });
  const env={DB:sqliteTotalChangesBinding(db),DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:6,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  const release=probeId=>{
    const row=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_snapshot:'+probeId);
    if(!row)return;const v=JSON.parse(row.value);
    if(!['held-before-insert','held-after-insert'].includes(v.phase))return;
    assert.equal(db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND value=?').run(JSON.stringify({...v,phase:'release-requested'}),'c02_sse_snapshot:'+probeId,row.value).changes,1);
  };
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();};
  t.after(async()=>{for(const r of journal.requests)release(r.probeId);for(const c of controllers)c.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  const api=async(path,method)=>{
    apiCalls.push({path,method:method??'GET'});assert.ok(!method||method==='GET','Closed Access mock must not hide unexpected writes');
    const s=SSE_STAGING_SCOPE;
    if(path===`/workers/scripts/${s.worker}/subdomain`)return {enabled:false,previews_enabled:false};
    if(path===`/access/apps/${s.app}`)return {id:s.app,type:'self_hosted',domain:s.domain,aud:s.audience,destinations:[{type:'public',uri:s.domain}],
      policies:[{id:s.policy,name:'CinaToken staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    if(path===`/d1/database/${s.database}`)return {uuid:s.database,name:'cinatoken-staging'};
    assert.fail('Unexpected account path '+path);
  };
  const batch=async statements=>{
    assert.ok(statements.length<=256&&statements.every(s=>s.params.length<=100&&Buffer.byteLength(s.sql)<=100000));
    return (await db.binding.batch(statements.map(s=>db.binding.prepare(s.sql).bind(...s.params)))).map(r=>r.results);
  };
  const options=()=>({api,batch,journal,nowMs:Date.now()+360000,persist:async e=>saved.push(structuredClone(e))});
  const run=async(mode,{timeout=false,recoverInHold=false}={})=>{
    const p={runId:journal.runId,probeId:randomUUID(),mode},u={runId:journal.runId,probeId:randomUUID(),mode:'success'};
    for(const row of [sseSnapshotFaultRow(p),imageSseRow(u),sseCancelObservationRow(p)])
      db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    const controller=new AbortController();controllers.push(controller);
    const startedAt=new Date().toISOString();
    const request=new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:controller.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',[SSE_CANCEL_HEADER]:'v1',
        [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${p.runId}:${p.probeId}:${mode}`},
      body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:imageSsePrompt(u),stream:true})});
    const response=await app.fetch(request,env,context);assert.equal(response.status,200);
    const id=response.headers.get('X-Generation-Id'),entry={id,mode,probeId:p.probeId,upstreamProbeId:u.probeId,startedAt,headersAt:new Date().toISOString()};
    journal.requests.push(entry);journal.probes.push(u);
    const reader=response.body.getReader(),first=await reader.read(),wire=new TextDecoder().decode(first.value);
    assert.match(wire,/image_generation.completed/);assert.doesNotMatch(wire,/\[DONE\]/);
    const pending=reader.read();pending.catch(()=>{});
    const snapshot=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_snapshot:'+p.probeId).value);
    for(let n=0;n<1000&&!snapshot().phase.startsWith('held-');n++)await delay(5);
    assert.equal(snapshot().phase,mode==='before-hold'?'held-before-insert':'held-after-insert');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM api_key_request_logs').get().n,0);
    entry.cancelIssuedAt=new Date().toISOString();controller.abort();await reader.cancel();assert.equal((await pending).done,true);
    const cancelRow=()=>({...db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get('c02_sse_cancel:'+p.probeId)});
    for(let n=0;n<1000&&JSON.parse(cancelRow().value).phase==='armed';n++)await delay(5);
    const observed=assertCancelObservation(journal,cancelRow(),true);assert.equal(observed.signalAborted,true);
    if(recoverInHold){assert.equal((await recover()).committed,mode==='after-hold'?1:0);assert.equal(snapshot().phase,mode==='after-hold'?'held-after-insert':'held-before-insert');}
    if(!timeout)release(p.probeId);
    await drain();entry.finishedAt=new Date().toISOString();
    const expected=timeout&&mode==='before-hold'?0:1;
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM api_key_request_logs').get().n,expected);
    assert.equal((await recover()).committed,0);assert.equal(sends,1);
    return {id,wire,observed};
  };
  return {db,app,env,context,key,fixture,journal,run,drain,recover,counts,baseline,otherRows,unrelated,options,saved,apiCalls,get sends(){return sends;}};
}

for(const mode of ['before-hold','after-hold'])for(const timeout of [false,true])
test(`native cancellation at ${mode}, release timeout=${timeout}: financial invariant and atomic cleanup`,{timeout:35000},async t=>{
  const f=await setup(t);await f.run(mode,{timeout});
  const r=await reconcileCancelledSseStagingRun(f.options());
  assert.equal(r.fixtureRemoved,true);assert.equal(r.cancelObservationsRemoved,true);
  assert.equal(r.unknownFixturesRemoved,timeout&&mode==='before-hold'?1:0);
  assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);
  assert.equal((await reconcileCancelledSseStagingRun(f.options())).alreadyRemoved,true);
});
test('cancel after native commit, independently recover before producer release: one receipt',{timeout:10000},async t=>{
  const f=await setup(t);await f.run('after-hold',{recoverInHold:true});
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM request_usage_commit_receipts').get().n,1);
  await reconcileCancelledSseStagingRun(f.options());assert.deepEqual(f.counts(),f.baseline);
});
for(const mode of ['before-hold','after-hold'])test('cancellation record validates held identity and rejects fabricated evidence: '+mode,async t=>{
  const f=await setup(t);await f.run(mode);
  const original={...f.db.sqlite.prepare("SELECT key,value,description FROM system_config WHERE key LIKE 'c02_sse_cancel:%'").get()};
  for(const change of [
    v=>v.signalAborted=false,v=>v.requestId='gen-'+randomUUID(),v=>v.mode='before-fail',
    v=>{const p=JSON.parse(v.snapshotValue);p.phase='insert-ack-returned';v.snapshotValue=JSON.stringify(p);},
    v=>{const p=JSON.parse(v.snapshotValue);p.runId='foreign';v.snapshotValue=JSON.stringify(p);},
  ]){const v=JSON.parse(original.value);change(v);assert.throws(()=>assertCancelObservation(f.journal,{...original,value:JSON.stringify(v)},true));}
  await reconcileCancelledSseStagingRun(f.options());assert.deepEqual(f.counts(),f.baseline);
});
for(const fault of ['save-fail','row-drift','late-row','delete-fail','ack-loss'])
test('cancel cleanup keeps all financial and observation changes atomic: '+fault,async t=>{
  const f=await setup(t);await f.run('after-hold');const options=f.options(),before=f.counts();let hit=false;
  if(['save-fail','row-drift','late-row'].includes(fault))options.persist=async e=>{
    if(e.step!=='cancel-observations-before-cleanup')return;hit=true;
    if(fault==='save-fail')throw Error('observe_save_failed');
    if(fault==='row-drift')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',e.rows[0].key);
    if(fault==='late-row')f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_sse_cancel:'+randomUUID(),'{}','c02-cancel:'+f.journal.runId);
  };
  if(fault==='delete-fail')f.db.hooks.beforeStatement=(sql,values)=>{if(sql.startsWith('DELETE FROM system_config')&&String(values[0]).startsWith('c02_sse_cancel:')){hit=true;throw Error('delete_failed');}};
  if(fault==='ack-loss')f.db.hooks.afterBatch=sql=>{if(sql.some(s=>s.startsWith('DELETE FROM request_dispatch_intents'))){hit=true;throw Error('ack_lost');}};
  await assert.rejects(reconcileCancelledSseStagingRun(options));assert.equal(hit,true);
  if(fault==='ack-loss'){f.db.hooks.afterBatch=undefined;assert.deepEqual(f.counts(),f.baseline);assert.equal((await reconcileCancelledSseStagingRun(f.options())).alreadyRemoved,true);}
  else{assert.equal(f.counts().api_key_request_logs,before.api_key_request_logs);assert.equal(f.counts().request_usage_commit_receipts,before.request_usage_commit_receipts);}
  assert.deepEqual(f.otherRows(),f.unrelated);
});


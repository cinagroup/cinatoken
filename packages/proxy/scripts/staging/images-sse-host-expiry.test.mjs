import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {sqliteTotalChangesBinding} from './sqlite-total-changes-binding.mjs';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {SSE_HOST_EXPIRY_MS,withSseSnapshotHostExpiry} from './images-sse-host-expiry.ts';
import {createImagesSseHostExpiryGateway,SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler.ts';

const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
async function setup(t,mode){
  const db=createSqliteD1(),tasks=[],key='synthetic-'+randomUUID(),controller=new AbortController();
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode};
  const fixture=await imageSseFixture(probe.runId,'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  for(const row of [sseSnapshotFaultRow(probe),sseCancelObservationRow(probe)])
    db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  let sends=0,markerReads=0;
  db.hooks.beforeStatement=(sql)=>{if(sql==='SELECT value FROM system_config WHERE key=? AND description=?')markerReads++;};
  const app=createImagesSseHostExpiryGateway(async(input,init)=>{
    sends++;const headers=new Headers(init.headers);
    for(const h of [SSE_HOST_EXPIRY_HEADER,SSE_SNAPSHOT_HEADER,SSE_CANCEL_HEADER])assert.equal(headers.has(h),false);
    return new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\ndata: [DONE]\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  });
  const env={DB:sqliteTotalChangesBinding(db),DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-expiry-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});},abort(){assert.fail('Native abort is forbidden in natural expiry profile');}};
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  const rowKey='c02_sse_snapshot:'+probe.probeId;
  const read=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(rowKey).value);
  const financial=()=>['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations']
    .map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>({...row})));
  const request=(overrides={})=>new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:controller.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',[SSE_HOST_EXPIRY_HEADER]:'v1',[SSE_CANCEL_HEADER]:'v1',
      [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${probe.runId}:${probe.probeId}:${mode}`,...overrides},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic expiry',stream:true})});
  t.mock.timers.enable({apis:['setTimeout']});
  t.after(async()=>{controller.abort();await flush();t.mock.timers.tick(45000);await flush();t.mock.timers.tick(45000);await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  return {db,app,env,context,request,probe,controller,recover,read,financial,rowKey,tasks,get sends(){return sends;},get markerReads(){return markerReads;}};
}

for(const mode of ['before-hold','after-hold'])for(const action of ['survive','release','owner-change'])
test(`fixed SSE host expiry ${mode} / ${action}: no early continuation and no invented platform success`,{timeout:10000},async t=>{
  const f=await setup(t,mode),response=await f.app.fetch(f.request(),f.env,f.context);
  assert.equal(response.status,200);const reader=response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/image_generation.completed/);
  const pending=reader.read();pending.catch(()=>{});
  const phase=mode==='before-hold'?'held-before-insert':'held-after-insert';
  for(let i=0;i<1000&&f.read().phase!==phase;i++)await delay(2);
  assert.equal(f.read().phase,phase);await flush();
  assert.deepEqual(f.financial().map(rows=>rows.length),mode==='before-hold'?[1,0,0,0,0,1]:[1,1,1,0,0,1]);
  if(mode==='after-hold')assert.deepEqual(f.read().nativeResult,{success:true,changes:2,rowsWritten:1,identityVerified:true});
  f.controller.abort();await reader.cancel();assert.equal((await pending).done,true);await flush();
  const cancel=JSON.parse(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_cancel:'+f.probe.probeId).value);
  assert.equal(cancel.phase,'request-aborted');assert.equal(JSON.parse(cancel.snapshotValue).phase,phase);
  assert.equal((await f.recover()).committed,mode==='after-hold'?1:0);
  const afterRecovery=f.financial();
  assert.equal(SSE_HOST_EXPIRY_MS,45000);
  if(action==='release')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...f.read(),phase:'release-requested'}),f.rowKey);
  if(action==='owner-change')f.db.sqlite.prepare('UPDATE system_config SET description=? WHERE key=?').run('foreign',f.rowKey);
  t.mock.timers.tick(44999);await flush();
  assert.equal(f.read().phase,action==='release'?'release-requested':phase);
  assert.deepEqual(f.financial(),afterRecovery);assert.equal(f.markerReads,0,'V2 release polling must never run');
  t.mock.timers.tick(1);await flush();await Promise.allSettled(f.tasks);await drainNodeBackgroundWork();
  assert.equal(f.read().phase,action==='survive'?'host-expiry-not-observed':action==='release'?'release-requested':phase);
  assert.deepEqual(f.financial(),afterRecovery,'surviving producer cannot insert again or revoke successful settlement');
  assert.equal((await f.recover()).committed,0);assert.deepEqual(f.financial(),afterRecovery);assert.equal(f.sends,1);
  const budget=f.db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(f.probe.runId+'-user');
  assert.deepEqual({...budget},mode==='after-hold'?{budget_spent_micros:100000,budget_reserved_micros:0}:{budget_spent_micros:0,budget_reserved_micros:100000});
});

for(const state of ['missing','foreign-owner','claimed'])test('host expiry cannot claim unarmed probe: '+state,{timeout:10000},async t=>{
  const f=await setup(t,'before-hold');
  if(state==='missing')f.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run(f.rowKey);
  if(state==='foreign-owner')f.db.sqlite.prepare('UPDATE system_config SET description=? WHERE key=?').run('foreign',f.rowKey);
  if(state==='claimed')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.rowKey);
  const response=await f.app.fetch(f.request(),f.env,f.context),wire=await response.text();
  assert.match(wire,/settlement_unconfirmed/);assert.deepEqual(f.financial().map(rows=>rows.length),[1,0,0,0,0,1]);
});

test('host expiry gateway rejects unsupported profiles and preserves API-key authorization',{timeout:10000},async t=>{
  const f=await setup(t,'before-hold');
  for(const overrides of [{[SSE_HOST_EXPIRY_HEADER]:'45000'},{[SSE_CANCEL_HEADER]:'v2'},{[SSE_SNAPSHOT_HEADER]:'invalid'},
    {[SSE_SNAPSHOT_HEADER]:`c02-snapshot:${f.probe.runId}:${f.probe.probeId}:before-fail`}]){
    assert.equal((await f.app.fetch(f.request(overrides),f.env,f.context)).status,400);
  }
  assert.equal((await f.app.fetch(f.request({Authorization:'Bearer invalid'}),f.env,f.context)).status,401);
  for(const mode of ['before-fail','after-ack-loss','snapshot-read-fail','job-read-fail'])
    assert.throws(()=>withSseSnapshotHostExpiry(f.env.DB,{...f.probe,mode}),/Invalid SSE host expiry profile/);
  assert.equal(f.sends,0);assert.equal(f.read().phase,'armed');
});

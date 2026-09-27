import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {createWorkerHandler} from '../../src/runtime/worker-handler.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {SSE_SNAPSHOT_FAULT_MODES, SSE_SNAPSHOT_HOLD_MS, parseSseSnapshotFault, sseSnapshotFaultRow, withSseSnapshotFault} from './images-sse-snapshot-fault.ts';

const completed = 'data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\n';
const done = 'data: [DONE]\n\n';
const makeProbe = mode => ({runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode});
const snapshotInsert = sql => /^INSERT INTO request_usage_settlements/.test(sql);
const tables = ['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs'];

async function setup(t, mode, armed = true) {
  const db=createSqliteD1(), tasks=[], probe=makeProbe(mode), row=sseSnapshotFaultRow(probe), key='synthetic-'+randomUUID();
  t.mock.method(globalThis,'fetch',async()=>{throw Error('Network forbidden');});
  for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const fixture=await imageSseFixture(probe.runId,'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  if(armed)db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const readProbe=()=>{
    const value=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value;
    return value?JSON.parse(value):null;
  };
  const release=()=>{
    const current=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value;
    if(!current)return;
    const value=JSON.parse(current);
    if(!['held-before-insert','held-after-insert'].includes(value.phase))return;
    assert.equal(db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND description=? AND value=?')
      .run(JSON.stringify({...value,phase:'release-requested'}),row.key,row.description,current).changes,1);
  };
  const wrapped=withSseSnapshotFault(db.binding,probe), abort=new AbortController();
  let sends=0, inserts=0, captured;
  db.hooks.beforeStatement=(sql,values)=>{if(snapshotInsert(sql)){inserts++;captured={sql,values:[...values]};}};
  const app=createWorkerHandler({imageUsageRecovery:{settlementLeaseSeconds:30,streaming:true}, imageFetch:async()=>{
    sends++;return new Response(completed+done,{headers:{'Content-Type':'text/event-stream'}});
  }});
  const env={DB:wrapped,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-snapshot-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  // Independent recovery uses the native database, not the producer fault wrapper.
  const storage=await resolveWorkerStorageFromBindings({...env,DB:db.binding});
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();};
  t.after(async()=>{release();abort.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  const observe=()=>({
    counts:tables.map(table=>db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),
    account:{...db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(fixture.ids.user)},
    reservation:db.sqlite.prepare('SELECT state,settled_micros,terminal_reason FROM user_budget_reservations WHERE user_id=?').all(fixture.ids.user).map(r=>({...r})),
    logs:db.sqlite.prepare('SELECT id,status,charged_cost,budget_charged_micros,output_image_count,upstream_attempt_count FROM api_key_request_logs WHERE user_id=?').all(fixture.ids.user).map(r=>({...r})),
  });
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:5,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  const waitPhase=async phase=>{
    for(let i=0;i<1000;i++){if(readProbe()?.phase===phase)return;await delay(5);}
    throw Error('Probe not reached: '+phase+' actual '+readProbe()?.phase);
  };
  return {db,wrapped,probe,row,release,readProbe,waitPhase,drain,observe,recover,abort,
    get sends(){return sends;},get inserts(){return inserts;},get captured(){return captured;},
    request:()=>app.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:abort.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic snapshot boundary',stream:true})}),env,context)};
}

function assertPending(f, snapshot) {
  const state=f.observe();assert.deepEqual(state.counts,snapshot?[1,1,1,0,0]:[1,0,0,0,0]);
  assert.deepEqual(state.account,{budget_spent_micros:0,budget_reserved_micros:100000});
  assert.deepEqual(state.reservation,[{state:'dispatched',settled_micros:0,terminal_reason:null}]);
  if(snapshot){
    const s=f.db.sqlite.prepare('SELECT * FROM request_usage_settlements').get();
    const j=f.db.sqlite.prepare('SELECT * FROM request_usage_recovery_jobs').get();
    for(const name of ['request_id','user_id','api_key_id','workspace_id','payload_sha256'])assert.equal(j[name],s[name]);
    assert.equal(j.state,'pending');assert.equal(j.attempts,0);assert.equal(j.revision,0);
    assert.equal(JSON.parse(s.payload_json).params.requestLog.responseStreamed,true);
  }
}
function assertSuccess(f,id) {
  const s=f.observe();assert.deepEqual(s.counts,[1,1,1,1,1]);
  assert.deepEqual(s.account,{budget_spent_micros:100000,budget_reserved_micros:0});
  assert.deepEqual(s.logs,[{id,status:'success',charged_cost:0.1,budget_charged_micros:100000,output_image_count:1,upstream_attempt_count:1}]);
  assert.equal(f.db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').get().state,'committed');
  assert.equal(f.sends,1);assert.equal(f.inserts,1);
}
function assertWire(wire,id,error) {
  const frames=wire.split('\n\n').filter(Boolean);assert.equal(frames.at(-1),'data: [DONE]');
  assert.equal(frames.filter(f=>f==='data: [DONE]').length,1);
  const data=frames.slice(0,-1).map(f=>JSON.parse(f.slice(6)));
  assert.equal(data[0].type,'image_generation.completed');assert.equal(data[0].b64_json,'AQID');
  assert.equal(data.length,error?2:1);
  if(error){assert.equal(data[1].type,'error');assert.equal(data[1].error.code,'gateway.image_settlement_unconfirmed');
    assert.deepEqual(data[1].error.metadata,{request_id:id,outcome_unknown:true,retry_safe:false});}
}

for(const mode of SSE_SNAPSHOT_FAULT_MODES.filter(m=>!m.endsWith('hold')))test('snapshot probe real handler: '+mode,{timeout:10000},async t=>{
  const f=await setup(t,mode), response=await f.request(), id=response.headers.get('X-Generation-Id');
  assert.equal(response.status,200);const wire=await response.text();await f.drain();
  assertWire(wire,id,mode!=='after-ack-loss');assert.equal(f.sends,1);assert.equal(f.inserts,mode==='before-fail'?0:1);
  assert.equal(f.readProbe().phase,{'before-fail':'failed-before-insert','after-ack-loss':'insert-ack-lost','snapshot-read-fail':'snapshot-read-failed','job-read-fail':'job-read-failed'}[mode]);
  if(mode==='after-ack-loss')assertSuccess(f,id);
  else {
    assertPending(f,mode!=='before-fail');
    assert.equal((await f.recover()).committed,mode==='before-fail'?0:1);
    if(mode==='before-fail')assertPending(f,false);else assertSuccess(f,id);
  }
  assert.equal((await f.recover()).claimed,0);assert.equal(f.sends,1);
});

for(const mode of ['before-hold','after-hold'])for(const action of ['release','cancel','abort'])test(`snapshot probe ${mode}: ${action}`,{timeout:10000},async t=>{
  const f=await setup(t,mode), response=await f.request(), id=response.headers.get('X-Generation-Id'), reader=response.body.getReader();
  let wire='';const reading=(async()=>{for(;;){const r=await reader.read();if(r.done)return;wire+=new TextDecoder().decode(r.value);}})();
  await f.waitPhase(mode==='before-hold'?'held-before-insert':'held-after-insert');
  assert.match(wire,/image_generation.completed/);assert.doesNotMatch(wire,/\[DONE\]/);assertPending(f,mode==='after-hold');
  if(action==='cancel')await reader.cancel();if(action==='abort')f.abort.abort();
  f.release();await reading;await f.drain();assertSuccess(f,id);
  if(action==='cancel')assert.doesNotMatch(wire,/\[DONE\]/);else assertWire(wire,id,false);
  assert.equal(f.readProbe().phase,'insert-ack-returned');assert.equal((await f.recover()).claimed,0);
});

// Native Node timers: exercise the real 15-second gate, not a shortened configurable timeout.
for(const mode of ['before-hold','after-hold'])test('snapshot hold exceeds delivery confirmation: '+mode,{timeout:30000},async t=>{
  const f=await setup(t,mode), response=await f.request(), id=response.headers.get('X-Generation-Id');
  const start=performance.now(), wire=await response.text();
  assert.ok(performance.now()-start>=14500);assertWire(wire,id,true);assertPending(f,mode==='after-hold');
  if(mode==='after-hold'){
    // Independent consumer may settle while producer still awaits INSERT acknowledgement.
    assert.equal((await f.recover()).committed,1);f.release();await f.drain();assertSuccess(f,id);
  }else{
    await f.drain();assert.equal(f.readProbe().phase,'release-timeout');assertPending(f,false);
    assert.equal((await f.recover()).claimed,0);assert.equal(f.inserts,0);
  }
  assert.equal((await f.recover()).claimed,0);assert.equal(f.sends,1);
});

for(const bad of [null,'','x'.repeat(201),`c02-snapshot:c02-success-${randomUUID()}:${randomUUID()}:before-abort`])
  test('snapshot grammar rejects '+String(bad).slice(0,35),()=>assert.equal(parseSseSnapshotFault(bad),null));
test('snapshot grammar round trips every fixed profile',()=>{
  for(const mode of SSE_SNAPSHOT_FAULT_MODES){const p=makeProbe(mode);assert.deepEqual(parseSseSnapshotFault(`c02-snapshot:${p.runId}:${p.probeId}:${mode}`),p);}
  assert.equal(SSE_SNAPSHOT_HOLD_MS,20000);
});
for(const state of ['missing','wrong-owner','already-claimed'])test('unarmed snapshot never inserts: '+state,{timeout:10000},async t=>{
  const f=await setup(t,'before-fail',state!=='missing');
  if(state==='wrong-owner')f.db.sqlite.prepare('UPDATE system_config SET description=? WHERE key=?').run('foreign',f.row.key);
  if(state==='already-claimed')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.row.key);
  const response=await f.request(), wire=await response.text();await f.drain();
  assertWire(wire,response.headers.get('X-Generation-Id'),true);assertPending(f,false);assert.equal(f.inserts,0);assert.equal(f.sends,1);
});
test('unrelated native batch stays atomic; foreign statements and sessions rejected',async t=>{
  const db=createSqliteD1();t.after(()=>db.sqlite.close());const wrapped=withSseSnapshotFault(db.binding,makeProbe('before-fail'));
  db.sqlite.exec('CREATE TABLE snapshot_probe_atomic(id INTEGER PRIMARY KEY)');
  await assert.rejects(wrapped.batch([wrapped.prepare('INSERT INTO snapshot_probe_atomic VALUES(?)').bind(1),wrapped.prepare('INSERT INTO snapshot_probe_atomic VALUES(?)').bind(1)]));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM snapshot_probe_atomic').get().n,0);
  assert.throws(()=>wrapped.batch([db.binding.prepare('SELECT 1')]),/FOREIGN_STATEMENT/);
  assert.throws(()=>wrapped.withSession(),/SESSION_UNSUPPORTED/);
  assert.equal((await wrapped.prepare('SELECT 42 n').first()).n,42);
  assert.equal(await wrapped.prepare('SELECT 42 n').first('n'),42);
});

test('claimed probe refuses duplicate execution and alternate INSERT APIs',async t=>{
  const f=await setup(t,'after-ack-loss'),response=await f.request();await response.text();await f.drain();
  assertSuccess(f,response.headers.get('X-Generation-Id'));
  const s=f.wrapped.prepare(f.captured.sql).bind(...f.captured.values);
  await assert.rejects(s.run(),/ALREADY_USED/);await assert.rejects(s.first(),/NON_RUN_INSERT/);
  await assert.rejects(s.all(),/NON_RUN_INSERT/);await assert.rejects(s.raw(),/NON_RUN_INSERT/);
  assert.throws(()=>f.wrapped.batch([s]),/BATCH_INSERT_UNSUPPORTED/);assert.equal(f.inserts,1);
});
test('probe owns input scalars and never consumes another synthetic tenant',async t=>{
  const f=await setup(t,'after-ack-loss'),original={...f.probe};
  f.probe.mode='before-fail';f.probe.runId=makeProbe('before-fail').runId;
  const response=await f.request();await response.text();await f.drain();assertSuccess(f,response.headers.get('X-Generation-Id'));
  assert.equal(f.readProbe().runId,original.runId);assert.equal(f.readProbe().mode,original.mode);
  const other=makeProbe('before-fail'),row=sseSnapshotFaultRow(other),wrapped=withSseSnapshotFault(f.db.binding,other);
  f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const result=await wrapped.prepare(f.captured.sql).bind(...f.captured.values).run();assert.equal(result.meta.changes,0);
  assert.equal(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value,row.value);
});
test('competing wrappers cannot reclaim the same durable probe',async t=>{
  const f=await setup(t,'after-ack-loss'),other=withSseSnapshotFault(f.db.binding,f.probe),response=await f.request();
  await response.text();await f.drain();
  await assert.rejects(other.prepare(f.captured.sql).bind(...f.captured.values).run(),/OWNERSHIP_UNCONFIRMED/);
  assert.equal(f.inserts,1);assert.equal(f.readProbe().phase,'insert-ack-lost');
});
for(const mode of ['before-hold','after-hold'])test('held ownership drift never resumes: '+mode,{timeout:10000},async t=>{
  const f=await setup(t,mode),response=await f.request(),reading=response.text();
  await f.waitPhase(mode==='before-hold'?'held-before-insert':'held-after-insert');
  f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.row.key);
  const wire=await reading;await f.drain();
  // A committed INSERT is still valid even if the observational marker changes afterwards.
  assertWire(wire,response.headers.get('X-Generation-Id'),mode==='before-hold');
  if(mode==='before-hold')assertPending(f,false);else assertSuccess(f,response.headers.get('X-Generation-Id'));
});

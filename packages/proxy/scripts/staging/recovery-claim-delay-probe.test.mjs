import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFixtureDatabase } from './usage-recovery-paid-fixture.mjs';
import { buildFiveRecoveryFixture, fiveRecoveryObservations } from './usage-recovery-five-fixture.mjs';
import { fiveRecoverySeedBatches } from './usage-recovery-five-seed.mjs';
import { assertFiveSnapshotProgress, assertFiveSnapshotInvocationProgress } from './usage-recovery-five-progress.mjs';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { createUsageRecoveryJobsD1 } from '../../../core/src/storage/recovery/usage-recovery-jobs-d1.ts';
import { withRecoveryFencingProbe, RECOVERY_FENCING_CONTROL_KEY as fencingKey, RECOVERY_FENCING_CONTROL_DESCRIPTION as fencingDescription } from './recovery-fencing-probe.ts';
import { withRecoveryClaimDelayProbe, recoveryClaimDelayValue, RECOVERY_CLAIM_DELAY_KEY as key, RECOVERY_CLAIM_DELAY_DESCRIPTION as description } from './recovery-claim-delay-probe.ts';
const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5', RECOVERY_CONCURRENCY: '1',
  RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000', RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const observe = (db, f) => Object.fromEntries(Object.entries(fiveRecoveryObservations(f))
  .map(([name,s]) => [name, JSON.parse(JSON.stringify(db.sqlite.prepare(s.sql).all(...s.params)))]));
async function fixture(t) {
  const f = await buildFiveRecoveryFixture('unicode'), db = recoveryFixtureDatabase(t);
  for (const b of fiveRecoverySeedBatches(f)) await db.binding.batch(b.statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
  const id = db.sqlite.prepare('SELECT request_id FROM request_usage_recovery_jobs ORDER BY available_at,request_id LIMIT 1').get().request_id;
  const wrapped = withRecoveryClaimDelayProbe(withRecoveryFencingProbe(db.binding));
  const arm = (value = recoveryClaimDelayValue(f.id,id,'armed'), desc = description) => db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(key,value,desc);
  return { f, db, id, wrapped, arm };
}
async function run(db, host = createUsageRecoveryHost()) {
  const held = []; const response = await host.run(db, settings, { waitUntil:p => held.push(p) });
  await Promise.all(held); assert.equal(response.status, 'finished');
  assert.equal(host.snapshot().active, false); assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return response.result;
}
async function heldPhase(db) {
  const limit = performance.now()+3000;
  while (!db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value.endsWith('|held')) {
    assert.ok(performance.now()<limit); await new Promise(r=>setTimeout(r,5));
  }
}
test('real claim ACK delay remains held then produces interrupted, natural retry and a new fenced receipt', {timeout:20000}, async t => {
  const {f,db,id,wrapped,arm} = await fixture(t); arm(); const initial=observe(db,f), host=createUsageRecoveryHost();
  const pending=run(wrapped,host); pending.catch(()=>{}); await heldPhase(db);
  assert.equal(host.snapshot().active,true); assert.equal(host.snapshot().capacity.reservedBytes,67108864);
  const heldJob=observe(db,f).jobs.find(j=>j.request_id===id); assert.equal(heldJob.state,'leased'); assert.equal(heldJob.revision,1);
  assert.equal(observe(db,f).receipts.length,0);
  assert.deepEqual(await host.run(wrapped,settings,{waitUntil(){}}),{status:'busy'});
  const first=await pending, partial=observe(db,f);
  assert.deepEqual(assertFiveSnapshotInvocationProgress(f,initial,partial,first),{committed:0,pending:5});
  assert.equal(first.claimed,1); assert.equal(first.deferred,1); assert.equal(first.admissionStopped,true);
  const job=partial.jobs.find(j=>j.request_id===id); assert.equal(job.last_error,'interrupted'); assert.equal(job.revision,2);
  assert.equal(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value,recoveryClaimDelayValue(f.id,id,'released'));
  const due=db.sqlite.prepare("SELECT available_at,updated_at,unixepoch('now') AS now_seconds FROM request_usage_recovery_jobs WHERE request_id=?").get(id);
  assert.equal(due.available_at-due.updated_at,5); const remaining=Math.max(0,due.available_at-due.now_seconds); assert.ok(remaining<=5);
  await new Promise(r=>setTimeout(r,remaining*1000+50));
  const next=await run(wrapped,host), complete=observe(db,f);
  assert.deepEqual(assertFiveSnapshotInvocationProgress(f,partial,complete,next),{committed:5,pending:0});
  assert.equal(complete.receipts.find(r=>r.request_id===id).lease_revision,3);
  const repeat=await run(wrapped,host); assertFiveSnapshotInvocationProgress(f,complete,observe(db,f),repeat);
  assert.deepEqual(observe(db,f),complete);
});
for (const mode of ['absent','released','other-tenant']) {
  test(mode+' control does not delay or alter native successful recovery', async t => {
    const {f,db,id,wrapped,arm}=await fixture(t);
    if(mode==='released')arm(recoveryClaimDelayValue(f.id,id,'released'));
    if(mode==='other-tenant')arm(recoveryClaimDelayValue('staging-recovery-'+crypto.randomUUID(),id,'armed'));
    const initial=observe(db,f), result=await run(wrapped,createUsageRecoveryHost({now:()=>0}));
    assert.deepEqual(assertFiveSnapshotInvocationProgress(f,initial,observe(db,f),result),{committed:5,pending:0});
  });
}
for (const [name,value,desc] of [['malformed','invalid',description],['oversized','x'.repeat(200000),description],
  ['Unicode byte overflow','漢'.repeat(160),description],['wrong owner description','v1|ignored','unowned']]) {
  test(name+' control fails before any native claim', async t => {
    const {f,db,wrapped,arm}=await fixture(t);arm(value,desc);const initial=observe(db,f), result=await run(wrapped,createUsageRecoveryHost({now:()=>0}));
    assert.equal(result.claimed,0);assert.equal(result.uncertain,5);assert.deepEqual(observe(db,f),initial);
  });
}
test('control ownership change after a real claim never confers ACK ownership or releases the new owner', {timeout:12000}, async t => {
  const {f,db,id,wrapped,arm}=await fixture(t);arm();const host=createUsageRecoveryHost(),pending=run(wrapped,host);pending.catch(()=>{});
  await heldPhase(db);db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('different-owner',key);
  const result=await pending;assert.equal(result.claimed,0);assert.equal(result.uncertain,1);assert.equal(result.admissionStopped,true);
  const state=observe(db,f);assert.equal(state.jobs.find(j=>j.request_id===id).state,'leased');assert.equal(state.receipts.length,0);
  assert.equal(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value,'different-owner');
});
test('adapter is lazy, host-rejection performs no I/O, and foreign statement/session paths cannot bypass it',async t=>{
  const db=recoveryFixtureDatabase(t);let reads=0;
  const wrapped=withRecoveryClaimDelayProbe({...db.binding,prepare(){reads++;throw Error('unexpected I/O');}}),host=createUsageRecoveryHost();
  assert.equal(reads,0);assert.deepEqual(await host.run(wrapped,{...settings,RECOVERY_ENABLED:'false'},{waitUntil(){}}),{status:'disabled'});
  assert.deepEqual(await host.run(wrapped,settings,{waitUntil(){throw Error('reject');}}),{status:'host_rejected'});assert.equal(reads,0);
  const actual=withRecoveryClaimDelayProbe(db.binding);
  assert.throws(()=>actual.batch([db.binding.prepare('SELECT 1')]),/FOREIGN_OR_BATCHED_CLAIM/);
  assert.throws(()=>actual.withSession(),/SESSION_NOT_IN_SCOPE/);
  assert.throws(()=>actual.prepare("UPDATE request_usage_recovery_jobs SET lease_token=CASE WHEN attempts<6 THEN ? ELSE NULL END"),/CLAIM_SQL_DRIFT/);
  assert.throws(()=>recoveryClaimDelayValue('production','gen-'+crypto.randomUUID(),'armed'),/INVALID_IDENTITY/);
});

test('a real zero-change claim CAS leaves the armed control untouched and never starts a delay', async t => {
  const {f,db,id,wrapped,arm}=await fixture(t), nativeJobs=createUsageRecoveryJobsD1(db.binding);
  const candidate=(await nativeJobs.scanDue({kind:'all'},5)).find(candidate=>candidate.ref.requestId===id);
  assert.ok(candidate); assert.equal(candidate.revision,0);
  // Another genuine repository claim owns revision 1; retry the stale revision 0.
  assert.equal((await nativeJobs.claim(candidate,30)).status,'claimed'); arm();
  const initial=observe(db,f); let nativeClaims=0, controlTransitions=0;
  db.hooks.beforeStatement=(sql)=>{
    if (/^UPDATE request_usage_recovery_jobs SET/.test(sql) && sql.includes('attempts=MIN')) nativeClaims++;
    if (/^UPDATE system_config SET/.test(sql)) controlTransitions++;
  };
  const timer=t.mock.method(globalThis,'setTimeout',()=>{throw Error('Unexpected zero-change claim delay');});
  assert.deepEqual(await createUsageRecoveryJobsD1(wrapped).claim(candidate,30),{status:'not_claimed'});
  assert.equal(nativeClaims,1); assert.equal(controlTransitions,0); assert.equal(timer.mock.callCount(),0);
  assert.equal(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value,recoveryClaimDelayValue(f.id,id,'armed'));
  assert.deepEqual(observe(db,f),initial);
});

test('composed claim-delay and fencing adapters reject malformed fencing before native accounting', async t => {
  const {f,db,id,wrapped,arm}=await fixture(t); arm(recoveryClaimDelayValue(f.id,id,'released'));
  db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(fencingKey,'invalid',fencingDescription);
  const initial=observe(db,f); let fencingReads=0, nativeAccountingInserts=0;
  db.hooks.beforeStatement=(sql,values)=>{
    if (sql.includes('FROM system_config WHERE key=?') && values.includes(fencingKey)) fencingReads++;
    if (sql.startsWith('INSERT INTO api_key_request_logs ')) nativeAccountingInserts++;
  };
  const result=await run(wrapped,createUsageRecoveryHost({now:()=>0})), after=observe(db,f);
  assert.deepEqual(result,{scanned:5,claimed:5,committed:0,blocked:0,deferred:5,lostOwnership:0,
    uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false});
  assert.equal(fencingReads,5); assert.equal(nativeAccountingInserts,0); assert.equal(after.receipts.length,0);
  assert.deepEqual(after,{...initial,jobs:initial.jobs.map(job=>({...job,revision:2,attempts:1,last_error:'execution_error'}))});
  assert.equal(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(fencingKey).value,'invalid');
  assert.equal(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value,recoveryClaimDelayValue(f.id,id,'released'));
});

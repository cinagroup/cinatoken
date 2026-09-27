import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup } from './images-recovery-test-support.mjs';
import { withRecoveryFencingProbe, RECOVERY_FENCING_CONTROL_KEY as key, RECOVERY_FENCING_CONTROL_DESCRIPTION as description } from './recovery-fencing-probe.ts';
import { imageStorageFaultHeader, imageStorageFaultRow } from './images-storage-fault-contract.ts';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';

async function fixture(t){
  const f=await setup(t),probe={runId:f.fixture.ids.runId,probeId:randomUUID(),mode:'before-release'};
  let batches=0;const sentinel=[];
  // Transport-only checks below: native batch deliberately stubbed. Actual SQL
  // transaction/fence/rollback proof lives in images-fencing.test.mjs.
  f.db.binding.batch=async()=>{batches++;return sentinel;};
  const db=withRecoveryFencingProbe(f.db.binding);
  const statement=(scope=probe.runId)=>db.prepare('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id, status) VALUES(?,?,?,?,?)')
    .bind('gen-'+randomUUID(),scope+'-user',scope+'-key',scope+'-workspace','success');
  const arm=(value=imageStorageFaultHeader(probe),desc=description)=>f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(key,value,desc);
  return {...f,db,native:f.db.binding,sqlite:f.db.sqlite,probe,statement,arm,sentinel,get batches(){return batches;}};
}

test('missing control is transparent, and non-accounting batches do not inspect a malformed control',async t=>{
  const f=await fixture(t);
  assert.equal(await f.db.batch([f.statement()]),f.sentinel);assert.equal(f.batches,1);
  f.arm('invalid');assert.equal(await f.db.batch([f.db.prepare('SELECT 1')]),f.sentinel);assert.equal(f.batches,2);
});
for(const [name,change] of [
  ['malformed',()=>['invalid']],['oversized',()=>['x'.repeat(200000)]],
  ['UTF-8 oversized',()=>['界'.repeat(100)]],['wrong description',p=>[imageStorageFaultHeader(p),'unowned']],
  ['failure mode',p=>[imageStorageFaultHeader({...p,mode:'before-fail'})]],
  ['native abort mode',p=>[imageStorageFaultHeader({...p,mode:'before-abort'})]],
  ['old producer mode',p=>[imageStorageFaultHeader({...p,mode:'before-fence'})]],
])test('reject control before native transaction: '+name,async t=>{
  const f=await fixture(t);f.arm(...change(f.probe));
  await assert.rejects(f.db.batch([f.statement()]),/INVALID_CONTROL/);assert.equal(f.batches,0);
});
test('valid control cannot pause another tenant or an unarmed probe',async t=>{
  const f=await fixture(t);f.arm();
  assert.equal(await f.db.batch([f.statement('c02-success-'+randomUUID())]),f.sentinel);
  await assert.rejects(f.db.batch([f.statement()]),/NOT_ARMED_OR_OWNERSHIP_CHANGED/);assert.equal(f.batches,1);
});
test('foreign statements, ambiguous accounting batches and session bypasses fail closed',async t=>{
  const f=await fixture(t);f.arm();
  await assert.rejects(f.db.batch([f.db.prepare('SELECT 1'),f.native.prepare('SELECT 2')]),/FOREIGN_STATEMENT/);
  await assert.rejects(f.db.batch([f.statement(),f.statement()]),/AMBIGUOUS_BATCH/);
  assert.throws(()=>f.db.withSession(),/SESSION_NOT_IN_SCOPE/);assert.equal(f.batches,0);
});
test('changed probe ownership aborts pause without executing native batch',async t=>{
  const f=await fixture(t);f.arm();const row=imageStorageFaultRow(f.probe);
  f.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const pending=f.db.batch([f.statement()]);pending.catch(()=>undefined);
  const deadline=performance.now()+2000;
  while(JSON.parse(f.row('SELECT value FROM system_config WHERE key=?',row.key).value).phase!=='held-before-commit'){
    assert.ok(performance.now()<deadline);await new Promise(r=>setTimeout(r,5));
  }
  f.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('ownership-changed',row.key);
  await assert.rejects(pending,/OWNERSHIP_CHANGED/);assert.equal(f.batches,0);
});
test('disabled or rejected host performs no probe lookup or other D1 I/O',async t=>{
  const f=await fixture(t),host=createUsageRecoveryHost();
  const settings={RECOVERY_ENVIRONMENT:'staging',RECOVERY_ENABLED:'true',RECOVERY_MAX_ITEMS:'5',RECOVERY_CONCURRENCY:'1',RECOVERY_LEASE_SECONDS:'30',RECOVERY_RUN_BUDGET_MS:'5000',RECOVERY_RESERVED_BYTES:'67108864',RECOVERY_INSTANCE_BYTES:'67108864'};
  let reads=0;const db=withRecoveryFencingProbe({...f.db,prepare(){reads++;throw Error('Unexpected I/O');}});
  const context={waitUntil(){throw Error('host rejected');}};
  assert.deepEqual(await host.run(db,{...settings,RECOVERY_ENABLED:'false'},context),{status:'disabled'});
  assert.deepEqual(await host.run(db,settings,context),{status:'host_rejected'});assert.equal(reads,0);
});
test('unreleased consumer pause times out and never invokes native transaction',{timeout:15000},async t=>{
  const f=await fixture(t);f.arm();const row=imageStorageFaultRow(f.probe);
  f.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  await assert.rejects(f.db.batch([f.statement()]),/RELEASE_TIMEOUT/);
  assert.equal(JSON.parse(f.row('SELECT value FROM system_config WHERE key=?',row.key).value).phase,'release-timeout');
  assert.equal(f.batches,0);
});

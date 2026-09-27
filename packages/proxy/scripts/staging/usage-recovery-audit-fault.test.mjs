import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaidRecoveryFixture, recoveryFixtureDatabase, paidRecoveryObservations, assertPaidRecoveryObservation,
  assertPaidRecoverySchema, paidRecoveryCleanup } from './usage-recovery-paid-fixture.mjs';
import { recoveryAuditFault, RECOVERY_FAULT_SCHEMA_QUERY, assertRecoveryFaultSchema } from './usage-recovery-audit-fault.mjs';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';

const plain = v => JSON.parse(JSON.stringify(v));
const settings = { RECOVERY_ENVIRONMENT:'staging', RECOVERY_ENABLED:'true', RECOVERY_MAX_ITEMS:'5', RECOVERY_CONCURRENCY:'1',
  RECOVERY_LEASE_SECONDS:'30', RECOVERY_RUN_BUDGET_MS:'5000', RECOVERY_RESERVED_BYTES:'67108864', RECOVERY_INSTANCE_BYTES:'67108864' };
const batch = (db,ss) => db.binding.batch(ss.map(s => db.binding.prepare(s.sql).bind(...s.params)));
const observe = (db,f) => Object.fromEntries(Object.entries(paidRecoveryObservations(f)).map(([k,s])=>[k,plain(db.sqlite.prepare(s.sql).all(...s.params))]));
const schema = db => plain(db.sqlite.prepare(RECOVERY_FAULT_SCHEMA_QUERY).all());
async function run(db) {
  const promises=[],host=createUsageRecoveryHost(), result=await host.run(db.binding,settings,{waitUntil:p=>promises.push(p)});
  await Promise.all(promises);assert.equal(result.status,'finished');assert.equal(host.snapshot().capacity.requests,0);return result.result;
}
async function fixture(t) {
  const f=await buildPaidRecoveryFixture(),db=recoveryFixtureDatabase(t),clock={seconds:Math.floor(Date.now()/1000)};
  db.sqlite.function('unixepoch',{varargs:true},()=>clock.seconds);
  await batch(db,f.seed);return{f,db,clock,fault:recoveryAuditFault(f)};
}

test('real conditional audit trigger aborts late accounting, defers once, then recovers with a fresh fenced receipt', async t => {
  const {f,db,clock,fault}=await fixture(t),before=schema(db);db.sqlite.exec(fault.create);
  assertRecoveryFaultSchema(before,schema(db),fault,true);
  await assertPaidRecoverySchema((sql,params)=>db.binding.prepare(sql).bind(...params).all());
  const first=await run(db);
  assert.deepEqual(first,{scanned:3,claimed:3,committed:2,blocked:0,deferred:1,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false});
  const failed=observe(db,f);assertPaidRecoveryObservation(f,failed,'audit_fault');
  const job=plain(db.sqlite.prepare('SELECT available_at,updated_at FROM request_usage_recovery_jobs WHERE request_id=?').get(fault.targetRequestId));
  assert.equal(job.available_at-job.updated_at,5);
  assert.equal((await run(db)).scanned,0);assert.deepEqual(observe(db,f),failed);
  db.sqlite.exec(fault.drop);assertRecoveryFaultSchema(before,schema(db),fault,false);
  clock.seconds=job.available_at;const second=await run(db);assert.equal(second.scanned,1);assert.equal(second.committed,1);
  const done=observe(db,f);assertPaidRecoveryObservation(f,done,'recovered_audit_fault');
  assert.equal((await run(db)).scanned,0);assert.deepEqual(observe(db,f),done);
  await batch(db,paidRecoveryCleanup(f));assert.ok(Object.values(observe(db,f)).every(v=>v.length===0));
});

test('audit fault cannot affect a different synthetic user or its positive-cost transactions', async t => {
  const {f,db,fault}=await fixture(t), other=await buildPaidRecoveryFixture();db.sqlite.exec(fault.create);
  // Commit the first fixture's non-target rows before introducing the other tenant.
  await run(db);await batch(db,other.seed);assert.equal((await run(db)).committed,3);
  assertPaidRecoveryObservation(other,observe(db,other),'committed');
  assertPaidRecoveryObservation(f,observe(db,f),'audit_fault');
});

test('fault DDL rejects arbitrary identifiers, quote injection and different fee target', async () => {
  const f=await buildPaidRecoveryFixture();
  for(const mutate of [v=>v.id="staging-recovery-';DROP TABLE users;--",v=>v.userId+="'",v=>v.keyId+="'",
    v=>v.cases[1].requestId="gen-';DROP TABLE users;--",v=>v.cases[1].cost=1]) {
    const bad=structuredClone(f);mutate(bad);assert.throws(()=>recoveryAuditFault(bad));
  }
  const fault=recoveryAuditFault(f);assert.match(fault.name,/^staging_recovery_audit_fault_[a-f0-9]{32}$/);
  assert.equal(fault.create.match(/RAISE\(ABORT/g).length,1);
});

test('whole-schema verifier rejects changed preexisting objects, extra objects, wrong target and truncated snapshots', async t => {
  const {db,fault}=await fixture(t),before=schema(db);db.sqlite.exec(fault.create);const after=schema(db);
  assertRecoveryFaultSchema(before,after,fault,true);
  for(const mutate of [rows=>rows[0].sql='tampered',rows=>rows.pop(),rows=>rows.push({...rows[0]}),
    rows=>rows.find(r=>r.name===fault.name).tbl_name='users']) {
    const bad=structuredClone(after);mutate(bad);assert.throws(()=>assertRecoveryFaultSchema(before,bad,fault,true));
  }
  assert.throws(()=>assertRecoveryFaultSchema(Array(512).fill(before[0]),after,fault,true));
  assert.throws(()=>assertRecoveryFaultSchema(before,after,fault,false));
});

test('fault-state evidence rejects a partial economic write or a falsely completed job', async t => {
  const {f,db,fault}=await fixture(t);db.sqlite.exec(fault.create);await run(db);const good=observe(db,f);
  assertPaidRecoveryObservation(f,good,'audit_fault');
  for(const mutate of [o=>o.account[0].budget_spent_micros=300000,o=>o.account[0].budget_reserved_micros=0,
    o=>o.jobs.find(j=>j.request_id===fault.targetRequestId).state='committed',
    o=>o.reservations.find(r=>r.request_id===fault.targetRequestId).settled_micros=100000,
    o=>o.logs.push({id:fault.targetRequestId}),o=>o.receipts.push({request_id:fault.targetRequestId})]) {
    const bad=structuredClone(good);mutate(bad);assert.throws(()=>assertPaidRecoveryObservation(f,bad,'audit_fault'));
  }
});

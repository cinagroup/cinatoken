import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaidRecoveryFixture, recoveryFixtureDatabase, paidRecoveryObservations,
  assertPaidRecoveryObservation, paidRecoveryCleanup, PAID_FIXTURE_TABLES, assertPaidRecoverySchema } from './usage-recovery-paid-fixture.mjs';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { createUsageRecoveryJobsD1 } from '../../../core/src/storage/recovery/usage-recovery-jobs-d1.ts';

const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5',
  RECOVERY_CONCURRENCY: '1', RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000',
  RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const plain = value => JSON.parse(JSON.stringify(value));
async function batch(db, statements) {
  return db.binding.batch(statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
}
function observe(db, f) {
  return Object.fromEntries(Object.entries(paidRecoveryObservations(f)).map(([k, s]) => [k, plain(db.sqlite.prepare(s.sql).all(...s.params))]));
}
const counts = db => Object.fromEntries(PAID_FIXTURE_TABLES.map(t => [t, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n]));
test('REST schema adapter preserves success and rejects missing/false success or transport failure', async t => {
  const db = recoveryFixtureDatabase(t);
  const query = (sql,params) => db.binding.prepare(sql).bind(...params).all();
  await assertPaidRecoverySchema(query);
  await assert.rejects(assertPaidRecoverySchema(async(sql,params) => ({ results:(await query(sql,params)).results })));
  await assert.rejects(assertPaidRecoverySchema(async(sql,params) => ({ ...(await query(sql,params)), success:false })));
  await assert.rejects(assertPaidRecoverySchema(async() => { throw new Error('transport failed'); }));
});
async function run(db, host = createUsageRecoveryHost()) {
  const held = [], result = await host.run(db.binding, settings, { waitUntil: p => held.push(p) });
  await Promise.all(held); assert.equal(result.status, 'finished');
  assert.equal(host.snapshot().capacity.requests, 0);
  assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return result.result;
}

test('synthetic fixture replays repository transitions, real enqueue and positive accounting exactly once', async t => {
  const f = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t), before = counts(db);
  assert.ok(f.seed.every(s => /^\s*(INSERT|UPDATE)\b/.test(s.sql)));
  assert.ok(!f.seed.some(s => /INSERT INTO request_usage_recovery_jobs/.test(s.sql)));
  assert.ok(!f.seed.some(s => /INSERT INTO request_usage_commit_receipts/.test(s.sql)));
  await batch(db, f.seed);
  assertPaidRecoveryObservation(f, observe(db,f), 'pending');
  const host = createUsageRecoveryHost(), first = await run(db,host);
  assert.deepEqual(first, { scanned:3,claimed:3,committed:3,blocked:0,deferred:0,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false });
  const after = observe(db,f); assertPaidRecoveryObservation(f,after,'committed');
  const repeat = await run(db,host);
  assert.ok(Object.values(repeat).every(v => v === 0 || v === false));
  assert.deepEqual(observe(db,f), after);
  await batch(db,paidRecoveryCleanup(f));
  assert.deepEqual(counts(db), before);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('atomic seed rejects duplicate identity with no partial changes', async t => {
  const f = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t);
  await batch(db,f.seed); const before = observe(db,f);
  await assert.rejects(batch(db,f.seed), /UNIQUE/);
  assert.deepEqual(observe(db,f), before);
});

test('late critical batch failure rolls back receipt, completion, budget, logs, stats and attempts together', async t => {
  const f = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t); await batch(db,f.seed);
  const jobs = createUsageRecoveryJobsD1(db.binding);
  const candidate = (await jobs.scanDue({kind:'all'},5)).find(c => c.ref.requestId === f.cases[1].requestId);
  const claim = await jobs.claim(candidate,30); assert.equal(claim.status,'claimed');
  const before = observe(db,f); let injected = 0;
  db.hooks.beforeStatement = sql => { if (/INSERT INTO user_audit_logs/.test(sql)) { injected++; throw new Error('synthetic audit insert failure'); } };
  await assert.rejects(db.repo.commit(claim.lease.ref,claim.lease.proof), /synthetic audit insert failure/);
  assert.equal(injected,1); assert.deepEqual(observe(db,f),before);
  db.hooks.beforeStatement = undefined;
  await db.repo.commit(claim.lease.ref,claim.lease.proof);
  assert.equal((await run(db)).committed,2);
  assertPaidRecoveryObservation(f,observe(db,f),'committed');
});

test('lost batch acknowledgement reconciles receipt without charging twice', async t => {
  const f = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t); await batch(db,f.seed);
  let lost = 0;
  db.hooks.afterBatch = sql => { if(sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts'))) { lost++; throw new Error('synthetic lost acknowledgement'); } };
  assert.equal((await run(db)).committed,3); assert.equal(lost,3);
  assertPaidRecoveryObservation(f,observe(db,f),'committed');
  assert.equal((await run(db)).scanned,0); assert.equal(lost,3);
});

test('cleanup leaves a second synthetic tenant and all its accounting facts untouched', async t => {
  const f = await buildPaidRecoveryFixture(), other = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t);
  await batch(db,other.seed); assert.equal((await run(db)).committed,3);
  const before = observe(db,other), beforeCounts = counts(db);
  await batch(db,f.seed); assert.equal((await run(db)).committed,3);
  await batch(db,paidRecoveryCleanup(f));
  assert.deepEqual(observe(db,other), before); assert.deepEqual(counts(db), beforeCounts);
});

test('evidence checker rejects false pass on amount, attribution, duplicate aggregate and snapshot identity', async t => {
  const f = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase(t); await batch(db,f.seed); await run(db);
  const good = observe(db,f); assertPaidRecoveryObservation(f,good,'committed');
  for(const mutate of [o => o.account[0].budget_spent_micros++, o => o.logs[0].created_at='2026-09-07T00:00:00.000Z',
    o => o.stats[0].request_count++, o => o.snapshots[0].payload_sha256='0'.repeat(64), o => o.audit.pop(),
    o => o.receipts[0].lease_revision=2, o => o.jobs[0].attempts=2]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => assertPaidRecoveryObservation(f,bad,'committed'));
  }
});

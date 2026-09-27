import test from 'node:test';
import assert from 'node:assert/strict';
import { sample } from '../../../core/src/storage/recovery/usage-settlement-test-support.mjs';
import { encodeUsageSettlement, decodeUsageSettlement, settlementDigest, MAX_SETTLEMENT_BYTES } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { createUsageRecoveryJobsD1 } from '../../../core/src/storage/recovery/usage-recovery-jobs-d1.ts';
import { buildPaidRecoveryFixture, recoveryFixtureDatabase, paidRecoveryObservations, assertPaidRecoveryObservation,
  paidRecoveryCleanup, PAID_FIXTURE_TABLES } from './usage-recovery-paid-fixture.mjs';
import { MAX_SNAPSHOT_PROFILES, exactSizeSettlement, buildMaxSnapshotRecoveryFixture } from './usage-recovery-max-snapshot-fixture.mjs';

const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5',
  RECOVERY_CONCURRENCY: '1', RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000',
  RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const plain = value => JSON.parse(JSON.stringify(value));
const batch = (db, statements) => db.binding.batch(statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
const observe = (db, f) => Object.fromEntries(Object.entries(paidRecoveryObservations(f))
  .map(([key, s]) => [key, plain(db.sqlite.prepare(s.sql).all(...s.params))]));
const counts = db => Object.fromEntries(PAID_FIXTURE_TABLES.map(table => [table, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n]));
async function run(db, host = createUsageRecoveryHost()) {
  const held = [], result = await host.run(db.binding, settings, { waitUntil: promise => held.push(promise) });
  await Promise.all(held);
  assert.equal(result.status, 'finished');
  assert.equal(host.snapshot().active, false);
  assert.equal(host.snapshot().capacity.requests, 0);
  assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return result.result;
}

for (const profile of MAX_SNAPSHOT_PROFILES) {
  test(profile + ': exact UTF-8 max-1 / max accepted, max+1 rejected on encode and decode', async () => {
    const input = sample(0.1), before = structuredClone(input);
    for (const delta of [-1, 0, 1]) {
      const sized = await exactSizeSettlement(input, profile, MAX_SETTLEMENT_BYTES + delta);
      assert.deepEqual(input, before, 'Sizing must not mutate the caller');
      assert.deepEqual(sized.intent, before.intent);
      assert.equal(sized.params.chargedCost, before.params.chargedCost);
      assert.deepEqual(sized.params.userBudgetSettlement, before.params.userBudgetSettlement);
      const json = JSON.stringify(sized);
      assert.equal(Buffer.byteLength(json), MAX_SETTLEMENT_BYTES + delta);
      if (profile === 'unicode') assert.ok(json.length < Buffer.byteLength(json));
      if (delta === 1) {
        await assert.rejects(encodeUsageSettlement(sized), /Settlement payload limit exceeded/);
        await assert.rejects(decodeUsageSettlement(json, await settlementDigest(json)), /Invalid stored settlement bounds/);
      } else {
        const encoded = await encodeUsageSettlement(sized);
        assert.equal(Buffer.byteLength(encoded.json), MAX_SETTLEMENT_BYTES + delta);
        assert.deepEqual(await decodeUsageSettlement(encoded.json, encoded.sha256), sized);
        await assert.rejects(decodeUsageSettlement(encoded.json, '0'.repeat(64)), /content mismatch/);
      }
    }
  });

  test(profile + ': exact-size seed / real host settlement / repeat / exact cleanup', async t => {
    const f = await buildMaxSnapshotRecoveryFixture(profile), db = recoveryFixtureDatabase(t), baseline = counts(db);
    assert.equal(f.cases.length, 3);
    assert.ok(f.cases.every(c => c.payloadBytes === MAX_SETTLEMENT_BYTES));
    assert.ok(!f.seed.some(s => /INSERT INTO request_usage_(recovery_jobs|commit_receipts)/.test(s.sql)));
    const oversized = structuredClone(f.seed);
    oversized.find(s => /^\s*INSERT INTO request_usage_settlements\b/.test(s.sql)).params[9] += ' ';
    await assert.rejects(batch(db, oversized), /CHECK/);
    assert.deepEqual(counts(db), baseline, 'SQL byte-bound rejection must leave no partial seed');
    await batch(db, f.seed);
    const before = observe(db, f); assertPaidRecoveryObservation(f, before, 'pending');
    await assert.rejects(batch(db, f.seed), /UNIQUE/);
    assert.deepEqual(observe(db, f), before, 'Duplicate seed must roll back atomically');
    const host = createUsageRecoveryHost();
    assert.deepEqual(await run(db, host), { scanned: 3, claimed: 3, committed: 3, blocked: 0, deferred: 0,
      lostOwnership: 0, uncertain: 0, skipped: 0, capacityLimited: false, admissionStopped: false });
    const after = observe(db, f); assertPaidRecoveryObservation(f, after, 'committed');
    assert.deepEqual(after.snapshots, before.snapshots);
    assert.ok(Object.values(await run(db, host)).every(value => value === 0 || value === false));
    assert.deepEqual(observe(db, f), after);
    // Verify persisted large audit fields as well as the scalar financial projection.
    for (const c of f.cases) {
      const stored = db.sqlite.prepare('SELECT payload_json FROM request_usage_settlements WHERE request_id=?').get(c.requestId);
      const value = await decodeUsageSettlement(stored.payload_json, c.payloadSha256);
      const log = db.sqlite.prepare('SELECT raw_usage,pricing_audit,route_trace,timing_metadata FROM api_key_request_logs WHERE id=?').get(c.requestId);
      assert.equal(log.raw_usage, value.params.requestLog.rawUsage);
      assert.equal(log.pricing_audit, value.params.requestLog.pricingAudit);
      assert.equal(log.route_trace, value.params.requestLog.routeTrace ?? null);
      assert.equal(log.timing_metadata, value.params.requestLog.timingMetadata ?? null);
    }
    await batch(db, paidRecoveryCleanup(f));
    assert.deepEqual(counts(db), baseline);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('maximum snapshot late audit failure rolls back the full batch before exact retry', async t => {
  const f = await buildMaxSnapshotRecoveryFixture('dense'), db = recoveryFixtureDatabase(t);
  await batch(db, f.seed);
  const jobs = createUsageRecoveryJobsD1(db.binding);
  const candidate = (await jobs.scanDue({ kind: 'all' }, 5)).find(c => c.ref.requestId === f.cases[1].requestId);
  const claim = await jobs.claim(candidate, 30); assert.equal(claim.status, 'claimed');
  const before = observe(db, f); let faults = 0;
  db.hooks.beforeStatement = sql => { if (/INSERT INTO user_audit_logs/.test(sql)) { faults++; throw new Error('max snapshot audit fault'); } };
  await assert.rejects(db.repo.commit(claim.lease.ref, claim.lease.proof), /max snapshot audit fault/);
  assert.equal(faults, 1); assert.deepEqual(observe(db, f), before);
  db.hooks.beforeStatement = undefined;
  await db.repo.commit(claim.lease.ref, claim.lease.proof);
  assert.equal((await run(db)).committed, 2);
  assertPaidRecoveryObservation(f, observe(db, f), 'committed');
});

test('maximum snapshot lost acknowledgement reconciles once and repeat is a no-op', async t => {
  const f = await buildMaxSnapshotRecoveryFixture('escaped'), db = recoveryFixtureDatabase(t);
  await batch(db, f.seed); let faults = 0;
  db.hooks.afterBatch = sql => {
    if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts'))) { faults++; throw new Error('lost maximum snapshot acknowledgement'); }
  };
  assert.equal((await run(db)).committed, 3); assert.equal(faults, 3);
  const after = observe(db, f); assertPaidRecoveryObservation(f, after, 'committed');
  assert.equal((await run(db)).scanned, 0);
  assert.equal(faults, 3); assert.deepEqual(observe(db, f), after);
});

test('maximum snapshot cleanup preserves another tenant and its accounting', async t => {
  const other = await buildPaidRecoveryFixture(), f = await buildMaxSnapshotRecoveryFixture('unicode'), db = recoveryFixtureDatabase(t);
  await batch(db, other.seed); assert.equal((await run(db)).committed, 3);
  const before = observe(db, other), baseline = counts(db);
  await batch(db, f.seed); assert.equal((await run(db)).committed, 3);
  await batch(db, paidRecoveryCleanup(f));
  assert.deepEqual(observe(db, other), before); assert.deepEqual(counts(db), baseline);
});

test('maximum snapshot fixture rejects unknown profiles and sizes outside boundary tests', async () => {
  for (const profile of ['', 'production', 'ASCII', null]) {
    await assert.rejects(buildMaxSnapshotRecoveryFixture(profile), /Unknown maximum snapshot profile/);
  }
  for (const size of [0, MAX_SETTLEMENT_BYTES - 2, MAX_SETTLEMENT_BYTES + 2, NaN, Infinity]) {
    await assert.rejects(exactSizeSettlement(sample(), 'ascii', size));
  }
});

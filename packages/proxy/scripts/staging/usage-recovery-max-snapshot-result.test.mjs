import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMaxSnapshotRecoveryResult } from './usage-recovery-max-snapshot-result.mjs';
import { buildMaxSnapshotRecoveryFixture } from './usage-recovery-max-snapshot-fixture.mjs';
import { recoveryFixtureDatabase, paidRecoveryObservations, assertPaidRecoveryObservation } from './usage-recovery-paid-fixture.mjs';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';

test('maximum snapshot result allows either admission flag only with exact complete counters', () => {
  for (const committed of [0, 3, 5]) for (const admissionStopped of [false, true]) {
    const result = { scanned: committed, claimed: committed, committed, blocked: 0, deferred: 0,
      lostOwnership: 0, uncertain: 0, skipped: 0, capacityLimited: false, admissionStopped };
    const before = structuredClone(result);
    assertMaxSnapshotRecoveryResult(result, committed); assert.deepEqual(result, before);
    for (const field of ['scanned', 'claimed', 'committed', 'blocked', 'deferred', 'lostOwnership', 'uncertain', 'skipped']) {
      assert.throws(() => assertMaxSnapshotRecoveryResult({ ...result, [field]: result[field] + 1 }, committed));
    }
    for (const admissionStopped of [undefined, null, 0, 1, 'true']) {
      assert.throws(() => assertMaxSnapshotRecoveryResult({ ...result, admissionStopped }, committed));
    }
    assert.throws(() => assertMaxSnapshotRecoveryResult({ ...result, capacityLimited: true }, committed));
    assert.throws(() => assertMaxSnapshotRecoveryResult({ ...result, unknown: 1 }, committed));
  }
});

test('real maximum snapshot host can commit all jobs before reporting the expired admission window', async t => {
  const f = await buildMaxSnapshotRecoveryFixture('ascii'), db = recoveryFixtureDatabase(t);
  await db.binding.batch(f.seed.map(s => db.binding.prepare(s.sql).bind(...s.params)));
  let now = 0, commits = 0;
  db.hooks.afterBatch = sql => {
    if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts')) && ++commits === 3) now = 5000;
  };
  const host = createUsageRecoveryHost({ now: () => now }), held = [];
  const result = await host.run(db.binding, { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5',
    RECOVERY_CONCURRENCY: '1', RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000',
    RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' }, { waitUntil: p => held.push(p) });
  await Promise.all(held); assert.equal(result.status, 'finished');
  assert.equal(result.result.admissionStopped, true); assertMaxSnapshotRecoveryResult(result.result, 3);
  const observation = Object.fromEntries(Object.entries(paidRecoveryObservations(f))
    .map(([key, s]) => [key, JSON.parse(JSON.stringify(db.sqlite.prepare(s.sql).all(...s.params)))]));
  assertPaidRecoveryObservation(f, observation, 'committed');
  assert.equal(host.snapshot().active, false); assert.equal(host.snapshot().capacity.reservedBytes, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMaxSnapshotRecoveryFixture, MAX_SNAPSHOT_PROFILES } from './usage-recovery-max-snapshot-fixture.mjs';
import { recoveryFixtureDatabase, paidRecoveryObservations, assertPaidRecoveryObservation, paidRecoveryCleanup, PAID_FIXTURE_TABLES } from './usage-recovery-paid-fixture.mjs';
import { recoverySeedBatches, MAX_RECOVERY_SEED_WIRE_BYTES } from './usage-recovery-seed-batches.mjs';
const apply = (db, statements) => db.binding.batch(statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
const observe = (db, f) => Object.fromEntries(Object.entries(paidRecoveryObservations(f))
  .map(([key, s]) => [key, JSON.parse(JSON.stringify(db.sqlite.prepare(s.sql).all(...s.params)))]));
const counts = db => Object.fromEntries(PAID_FIXTURE_TABLES.map(t => [t, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n]));
for (const profile of MAX_SNAPSHOT_PROFILES) {
  test(profile + ': bounded batches preserve all statements, values, ordering and durable snapshot identity', async t => {
    const f = await buildMaxSnapshotRecoveryFixture(profile), before = structuredClone(f), batches = recoverySeedBatches(f);
    assert.deepEqual(f, before); assert.ok(batches.length > 1);
    assert.deepEqual(batches.flatMap(b => b.statements), f.seed);
    const db = recoveryFixtureDatabase(t), baseline = counts(db);
    for (const b of batches) {
      const wire = JSON.stringify({ batch: b.statements });
      assert.ok(b.wireBytes <= MAX_RECOVERY_SEED_WIRE_BYTES); assert.equal(b.wireBytes, Buffer.byteLength(wire));
      assert.equal(b.sha256, createHash('sha256').update(wire).digest('hex'));
      await apply(db, b.statements);
    }
    assertPaidRecoveryObservation(f, observe(db, f), 'pending');
    await apply(db, paidRecoveryCleanup(f)); assert.deepEqual(counts(db), baseline);
  });
}
test('every interrupted seed prefix is exactly cleanable without assuming cross-batch atomicity', async t => {
  const f = await buildMaxSnapshotRecoveryFixture('escaped'), batches = recoverySeedBatches(f);
  for (let prefix = 1; prefix <= batches.length; prefix++) {
    const db = recoveryFixtureDatabase(t), baseline = counts(db);
    for (const b of batches.slice(0, prefix)) await apply(db, b.statements);
    // Represents lost ACK after this batch; do not repeat it or execute remaining seed.
    await apply(db, f.seed.slice(-2)); // Disable exact identities if they exist.
    assert.ok(observe(db, f).jobs.every(j => j.state === 'pending'));
    await apply(db, paidRecoveryCleanup(f)); assert.deepEqual(counts(db), baseline);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  }
});
test('planner owns copies and rejects oversized single statements or invalid fixture identity', async () => {
  const f = await buildMaxSnapshotRecoveryFixture('unicode'), batches = recoverySeedBatches(f);
  const original = structuredClone(batches);
  f.seed[0].params[0] = 'mutated'; assert.deepEqual(batches, original);
  const invalid = await buildMaxSnapshotRecoveryFixture('unicode'); invalid.userId = 'production-user';
  assert.throws(() => recoverySeedBatches(invalid));
  const oversized = await buildMaxSnapshotRecoveryFixture('ascii'); oversized.seed[0].params[0] = 'x'.repeat(MAX_RECOVERY_SEED_WIRE_BYTES);
  assert.throws(() => recoverySeedBatches(oversized), /exceeds the operator transport bound/);
});

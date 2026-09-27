import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { recoveryFixtureDatabase } from './usage-recovery-paid-fixture.mjs';
import { buildFiveRecoveryFixture, fiveRecoveryObservations, fiveRecoveryCleanup, FIVE_FIXTURE_TABLES } from './usage-recovery-five-fixture.mjs';
import { fiveRecoverySeedBatches, MAX_FIVE_SEED_WIRE_BYTES } from './usage-recovery-five-seed.mjs';
import { assertFiveSnapshotProgress, assertFiveSnapshotInvocationProgress } from './usage-recovery-five-progress.mjs';
const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5', RECOVERY_CONCURRENCY: '1',
  RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000', RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const apply = (db, statements) => db.binding.batch(statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
const observe = (db, f) => Object.fromEntries(Object.entries(fiveRecoveryObservations(f))
  .map(([key, s]) => [key, JSON.parse(JSON.stringify(db.sqlite.prepare(s.sql).all(...s.params)))]));
const counts = db => Object.fromEntries(FIVE_FIXTURE_TABLES.map(name => [name, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n]));
async function seed(db, f) { for (const b of fiveRecoverySeedBatches(f)) await apply(db, b.statements); }
async function run(db, host) {
  const held = [], response = await host.run(db.binding, settings, { waitUntil: p => held.push(p) });
  await Promise.all(held); assert.equal(response.status, 'finished');
  assert.equal(host.snapshot().active, false); assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return response.result;
}
for (const profile of ['ascii', 'unicode', 'dense', 'escaped']) {
  test('five exact maximum snapshots: ' + profile + ' seed, settle, audit, deduplicate and cleanup', async t => {
    const f = await buildFiveRecoveryFixture(profile), db = recoveryFixtureDatabase(t), baseline = counts(db);
    assert.equal(f.seed.length, 28); assert.equal(f.cases.length, 5);
    const batches = fiveRecoverySeedBatches(f);
    assert.deepEqual(batches.flatMap(b => b.statements), f.seed);
    for (const b of batches) {
      const wire = JSON.stringify({ batch: b.statements });
      assert.ok(b.wireBytes <= MAX_FIVE_SEED_WIRE_BYTES); assert.equal(b.wireBytes, Buffer.byteLength(wire));
      assert.equal(b.sha256, createHash('sha256').update(wire).digest('hex'));
    }
    await seed(db, f); const initial = observe(db, f); assertFiveSnapshotProgress(f, initial);
    const host = createUsageRecoveryHost({ now: () => 0 }); // Deterministic admission only, not a physical timing proof.
    const result = await run(db, host), complete = observe(db, f);
    assert.deepEqual(assertFiveSnapshotInvocationProgress(f, initial, complete, result), { committed: 5, pending: 0 });
    assert.equal(result.scanned, 5); assert.equal(complete.account[0].budget_spent_micros, 1000000);
    const equal = db.sqlite.prepare(`SELECT s.request_id,
      l.raw_usage=json_extract(s.payload_json,'$.params.requestLog.rawUsage') AS raw,
      l.pricing_audit=json_extract(s.payload_json,'$.params.requestLog.pricingAudit') AS pricing,
      l.route_trace IS json_extract(s.payload_json,'$.params.requestLog.routeTrace') AS route,
      l.timing_metadata IS json_extract(s.payload_json,'$.params.requestLog.timingMetadata') AS timing
      FROM request_usage_settlements s JOIN api_key_request_logs l ON s.request_id=l.id WHERE s.user_id=?`).all(f.userId);
    assert.equal(equal.length, 5); assert.ok(equal.every(r => r.raw === 1 && r.pricing === 1 && r.route === 1 && r.timing === 1));
    assertFiveSnapshotInvocationProgress(f, complete, observe(db, f), await run(db, host));
    assert.deepEqual(observe(db, f), complete);
    await apply(db, fiveRecoveryCleanup(f)); assert.deepEqual(counts(db), baseline);
  });
}
for (const boundary of ['before-claim', 'after-claim']) {
  test('five-item scan resumes after ' + boundary + ' with original retry due time', async t => {
    const f = await buildFiveRecoveryFixture('unicode'), db = recoveryFixtureDatabase(t); await seed(db, f);
    let now = 0, commits = 0, claims = 0;
    const host = createUsageRecoveryHost({ now: () => now });
    db.hooks.afterBatch = sql => {
      if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts')) && ++commits === 2 && boundary === 'before-claim') now = 5000;
    };
    db.hooks.afterStatement = sql => {
      if (sql.includes("state=CASE WHEN attempts<5 THEN 'leased'") && ++claims === 3 && boundary === 'after-claim') now = 5000;
    };
    const initial = observe(db, f), first = await run(db, host), partial = observe(db, f);
    assert.deepEqual(assertFiveSnapshotInvocationProgress(f, initial, partial, first), { committed: 2, pending: 3 });
    assert.equal(first.scanned, 5); assert.equal(first.deferred, boundary === 'after-claim' ? 1 : 0);
    db.hooks.afterBatch = undefined; db.hooks.afterStatement = undefined;
    const interrupted = partial.jobs.find(j => j.state === 'pending' && j.attempts === 1);
    if (boundary === 'after-claim') {
      assert.ok(interrupted);
      const due = db.sqlite.prepare("SELECT available_at,updated_at,unixepoch('now') AS now_seconds FROM request_usage_recovery_jobs WHERE request_id=?").get(interrupted.request_id);
      assert.equal(due.available_at - due.updated_at, 5);
      const remaining = Math.max(0, due.available_at - due.now_seconds); assert.ok(remaining <= 5);
      await new Promise(resolve => setTimeout(resolve, remaining * 1000 + 50));
    } else assert.equal(interrupted, undefined);
    const next = await run(db, host), complete = observe(db, f);
    assert.deepEqual(assertFiveSnapshotInvocationProgress(f, partial, complete, next), { committed: 5, pending: 0 });
    assert.equal(next.committed, 3);
    if (interrupted) assert.equal(complete.receipts.find(r => r.request_id === interrupted.request_id).lease_revision, 3);
    const repeat = await run(db, host); assertFiveSnapshotInvocationProgress(f, complete, observe(db, f), repeat);
    assert.deepEqual(observe(db, f), complete);
  });
}
test('scan limit five excludes additional due jobs and does not lose their later settlement', async t => {
  const a = await buildFiveRecoveryFixture('ascii'), b = await buildFiveRecoveryFixture('dense'), db = recoveryFixtureDatabase(t);
  await seed(db, a); await seed(db, b);
  const order = db.sqlite.prepare("SELECT request_id FROM request_usage_recovery_jobs ORDER BY available_at,request_id").all().map(j => j.request_id);
  assert.equal(order.length, 10);
  const host = createUsageRecoveryHost({ now: () => 0 }), first = await run(db, host);
  assert.equal(first.scanned, 5); assert.equal(first.claimed, 5); assert.equal(first.committed, 5);
  for (const f of [a, b]) {
    const o = observe(db, f); assertFiveSnapshotProgress(f, o);
    for (const j of o.jobs) assert.equal(j.state, order.slice(0, 5).includes(j.request_id) ? 'committed' : 'pending');
  }
  const second = await run(db, host); assert.equal(second.committed, 5);
  for (const f of [a, b]) { const o = observe(db, f); assertFiveSnapshotProgress(f, o); assert.ok(o.jobs.every(j => j.state === 'committed')); }
  const beforeOther = observe(db, b); await apply(db, fiveRecoveryCleanup(a)); assert.deepEqual(observe(db, b), beforeOther);
  assert.equal((await run(db, host)).committed, 0);
});
test('every five-item seed prefix is cleanable and cannot remove another synthetic tenant', async t => {
  const f = await buildFiveRecoveryFixture('escaped'), other = await buildFiveRecoveryFixture('ascii'), batches = fiveRecoverySeedBatches(f);
  for (let prefix = 1; prefix <= batches.length; prefix++) {
    const db = recoveryFixtureDatabase(t); await seed(db, other); const baseline = counts(db), otherBefore = observe(db, other);
    for (const b of batches.slice(0, prefix)) await apply(db, b.statements);
    await apply(db, f.seed.slice(-2));
    assert.ok(observe(db, f).jobs.every(j => j.state === 'pending'));
    await apply(db, fiveRecoveryCleanup(f)); assert.deepEqual(counts(db), baseline);
    assert.deepEqual(observe(db, other), otherBefore); assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  }
});
test('five-item fixture and progress checks reject identity, financial and terminal-state corruption', async t => {
  const f = await buildFiveRecoveryFixture('unicode'), db = recoveryFixtureDatabase(t); await seed(db, f);
  const initial = observe(db, f), result = await run(db, createUsageRecoveryHost({ now: () => 0 })), complete = observe(db, f);
  for (const mutate of [o => o.account[0].budget_spent_micros++, o => o.receipts.pop(), o => o.logs.pop(), o => o.audit.pop(),
    o => o.jobs[0].attempts++, o => o.jobs[0].state = 'leased', o => o.stats[0].request_count++, o => o.snapshots[0].bytes--]) {
    const bad = structuredClone(complete); mutate(bad); assert.throws(() => assertFiveSnapshotProgress(f, bad));
  }
  for (const change of [{ scanned: 6 }, { committed: 4 }, { uncertain: 1 }, { capacityLimited: true }])
    assert.throws(() => assertFiveSnapshotInvocationProgress(f, initial, complete, { ...result, ...change }));
  for (const mutate of [v => v.userId = 'production', v => v.cases.pop(), v => v.cases[4].cost = 99,
    v => v.syntheticFundsOnly = false, v => v.cases[4].requestId = v.cases[0].requestId]) {
    const bad = structuredClone(f); mutate(bad);
    assert.throws(() => fiveRecoveryObservations(bad)); assert.throws(() => fiveRecoveryCleanup(bad)); assert.throws(() => fiveRecoverySeedBatches(bad));
  }
  const oversized = structuredClone(f); oversized.seed[0].params[0] = 'x'.repeat(MAX_FIVE_SEED_WIRE_BYTES);
  assert.throws(() => fiveRecoverySeedBatches(oversized), /exceeds the operator transport bound/);
});

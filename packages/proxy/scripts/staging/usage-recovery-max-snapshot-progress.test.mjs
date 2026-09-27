import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { buildMaxSnapshotRecoveryFixture } from './usage-recovery-max-snapshot-fixture.mjs';
import { recoveryFixtureDatabase, paidRecoveryObservations } from './usage-recovery-paid-fixture.mjs';
import { assertMaxSnapshotProgress, assertMaxSnapshotInvocationProgress } from './usage-recovery-max-snapshot-progress.mjs';
const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5', RECOVERY_CONCURRENCY: '1',
  RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000', RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const observe = (db, f) => Object.fromEntries(Object.entries(paidRecoveryObservations(f))
  .map(([key, s]) => [key, JSON.parse(JSON.stringify(db.sqlite.prepare(s.sql).all(...s.params)))]));
async function run(db, host) {
  const held = [], r = await host.run(db.binding, settings, { waitUntil: p => held.push(p) });
  await Promise.all(held); assert.equal(r.status, 'finished');
  assert.equal(host.snapshot().active, false); assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return r.result;
}
for (const boundary of ['before-claim', 'after-claim']) {
  test('maximum snapshot resumes after budget stop ' + boundary + ' without rewriting clocks or snapshots', async t => {
    const f = await buildMaxSnapshotRecoveryFixture('unicode'), db = recoveryFixtureDatabase(t);
    await db.binding.batch(f.seed.map(s => db.binding.prepare(s.sql).bind(...s.params)));
    let now = 0, commits = 0, claims = 0;
    const host = createUsageRecoveryHost({ now: () => now });
    db.hooks.afterBatch = sql => {
      if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts')) && ++commits === 2 && boundary === 'before-claim') now = 5000;
    };
    db.hooks.afterStatement = sql => {
      if (sql.includes("state=CASE WHEN attempts<5 THEN 'leased'") && ++claims === 3 && boundary === 'after-claim') now = 5000;
    };
    const initial = observe(db, f), first = await run(db, host), partial = observe(db, f);
    assert.deepEqual(assertMaxSnapshotInvocationProgress(f, initial, partial, first), { committed: 2, pending: 1 });
    assert.equal(first.admissionStopped, true); assert.equal(first.deferred, boundary === 'after-claim' ? 1 : 0);
    const pending = partial.jobs.find(j => j.state === 'pending');
    assert.equal(pending.attempts, boundary === 'after-claim' ? 1 : 0);
    db.hooks.afterBatch = undefined; db.hooks.afterStatement = undefined;
    if (boundary === 'after-claim') {
      const due = db.sqlite.prepare("SELECT available_at,updated_at,unixepoch('now') AS now_seconds FROM request_usage_recovery_jobs WHERE request_id=?").get(pending.request_id);
      assert.equal(due.available_at - due.updated_at, 5);
      // Observe the original DB backoff; never UPDATE available_at or fake D1 time.
      assert.ok(Math.max(0, due.available_at - due.now_seconds) <= 5);
      // A host timer firing is not evidence that SQLite's wall clock reached
      // available_at (clock adjustment/early wakeup can leave the job not due).
      // Observe the actual admission predicate, bounded in reads and monotonic time.
      const started = performance.now();
      for (let poll = 0; ; poll++) {
        assert.ok(poll < 32 && performance.now() - started < 7500, 'original DB backoff did not become due within bounded wait');
        const current = db.sqlite.prepare("SELECT available_at,updated_at,unixepoch('now') AS now_seconds FROM request_usage_recovery_jobs WHERE request_id=?").get(pending.request_id);
        assert.equal(current.available_at, due.available_at); assert.equal(current.updated_at, due.updated_at);
        if (current.now_seconds >= current.available_at) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const next = await run(db, host), complete = observe(db, f);
    assert.deepEqual(assertMaxSnapshotInvocationProgress(f, partial, complete, next), { committed: 3, pending: 0 });
    assert.equal(next.committed, 1);
    const job = complete.jobs.find(j => j.request_id === pending.request_id);
    assert.equal(job.revision, boundary === 'after-claim' ? 4 : 2);
    assert.equal(complete.receipts.find(r => r.request_id === pending.request_id).lease_revision, job.revision - 1);
    const repeat = await run(db, host); assertMaxSnapshotInvocationProgress(f, complete, observe(db, f), repeat);
    assert.deepEqual(observe(db, f), complete);
  });
}
test('progress checker rejects false completion, duplicate effects, uncertain outcomes and regressions', async t => {
  const f = await buildMaxSnapshotRecoveryFixture('dense'), db = recoveryFixtureDatabase(t);
  await db.binding.batch(f.seed.map(s => db.binding.prepare(s.sql).bind(...s.params)));
  const before = observe(db, f), result = await run(db, createUsageRecoveryHost()), after = observe(db, f);
  assertMaxSnapshotInvocationProgress(f, before, after, result);
  for (const mutate of [o => o.account[0].budget_spent_micros++, o => o.receipts.pop(), o => o.logs.pop(),
    o => o.jobs[0].attempts++, o => o.jobs[0].state = 'leased', o => o.jobs[0].last_error = 'execution_error',
    o => o.stats[0].request_count++, o => o.audit.pop(), o => o.snapshots[0].bytes--]) {
    const bad = structuredClone(after); mutate(bad); assert.throws(() => assertMaxSnapshotProgress(f, bad));
  }
  assert.throws(() => assertMaxSnapshotInvocationProgress(f, after, before, { ...result, committed: 0 }));
  for (const change of [{ uncertain: 1 }, { committed: 2 }, { claimed: 4 }, { scanned: 4 }, { capacityLimited: true }, { admissionStopped: 'true' }]) {
    assert.throws(() => assertMaxSnapshotInvocationProgress(f, before, after, { ...result, ...change }));
  }
});

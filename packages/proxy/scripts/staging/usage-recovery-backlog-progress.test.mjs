import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { recoveryFixtureDatabase } from './usage-recovery-paid-fixture.mjs';
import { buildFiveRecoveryFixture, fiveRecoveryObservations, fiveRecoveryCleanup, FIVE_FIXTURE_TABLES } from './usage-recovery-five-fixture.mjs';
import { fiveRecoverySeedBatches } from './usage-recovery-five-seed.mjs';
import { BACKLOG_RECOVERY_SCOPE_QUERY, assertBacklogSnapshotProgress, assertBacklogSnapshotInvocationProgress } from './usage-recovery-backlog-progress.mjs';

const settings = { RECOVERY_ENVIRONMENT: 'staging', RECOVERY_ENABLED: 'true', RECOVERY_MAX_ITEMS: '5', RECOVERY_CONCURRENCY: '1',
  RECOVERY_LEASE_SECONDS: '30', RECOVERY_RUN_BUDGET_MS: '5000', RECOVERY_RESERVED_BYTES: '67108864', RECOVERY_INSTANCE_BYTES: '67108864' };
const plain = value => JSON.parse(JSON.stringify(value));
const apply = (db, statements) => db.binding.batch(statements.map(s => db.binding.prepare(s.sql).bind(...s.params)));
const observe = (db, fixtures) => fixtures.map(f => Object.fromEntries(Object.entries(fiveRecoveryObservations(f))
  .map(([key, s]) => [key, plain(db.sqlite.prepare(s.sql).all(...s.params))])));
const scope = db => plain(db.sqlite.prepare(BACKLOG_RECOVERY_SCOPE_QUERY).all());
const counts = db => Object.fromEntries(FIVE_FIXTURE_TABLES.map(table => [table, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n]));
async function seed(db, fixtures) {
  for (const f of fixtures) for (const b of fiveRecoverySeedBatches(f)) await apply(db, b.statements);
}
async function run(db, host) {
  const held = [], response = await host.run(db.binding, settings, { waitUntil: p => held.push(p) });
  await Promise.all(held); assert.equal(response.status, 'finished');
  assert.equal(host.snapshot().active, false); assert.equal(host.snapshot().capacity.reservedBytes, 0);
  return response.result;
}
async function fixtures() { return [await buildFiveRecoveryFixture('ascii'), await buildFiveRecoveryFixture('dense')]; }
async function checkedRun(db, fs, host) {
  const before = observe(db, fs), rows = scope(db), result = await run(db, host), after = observe(db, fs);
  const progress = assertBacklogSnapshotInvocationProgress(fs, before, after, result, rows);
  return { before, rows, result, after, progress };
}

test('ten original due jobs drain in two bounded pages with exact tenant accounting and isolated cleanup', async t => {
  const fs = await fixtures(), db = recoveryFixtureDatabase(t), baseline = counts(db);
  await seed(db, fs); const initial = observe(db, fs), rows = scope(db);
  assert.deepEqual(assertBacklogSnapshotProgress(fs, initial), { committed: 0, pending: 10 });
  assert.equal(rows.filter(r => r.available_at <= r.now_seconds).length, 10);
  const host = createUsageRecoveryHost({ now: () => 0 }); // Deterministic local admission, not physical timing.
  const first = await checkedRun(db, fs, host);
  assert.equal(first.result.scanned, 5); assert.deepEqual(first.progress, { committed: 5, pending: 5 });
  assert.deepEqual(first.after.flatMap(o => o.jobs).filter(j => j.state === 'committed').map(j => j.request_id).sort(), rows.slice(0, 5).map(r => r.request_id).sort());
  const second = await checkedRun(db, fs, host);
  assert.equal(second.result.scanned, 5); assert.deepEqual(second.progress, { committed: 10, pending: 0 });
  for (const o of second.after) {
    assert.equal(o.account[0].budget_spent_micros, 1000000); assert.equal(o.account[0].budget_reserved_micros, 0);
  }
  const repeat = await checkedRun(db, fs, host);
  assert.equal(repeat.result.scanned, 0); assert.deepEqual(repeat.after, second.after);
  const other = observe(db, [fs[1]]); await apply(db, fiveRecoveryCleanup(fs[0]));
  assert.deepEqual(observe(db, [fs[1]]), other);
  await apply(db, fiveRecoveryCleanup(fs[1])); assert.deepEqual(counts(db), baseline);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const boundary of ['before-claim', 'after-claim']) {
  test('ten-job backlog survives ' + boundary + ' budget interruption and original database backoff', async t => {
    const fs = await fixtures(), db = recoveryFixtureDatabase(t); await seed(db, fs);
    let now = 0, commits = 0, claims = 0;
    const host = createUsageRecoveryHost({ now: () => now });
    db.hooks.afterBatch = sql => {
      if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts')) && ++commits === 2 && boundary === 'before-claim') now = 5000;
    };
    db.hooks.afterStatement = sql => {
      if (sql.includes("state=CASE WHEN attempts<5 THEN 'leased'") && ++claims === 3 && boundary === 'after-claim') now = 5000;
    };
    const first = await checkedRun(db, fs, host);
    assert.deepEqual(first.progress, { committed: 2, pending: 8 }); assert.equal(first.result.scanned, 5);
    assert.equal(first.result.deferred, boundary === 'after-claim' ? 1 : 0);
    db.hooks.afterBatch = undefined; db.hooks.afterStatement = undefined;
    const interrupted = first.after.flatMap(o => o.jobs).find(j => j.state === 'pending' && j.attempts === 1);
    if (boundary === 'after-claim') {
      assert.ok(interrupted);
      const due = db.sqlite.prepare("SELECT available_at,updated_at,unixepoch('now') AS now_seconds FROM request_usage_recovery_jobs WHERE request_id=?").get(interrupted.request_id);
      assert.equal(due.available_at - due.updated_at, 5);
      const remaining = Math.max(0, due.available_at - due.now_seconds); assert.ok(remaining <= 5);
      await new Promise(resolve => setTimeout(resolve, remaining * 1000 + 50)); // Never rewrite the job clock.
    } else assert.equal(interrupted, undefined);
    const second = await checkedRun(db, fs, host);
    assert.deepEqual(second.progress, { committed: 7, pending: 3 }); assert.equal(second.result.scanned, 5);
    const third = await checkedRun(db, fs, host);
    assert.deepEqual(third.progress, { committed: 10, pending: 0 }); assert.equal(third.result.scanned, 3);
    if (interrupted) {
      const receipt = third.after.flatMap(o => o.receipts).find(r => r.request_id === interrupted.request_id);
      assert.equal(receipt.lease_revision, 3);
    }
    assert.deepEqual((await checkedRun(db, fs, host)).after, third.after);
  });
}

test('ten-job backlog accepts observed 3+3+3+1 commits without claiming an entire scanned page', async t => {
  const fs = await fixtures(), db = recoveryFixtureDatabase(t); await seed(db, fs);
  let now = 0, commits = 0;
  const host = createUsageRecoveryHost({ now: () => now });
  db.hooks.afterBatch = sql => {
    if (sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts')) && ++commits === 3) now += 5000;
  };
  const expectedScans = [5, 5, 4, 1], expectedCommits = [3, 3, 3, 1];
  for (let i = 0; i < 4; i++) {
    commits = 0;
    const v = await checkedRun(db, fs, host);
    assert.equal(v.result.scanned, expectedScans[i]); assert.equal(v.result.committed, expectedCommits[i]);
    assert.equal(v.result.claimed, expectedCommits[i]); assert.equal(v.result.deferred, 0);
    assert.equal(v.result.admissionStopped, i < 3);
    assert.equal(v.progress.committed, Math.min((i + 1) * 3, 10));
  }
  db.hooks.afterBatch = undefined;
  const repeat = await checkedRun(db, fs, host);
  assert.equal(repeat.result.claimed, 0); assert.deepEqual(repeat.progress, { committed: 10, pending: 0 });
});

test('global first-page evidence rejects wrong ordering, ownership, omissions, extra jobs and false scan counts', async t => {
  const fs = await fixtures(), db = recoveryFixtureDatabase(t); await seed(db, fs);
  const v = await checkedRun(db, fs, createUsageRecoveryHost({ now: () => 0 }));
  for (const mutate of [r => r.reverse(), r => r.pop(), r => r.push(structuredClone(r[0])),
    r => r[0].user_id = fs[1].userId + '-foreign', r => r[0].payload_sha256 = '0'.repeat(64),
    r => r[0].now_seconds++, r => r[0].available_at = r[0].now_seconds + 30,
    r => r[0].request_id = 'gen-00000000-0000-0000-0000-000000000000']) {
    const bad = structuredClone(v.rows); mutate(bad);
    assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.before, v.after, v.result, bad));
  }
  const noEffects = { ...v.result, scanned: 4, claimed: 0, committed: 0, admissionStopped: true };
  assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.before, v.before, noEffects, v.rows), /observed due first page/);
  assertBacklogSnapshotInvocationProgress(fs, v.before, v.before, { ...noEffects, scanned: 0 }, v.rows);
  const otherPrefix = structuredClone(v.rows);
  // Another well-formed, all-due ordering has the same counts/owners but cannot
  // justify these five claims. The oracle must inspect selection, not totals.
  for (let i = 0; i < otherPrefix.length; i++) otherPrefix[i].available_at = otherPrefix[i].now_seconds - (i < 5 ? 1 : 2);
  otherPrefix.sort((a, b) => a.available_at - b.available_at || (a.request_id < b.request_id ? -1 : 1));
  assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.before, v.after, v.result, otherPrefix), /sequential due prefix/);
  const foreign = await buildFiveRecoveryFixture('unicode'); await seed(db, [foreign]);
  assert.equal(scope(db).length, 11); // Query is bounded while still detecting out-of-scope work.
  assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.after, v.after,
    { ...noEffects, scanned: 0 }, scope(db)), /exactly the ten fixture jobs/);
});

test('cross-tenant checker rejects misleading aggregates, changed projections, duplicate owners and recaptured commits', async t => {
  const fs = await fixtures(), db = recoveryFixtureDatabase(t); await seed(db, fs);
  const v = await checkedRun(db, fs, createUsageRecoveryHost({ now: () => 0 }));
  for (const change of [{ scanned: 6 }, { claimed: 4 }, { committed: 4 }, { deferred: 1 },
    { uncertain: 1 }, { blocked: 1 }, { skipped: 1 }, { capacityLimited: true }, { admissionStopped: 'false' }])
    assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.before, v.after, { ...v.result, ...change }));
  for (const key of ['account', 'key', 'intents', 'snapshots', 'jobs', 'reservations', 'receipts', 'logs', 'attempts', 'audit', 'stats']) {
    const bad = structuredClone(v.after);
    const nonempty = bad.find(o => o[key].length);
    nonempty[key].pop();
    assert.throws(() => assertBacklogSnapshotProgress(fs, bad), 'projection ' + key);
  }
  const money = structuredClone(v.after);
  money[0].account[0].budget_spent_micros++; money[1].account[0].budget_spent_micros--;
  assert.throws(() => assertBacklogSnapshotProgress(fs, money)); // Aggregate spend is unchanged.
  const captured = structuredClone(v.after), o = captured.find(o => o.jobs.some(j => j.state === 'committed'));
  const job = o.jobs.find(j => j.state === 'committed'); job.attempts++; job.revision += 2;
  o.receipts.find(r => r.request_id === job.request_id).lease_revision += 2;
  assertBacklogSnapshotProgress(fs, captured); // Internally consistent terminal state is insufficient.
  assert.throws(() => assertBacklogSnapshotInvocationProgress(fs, v.after, captured,
    { ...v.result, claimed: 0, committed: 0, scanned: 0 }), /cannot be recaptured/);
  assert.throws(() => assertBacklogSnapshotProgress([fs[0], fs[0]], [v.after[0], v.after[0]]));
  assert.throws(() => assertBacklogSnapshotProgress(fs.slice(0, 1), v.after.slice(0, 1)));
  const overlapping = structuredClone(fs); overlapping[1].cases[0].requestId = overlapping[0].cases[0].requestId;
  assert.throws(() => assertBacklogSnapshotProgress(overlapping, v.after), /Overlapping fixture requestId/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPostgresSharedUsageRepairBackfillPage,
  runPostgresSharedUsageRepairBackfillPage,
} from './build-postgres-shared-usage-repair-backfill.mjs';

test('historical usage repair page is bounded, pinned and keyset resumable', async () => {
  await assert.rejects(buildPostgresSharedUsageRepairBackfillPage({ limit: 1 }),
    /Explicit reviewed-v1/);
  for (const limit of [0, 501, 1.5, NaN]) {
    await assert.rejects(buildPostgresSharedUsageRepairBackfillPage({
      activation: 'reviewed-v1', limit }), /limit must be 1..500/);
  }
  for (const afterEarningId of [undefined, 3, 'bad\0cursor', '\ud800']) {
    if (afterEarningId === undefined) continue;
    await assert.rejects(buildPostgresSharedUsageRepairBackfillPage({
      activation: 'reviewed-v1', afterEarningId, limit: 2 }), /Invalid earning ID cursor/);
  }
  const first = await buildPostgresSharedUsageRepairBackfillPage({
    activation: 'reviewed-v1', limit: 500 });
  assert.equal(first.historySha256,
    '454a720f9a6b7410e0aad99c2aaa2eb3327fbbac8c86bb3e3cd4537131e6611b');
  assert.equal(first.jobsSha256,
    '7b2f288ecb83e34207bcfd5a2a4eec934c0d6e156190826816ab033716c173d4');
  assert.match(first.preflightSql, /LOCK TABLE cinatoken_gateway\.shared_key_earnings,[\s\S]*IN ROW EXCLUSIVE MODE/);
  assert.match(first.preflightSql, /SESSION_USER <> 'cinatoken_gateway_migrator'/);
  assert.match(first.preflightSql, /c\.contype = 'p' AND NOT c\.condeferrable/);
  assert.match(first.preflightSql, /t\.tgqual IS NULL/);
  assert.match(first.batchSql, /ORDER BY id\s+LIMIT 500/);
  assert.match(first.batchSql, /ON CONFLICT \(shared_key_id\) DO NOTHING/);
  assert.doesNotMatch(first.batchSql, /\bOFFSET\b/);
  const resume = await buildPostgresSharedUsageRepairBackfillPage({
    activation: 'reviewed-v1', afterEarningId: '', limit: 2 });
  assert.match(resume.batchSql,
    /WHERE id > pg_catalog\.convert_from\(pg_catalog\.decode\('','hex'\),'UTF8'\)/);
});

test('page runner exposes the cursor only after COMMIT resolves', async () => {
  const events = [];
  const sql = {
    async begin(callback) {
      const result = await callback({ unsafe(text) {
        if (text.startsWith('SET LOCAL')) return { async simple() { events.push('preflight'); } };
        events.push('batch');
        return Promise.resolve([{ scanned: 2, enqueued: 1, next_earning_id: 'earning-02' }]);
      } });
      events.push('commit');
      return result;
    },
  };
  const result = await runPostgresSharedUsageRepairBackfillPage(sql,
    { activation: 'reviewed-v1', limit: 2 });
  assert.deepEqual(events, ['preflight', 'batch', 'commit']);
  assert.deepEqual(result, { scanned: 2, enqueued: 1,
    nextEarningId: 'earning-02', afterEarningId: null });
  const ackLost = { async begin(callback) {
    await callback({ unsafe(text) {
      if (text.startsWith('SET LOCAL')) return { async simple() {} };
      return Promise.resolve([{ scanned: 1, enqueued: 1, next_earning_id: 'earning-01' }]);
    } });
    throw new Error('commit acknowledgement lost');
  } };
  await assert.rejects(runPostgresSharedUsageRepairBackfillPage(ackLost,
    { activation: 'reviewed-v1', limit: 1 }), /commit acknowledgement lost/);
});

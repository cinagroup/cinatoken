import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPostgresSharedUsageRepairDurableCursorActivation,
  runPostgresSharedUsageRepairDurablePage,
} from './build-postgres-shared-usage-repair-durable-cursor.mjs';

test('reviewed cursor activation keeps progress in a private migrator-owned schema', async () => {
  await assert.rejects(buildPostgresSharedUsageRepairDurableCursorActivation(),
    /Explicit reviewed-v1/);
  const sql = await buildPostgresSharedUsageRepairDurableCursorActivation({
    activation: 'reviewed-v1',
  });
  assert.match(sql, /SESSION_USER <> 'cinatoken_gateway_migrator'/);
  assert.match(sql, /pg_has_role\(runtime_oid, migrator_oid, 'MEMBER'\)/);
  assert.match(sql, /'pg_read_all_data'::pg_catalog\.regrole, 'MEMBER'/);
  assert.match(sql, /'pg_write_all_data'::pg_catalog\.regrole, 'MEMBER'/);
  assert.doesNotMatch(sql, /pg_has_role\(runtime_oid, migrator_oid, 'USAGE'\)/);
  assert.match(sql, /has_database_privilege\([\s\S]*'CREATE'\)/);
  assert.match(sql, /CREATE SCHEMA cinatoken_repair_maintenance AUTHORIZATION cinatoken_gateway_migrator/);
  assert.match(sql, /REVOKE ALL ON SCHEMA cinatoken_repair_maintenance FROM cinatoken_gateway_runtime/);
  assert.match(sql, /CREATE TABLE cinatoken_repair_maintenance\.shared_key_usage_repair_cursor/);
  assert.match(sql, /INSERT INTO cinatoken_repair_maintenance\.shared_key_usage_repair_cursor\(singleton\) VALUES \(1\)/);
  assert.ok(sql.indexOf('Historical shared-key repair backfill source contract differs')
    < sql.indexOf('CREATE SCHEMA cinatoken_repair_maintenance'));
});

test('durable page reads locked database cursor and returns only after COMMIT', async () => {
  for (const limit of [0, 501, 1.5]) {
    await assert.rejects(runPostgresSharedUsageRepairDurablePage({}, {
      activation: 'reviewed-v1', limit,
    }), /limit must be 1..500/);
  }
  await assert.rejects(runPostgresSharedUsageRepairDurablePage({}, { limit: 1 }),
    /Explicit reviewed-v1/);
  const events = [];
  const batchLimits = [];
  const sql = { async begin(callback) {
    const result = await callback({ unsafe(query, parameters) {
      if (query.startsWith('SET LOCAL')) {
        events.push('preflight');
        return { async simple() {} };
      }
      if (query.includes('FOR UPDATE')) {
        events.push('locked-cursor');
        return Promise.resolve([{ last_earning_id: 'earning-02', pages_committed: 1 }]);
      }
      if (query.startsWith('WITH batch')) {
        events.push('batch');
        assert.match(query, /WHERE id > pg_catalog\.convert_from/);
        batchLimits.push(Number(query.match(/LIMIT (\d+)/)?.[1]));
        return Promise.resolve([{ scanned: 2, enqueued: 1,
          next_earning_id: 'earning-04' }]);
      }
      if (query.startsWith('UPDATE cinatoken_repair_maintenance')) {
        events.push('cursor-update');
        assert.deepEqual(parameters, ['earning-04']);
        return Promise.resolve([{ last_earning_id: 'earning-04', pages_committed: 2 }]);
      }
      throw new Error(`Unexpected query ${query.slice(0, 80)}`);
    } });
    events.push('commit');
    return result;
  } };
  const result = await runPostgresSharedUsageRepairDurablePage(sql, {
    activation: 'reviewed-v1', limit: 2,
  });
  assert.deepEqual(events, ['preflight', 'locked-cursor', 'preflight',
    'batch', 'cursor-update', 'commit']);
  assert.deepEqual(result, { scanned: 2, enqueued: 1,
    afterEarningId: 'earning-02', nextEarningId: 'earning-04', pagesCommitted: 2 });
  await runPostgresSharedUsageRepairDurablePage(sql, {
    activation: 'reviewed-v1', limit: 500,
  });
  assert.deepEqual(batchLimits, [2, 500]);
});

// Local SQLite/D1 plan and scale fixture; no remote D1 database is opened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createD1PortalLedgerRepository } from '../../../packages/core/src/db/d1/portal-marketplace.impl.ts';
import { createSqliteD1 } from '../../../packages/proxy/src/test-support/sqlite-d1.ts';

const proposal = readFileSync(new URL('../../../packages/core/migrations-proposals/d1/shared-key-earnings-projection-index.sql', import.meta.url), 'utf8');
const rowCount = 25_000;
const keyCount = 100;
const targetKey = 'projection-key-1';
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function seed(sqlite) {
  sqlite.exec(`
    INSERT INTO users(id,email) VALUES ('projection-seller','projection-seller@example.invalid');
    INSERT INTO user_earnings(user_id) VALUES ('projection-seller');
    INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug)
      VALUES ('projection-workspace','personal','projection-seller','Projection','projection');
    INSERT INTO api_keys(id,key,user_id,workspace_id)
      VALUES ('projection-api-key','synthetic-key','projection-seller','projection-workspace');
    WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<${keyCount - 1})
    INSERT INTO shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
      SELECT 'projection-key-'||x,'projection-seller','openai','synthetic-'||x,'fingerprint-'||x FROM n;
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${rowCount})
    INSERT INTO api_key_request_logs(id,user_id,api_key_id,workspace_id)
      SELECT 'projection-log-'||x,'projection-seller','projection-api-key','projection-workspace' FROM n;
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${rowCount})
    INSERT INTO shared_key_earnings
      (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,net_amount,created_at)
      SELECT 'projection-earning-'||x,'projection-log-'||x,
        'projection-key-'||((x-1)%${keyCount}),'projection-seller',x%17,x%23,0.01,
        '2026-09-24T00:00:00.000Z' FROM n;
  `);
}

test('D1 25k-row shared-key projection rebuild uses the review-only covering index',
  { timeout: 120_000 }, async () => {
    let captured;
    const db = createSqliteD1({ beforeStatement(sql, values) {
      if (/^UPDATE shared_keys\s+SET served_input_tokens/u.test(sql)) captured = { sql, values };
    } });
    const { sqlite, binding } = db;
    try {
      assert.equal(db.migrationFiles.length, 68);
      seed(sqlite);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM shared_key_earnings').get().n, rowCount);
      assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM pragma_index_list('shared_key_earnings')
        WHERE name='idx_shared_key_earnings_key_projection'`).get().n, 0);
      const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw: binding, drizzle: {} });
      const rebuild = () => ledger.rebuildSharedKeyUsageFromEarnings(
        'projection-log-2', targetKey, '2026-09-24T01:00:00.000Z');
      const measure = async () => {
        const samples = [];
        for (let n = 0; n < 5; n++) {
          const started = performance.now();
          await rebuild();
          samples.push(Number((performance.now() - started).toFixed(3)));
        }
        return median(samples);
      };
      const beforeMs = await measure();
      assert.ok(captured);
      const plan = () => sqlite.prepare(`EXPLAIN QUERY PLAN ${captured.sql}`).all(...captured.values)
        .map(row => row.detail);
      const beforePlan = plan();
      assert.equal(beforePlan.filter(detail => /SCAN shared_key_earnings\b/u.test(detail)).length, 3);
      assert.ok(beforePlan.includes('SEARCH shared_key_earnings'));
      const beforeBytes = sqlite.prepare('PRAGMA page_count').get().page_count
        * sqlite.prepare('PRAGMA page_size').get().page_size;

      sqlite.exec(proposal);
      const afterPlan = plan();
      assert.equal(afterPlan.filter(detail => /USING COVERING INDEX idx_shared_key_earnings_key_projection/u.test(detail)).length, 4);
      const afterMs = await measure();
      const afterBytes = sqlite.prepare('PRAGMA page_count').get().page_count
        * sqlite.prepare('PRAGMA page_size').get().page_size;
      const expected = sqlite.prepare(`SELECT sum(input_tokens) AS input_tokens,
        sum(output_tokens) AS output_tokens, sum(net_amount) AS net_amount,
        max(created_at) AS last_used_at FROM shared_key_earnings WHERE shared_key_id=?`).get(targetKey);
      const actual = sqlite.prepare(`SELECT served_input_tokens AS input_tokens,
        served_output_tokens AS output_tokens, earned_total AS net_amount,
        last_used_at FROM shared_keys WHERE id=?`).get(targetKey);
      assert.deepEqual(actual, expected);
      assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM shared_key_earnings
        WHERE shared_key_id=?`).get(targetKey).n, rowCount / keyCount);
      assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
      console.log('D1 projection index fixture ' + JSON.stringify({
        formalMigrations: db.migrationFiles.length, rows: rowCount, keys: keyCount,
        targetRows: rowCount / keyCount, baselineMedianMs: beforeMs,
        indexedMedianMs: afterMs, databaseBytesBeforeIndex: beforeBytes,
        databaseBytesAfterIndex: afterBytes, beforePlan, afterPlan,
      }));
    } finally { sqlite.close(); }
  });

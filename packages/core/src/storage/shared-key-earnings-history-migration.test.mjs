import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createSqliteD1 } from '../../../proxy/src/test-support/sqlite-d1.ts';
import { createD1PortalLedgerRepository } from '../db/d1/portal-marketplace.impl.ts';

const heads = {
  d1: '0073_shared_key_earnings_history_guard.sql',
  postgres: '0078_shared_key_earnings_history_guard.sql',
  mysql: '0069_shared_key_earnings_history_guard.sql',
};
const migration = driver => readFileSync(new URL(`../../migrations-${driver}/${heads[driver]}`, import.meta.url), 'utf8');
const immutable = /credited_shared_key_earning_history_immutable|FOREIGN KEY constraint failed/u;
const seedSql = `
  INSERT INTO users(id,email) VALUES ('history-seller','seller@example.invalid'),('history-buyer','buyer@example.invalid');
  INSERT INTO user_earnings(user_id) VALUES ('history-seller');
  INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug)
    VALUES ('history-space','personal','history-buyer','Buyer','buyer');
  INSERT INTO api_keys(id,key,user_id,workspace_id,name)
    VALUES ('history-api-key','test-only-hash','history-buyer','history-space','Buyer key');
  INSERT INTO shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
    VALUES ('history-key','history-seller','openai','test-only-secret','history-fingerprint');
  INSERT INTO api_key_request_logs(id,user_id,api_key_id,workspace_id)
    VALUES ('history-log','history-buyer','history-api-key','history-space');
  INSERT INTO shared_key_earnings(id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,platform_fee,net_amount)
    VALUES ('history-earning','history-log','history-key','history-seller',100,50,0.05,0.01,0.04);
`;

function beforeGuard() {
  const db = createSqliteD1({}, { applyMigrations: false });
  for (const file of db.migrationFiles.filter(name => name < heads.d1)) {
    db.sqlite.exec(readFileSync(new URL(`../../migrations-d1/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}

function financialState(sqlite) {
  const tables = ['users', 'shared_keys', 'api_key_request_logs', 'shared_key_earnings', 'user_earnings', 'portal_ledger_entries'];
  if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='shared_key_earning_history_anchors'").get()) {
    tables.push('shared_key_earning_history_anchors');
  }
  return Object.fromEntries(tables.map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function applyGuard(sqlite) {
  sqlite.exec('BEGIN');
  try { sqlite.exec(migration('d1')); sqlite.exec('COMMIT'); }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

function log(sqlite, id) {
  sqlite.prepare(`INSERT INTO api_key_request_logs(id,user_id,api_key_id,workspace_id)
    VALUES (?,'history-buyer','history-api-key','history-space')`).run(id);
}

function earning(id, requestLogId = id + '-log') {
  return { id, requestLogId, sharedKeyId: 'history-key', sellerUserId: 'history-seller',
    inputTokens: 200, outputTokens: 70, cacheReadTokens: 4, cacheWriteTokens: 3,
    grossAmount: 0.025, platformFee: 0.005, netAmount: 0.02, currency: 'USD',
    nowIso: '2026-09-30T00:00:00.000Z' };
}

test('formal three-library guards append after the frozen lifecycle-audit heads and retain insert-only writers', () => {
  for (const driver of Object.keys(heads)) {
    const files = readdirSync(new URL(`../../migrations-${driver}/`, import.meta.url)).filter(name => name.endsWith('.sql')).sort();
    const position = files.indexOf(heads[driver]);
    assert.equal(position, Number(heads[driver].slice(0, 4)) - 1);
    assert.ok(files[position - 1].endsWith('_admin_access_key_audit.sql'));
    const sql = migration(driver);
    assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM)\s+(?:cinatoken_gateway\.)?(?:shared_key_earnings|user_earnings|portal_ledger_entries)\b/iu);
    assert.doesNotMatch(sql, /INSERT INTO\s+(?:cinatoken_gateway\.)?shared_key_earnings\b/iu);
    const writer = readFileSync(new URL(`../db/${driver}/portal-marketplace.impl.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(writer, /(?:UPDATE|DELETE FROM)\s+(?:cinatoken_gateway\.)?shared_key_earnings\b/iu);
  }
  const mysql = migration('mysql');
  for (const fk of ['fk_shared_key_earnings_log', 'fk_shared_key_earnings_key', 'fk_shared_key_earnings_user']) {
    assert.match(mysql, new RegExp(`DROP FOREIGN KEY ${fk}`, 'u'));
    assert.match(mysql, new RegExp(`ADD CONSTRAINT ${fk}[\\s\\S]*?ON UPDATE RESTRICT ON DELETE RESTRICT`, 'u'));
  }
  assert.match(mysql, /FOREIGN KEY \(earning_id\) REFERENCES shared_key_earnings\(id\)/u);
  assert.equal((mysql.match(/SIGNAL SQLSTATE '45000'/gu) ?? []).length, 4);
  assert.doesNotMatch(mysql, /DELIMITER/u, 'the mysql2 migration runner executes server SQL directly');
  const pg = migration('postgres');
  assert.match(pg, /BEFORE UPDATE OR DELETE/u);
  assert.match(pg, /BEFORE TRUNCATE/u);
  assert.match(pg, /CONSTRAINT = 'shared_key_earnings_history_immutable'/u);
  assert.equal((pg.match(/ON UPDATE RESTRICT ON DELETE RESTRICT/gu) ?? []).length, 3);
});

test('D1 historical upgrade backfills anchors without replaying credits and adopts the old proposal', () => {
  const db = beforeGuard();
  try {
    db.sqlite.exec(seedSql);
    const before = financialState(db.sqlite);
    db.sqlite.exec('SAVEPOINT old_cascade');
    db.sqlite.exec("DELETE FROM shared_keys WHERE id='history-key'");
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM shared_key_earnings').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM portal_ledger_entries').get().n, 1);
    assert.equal(db.sqlite.prepare("SELECT balance_micros FROM user_earnings WHERE user_id='history-seller'").get().balance_micros, 40000);
    db.sqlite.exec('ROLLBACK TO old_cascade; RELEASE old_cascade');
    db.sqlite.exec(readFileSync(new URL('../../migrations-proposals/d1/shared-key-earnings-history-guard.sql', import.meta.url), 'utf8'));
    applyGuard(db.sqlite);
    const after = financialState(db.sqlite);
    const { shared_key_earning_history_anchors: anchors, ...facts } = after;
    assert.deepEqual(facts, before);
    assert.deepEqual(anchors.map(row => row.earning_id), ['history-earning']);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.sqlite.exec("DELETE FROM shared_keys WHERE id='history-key'"), immutable);
  } finally { db.sqlite.close(); }
});

test('D1 direct, parent-cascade and bulk cleanup failures preserve every financial row atomically', () => {
  const db = createSqliteD1();
  try {
    db.sqlite.exec(seedSql);
    db.sqlite.exec(`INSERT INTO shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
      VALUES ('unused-key','history-seller','openai','test-only-secret','unused-fingerprint');`);
    const expected = financialState(db.sqlite);
    for (const sql of [
      "UPDATE shared_key_earnings SET net_amount=0 WHERE id='history-earning'",
      "UPDATE shared_key_earnings SET id='changed' WHERE id='history-earning'",
      'DELETE FROM shared_key_earnings',
      "DELETE FROM shared_keys WHERE id='history-key'",
      'DELETE FROM shared_keys',
      "DELETE FROM api_key_request_logs WHERE created_at <= '9999-01-01'",
      "DELETE FROM users WHERE id='history-seller'",
      'DELETE FROM shared_key_earning_history_anchors',
      "UPDATE shared_key_earning_history_anchors SET earning_id='changed'",
    ]) {
      assert.throws(() => db.sqlite.exec(sql), immutable, sql);
      assert.deepEqual(financialState(db.sqlite), expected, sql);
    }
    db.sqlite.exec("DELETE FROM shared_keys WHERE id='unused-key'");
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM shared_keys').get().n, 1);
    const retained = financialState(db.sqlite);
    log(db.sqlite, 'uncredited-log');
    db.sqlite.exec("DELETE FROM api_key_request_logs WHERE id='uncredited-log'");
    db.sqlite.exec("INSERT INTO users(id,email) VALUES ('uncredited-seller','unused@example.invalid')");
    db.sqlite.exec("DELETE FROM users WHERE id='uncredited-seller'");
    assert.deepEqual(financialState(db.sqlite), retained, 'unrelated parent cleanup remains available');
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.sqlite.close(); }
});

test('D1 REPLACE cannot erase history with recursive triggers on or off', () => {
  const db = createSqliteD1();
  try {
    db.sqlite.exec(seedSql);
    const expected = financialState(db.sqlite);
    for (const recursive of ['OFF', 'ON']) {
      db.sqlite.exec('PRAGMA recursive_triggers=' + recursive);
      for (const sql of [
        `INSERT OR REPLACE INTO shared_key_earnings(id,request_log_id,shared_key_id,seller_user_id,net_amount)
          VALUES ('replacement','history-log','history-key','history-seller',0.9)`,
        `REPLACE INTO shared_key_earnings(id,request_log_id,shared_key_id,seller_user_id,net_amount)
          VALUES ('history-earning','history-log','history-key','history-seller',0.9)`,
        `INSERT OR REPLACE INTO shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
          VALUES ('history-key','history-seller','openai','replacement-secret','history-fingerprint')`,
        `INSERT OR REPLACE INTO users(id,email) VALUES ('history-seller','seller@example.invalid')`,
        `INSERT OR REPLACE INTO api_key_request_logs(id,user_id,api_key_id,workspace_id)
          VALUES ('history-log','history-buyer','history-api-key','history-space')`,
      ]) {
        assert.throws(() => db.sqlite.exec(sql), immutable, recursive + ': ' + sql);
        assert.deepEqual(financialState(db.sqlite), expected, recursive + ': ' + sql);
      }
    }
  } finally { db.sqlite.close(); }
});

test('D1 production insert/credit remains idempotent and usage repair changes only derived statistics', async () => {
  const db = createSqliteD1();
  try {
    db.sqlite.exec(seedSql);
    const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw: db.binding });
    log(db.sqlite, 'second-log');
    const params = earning('second', 'second-log');
    assert.equal(await ledger.recordEarningAndCredit(params), true);
    const credited = financialState(db.sqlite);
    assert.equal(credited.shared_key_earnings.length, 2);
    assert.equal(credited.portal_ledger_entries.length, 2);
    assert.equal(credited.shared_key_earning_history_anchors.length, 2);
    assert.equal(credited.user_earnings[0].balance_micros, 60000);
    assert.equal(await ledger.recordEarningAndCredit({ ...params, id: 'redelivery', netAmount: 9 }), false);
    assert.deepEqual(financialState(db.sqlite), credited);
    await ledger.rebuildSharedKeyUsageFromEarnings('second-log', 'history-key', params.nowIso);
    await ledger.rebuildSharedKeyUsageFromEarnings('second-log', 'history-key', params.nowIso);
    const repaired = financialState(db.sqlite);
    const { shared_keys: keys, ...otherFacts } = repaired;
    const { shared_keys: oldKeys, ...oldFacts } = credited;
    assert.equal(oldKeys[0].served_input_tokens, 0);
    assert.equal(keys[0].served_input_tokens, 300);
    assert.equal(keys[0].served_output_tokens, 120);
    assert.equal(keys[0].earned_total, 0.06);
    assert.deepEqual(otherFacts, oldFacts);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.sqlite.close(); }
});

test('D1 anchor and credit failures roll back earning, anchor, balance and journal together', async () => {
  const db = createSqliteD1();
  try {
    db.sqlite.exec(seedSql);
    const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw: db.binding });
    log(db.sqlite, 'fault-anchor-log');
    log(db.sqlite, 'fault-credit-log');
    const expected = financialState(db.sqlite);
    db.sqlite.exec(`CREATE TRIGGER fixture_anchor_failure BEFORE INSERT ON shared_key_earning_history_anchors
      BEGIN SELECT RAISE(ABORT,'fixture_anchor_failure'); END;`);
    await assert.rejects(ledger.recordEarningAndCredit(earning('fault-anchor')), /fixture_anchor_failure/u);
    assert.deepEqual(financialState(db.sqlite), expected);
    db.sqlite.exec('DROP TRIGGER fixture_anchor_failure');
    db.sqlite.exec(`CREATE TRIGGER fixture_credit_failure BEFORE INSERT ON portal_ledger_entries
      WHEN NEW.reference_id='fault-credit' BEGIN SELECT RAISE(ABORT,'fixture_credit_failure'); END;`);
    await assert.rejects(ledger.recordEarningAndCredit(earning('fault-credit')), /fixture_credit_failure/u);
    assert.deepEqual(financialState(db.sqlite), expected);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.sqlite.close(); }
});

test('D1 failed migration transaction restores its previous guards and retry preserves all historical credits', () => {
  const db = beforeGuard();
  try {
    db.sqlite.exec(seedSql);
    db.sqlite.exec(readFileSync(new URL('../../migrations-proposals/d1/shared-key-earnings-history-guard.sql', import.meta.url), 'utf8'));
    db.sqlite.exec('CREATE INDEX idx_shared_key_earnings_history_key ON shared_key_earnings(shared_key_id)');
    const expected = financialState(db.sqlite);
    assert.throws(() => applyGuard(db.sqlite), /already exists/u);
    assert.deepEqual(financialState(db.sqlite), expected);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='shared_key_earning_history_anchors'").get().n, 0);
    assert.throws(() => db.sqlite.exec("DELETE FROM shared_keys WHERE id='history-key'"), immutable);
    db.sqlite.exec('DROP INDEX idx_shared_key_earnings_history_key');
    applyGuard(db.sqlite);
    const { shared_key_earning_history_anchors: anchors, ...facts } = financialState(db.sqlite);
    assert.deepEqual(facts, expected);
    assert.equal(anchors.length, 1);
  } finally { db.sqlite.close(); }
});

test('PostgreSQL formal guard executes the complete migration chain when a local PGlite fixture is supplied',
  { skip: !process.env.GATEWAY_PGLITE_MODULE }, async () => {
    const { createFinancialEngine } = await import('../test-support/postgres-financial-engine.mjs');
    const f = await createFinancialEngine();
    try {
      assert.ok(f.migrations.includes(heads.postgres));
      // No fact exists yet: pristine-target TRUNCATE is permitted.
      await f.pg.exec('TRUNCATE cinatoken_gateway.shared_key_earnings');
      // The engine fixture intentionally has same-named temporary shadow tables.
      // Naming pg_temp last prevents its implicit precedence from seeding shadows.
      await f.pg.exec('SET search_path TO cinatoken_gateway,pg_catalog,pg_temp; ' + seedSql);
      const totals = async () => (await f.pg.query(`SELECT
        (SELECT COUNT(*)::int FROM cinatoken_gateway.shared_key_earnings) AS earnings,
        (SELECT COUNT(*)::int FROM cinatoken_gateway.portal_ledger_entries) AS ledger,
        (SELECT balance_micros::text FROM cinatoken_gateway.user_earnings WHERE user_id='history-seller') AS balance`)).rows[0];
      assert.deepEqual(await totals(), { earnings: 1, ledger: 1, balance: '40000' });
      for (const sql of [
        "DELETE FROM cinatoken_gateway.shared_keys WHERE id='history-key'",
        "DELETE FROM cinatoken_gateway.api_key_request_logs WHERE id='history-log'",
        "DELETE FROM cinatoken_gateway.users WHERE id='history-seller'",
        'DELETE FROM cinatoken_gateway.shared_key_earnings',
        'UPDATE cinatoken_gateway.shared_key_earnings SET net_amount=0',
        'TRUNCATE cinatoken_gateway.shared_key_earnings',
        'TRUNCATE cinatoken_gateway.shared_keys CASCADE',
        'TRUNCATE cinatoken_gateway.users CASCADE',
      ]) {
        await assert.rejects(f.pg.exec(sql), error => ['23001', '23503', '23514'].includes(error?.code), sql);
        assert.deepEqual(await totals(), { earnings: 1, ledger: 1, balance: '40000' });
      }
      await f.pg.exec(`INSERT INTO cinatoken_gateway.shared_key_earnings(id,request_log_id,shared_key_id,seller_user_id,net_amount)
        VALUES ('redelivery','history-log','history-key','history-seller',9) ON CONFLICT(request_log_id) DO NOTHING`);
      assert.deepEqual(await totals(), { earnings: 1, ledger: 1, balance: '40000' });
    } finally { await f.pg.close(); }
  });

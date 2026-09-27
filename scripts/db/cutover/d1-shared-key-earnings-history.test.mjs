import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSqliteD1 } from '../../../packages/proxy/src/test-support/sqlite-d1.ts';

const guardSql = readFileSync(new URL('../../../packages/core/migrations-proposals/d1/shared-key-earnings-history-guard.sql', import.meta.url), 'utf8');
const immutable = /credited_shared_key_earning_history_immutable/;

function seed(sqlite) {
  sqlite.exec(`
    INSERT INTO users(id, email) VALUES ('seller', 'seller@example.invalid');
    INSERT INTO user_earnings(user_id) VALUES ('seller');
    INSERT INTO workspaces(id, scope_type, personal_owner_user_id, name, slug)
      VALUES ('seller-workspace', 'personal', 'seller', 'Seller', 'seller');
    INSERT INTO api_keys(id, key, user_id, workspace_id, name)
      VALUES ('buyer-key', 'test-only-hash', 'seller', 'seller-workspace', 'Buyer key');
    INSERT INTO shared_keys(id, seller_user_id, channel_type, api_key, key_fingerprint)
      VALUES ('used-key', 'seller', 'openai', 'test-secret', 'used-fingerprint');
    INSERT INTO api_key_request_logs(id, user_id, api_key_id, workspace_id)
      VALUES ('used-log', 'seller', 'buyer-key', 'seller-workspace');
    INSERT INTO shared_key_earnings
      (id, request_log_id, shared_key_id, seller_user_id, net_amount)
      VALUES ('earning', 'used-log', 'used-key', 'seller', 0.04);
  `);
}

function financialState(sqlite) {
  const count = table => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    keys: count('shared_keys'),
    earnings: count('shared_key_earnings'),
    ledger: count('portal_ledger_entries'),
    balanceMicros: sqlite.prepare("SELECT balance_micros FROM user_earnings WHERE user_id='seller'").get()?.balance_micros,
  };
}

test('D1 earning history guard rejects direct and cascading mutation while keeping ordinary deletion', () => {
  const db = createSqliteD1();
  const { sqlite } = db;
  try {
    assert.ok(db.migrationFiles.length >= 68);
    assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    seed(sqlite);
    assert.deepEqual(financialState(sqlite), { keys: 1, earnings: 1, ledger: 1, balanceMicros: 40000 });

    // Confirm the historical mismatch before installing the proposal, then undo
    // only the negative control. No test fixture is left with missing history.
    sqlite.exec('SAVEPOINT pre_guard_cascade');
    sqlite.exec("DELETE FROM shared_keys WHERE id='used-key'");
    assert.deepEqual(financialState(sqlite), { keys: 0, earnings: 0, ledger: 1, balanceMicros: 40000 });
    sqlite.exec('ROLLBACK TO pre_guard_cascade; RELEASE pre_guard_cascade');

    sqlite.exec(guardSql);
    const expected = financialState(sqlite);
    for (const mutation of [
      "DELETE FROM shared_keys WHERE id='used-key'",
      "DELETE FROM users WHERE id='seller'",
      "DELETE FROM api_key_request_logs WHERE id='used-log'",
      "DELETE FROM shared_key_earnings WHERE id='earning'",
      "UPDATE shared_key_earnings SET net_amount=0 WHERE id='earning'",
    ]) {
      assert.throws(() => sqlite.exec(mutation), immutable, mutation);
      assert.deepEqual(financialState(sqlite), expected, mutation);
    }

    assert.throws(() => sqlite.exec(`
      INSERT INTO shared_key_earnings
        (id, request_log_id, shared_key_id, seller_user_id, net_amount)
        VALUES ('duplicate', 'used-log', 'used-key', 'seller', 0.04)
    `), /UNIQUE constraint failed/);
    assert.deepEqual(financialState(sqlite), expected);

    sqlite.exec("UPDATE shared_keys SET status='disabled', input_price=2 WHERE id='used-key'");
    assert.deepEqual(financialState(sqlite), expected);

    sqlite.exec(`
      INSERT INTO shared_keys(id, seller_user_id, channel_type, api_key, key_fingerprint)
        VALUES ('unused-key', 'seller', 'openai', 'test-secret', 'unused-fingerprint');
      DELETE FROM shared_keys WHERE id='unused-key';
    `);
    assert.deepEqual(financialState(sqlite), expected);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    sqlite.close();
  }
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDirectory = join(root, 'packages/core/migrations-d1');
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys = ON');

for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()) {
	const sql = readFileSync(join(migrationsDirectory, file), 'utf8');
	assert.doesNotMatch(
		sql,
		/\bSELECT\s+CASE\b/iu,
		`${file} contains an unparenthesized SELECT CASE that Wrangler can misparse inside a trigger`,
	);
	database.exec(sql);
}

database.prepare('INSERT INTO users (id, email) VALUES (?, ?)')
	.run('user-1', 'user@example.com');
database.prepare('INSERT INTO user_earnings (user_id) VALUES (?)').run('user-1');
database.prepare(`INSERT INTO shared_keys
  (id, seller_user_id, channel_type, api_key, key_fingerprint, status)
  VALUES (?, ?, ?, ?, ?, ?)`)
	.run('key-1', 'user-1', 'openai', 'encrypted', 'fingerprint', 'active');
database.prepare('INSERT INTO api_key_request_logs (id, user_id) VALUES (?, ?)')
	.run('request-1', 'user-1');

const insertEarning = database.prepare(`INSERT OR IGNORE INTO shared_key_earnings
  (id, request_log_id, shared_key_id, seller_user_id, gross_amount, net_amount)
  VALUES (?, ?, ?, ?, ?, ?)`);
insertEarning.run('earning-1', 'request-1', 'key-1', 'user-1', 1.234567, 1.234567);
insertEarning.run('earning-duplicate', 'request-1', 'key-1', 'user-1', 1.234567, 1.234567);

const earnings = database.prepare(`SELECT balance_micros, lifetime_earned_micros,
  contribution_value_micros FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual(
	[earnings.balance_micros, earnings.lifetime_earned_micros, earnings.contribution_value_micros],
	[1_234_567, 1_234_567, 1_234_567],
);

database.prepare(`INSERT INTO withdrawals
  (id, user_id, amount, fee, net_amount, wallet_address, token_amount,
   amount_micros, fee_micros, net_amount_micros, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	.run(
		'withdrawal-1', 'user-1', 1, 0.1, 0.9,
		'0x0000000000000000000000000000000000000001', 0.9,
		1_000_000, 100_000, 900_000,
		'2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z',
	);
const locked = database.prepare(`SELECT balance_micros, locked_amount_micros
  FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual([locked.balance_micros, locked.locked_amount_micros], [234_567, 1_000_000]);

assert.throws(
	() => database.exec(`INSERT INTO withdrawals
	  (id, user_id, amount, net_amount, wallet_address, amount_micros,
	   net_amount_micros, created_at, updated_at)
	  VALUES ('withdrawal-2', 'user-1', 0.1, 0.1,
	          '0x0000000000000000000000000000000000000001',
	          100000, 100000, datetime('now'), datetime('now'))`),
	/active_withdrawal_exists/,
);

database.prepare(`UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, updated_at = ?
  WHERE id = ? AND status = 'requested'`)
	.run('2026-08-24T00:01:00.000Z', '2026-08-24T00:01:00.000Z', 'withdrawal-1');
const settled = database.prepare(`SELECT balance_micros, locked_amount_micros,
  lifetime_withdrawn_micros FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual(
	[settled.balance_micros, settled.locked_amount_micros, settled.lifetime_withdrawn_micros],
	[234_567, 0, 1_000_000],
);

const ledger = database.prepare(`SELECT kind, amount_micros
  FROM portal_ledger_entries ORDER BY kind`).all();
assert.deepEqual(
	ledger.map((row) => [row.kind, row.amount_micros]),
	[
		['shared_key_earning', 1_234_567],
		['withdrawal_lock', -1_000_000],
		['withdrawal_settle', -1_000_000],
	],
);

console.log('D1 migration chain and portal ledger invariants: PASS');

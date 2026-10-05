import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import type { MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createMySqlPortalLedgerRepository } from './mysql/portal-marketplace.impl';
import { createPostgresPortalLedgerRepository } from './postgres/portal-marketplace.impl';
import { chainJobTransactionsTable, mysqlCoreSchema } from '../storage/drizzle/schema.mysql';

const now = '2026-10-01T06:00:00.000Z';

/** Execute captured production SQL offline with narrow dialect adaptation.
 * SQLite exercises predicates/rollback; it does not prove native MySQL/PG
 * row/gap locks, wire acknowledgements, isolation, or multi-session behavior. */
function fixture(driver: 'postgres' | 'mysql') {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(`CREATE TABLE withdrawals(id TEXT PRIMARY KEY,user_id TEXT,amount REAL,status TEXT,
		tx_hash TEXT,failure_reason TEXT,updated_at TEXT);
		CREATE TABLE user_earnings(user_id TEXT PRIMARY KEY,balance REAL,locked_amount REAL,updated_at TEXT);
		CREATE TABLE chain_job_transactions(job_kind TEXT,job_id TEXT,tx_hash TEXT);
		INSERT INTO withdrawals VALUES('w','u',1.125001,'requested',NULL,NULL,NULL);
		INSERT INTO user_earnings VALUES('u',3.874999,1.125001,NULL);`);
	if (driver === 'postgres') sqlite.exec(`CREATE TRIGGER refund AFTER UPDATE OF status ON withdrawals
		WHEN OLD.status='requested' AND NEW.status='failed' BEGIN
		UPDATE user_earnings SET balance=balance+OLD.amount,locked_amount=locked_amount-OLD.amount
		WHERE user_id=OLD.user_id AND locked_amount>=OLD.amount;
		SELECT RAISE(ABORT,'insufficient_locked_balance') WHERE changes()<>1; END;`);
	const queries: { sql: string; params: unknown[] }[] = [];
	const receipts: string[] = [];
	const hooks: { before?: (sql: string) => void; ack?: unknown; commitError?: boolean } = {};
	function execute(sql: string, params: unknown[] = []) {
		queries.push({ sql, params });
		hooks.before?.(sql);
		const adapted = sql.replaceAll('cinatoken_gateway.', '').replace(/\$[0-9]+/gu, '?')
			.replaceAll('::timestamptz', '').replace(/ FOR UPDATE\b/gu, '');
		const statement = sqlite.prepare(adapted);
		const returnsRows = /^SELECT\b/iu.test(adapted.trim()) || /\bRETURNING\b/iu.test(adapted);
		const rows = returnsRows ? statement.all(...params as SQLInputValue[]) : [];
		const changes = returnsRows ? rows.length : Number(statement.run(...params as SQLInputValue[]).changes);
		return { rows, changes };
	}
	const connection = {
		async beginTransaction() { sqlite.exec('BEGIN'); receipts.push('begin'); },
		async execute(sql: string, params: unknown[]) {
			const result = execute(sql, params);
			if (sql.startsWith('SELECT')) {
				// mysql2 returns DECIMAL as a string; preserve it in the production write.
				return [result.rows.map((row) => ({ ...row, ...(row.amount != null ? { amount: Number(row.amount).toFixed(6) } : {}) }))];
			}
			return [{ affectedRows: hooks.ack ?? result.changes }];
		},
		async commit() {
			if (hooks.commitError) { receipts.push('commit-error'); throw new Error('commit acknowledgement uncertain'); }
			sqlite.exec('COMMIT'); receipts.push('commit');
		},
		async rollback() { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); receipts.push('rollback'); },
		release() { receipts.push('release'); },
	};
	const postgres = { async unsafe(sql: string, params: unknown[]) { return execute(sql, params).rows; } };
	const mysql = { async getConnection() { return connection; } };
	const ledger = driver === 'mysql'
		? createMySqlPortalLedgerRepository({ driver, raw: mysql, drizzle: {} } as unknown as MySqlDatabaseClient)
		: createPostgresPortalLedgerRepository({ driver, raw: postgres, drizzle: {} } as unknown as PostgresDatabaseClient);
	const state = () => ({
		withdrawal: { ...sqlite.prepare('SELECT * FROM withdrawals').get() },
		earnings: { ...sqlite.prepare('SELECT * FROM user_earnings').get() },
	});
	return { sqlite, ledger, queries, receipts, hooks, state };
}

for (const driver of ['postgres', 'mysql'] as const) {
	test(`${driver} SQL contract: reject wins requested claim and repeated reject cannot refund twice`, async () => {
		const f = fixture(driver);
		try {
			assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), { kind: 'rejected', withdrawalId: 'w' });
			const before = f.state();
			assert.equal(before.withdrawal.failure_reason, 'reviewed');
			assert.equal(Math.round(Number(before.earnings.balance) * 1_000_000), 5_000_000);
			assert.equal(Math.round(Number(before.earnings.locked_amount) * 1_000_000), 0);
			assert.equal(f.sqlite.prepare("UPDATE withdrawals SET status='processing' WHERE id='w' AND status='requested'").run().changes, 0);
			assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'retry', now), { kind: 'conflict' });
			assert.deepEqual(f.state(), before);
			assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('absent', 'reviewed', now), { kind: 'not-found' });
			if (driver === 'mysql') {
				assert.deepEqual(f.receipts.slice(0, 3), ['begin', 'commit', 'release']);
				assert.match(f.queries[0].sql, /FOR UPDATE$/u);
				const balance = f.queries.find((row) => row.sql.startsWith('UPDATE user_earnings'));
				assert.deepEqual(balance?.params, ['1.125001', '1.125001', now, 'u', '1.125001', '1.125001']);
			} else {
				assert.match(f.queries[0].sql, /^UPDATE cinatoken_gateway\.withdrawals/u);
				assert.match(f.queries[0].sql, /FROM cinatoken_gateway\.chain_job_transactions/u);
			}
		} finally { f.sqlite.close(); }
	});
	for (const barrier of ['processing', 'submitted', 'confirmed', 'failed', 'hash', 'outbox']) {
		test(`${driver} SQL contract: ${barrier} blocks administrative refunds`, async () => {
			const f = fixture(driver);
			try {
				if (barrier === 'hash') f.sqlite.exec("UPDATE withdrawals SET tx_hash='0xsynthetic'");
				else if (barrier === 'outbox') f.sqlite.exec("INSERT INTO chain_job_transactions VALUES('withdrawal','w','0xsynthetic')");
				else f.sqlite.prepare('UPDATE withdrawals SET status=?').run(barrier);
				const before = f.state();
				assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), { kind: 'conflict' });
				assert.deepEqual(f.state(), before);
				assert.equal(f.queries.some((row) => row.sql.startsWith('UPDATE user_earnings')), false);
				if (driver === 'mysql') assert.deepEqual(f.receipts, ['begin', 'rollback', 'release']);
			} finally { f.sqlite.close(); }
		});
	}
	test(`${driver} SQL contract: claim just before rejection admission defeats the refund`, async () => {
		const f = fixture(driver);
		try {
			f.hooks.before = () => {
				f.hooks.before = undefined;
				f.sqlite.exec("UPDATE withdrawals SET status='processing' WHERE id='w' AND status='requested'");
			};
			assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), { kind: 'conflict' });
			assert.equal(f.queries.some((row) => row.sql.startsWith('UPDATE user_earnings')), false);
		} finally { f.sqlite.close(); }
	});
	test(`${driver} SQL contract: insufficient lock rolls back status and balances`, async () => {
		const f = fixture(driver);
		try {
			f.sqlite.exec('UPDATE user_earnings SET locked_amount=0.5');
			const before = f.state();
			await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), /insufficient_locked_balance/);
			assert.deepEqual(f.state(), before);
			if (driver === 'mysql') assert.deepEqual(f.receipts, ['begin', 'rollback', 'release']);
		} finally { f.sqlite.close(); }
	});
}

test('MySQL uncertain commit never returns a rejected acknowledgement and releases the connection', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.commitError = true;
		const before = f.state();
		await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), /commit acknowledgement uncertain/);
		assert.deepEqual(f.state(), before);
		assert.deepEqual(f.receipts, ['begin', 'commit-error', 'rollback', 'release']);
	} finally { f.sqlite.close(); }
});

for (const affectedRows of [2, '1', -1]) {
	test(`MySQL ambiguous CAS acknowledgement ${affectedRows} rolls back without refund`, async () => {
		const f = fixture('mysql');
		try {
			f.hooks.ack = affectedRows;
			const before = f.state();
			await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), /withdrawal_rejection_result_uncertain/);
			assert.deepEqual(f.state(), before);
			assert.equal(f.queries.some((row) => row.sql.startsWith('UPDATE user_earnings')), false);
		} finally { f.sqlite.close(); }
	});
}

test('Postgres inconsistent RETURNING identity never acknowledges rejection', async () => {
	const ledger = createPostgresPortalLedgerRepository({ driver: 'postgres', drizzle: {},
		raw: { unsafe: async () => [{ id: 'different-withdrawal' }] } } as unknown as PostgresDatabaseClient);
	await assert.rejects(ledger.rejectRequestedWithdrawal('w', 'reviewed', now), /withdrawal_rejection_result_uncertain/);
});

test('formal MySQL 0075 and Drizzle declare the required signed outbox barrier; this is a schema contract, not native DDL proof', () => {
	const directory = new URL('../../migrations-mysql/', import.meta.url);
	const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
	assert.equal(names.length, 75);
	assert.equal(names.at(-1), '0075_chain_job_transactions.sql');
	assert.equal(names.slice(0, -1).some((name) => /CREATE TABLE(?: IF NOT EXISTS)? chain_job_transactions/u.test(
		readFileSync(new URL(name, directory), 'utf8'))), false, 'the previous MySQL schema really lacked this barrier');
	const ddl = readFileSync(new URL(names.at(-1)!, directory), 'utf8');
	assert.match(ddl, /CREATE TABLE chain_job_transactions/u);
	assert.match(ddl, /PRIMARY KEY \(job_kind, job_id\)/u);
	assert.match(ddl, /UNIQUE KEY uk_chain_job_transactions_hash \(tx_hash\)/u);
	assert.match(ddl, /raw_transaction LONGTEXT NOT NULL/u);
	assert.match(ddl, /COLLATE=utf8mb4_bin/u);
	assert.equal(mysqlCoreSchema.chainJobTransactionsTable, chainJobTransactionsTable);
	const schema = getTableConfig(chainJobTransactionsTable);
	assert.equal(schema.name, 'chain_job_transactions');
	assert.deepEqual(schema.columns.map((column) => column.name), [
		'job_kind', 'job_id', 'tx_hash', 'raw_transaction', 'chain_id', 'created_at', 'broadcast_at',
	]);
	assert.equal(schema.columns[3].getSQLType(), 'longtext');
	assert.deepEqual(schema.primaryKeys[0].columns.map((column) => column.name), ['job_kind', 'job_id']);
	assert.deepEqual(schema.indexes.map((index) => index.config.name), [
		'uk_chain_job_transactions_hash', 'idx_chain_job_transactions_created',
	]);
});

for (const amount of [-1, -0.000001, 0]) {
	test(`MySQL nonpositive stored amount ${amount} conflicts without financial writes`, async () => {
		const f = fixture("mysql");
		try {
			f.sqlite.prepare("UPDATE withdrawals SET amount = ?").run(amount);
			const before = f.state();
			assert.deepEqual(await f.ledger.rejectRequestedWithdrawal("w", "reviewed", now), { kind: "conflict" });
			assert.deepEqual(f.state(), before);
			assert.equal(f.queries.some(row => row.sql.startsWith("UPDATE user_earnings")), false);
			assert.match(f.queries.find(row => row.sql.startsWith("UPDATE withdrawals"))!.sql, /AND amount > 0/u);
			assert.deepEqual(f.receipts, ["begin", "rollback", "release"]);
		} finally { f.sqlite.close(); }
	});
}

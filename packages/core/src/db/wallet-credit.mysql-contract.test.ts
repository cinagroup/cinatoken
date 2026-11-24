import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySqlDatabaseClient } from '../storage/database-client';
import { mysqlCoreSchema } from '../storage/drizzle/schema.mysql';
import { grantWalletCreditWithAuditTxMy, readWalletCreditReceiptMy } from './mysql/critical-writes.impl';
import {
	WalletCreditConflictError,
	WalletCreditLegacyUnverifiedError,
	WalletCreditConcurrentMutationError,
} from './wallet-credit';

/** Real Drizzle/mysql2 query surface and SQLite rollback; NOT native MySQL
 * collation, locking, isolation or wire proof. NOCASE models ASCII collisions only. */
function fixture() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,budget_max TEXT,budget_base TEXT,budget_spent TEXT,
  budget_period TEXT,budget_reset_at TEXT,budget_epoch INTEGER,budget_reserved_micros INTEGER,
  wallet_granted TEXT,wallet_spent TEXT,status TEXT,metadata TEXT,rate_limit TEXT,charged_cost_factors TEXT,
  external_system TEXT,external_user_id TEXT,external_system_norm TEXT,created_at TEXT,updated_at TEXT);
  CREATE TABLE user_audit_logs(id TEXT PRIMARY KEY,user_id TEXT,api_key_id TEXT,event_type TEXT,actor_type TEXT,
  request_log_id TEXT,change_payload TEXT,before_user_snapshot TEXT,after_user_snapshot TEXT,changed_fields TEXT,
  correlation_id TEXT,source TEXT,actor_id TEXT,reason_code TEXT,reason_text TEXT,dedup_key TEXT COLLATE NOCASE,
  created_at TEXT,UNIQUE(user_id,dedup_key));
  INSERT INTO users VALUES('u','u@example.invalid','10.000000','10.000000','0.000000','monthly',NULL,5,123,
  '0.300000','0.100000','active',NULL,'{ "rpm" : 7 }',NULL,NULL,NULL,'','2026-10-18 00:00:00.000000','2026-10-18 00:00:00.000000');`);
	sqlite.exec(`UPDATE users SET metadata='{"nested":{"a":true}}',charged_cost_factors='{"default":0.8}' WHERE id='u'`);
	sqlite.function('FROM_UNIXTIME', (seconds) =>
		new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace('Z', '000'),
	);
	sqlite.function('wallet_epoch_micros', (value) =>
		value == null ? null : (BigInt(Date.parse(String(value).replace(' ', 'T') + 'Z')) * 1000n).toString(),
	);
	const queries: { sql: string; params: unknown[]; transaction: boolean }[] = [];
	const events: string[] = [];
	const hooks: { commitAckLost?: boolean; malformedUpdateAck?: boolean } = {};
	async function query(queryInput: string | { sql: string; rowsAsArray?: boolean }, params: unknown[] = []) {
		const sql = typeof queryInput === 'string' ? queryInput : queryInput.sql;
		const arrays = typeof queryInput !== 'string' && queryInput.rowsAsArray;
		queries.push({ sql, params, transaction: sqlite.isTransaction });
		if (/^begin$/iu.test(sql)) {
			sqlite.exec('BEGIN');
			events.push('begin');
			return [{ affectedRows: 0 }, []];
		}
		if (/^commit$/iu.test(sql)) {
			sqlite.exec('COMMIT');
			events.push('commit');
			if (hooks.commitAckLost) throw new Error('commit acknowledgement lost');
			return [{ affectedRows: 0 }, []];
		}
		if (/^rollback$/iu.test(sql)) {
			if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
			events.push('rollback');
			return [{ affectedRows: 0 }, []];
		}
		const statement = sqlite.prepare(
			sql
				.replace(/ for update\b/giu, '')
				.replace(/CAST\(UNIX_TIMESTAMP\(([^)]+)\) \* 1000000 AS CHAR\)/giu, 'wallet_epoch_micros($1)'),
		);
		if (/^select\b/iu.test(sql)) {
			if (arrays) statement.setReturnArrays(true);
			return [statement.all(...(params as SQLInputValue[])), []];
		}
		const changed = Number(statement.run(...(params as SQLInputValue[])).changes);
		return [{ affectedRows: /^update\b/iu.test(sql) && hooks.malformedUpdateAck ? '1' : changed, insertId: 0 }, []];
	}
	const connection = { query, release: () => events.push('release') };
	const pool = {
		getConnection: async () => connection,
		query: (...args: Parameters<typeof query>) => {
			assert.equal(sqlite.isTransaction, false, 'never escape pinned transaction to pool');
			return query(...args);
		},
	};
	const client = {
		driver: 'mysql',
		raw: pool,
		drizzle: drizzle(pool as never, { schema: mysqlCoreSchema, mode: 'default' }),
	} as unknown as MySqlDatabaseClient;
	const params = { userId: 'u', amount: 0.1, kind: 'topup' as const, externalRef: 'Order-1' };
	const grant = (patch = {}) => grantWalletCreditWithAuditTxMy(client, { ...params, ...patch });
	const state = () => ({
		user: sqlite.prepare('SELECT * FROM users').get(),
		audit: sqlite.prepare('SELECT * FROM user_audit_logs').all(),
	});
	return { sqlite, queries, events, hooks, client, params, grant, state };
}

test('MySQL credit locks user then reference and writes exact snapshot in pinned transaction; duplicate returns immutable original', async () => {
	const f = fixture();
	try {
		const first = await f.grant();
		assert.equal(first.status, 'applied');
		assert.equal(first.walletBalance, 0.3);
		assert.deepEqual(f.events, ['begin', 'commit', 'release']);
		const statements = f.queries.filter((q) => /^(select|insert|update)/iu.test(q.sql));
		assert.ok(statements.every((q) => q.transaction));
		assert.match(statements[0].sql, /from `users`.*for update$/iu);
		assert.match(statements[1].sql, /from `user_audit_logs`.*for update$/iu);
		assert.match(statements[2].sql, /^insert into `user_audit_logs`/iu);
		assert.doesNotMatch(statements[2].sql, /ignore|on duplicate/iu);
		assert.match(statements[2].sql, /FROM_UNIXTIME\(\?\)/u);
		const millis = Date.parse(first.receipt.creditedAt);
		assert.ok(statements[2].params.includes(`${Math.floor(millis / 1000)}.${String(millis % 1000).padStart(3, '0')}`));
		assert.match(statements[1].sql, /UNIX_TIMESTAMP/u);
		const audit = f.state().audit[0];
		assert.equal(JSON.parse(String(audit.before_user_snapshot)).wallet_granted, 0.3);
		assert.equal(JSON.parse(String(audit.after_user_snapshot)).wallet_granted, 0.4);
		assert.equal(JSON.parse(String(audit.before_user_snapshot)).metadata, '{"nested":{"a":true}}');
		assert.equal(JSON.parse(String(audit.after_user_snapshot)).charged_cost_factors, '{"default":0.8}');
		assert.equal(JSON.parse(String(audit.after_user_snapshot)).budget_reserved_micros, 123);
		f.sqlite.exec("UPDATE users SET wallet_spent='0.400000',wallet_granted='2.000000'");
		assert.deepEqual(await f.grant(), {
			status: 'duplicate',
			walletGranted: 2,
			walletSpent: 0.4,
			walletBalance: 1.6,
			receipt: first.receipt,
		});
		await f.grant({ externalRef: 'later-credit', amount: 0.2 });
		assert.deepEqual(await f.grant(), {
			status: 'duplicate',
			walletGranted: 2.2,
			walletSpent: 0.4,
			walletBalance: 1.8,
			receipt: first.receipt,
		});
		assert.deepEqual(await readWalletCreditReceiptMy(f.client, f.params), {
			version: 1,
			status: 'recorded',
			receipt: first.receipt,
		});
		assert.equal(f.state().audit.length, 2);
	} finally {
		f.sqlite.close();
	}
});

test('MySQL same-ref payload and collation-equivalent different literal are conflicts with no write', async () => {
	const f = fixture();
	try {
		await f.grant();
		const before = f.state();
		for (const patch of [{ amount: 0.2 }, { kind: 'refund' }, { externalRef: 'order-1' }])
			await assert.rejects(() => f.grant(patch), WalletCreditConflictError);
		await assert.rejects(
			() => readWalletCreditReceiptMy(f.client, { ...f.params, externalRef: 'order-1' }),
			WalletCreditConflictError,
		);
		assert.deepEqual(f.state(), before);
	} finally {
		f.sqlite.close();
	}
});

test('MySQL two distinct credits see the previous committed balance in their audit; legacy reference never recredits', async () => {
	const f = fixture();
	try {
		await f.grant();
		const second = await f.grant({ externalRef: 'second', amount: -0.2 });
		assert.deepEqual(second.receipt.before, { walletGranted: 0.4, walletSpent: 0.1, walletBalance: 0.3 });
		assert.deepEqual(second.receipt.after, { walletGranted: 0.2, walletSpent: 0.1, walletBalance: 0.1 });
		f.sqlite
			.prepare(
				"INSERT INTO user_audit_logs(id,user_id,event_type,dedup_key,change_payload) VALUES('legacy','u','wallet_credit','old','{}')",
			)
			.run();
		const before = f.state();
		assert.deepEqual(await readWalletCreditReceiptMy(f.client, { ...f.params, externalRef: 'old' }), {
			version: 1,
			status: 'legacy_unverified',
		});
		await assert.rejects(() => f.grant({ externalRef: 'old' }), WalletCreditLegacyUnverifiedError);
		assert.deepEqual(f.state(), before);
	} finally {
		f.sqlite.close();
	}
});

for (const [name, trigger] of [
	['failed insert', `CREATE TRIGGER fail BEFORE INSERT ON user_audit_logs BEGIN SELECT RAISE(ABORT,'audit fail'); END`],
	['ignored update', `CREATE TRIGGER fail BEFORE UPDATE OF wallet_granted ON users BEGIN SELECT RAISE(IGNORE); END`],
	[
		'changed audit',
		`CREATE TRIGGER fail AFTER INSERT ON user_audit_logs BEGIN UPDATE user_audit_logs SET change_payload='{}' WHERE id=NEW.id; END`,
	],
	[
		'changed wallet',
		`CREATE TRIGGER fail AFTER UPDATE OF wallet_granted ON users BEGIN UPDATE users SET wallet_spent='5.000000' WHERE id=NEW.id; END`,
	],
] as const) {
	test(`MySQL transaction rolls back wallet and audit on ${name}`, async () => {
		const f = fixture();
		try {
			f.sqlite.exec(trigger);
			const before = f.state();
			await assert.rejects(() => f.grant());
			assert.deepEqual(f.state(), before);
			assert.deepEqual(f.events, ['begin', 'rollback', 'release']);
		} finally {
			f.sqlite.close();
		}
	});
}

test('MySQL malformed update acknowledgement cannot commit, but committed/lost ACK recovers via exact read', async () => {
	const f = fixture();
	try {
		const before = f.state();
		f.hooks.malformedUpdateAck = true;
		await assert.rejects(() => f.grant(), WalletCreditConcurrentMutationError);
		assert.deepEqual(f.state(), before);
		f.hooks.malformedUpdateAck = false;
		f.hooks.commitAckLost = true;
		await assert.rejects(
			() => f.grant(),
			(error: unknown) =>
				error instanceof Error &&
				/Failed query: commit/u.test(error.message) &&
				error.cause instanceof Error &&
				/commit acknowledgement lost/u.test(error.cause.message),
		);
		f.hooks.commitAckLost = false;
		const recovered = await readWalletCreditReceiptMy(f.client, f.params);
		assert.equal(recovered.status, 'recorded');
		assert.equal((await f.grant()).status, 'duplicate');
		assert.equal(f.state().audit.length, 1);
	} finally {
		f.sqlite.close();
	}
});

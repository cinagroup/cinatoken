import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import type { D1DatabaseClient } from '../storage/database-client';
import { createSqliteD1 } from '../../../proxy/src/test-support/sqlite-d1';
import { createD1PortalLedgerRepository } from './d1/portal-marketplace.impl';

const now = '2026-10-01T06:00:00.000Z';
const head = '0077_withdrawal_balance_update_guards.sql';
const migration = (name: string) => readFileSync(new URL(`../../migrations-d1/${name}`, import.meta.url), 'utf8');

function legacyDatabase(locked: number | null) {
	const sqlite = new DatabaseSync(':memory:');
	for (const name of readdirSync(new URL('../../migrations-d1/', import.meta.url))
		.filter((name) => name.endsWith('.sql') && name <= '0031_ledger_integrity_guards.sql').sort()) {
		sqlite.exec(migration(name));
	}
	seed(sqlite, locked);
	return sqlite;
}

function seed(sqlite: DatabaseSync, locked: number | null) {
	sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.invalid')");
	if (locked !== null) sqlite.prepare(`INSERT INTO user_earnings
		(user_id,balance_micros,locked_amount_micros,balance,locked_amount)
		VALUES('u',2000000,?,2,?)`).run(locked, locked / 1_000_000);
	sqlite.exec(`INSERT INTO withdrawals(id,user_id,amount,net_amount,amount_micros,status,wallet_address)
		VALUES('w','u',1,1,1000000,'submitted','wallet')`);
}

function financialState(sqlite: DatabaseSync) {
	return {
		withdrawal: { ...sqlite.prepare('SELECT status,failure_reason,updated_at FROM withdrawals').get() },
		earnings: sqlite.prepare(`SELECT balance_micros,locked_amount_micros,lifetime_withdrawn_micros,
			balance,locked_amount,lifetime_withdrawn,updated_at FROM user_earnings`).all().map((row) => ({ ...row })),
		journal: sqlite.prepare('SELECT kind,amount_micros,balance_after_micros,locked_after_micros FROM portal_ledger_entries').all().map((row) => ({ ...row })),
	};
}

for (const terminal of ['failed', 'confirmed']) {
	test(`preserved 0031 reproduction: ${terminal} admits an unfunded terminal journal and rejects an excess lock`, () => {
		const insufficient = legacyDatabase(500_000);
		const excess = legacyDatabase(3_000_000);
		try {
			insufficient.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(terminal, 'w');
			const state = financialState(insufficient);
			assert.equal(state.withdrawal.status, terminal);
			assert.equal(state.earnings[0].locked_amount_micros, 500_000);
			assert.equal(state.earnings[0].balance_micros, 2_000_000);
			assert.equal(state.earnings[0].lifetime_withdrawn_micros, 0);
			assert.equal(state.journal.length, 1);
			const before = financialState(excess);
			assert.throws(() => excess.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(terminal, 'w'), /insufficient_locked_balance/);
			assert.deepEqual(financialState(excess), before);
		} finally { insufficient.close(); excess.close(); }
	});
	for (const locked of [null, 500_000, 1_000_000, 1_500_000, 3_000_000]) {
		test(`append-only 0077 ${terminal}: locked=${locked} preserves atomic status, micros, decimal projection and journal`, () => {
			const sqlite = legacyDatabase(locked);
			try {
				sqlite.exec(migration(head));
				const before = financialState(sqlite);
				const update = () => sqlite.prepare(`UPDATE withdrawals
					SET status=?,failure_reason='reviewed',updated_at=? WHERE id='w'`).run(terminal, now);
				if (locked === null || locked < 1_000_000) {
					assert.throws(update, /insufficient_locked_balance/);
					assert.deepEqual(financialState(sqlite), before);
					return;
				}
				update();
				const state = financialState(sqlite);
				assert.equal(state.withdrawal.status, terminal);
				assert.equal(state.withdrawal.failure_reason, 'reviewed');
				assert.equal(state.earnings[0].locked_amount_micros, locked - 1_000_000);
				assert.equal(state.earnings[0].locked_amount, (locked - 1_000_000) / 1_000_000);
				assert.equal(state.earnings[0].balance_micros, terminal === 'failed' ? 3_000_000 : 2_000_000);
				assert.equal(state.earnings[0].balance, terminal === 'failed' ? 3 : 2);
				assert.equal(state.earnings[0].lifetime_withdrawn_micros, terminal === 'confirmed' ? 1_000_000 : 0);
				assert.equal(state.earnings[0].lifetime_withdrawn, terminal === 'confirmed' ? 1 : 0);
				assert.deepEqual(state.journal, [{
					kind: terminal === 'failed' ? 'withdrawal_refund' : 'withdrawal_settle',
					amount_micros: terminal === 'failed' ? 1_000_000 : -1_000_000,
					balance_after_micros: terminal === 'failed' ? 3_000_000 : 2_000_000,
					locked_after_micros: locked - 1_000_000,
				}]);
				update();
				assert.deepEqual(financialState(sqlite), state, 'terminal retries must not move money twice');
			} finally { sqlite.close(); }
		});
	}
	test(`0077 ${terminal} rolls back all financial writes when the unique journal cannot be appended`, () => {
		const sqlite = legacyDatabase(3_000_000);
		try {
			sqlite.exec(migration(head));
			sqlite.prepare(`INSERT INTO portal_ledger_entries VALUES(?,?,?,?,?,?,?,?,?)`)
				.run('collision', 'u', terminal === 'failed' ? 'withdrawal_refund' : 'withdrawal_settle', 0, 2_000_000, 3_000_000, 'withdrawal', 'w', now);
			const before = financialState(sqlite);
			assert.throws(() => sqlite.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(terminal, 'w'), /UNIQUE constraint/);
			assert.deepEqual(financialState(sqlite), before);
		} finally { sqlite.close(); }
	});
	test(`0077 ${terminal} changes() excludes nested earnings-trigger writes`, () => {
		const sqlite = legacyDatabase(3_000_000);
		try {
			sqlite.exec(migration(head));
			sqlite.exec(`CREATE TABLE nested_audit(id INTEGER); CREATE TRIGGER nested_earnings
				AFTER UPDATE ON user_earnings BEGIN INSERT INTO nested_audit VALUES(1),(2),(3); END;`);
			sqlite.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(terminal, 'w');
			assert.equal(sqlite.prepare('SELECT count(*) AS n FROM nested_audit').get()?.n, 3);
			assert.equal(financialState(sqlite).journal.length, 1);
		} finally { sqlite.close(); }
	});
}

function fixture(t: TestContext) {
	const f = createSqliteD1();
	t.after(() => f.sqlite.close());
	f.sqlite.exec(`INSERT INTO users(id,email) VALUES('u','u@example.invalid');
		INSERT INTO user_earnings(user_id,balance,balance_micros) VALUES('u',5,5000000)`);
	const metadata: { changes: number; ids: unknown[] }[] = [];
	const raw = { ...f.binding, prepare(sql: string) {
		const prepared = f.binding.prepare(sql);
		return { ...prepared, bind(...values: unknown[]) {
			const bound = prepared.bind(...values);
			return { ...bound,
				async all<T>() {
					const before = Number(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n);
					const result = await bound.all<T>();
					const changes = Number(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n) - before;
					if (sql.includes('RETURNING id')) metadata.push({ changes, ids: result.results.map((row) =>
						row && typeof row === 'object' ? { ...row } : row) });
					return { ...result, meta: { ...result.meta, changes } };
				},
				first: bound.first.bind(bound), run: bound.run.bind(bound),
			};
		}, first: prepared.first.bind(prepared), all: prepared.all.bind(prepared), run: prepared.run.bind(prepared) };
	} };
	const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
	return { ...f, ledger, metadata };
}

async function withdrawal(f: ReturnType<typeof fixture>) {
	assert.equal(await f.ledger.createWithdrawalWithBalanceLock({ id: 'w', userId: 'u', amount: 1,
		fee: 0.1, netAmount: 0.9, currency: 'USD', walletAddress: 'wallet', tokenAmount: 2, nowIso: now }), 'created');
}

for (const locked of [null, 500_000, 1_000_000, 3_000_000]) {
	test(`D1 runtime gate refuses real legacy 0031 with locked=${locked} before any financial write`, async (t) => {
		const f = createSqliteD1({}, { applyMigrations: false });
		t.after(() => f.sqlite.close());
		for (const name of f.migrationFiles.filter(name => name <= '0031_ledger_integrity_guards.sql')) f.sqlite.exec(migration(name));
		seed(f.sqlite, locked);
		f.sqlite.exec("UPDATE withdrawals SET status='requested' WHERE id='w'");
		const before = financialState(f.sqlite);
		const changes = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n;
		const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw: f.binding, drizzle: {} } as unknown as D1DatabaseClient);
		await assert.rejects(ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_schema_unavailable/);
		assert.deepEqual(financialState(f.sqlite), before);
		assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n, changes, 'schema refusal cannot write state, balances or journal');
	});
}

for (const ending of ['LF', 'CRLF']) {
	test(`D1 runtime gate accepts the complete formal 0077 ${ending} trigger artifact`, async (t) => {
		const f = fixture(t); await withdrawal(f);
		f.sqlite.exec(migration(head).replace(/\r?\n/g, ending === 'LF' ? '\n' : '\r\n'));
		assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'review', now), { kind: 'rejected', withdrawalId: 'w' });
		assert.equal(financialState(f.sqlite).journal.filter(row => row.kind === 'withdrawal_refund').length, 1);
	});
}

for (const replacement of ['absent', 'legacy', 'no-balance-guard', 'changed-journal-literal']) {
	test(`D1 runtime gate refuses ${replacement} actual same-name refund trigger without writing`, async (t) => {
		const f = fixture(t); await withdrawal(f);
		if (replacement === 'absent') f.sqlite.exec('DROP TRIGGER withdrawals_refund_after_status_update');
		else if (replacement === 'legacy') {
			f.sqlite.exec('DROP TRIGGER withdrawals_confirm_after_status_update; DROP TRIGGER withdrawals_refund_after_status_update;');
			f.sqlite.exec(migration('0031_ledger_integrity_guards.sql'));
		} else {
			const altered = replacement === 'no-balance-guard'
				? migration(head).replace("  SELECT RAISE(ABORT, 'insufficient_locked_balance') WHERE changes() <> 1;", '')
					.replace("  SELECT RAISE(ABORT, 'insufficient_locked_balance') WHERE changes() <> 1;", '')
				: migration(head).replace("'withdrawal_refund'", "'withdrawal_ refund'");
			f.sqlite.exec(altered);
		}
		const before = financialState(f.sqlite);
		const changes = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n;
		await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_schema_unavailable/);
		assert.deepEqual(financialState(f.sqlite), before);
		assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n, changes);
	});
}

for (const replacement of ['absent', 'legacy', 'other-reviewed-ending']) {
	test(`D1 same-write schema guard blocks ${replacement} replacement in the pre-CAS window`, async (t) => {
		const f = fixture(t); await withdrawal(f);
		const before = financialState(f.sqlite);
		const changes = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n;
		f.hooks.beforeStatement = sql => {
			if (!sql.includes('RETURNING id')) return;
			f.hooks.beforeStatement = undefined;
			if (replacement === 'absent') f.sqlite.exec('DROP TRIGGER withdrawals_refund_after_status_update');
			else if (replacement === 'legacy') {
				f.sqlite.exec('DROP TRIGGER withdrawals_confirm_after_status_update; DROP TRIGGER withdrawals_refund_after_status_update;');
				f.sqlite.exec(migration('0031_ledger_integrity_guards.sql'));
			} else {
				const installed = String(f.sqlite.prepare("SELECT sql FROM main.sqlite_master WHERE name='withdrawals_refund_after_status_update'").get()?.sql);
				f.sqlite.exec(migration(head).replace(/\r?\n/g, installed.includes('\r\n') ? '\n' : '\r\n'));
			}
		};
		await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_schema_unavailable/);
		assert.deepEqual(f.metadata[0], { changes: 0, ids: [] });
		assert.deepEqual(financialState(f.sqlite), before);
		assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n, changes);
	});
}

test('D1 runtime gate never caches a prior approved schema check', async (t) => {
	const f = fixture(t); await withdrawal(f);
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('absent', 'review', now), { kind: 'not-found' });
	f.sqlite.exec('DROP TRIGGER withdrawals_refund_after_status_update');
	const before = financialState(f.sqlite);
	await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_schema_unavailable/);
	assert.deepEqual(financialState(f.sqlite), before);
});

for (const result of [{ success: false, results: [] }, { success: true }, { success: true, results: null },
	{ success: true, results: [] }, { success: true, results: [null] }, { success: true, results: [{ definition: 'unsafe' }] },
	{ success: true, results: [{ object_type: 'trigger', object_name: 'withdrawals_refund_after_status_update', table_name: 'withdrawals', sql_bytes: 9000, definition: null }] }]) {
	test(`D1 untrusted schema acknowledgement ${JSON.stringify(result)} cannot reach the rejection write`, async () => {
		let writes = 0;
		const raw = { prepare: (sql: string) => ({ bind: () => ({ all: async () => {
			if (sql.includes('RETURNING id')) writes++;
			return result;
		} }) }) };
		const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
		await assert.rejects(ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_schema_unavailable/);
		assert.equal(writes, 0);
	});
}

test('D1 schema adapter diagnostics are replaced with a safe unavailable error before writing', async () => {
	const raw = { prepare: () => { throw new Error('private adapter SQL diagnostic'); } };
	const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
	await assert.rejects(ledger.rejectRequestedWithdrawal('w', 'review', now), error =>
		error instanceof Error && error.message === 'withdrawal_rejection_schema_unavailable');
});

test('D1 admin rejection wins the claim race, refunds once, and blocks a later chain claim', async (t) => {
	const f = fixture(t); await withdrawal(f);
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'manual review', now), { kind: 'rejected', withdrawalId: 'w' });
	assert.deepEqual(f.metadata[0], { changes: 3, ids: [{ id: 'w' }] }, 'D1 total_changes includes state, balance and journal');
	assert.notEqual(f.metadata[0].changes, 1, 'the previous run.meta.changes===1 winner inference fails on real trigger writes');
	assert.equal(await f.ledger.updateWithdrawalStatus('w', { status: 'processing', expectedStatus: 'requested', nowIso: now }), false);
	const state = financialState(f.sqlite);
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'again', now), { kind: 'conflict' });
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('absent', 'review', now), { kind: 'not-found' });
	assert.deepEqual(financialState(f.sqlite), state);
	assert.equal(state.earnings[0].balance_micros, 5_000_000);
	assert.equal(state.earnings[0].locked_amount_micros, 0);
	assert.equal(state.journal.filter((row) => row.kind === 'withdrawal_refund').length, 1);
});

test('D1 claim in the exact pre-write race window causes conflict with no refund', async (t) => {
	const f = fixture(t); await withdrawal(f);
	f.hooks.beforeStatement = (sql) => {
		if (sql.includes('AND NOT EXISTS (SELECT 1 FROM chain_job_transactions')) {
			f.hooks.beforeStatement = undefined;
			f.sqlite.exec("UPDATE withdrawals SET status='processing' WHERE id='w' AND status='requested'");
		}
	};
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'review', now), { kind: 'conflict' });
	const state = financialState(f.sqlite);
	assert.equal(state.withdrawal.status, 'processing');
	assert.equal(state.earnings[0].balance_micros, 4_000_000);
	assert.equal(state.earnings[0].locked_amount_micros, 1_000_000);
	assert.equal(state.journal.length, 1);
});

for (const barrier of ['processing', 'submitted', 'confirmed', 'failed', 'hash', 'outbox']) {
	test(`D1 admin rejects ${barrier} as a conflict, retaining all financial state`, async (t) => {
		const f = fixture(t); await withdrawal(f);
		if (barrier === 'hash') f.sqlite.exec("UPDATE withdrawals SET tx_hash='0xsynthetic' WHERE id='w'");
		else if (barrier === 'outbox') f.sqlite.exec(`INSERT INTO chain_job_transactions
			VALUES('withdrawal','w','0xsynthetic','synthetic-signed',1,'${now}',NULL)`);
		else f.sqlite.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(barrier, 'w');
		const before = financialState(f.sqlite);
		assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'review', now), { kind: 'conflict' });
		assert.deepEqual(financialState(f.sqlite), before);
	});
}

test('D1 failed refund remains requested and retry is possible only after funds are reconciled', async (t) => {
	const f = fixture(t); await withdrawal(f);
	f.sqlite.exec('UPDATE user_earnings SET locked_amount_micros=500000,locked_amount=0.5');
	const before = financialState(f.sqlite);
	await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'review', now), /insufficient_locked_balance/);
	assert.deepEqual(financialState(f.sqlite), before);
});

test('D1 lost acknowledgement never reports success or repeats a committed refund', async (t) => {
	const f = fixture(t); await withdrawal(f);
	f.hooks.afterStatement = (sql) => {
		if (sql.includes('AND NOT EXISTS (SELECT 1 FROM chain_job_transactions')) throw new Error('acknowledgement lost');
	};
	await assert.rejects(f.ledger.rejectRequestedWithdrawal('w', 'review', now), /acknowledgement lost/);
	f.hooks.afterStatement = undefined;
	const state = financialState(f.sqlite);
	assert.equal(state.withdrawal.status, 'failed');
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'retry', now), { kind: 'conflict' });
	assert.deepEqual(financialState(f.sqlite), state);
});

for (const result of [{ success: false, results: [{ id: 'w' }], meta: { changes: 3 } }, { success: true },
	{ success: true, results: null }, { success: true, results: [{ id: 'wrong' }] },
	{ success: true, results: [{ id: 'w' }, { id: 'w' }] }, { success: true, results: [null] }]) {
	test(`D1 ambiguous write result ${JSON.stringify(result)} is never a rejection acknowledgement`, async (t) => {
		const f = fixture(t);
		const raw = { prepare: (sql: string) => !sql.includes('RETURNING id')
			? f.binding.prepare(sql) : { bind: () => ({ all: async () => result }) } };
		const ledger = createD1PortalLedgerRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
		await assert.rejects(ledger.rejectRequestedWithdrawal('w', 'review', now), /withdrawal_rejection_result_uncertain/);
	});
}

test('D1 rejection acknowledges its RETURNING winner with nested trigger writes and seven total changes', async (t) => {
	const f = fixture(t); await withdrawal(f);
	f.sqlite.exec(`CREATE TABLE rejection_audit(id INTEGER);
		CREATE TRIGGER rejection_audit AFTER UPDATE ON user_earnings BEGIN INSERT INTO rejection_audit VALUES(1),(2),(3),(4); END;`);
	assert.deepEqual(await f.ledger.rejectRequestedWithdrawal('w', 'reviewed', now), { kind: 'rejected', withdrawalId: 'w' });
	assert.equal(f.metadata[0].changes, 7);
	assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM rejection_audit').get()?.n, 4);
	assert.equal(financialState(f.sqlite).journal.filter((row) => row.kind === 'withdrawal_refund').length, 1);
});

test('D1 global chain refund still accepts submitted and records a reverted transaction once', async (t) => {
	const f = fixture(t); await withdrawal(f);
	await f.ledger.updateWithdrawalStatus('w', { status: 'submitted', txHash: '0xsynthetic', expectedStatus: 'requested', nowIso: now });
	await f.ledger.refundWithdrawal('w', 'u', 99, 'chain revert', now);
	const state = financialState(f.sqlite);
	assert.equal(state.withdrawal.status, 'failed');
	assert.equal(state.earnings[0].balance_micros, 5_000_000);
	await f.ledger.refundWithdrawal('w', 'u', 99, 'retry', now);
	assert.deepEqual(financialState(f.sqlite), state);
});

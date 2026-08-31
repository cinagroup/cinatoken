import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { ReserveUserBudgetParams } from '../db/user-budget-reservation-types';
import { USER_BUDGET_MAX_SAFE_MICROS } from '../db/user-budget-reservation-types';
import type { D1DatabaseClient } from './database-client';
import { createD1Repositories } from './repositories-d1';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
	}

	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}

	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function createD1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[])
					.map((statement) => statement.run());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'] };
}

function setupDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			budget_max REAL,
			budget_base REAL NOT NULL DEFAULT 0,
			budget_spent REAL NOT NULL DEFAULT 0,
			budget_period TEXT NOT NULL DEFAULT 'none',
			budget_reset_at TEXT,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
	`);
	database.exec(readFileSync(join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations-d1/0040_user_budget_reservations.sql',
	), 'utf8'));
	database.exec(readFileSync(join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations-d1/0041_user_budget_spent_micros.sql',
	), 'utf8'));
	return database;
}

function insertUser(
	database: DatabaseSync,
	params: {
		id: string;
		budgetMax: number | null;
		budgetSpent?: number;
		budgetPeriod?: string;
		budgetResetAt?: string | null;
	},
): void {
	database.prepare(`INSERT INTO users (
		id, budget_max, budget_spent, budget_period, budget_reset_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(
			params.id,
			params.budgetMax,
			params.budgetSpent ?? 0,
			params.budgetPeriod ?? 'none',
			params.budgetResetAt ?? null,
			'2026-08-29T00:00:00.000Z',
		);
	database.prepare(`INSERT INTO api_keys (id, user_id, status) VALUES (?, ?, 'active')`)
		.run(`key-${params.id}`, params.id);
	if (params.id === 'user-capacity') {
		database.prepare(`INSERT INTO api_keys (id, user_id, status) VALUES (?, ?, 'active'), (?, ?, 'active')`)
			.run('key-0', params.id, 'key-1', params.id);
	}
}

function insertAuthoritativeUser(
	database: DatabaseSync,
	id: string,
	budgetSpentMicros: number,
): void {
	database.prepare(`INSERT INTO users (
		id, budget_max, budget_spent, budget_spent_micros,
		budget_period, budget_reset_at, updated_at
	) VALUES (?, ?, ?, ?, 'none', NULL, ?)`)
		.run(
			id,
			USER_BUDGET_MAX_SAFE_MICROS / 1_000_000,
			budgetSpentMicros / 1_000_000,
			budgetSpentMicros,
			'2026-08-30T00:00:00.000Z',
		);
	database.prepare(`INSERT INTO api_keys (id, user_id, status) VALUES (?, ?, 'active')`)
		.run(`key-${id}`, id);
}

const NOW = '2026-08-29T01:00:00.000Z';
const EXPIRES = '2026-08-29T01:02:00.000Z';

function reservationParams(
	requestId: string,
	userId: string,
	reservedMicros: number,
	overrides: Partial<ReserveUserBudgetParams> = {},
): ReserveUserBudgetParams {
	return {
		requestId,
		userId,
		apiKeyId: `key-${userId}`,
		expectedBudgetEpoch: 0,
		reservedMicros,
		nowIso: NOW,
		expiresAtIso: EXPIRES,
		...overrides,
	};
}

function account(database: DatabaseSync, userId: string): {
	budget_spent: number;
	budget_epoch: number;
	budget_reserved_micros: number;
} {
	const row = database.prepare(`SELECT budget_spent, budget_epoch, budget_reserved_micros
		FROM users WHERE id = ?`).get(userId) as {
			budget_spent: number;
			budget_epoch: number;
			budget_reserved_micros: number;
		};
	return { ...row };
}

function reservation(database: DatabaseSync, requestId: string): {
	budget_epoch: number;
	reserved_micros: number;
	settled_micros: number;
	state: string;
} {
	const row = database.prepare(`SELECT budget_epoch, reserved_micros, settled_micros, state
		FROM user_budget_reservations WHERE request_id = ?`).get(requestId) as {
			budget_epoch: number;
			reserved_micros: number;
			settled_micros: number;
			state: string;
		};
	return { ...row };
}

// Production settlement is embedded in the request-log critical write, not
// exposed as a detached repository method. Drive the migration trigger here to
// verify the ledger/account transaction contract around that critical write.
function settleActual(
	database: DatabaseSync,
	requestId: string,
	settledMicros: number,
	nowIso = '2026-08-29T01:03:00.000Z',
): void {
	database.prepare(`UPDATE user_budget_reservations
		SET state = 'settled', settled_micros = ?, terminal_at = ?,
			terminal_reason = 'actual_usage', updated_at = ?
		WHERE request_id = ? AND state IN ('reserved', 'dispatched')`)
		.run(settledMicros, nowIso, nowIso, requestId);
}

test('D1 ordinary budget admission is atomic across keys, capacity bounded, and replay safe', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-capacity', budgetMax: 1, budgetSpent: 0.2 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;
		const params = Array.from({ length: 12 }, (_, index) => reservationParams(
			`request-capacity-${index}`,
			'user-capacity',
			100_000,
			{ apiKeyId: `key-${index % 2}` },
		));

		const results = await Promise.all(params.map((item) => budgets.reserve(item)));
		assert.equal(results.filter((result) => result.status === 'reserved').length, 8);
		assert.equal(results.filter((result) => result.status === 'blocked').length, 4);
		assert.deepEqual(account(database, 'user-capacity'), {
			budget_spent: 0.2,
			budget_epoch: 0,
			budget_reserved_micros: 800_000,
		});
		assert.equal(
			Number(database.prepare(`SELECT COUNT(*) AS count FROM user_budget_reservations
				WHERE user_id = ? AND state = 'reserved'`).get('user-capacity')?.count),
			8,
		);

		const admittedIndex = results.findIndex((result) => result.status === 'reserved');
		assert.ok(admittedIndex >= 0);
		assert.equal((await budgets.reserve(params[admittedIndex]!)).status, 'idempotent');
		assert.equal((await budgets.reserve({
			...params[admittedIndex]!, reservedMicros: 99_999,
		})).status, 'conflict');
		assert.deepEqual(
			await budgets.reserve(reservationParams('request-one-micro-over', 'user-capacity', 1)),
			{ status: 'blocked', remainingMicros: 0 },
		);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget admission distinguishes unlimited, stale, missing, and unsafe requests', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-unlimited', budgetMax: null });
		insertUser(database, {
			id: 'user-stale',
			budgetMax: 1,
			budgetPeriod: 'daily',
			budgetResetAt: '2026-08-29T00:59:59.000Z',
		});
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;

		assert.deepEqual(
			await budgets.reserve(reservationParams('request-unlimited', 'user-unlimited', 1)),
			{ status: 'unlimited' },
		);
		assert.deepEqual(
			await budgets.reserve(reservationParams('request-stale', 'user-stale', 1)),
			{ status: 'stale', budgetResetAt: '2026-08-29T00:59:59.000Z' },
		);
		assert.equal(
			(await budgets.reserve(reservationParams('request-missing', 'user-missing', 1))).status,
			'conflict',
		);
		assert.equal(
			(await budgets.reserve(reservationParams('request-zero', 'user-stale', 0))).status,
			'conflict',
		);
		assert.equal(
			(await budgets.reserve(reservationParams('request-wrong-key', 'user-stale', 1, {
				apiKeyId: 'key-user-unlimited',
			}))).status,
			'conflict',
		);
		assert.equal(
			(await budgets.reserve(reservationParams(
				'request-unsafe',
				'user-unlimited',
				Number.MAX_SAFE_INTEGER + 1,
			))).status,
			'conflict',
		);
		assert.deepEqual(
			await budgets.reserve(reservationParams('request-old-epoch', 'user-unlimited', 1, {
				expectedBudgetEpoch: 1,
			})),
			{ status: 'stale', budgetResetAt: null },
		);
		assert.equal(
			Number(database.prepare('SELECT COUNT(*) AS count FROM user_budget_reservations').get()?.count),
			0,
		);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget release is pre-dispatch only, terminal, and idempotent', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-release', budgetMax: 1 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;
		assert.equal((await budgets.reserve(
			reservationParams('request-release', 'user-release', 300_000),
		)).status, 'reserved');

		assert.equal(await budgets.release('request-release', NOW, 'not_dispatched'), 1);
		assert.equal(await budgets.release('request-release', NOW, 'duplicate'), 1);
		assert.deepEqual(account(database, 'user-release'), {
			budget_spent: 0,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.equal(reservation(database, 'request-release').state, 'released');
		assert.throws(
			() => database.prepare(`UPDATE user_budget_reservations SET state = 'reserved'
				WHERE request_id = ?`).run('request-release'),
			/invalid_user_budget_transition/,
		);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget dispatch and forfeit charge the ceiling exactly once', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-forfeit', budgetMax: 1 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;
		await budgets.reserve(reservationParams('request-forfeit', 'user-forfeit', 400_000));

		assert.equal(await budgets.markDispatched('request-forfeit', NOW, EXPIRES), true);
		assert.equal(await budgets.markDispatched('request-forfeit', NOW, EXPIRES), true);
		assert.equal(await budgets.release('request-forfeit', NOW, 'too_late'), 0);
		assert.equal(await budgets.forfeitDispatched('request-forfeit', NOW, 'unknown_usage'), 1);
		assert.equal(await budgets.forfeitDispatched('request-forfeit', NOW, 'duplicate'), 1);
		assert.deepEqual(account(database, 'user-forfeit'), {
			budget_spent: 0.4,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.deepEqual(reservation(database, 'request-forfeit'), {
			budget_epoch: 0,
			reserved_micros: 400_000,
			settled_micros: 400_000,
			state: 'expired',
		});
	} finally {
		database.close();
	}
});

test('D1 ordinary budget expiry releases undispatched leases and forfeits dispatched leases once', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-expiry', budgetMax: 1 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;
		await budgets.reserve(reservationParams('request-expire-release', 'user-expiry', 200_000));
		await budgets.reserve(reservationParams('request-expire-forfeit', 'user-expiry', 300_000));
		await budgets.markDispatched(
			'request-expire-forfeit',
			'2026-08-29T01:00:30.000Z',
			'2026-08-29T01:01:30.000Z',
		);

		assert.equal(await budgets.expireBefore('2026-08-29T01:03:00.000Z'), 2);
		assert.equal(await budgets.expireBefore('2026-08-29T01:03:00.000Z'), 0);
		assert.equal(reservation(database, 'request-expire-release').state, 'released');
		assert.deepEqual(reservation(database, 'request-expire-forfeit'), {
			budget_epoch: 0,
			reserved_micros: 300_000,
			settled_micros: 300_000,
			state: 'expired',
		});
		assert.deepEqual(account(database, 'user-expiry'), {
			budget_spent: 0.3,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
	} finally {
		database.close();
	}
});

test('D1 ordinary budget settlement releases estimate slack and records actual overruns', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-actual', budgetMax: 0.8, budgetSpent: 0.1 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;

		await budgets.reserve(reservationParams('request-below', 'user-actual', 600_000));
		await budgets.markDispatched('request-below', NOW, EXPIRES);
		settleActual(database, 'request-below', 250_000);
		settleActual(database, 'request-below', 600_000);
		assert.deepEqual(account(database, 'user-actual'), {
			budget_spent: 0.35,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.deepEqual(reservation(database, 'request-below'), {
			budget_epoch: 0,
			reserved_micros: 600_000,
			settled_micros: 250_000,
			state: 'settled',
		});

		await budgets.reserve(reservationParams('request-overrun', 'user-actual', 200_000));
		await budgets.markDispatched('request-overrun', NOW, EXPIRES);
		settleActual(database, 'request-overrun', 500_000);
		assert.deepEqual(account(database, 'user-actual'), {
			budget_spent: 0.85,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.equal(reservation(database, 'request-overrun').settled_micros, 500_000);
		assert.deepEqual(
			await budgets.reserve(reservationParams('request-after-overrun', 'user-actual', 1)),
			{ status: 'blocked', remainingMicros: 0 },
		);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget late actual reconciles one epoch and never mutates a newer epoch', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-epoch', budgetMax: 1 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;
		await budgets.reserve(reservationParams('request-epoch', 'user-epoch', 400_000));
		await budgets.markDispatched('request-epoch', NOW, EXPIRES);
		await budgets.forfeitDispatched('request-epoch', NOW, 'unknown_usage');

		database.prepare(`UPDATE user_budget_reservations
			SET settled_micros = 250000, updated_at = ? WHERE request_id = ? AND state = 'expired'`)
			.run('2026-08-29T01:04:00.000Z', 'request-epoch');
		assert.equal(account(database, 'user-epoch').budget_spent, 0.25);
		database.prepare(`UPDATE user_budget_reservations
			SET settled_micros = 500000, updated_at = ? WHERE request_id = ? AND state = 'expired'`)
			.run('2026-08-29T01:05:00.000Z', 'request-epoch');
		assert.equal(account(database, 'user-epoch').budget_spent, 0.5);
		await budgets.reserve(reservationParams('request-straddles-reset', 'user-epoch', 100_000));
		await budgets.markDispatched('request-straddles-reset', NOW, EXPIRES);

		database.prepare(`UPDATE users SET budget_epoch = budget_epoch + 1,
			budget_spent = 0, budget_reserved_micros = 0, updated_at = ? WHERE id = ?`)
			.run('2026-08-29T01:06:00.000Z', 'user-epoch');
		assert.equal(
			await budgets.forfeitDispatched(
				'request-straddles-reset',
				'2026-08-29T01:06:30.000Z',
				'old_epoch_unknown_usage',
			),
			1,
		);
		database.prepare(`UPDATE user_budget_reservations
			SET settled_micros = 600000, updated_at = ? WHERE request_id = ? AND state = 'expired'`)
			.run('2026-08-29T01:07:00.000Z', 'request-epoch');
		assert.deepEqual(account(database, 'user-epoch'), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
		assert.equal((await budgets.reserve(
			reservationParams('request-new-epoch', 'user-epoch', 1_000_000, {
				expectedBudgetEpoch: 1,
			}),
		)).status, 'reserved');
	} finally {
		database.close();
	}
});

test('D1 ordinary budget admission preserves one-micro boundary precision', async () => {
	const database = setupDatabase();
	try {
		insertUser(database, { id: 'user-precision', budgetMax: 1, budgetSpent: 0.999999 });
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;

		assert.equal((await budgets.reserve(
			reservationParams('request-last-micro', 'user-precision', 1),
		)).status, 'reserved');
		assert.deepEqual(
			await budgets.reserve(reservationParams('request-past-limit', 'user-precision', 1)),
			{ status: 'blocked', remainingMicros: 0 },
		);
		assert.equal(account(database, 'user-precision').budget_reserved_micros, 1);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget INTEGER source preserves a one-micro settlement where the REAL mirror cannot', async () => {
	const database = setupDatabase();
	try {
		// At 2^33 units, adjacent binary64 REAL values are about 1.907 micros
		// apart. The compatibility mirror cannot encode this +1 micro update.
		const startingMicros = 8_589_934_592_000_000;
		insertAuthoritativeUser(database, 'user-large-precision', startingMicros);
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;

		assert.equal((await budgets.reserve(reservationParams(
			'request-large-last-micro',
			'user-large-precision',
			1,
		))).status, 'reserved');
		settleActual(database, 'request-large-last-micro', 1);

		const row = database.prepare(`SELECT budget_spent, budget_spent_micros
			FROM users WHERE id = 'user-large-precision'`).get() as {
			budget_spent: number;
			budget_spent_micros: number;
		};
		assert.equal(row.budget_spent_micros, startingMicros + 1);
		assert.notEqual(Math.round(row.budget_spent * 1_000_000), startingMicros + 1);
	} finally {
		database.close();
	}
});

test('D1 ordinary budget overrun saturates at MAX_SAFE micros and remains fail-closed', async () => {
	const database = setupDatabase();
	try {
		insertAuthoritativeUser(
			database,
			'user-large-overrun',
			USER_BUDGET_MAX_SAFE_MICROS - 1,
		);
		const budgets = createD1Repositories(createD1Client(database)).userBudgets;

		assert.equal((await budgets.reserve(reservationParams(
			'request-large-overrun',
			'user-large-overrun',
			1,
		))).status, 'reserved');
		settleActual(database, 'request-large-overrun', 100);

		assert.equal(
			Number(database.prepare(`SELECT budget_spent_micros FROM users
				WHERE id = 'user-large-overrun'`).get()?.budget_spent_micros),
			USER_BUDGET_MAX_SAFE_MICROS,
		);
		assert.deepEqual(
			await budgets.reserve(reservationParams(
				'request-after-large-overrun',
				'user-large-overrun',
				1,
			)),
			{ status: 'blocked', remainingMicros: 0 },
		);
	} finally {
		database.close();
	}
});

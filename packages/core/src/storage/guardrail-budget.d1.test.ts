import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { insertRequestUsageAndChargeTxD1 } from '../db/d1/critical-writes.impl';
import { createD1GuardrailBudgetsRepository } from '../db/d1/guardrail-budgets.impl';
import type { GuardrailBudgetIntent } from '../db/guardrail-budget-types';
import type { InsertRequestLogParams } from '../db/request-logs-types';
import type { D1DatabaseClient } from './database-client';

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
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
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

const PERIOD_START = '2026-08-29T00:00:00.000Z';
const PERIOD_END = '2026-08-30T00:00:00.000Z';

function intent(
	assignmentId: string,
	scopeType: 'user' | 'api_key',
	scopeId: string,
	limitMicros = 1_000_000,
): GuardrailBudgetIntent {
	return {
		workspaceId: 'personal:user-1',
		assignmentId,
		guardrailId: `guardrail-${assignmentId}`,
		guardrailVersion: 1,
		scopeType,
		scopeId,
		period: 'daily',
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		limitMicros,
	};
}

function reservationParams(
	requestId: string,
	intents: GuardrailBudgetIntent[],
	reservedMicros: number,
) {
	return {
		requestId,
		intents,
		reservedMicros,
		nowIso: '2026-08-29T01:00:00.000Z',
		expiresAtIso: '2026-08-29T01:02:00.000Z',
	};
}

function setupDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			budget_spent REAL NOT NULL DEFAULT 0,
			budget_spent_micros INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			api_key_id TEXT,
			workspace_id TEXT,
			user_email TEXT,
			model_id TEXT,
			provider_id TEXT,
			provider_model_name TEXT,
			model_name TEXT,
			provider_name TEXT,
			request_body TEXT,
			upstream_request_body TEXT,
			request_protocol TEXT,
			request_operation TEXT,
			upstream_protocol TEXT,
			upstream_operation TEXT,
			model_surface_id TEXT,
			route_pool_id TEXT,
			route_target_id TEXT,
			adapter TEXT,
			route_trace TEXT,
			input_tokens INTEGER,
			output_tokens INTEGER,
			cache_read_tokens INTEGER,
			cache_write_tokens INTEGER,
			reasoning_tokens INTEGER,
			total_tokens INTEGER,
			metered_cost REAL,
			standard_cost REAL,
			charged_cost REAL,
			route_group TEXT,
			status TEXT,
			latency_ms INTEGER,
			gateway_overhead_ms INTEGER,
			upstream_response_ms INTEGER,
			final_upstream_headers_ms INTEGER,
			first_reasoning_token_ms INTEGER,
			first_token_ms INTEGER,
			stream_duration_ms INTEGER,
			upstream_attempt_count INTEGER,
			upstream_failover_count INTEGER,
			timing_metadata TEXT,
			error_message TEXT,
			raw_usage TEXT,
			pricing_audit TEXT,
			provider_key_id TEXT,
			provider_key_label TEXT,
			provider_key_fingerprint TEXT,
			upstream_request_id TEXT,
			upstream_message_id TEXT,
			billing_kind TEXT,
			input_image_count INTEGER,
			output_image_count INTEGER,
			audio_duration_seconds REAL,
			audio_characters INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE public_model_daily_stats (
			stat_date TEXT NOT NULL,
			model_id TEXT NOT NULL,
			shard INTEGER NOT NULL,
			request_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			latency_total_ms INTEGER NOT NULL DEFAULT 0,
			latency_sample_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			UNIQUE (stat_date, model_id, shard)
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			api_key_id TEXT,
			event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL,
			request_log_id TEXT,
			change_payload TEXT,
			before_user_snapshot TEXT,
			after_user_snapshot TEXT,
			changed_fields TEXT,
			correlation_id TEXT,
			source TEXT,
			actor_id TEXT,
			reason_code TEXT,
			reason_text TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		INSERT INTO users (id, budget_spent, updated_at)
		VALUES ('user-1', 0, '2026-08-29T00:00:00.000Z');
		INSERT INTO api_keys (id, user_id, workspace_id, status) VALUES
			('key-1', 'user-1', 'personal:user-1', 'active'),
			('legacy-key', 'legacy-user', 'personal:user-1', 'active');
	`);
	database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0039_guardrail_budget_reservations.sql', import.meta.url)), 'utf8'));
	database.exec(`
		ALTER TABLE guardrail_budget_windows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal:user-1';
		ALTER TABLE guardrail_budget_reservations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal:user-1';
	`);
	return database;
}

function usageLog(
	id: string,
	chargedCost: number,
	budgetAccountedAt: string | null = '2026-08-29T01:00:00.000Z',
): InsertRequestLogParams {
	return {
		id, userId: 'user-1', apiKeyId: 'key-1', workspaceId: 'personal:user-1', userEmail: 'user@example.com',
		modelId: 'openai/test', providerId: 'provider-1', providerModelName: 'test',
		modelName: 'Test', providerName: 'Provider', requestBody: null, upstreamRequestBody: null,
		requestProtocol: 'openai', requestOperation: 'chat.completions', upstreamProtocol: 'openai',
		upstreamOperation: 'chat.completions', inputTokens: 10, outputTokens: 10,
		cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 20,
		meteredCost: chargedCost, standardCost: chargedCost, chargedCost, budgetAccountedAt,
		routeGroup: 'default', status: 'success', latencyMs: 10, errorMessage: null, rawUsage: null,
	};
}

async function writeUsage(
	client: D1DatabaseClient,
	params: {
		id: string;
		chargedCost: number;
		budgetAccountedAt?: string | null;
		settlement?: { requestId: string; mode: 'actual' | 'reserved'; reason: string };
	},
): Promise<void> {
	await insertRequestUsageAndChargeTxD1(client, {
		requestLog: usageLog(params.id, params.chargedCost, params.budgetAccountedAt),
		shouldChargeBudget: true,
		userId: 'user-1',
		beforeSpent: 0,
		chargedCost: params.chargedCost,
		guardrailBudgetSettlement: params.settlement,
		audit: {
			apiKeyId: 'key-1', eventType: 'usage_charge', actorType: 'system', beforeSpent: 0,
			requestLogId: params.id, source: 'gateway_usage',
		},
	});
}

function plain<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

test('D1 Guardrail budget admission is all-or-none, idempotent, and capacity bounded', async () => {
	const database = setupDatabase();
	try {
		const repository = createD1GuardrailBudgetsRepository(createD1Client(database));
		const intents = [intent('user-assignment', 'user', 'user-1'), intent('key-assignment', 'api_key', 'key-1')];
		const first = reservationParams('request-1', intents, 600_000);

		assert.deepEqual(await repository.reserveMany(first), { status: 'reserved', reservationCount: 2 });
		assert.deepEqual(await repository.reserveMany(first), { status: 'idempotent', reservationCount: 2 });
		assert.equal((await repository.reserveMany({ ...first, reservedMicros: 500_000 })).status, 'conflict');

		const blocked = await repository.reserveMany(reservationParams('request-2', intents, 500_000));
		assert.equal(blocked.status, 'blocked');
		assert.equal(
			(database.prepare('SELECT COUNT(*) AS count FROM guardrail_budget_reservations WHERE request_id = ?').get('request-2') as { count: number }).count,
			0,
		);
		const windows = plain(database.prepare(`
			SELECT scope_type, settled_micros, reserved_micros
			FROM guardrail_budget_windows ORDER BY scope_type
		`).all() as Array<{ scope_type: string; settled_micros: number; reserved_micros: number }>);
		assert.deepEqual(windows, [
			{ scope_type: 'api_key', settled_micros: 0, reserved_micros: 600_000 },
			{ scope_type: 'user', settled_micros: 0, reserved_micros: 600_000 },
		]);
	} finally {
		database.close();
	}
});

test('D1 concurrent identical Guardrail budget admission is classified as an idempotent replay', async () => {
	const database = setupDatabase();
	try {
		const repository = createD1GuardrailBudgetsRepository(createD1Client(database));
		const intents = [intent('user-assignment', 'user', 'user-1'), intent('key-assignment', 'api_key', 'key-1')];
		const params = reservationParams('request-concurrent-replay', intents, 1_000_000);

		const results = await Promise.all([
			repository.reserveMany(params),
			repository.reserveMany(params),
		]);
		assert.deepEqual(
			results.map((result) => result.status).sort(),
			['idempotent', 'reserved'],
			'a raced retry must be re-read before a capacity-trigger error is classified as blocked',
		);
		assert.equal(
			(database.prepare('SELECT COUNT(*) AS count FROM guardrail_budget_reservations WHERE request_id = ?')
				.get(params.requestId) as { count: number }).count,
			2,
		);
		assert.equal(
			await repository.markDispatched(
				params.requestId,
				'2026-08-29T01:01:00.000Z',
				'2026-08-29T01:16:00.000Z',
			),
			true,
		);
		assert.equal(
			(database.prepare(`SELECT COUNT(*) AS count FROM guardrail_budget_reservations
				WHERE request_id = ? AND state = 'dispatched'`).get(params.requestId) as { count: number }).count,
			2,
			'the conditional UPDATE must transition every reserved sibling in one statement',
		);
	} finally {
		database.close();
	}
});

test('D1 dispatch transition does not partially dispatch a request split by expiry', async () => {
	const database = setupDatabase();
	try {
		const repository = createD1GuardrailBudgetsRepository(createD1Client(database));
		const intents = [intent('user-assignment', 'user', 'user-1'), intent('key-assignment', 'api_key', 'key-1')];
		await repository.reserveMany(reservationParams('request-split-expiry', intents, 100_000));
		assert.equal(await repository.expireBefore('2026-08-29T01:03:00.000Z', 1), 1);

		assert.equal(
			await repository.markDispatched(
				'request-split-expiry',
				'2026-08-29T01:04:00.000Z',
				'2026-08-29T01:19:00.000Z',
			),
			false,
		);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT state FROM guardrail_budget_reservations
				WHERE request_id = ? ORDER BY state
			`).all('request-split-expiry')),
			[{ state: 'released' }, { state: 'reserved' }],
			'the surviving reservation must not enter dispatched when any sibling is terminal',
		);
	} finally {
		database.close();
	}
});

test('D1 Guardrail budget lifecycle releases before dispatch and forfeits after dispatch', async () => {
	const database = setupDatabase();
	try {
		const repository = createD1GuardrailBudgetsRepository(createD1Client(database));
		const userIntent = [intent('user-assignment', 'user', 'user-1')];

		await repository.reserveMany(reservationParams('request-dispatched', userIntent, 600_000));
		assert.equal(
			await repository.markDispatched(
				'request-dispatched',
				'2026-08-29T01:01:00.000Z',
				'2026-08-29T01:16:00.000Z',
			),
			true,
		);
		assert.equal(
			await repository.markDispatched(
				'request-dispatched',
				'2026-08-29T01:01:30.000Z',
				'2026-08-29T01:16:30.000Z',
			),
			true,
			'an already-dispatched request remains idempotently dispatched',
		);
		assert.equal(await repository.forfeitMany('request-dispatched', '2026-08-29T01:02:00.000Z', 'usage_unknown'), 1);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 600_000, reserved_micros: 0 },
		);

		await repository.reserveMany(reservationParams('request-release', userIntent, 300_000));
		assert.equal(await repository.releaseMany('request-release', '2026-08-29T01:03:00.000Z', 'not_dispatched'), 1);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 600_000, reserved_micros: 0 },
		);

		await repository.reserveMany(reservationParams('request-expire-reserved', userIntent, 200_000));
		assert.equal(await repository.expireBefore('2026-08-29T01:03:00.000Z'), 1);
		await repository.reserveMany(reservationParams('request-expire-dispatched', userIntent, 200_000));
		await repository.markDispatched(
			'request-expire-dispatched',
			'2026-08-29T01:01:00.000Z',
			'2026-08-29T01:02:00.000Z',
		);
		assert.equal(await repository.expireBefore('2026-08-29T01:03:00.000Z'), 1);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 800_000, reserved_micros: 0 },
		);
		assert.throws(
			() => database.prepare("UPDATE guardrail_budget_reservations SET state = 'reserved' WHERE request_id = ?").run('request-dispatched'),
			/invalid_guardrail_budget_transition/,
		);
	} finally {
		database.close();
	}
});

test('D1 Guardrail budget windows seed legacy and explicit request-log charges', async () => {
	const database = setupDatabase();
	try {
		database.prepare(`
			INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id, charged_cost, created_at)
			VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
		`).run(
			'legacy-log', 'legacy-user', 'legacy-key', 'personal:user-1', 0.2, '2026-08-29T00:10:00.000Z',
			'explicit-log', 'legacy-user', 'legacy-key', 'personal:user-1', 99, '2026-08-29T00:20:00.000Z',
		);
		database.prepare('UPDATE api_key_request_logs SET budget_charged_micros = ? WHERE id = ?').run(300_000, 'explicit-log');
		const repository = createD1GuardrailBudgetsRepository(createD1Client(database));
		const seededIntent = [intent('legacy-assignment', 'user', 'legacy-user')];

		const blocked = await repository.reserveMany(reservationParams('legacy-request', seededIntent, 500_001));
		assert.equal(blocked.status, 'blocked');
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			undefined,
			'a blocked first reservation must roll back the newly seeded window',
		);
		assert.equal((await repository.reserveMany(reservationParams('legacy-request-ok', seededIntent, 500_000))).status, 'reserved');
		assert.deepEqual(
			plain(database.prepare('SELECT unreserved_micros, settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ unreserved_micros: 500_000, settled_micros: 0, reserved_micros: 500_000 },
		);
	} finally {
		database.close();
	}
});

test('D1 admission adds no-log forfeits, unreserved logs, and live reservations', async () => {
	const database = setupDatabase();
	try {
		const client = createD1Client(database);
		const repository = createD1GuardrailBudgetsRepository(client);
		const userIntent = [intent('user-assignment', 'user', 'user-1')];

		await repository.reserveMany(reservationParams('request-forfeited', userIntent, 300_000));
		await repository.markDispatched(
			'request-forfeited',
			'2026-08-29T01:01:00.000Z',
			'2026-08-29T01:16:00.000Z',
		);
		assert.equal(await repository.forfeitMany('request-forfeited', '2026-08-29T01:02:00.000Z', 'usage_unknown'), 1);
		assert.equal(
			(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs WHERE id = ?').get('request-forfeited') as { count: number }).count,
			0,
			'the forfeited ceiling must remain accounted even without a request log',
		);

		await writeUsage(client, { id: 'request-unreserved', chargedCost: 0.2 });
		assert.equal(
			(await repository.reserveMany(reservationParams('request-live', userIntent, 100_000))).status,
			'reserved',
		);
		assert.equal(
			(await repository.reserveMany(reservationParams('request-over-limit', userIntent, 400_001))).status,
			'blocked',
		);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT unreserved_micros, settled_micros, reserved_micros
				FROM guardrail_budget_windows
			`).get()),
			{ unreserved_micros: 200_000, settled_micros: 300_000, reserved_micros: 100_000 },
		);
		assert.equal(
			(await repository.reserveMany(reservationParams('request-at-limit', userIntent, 400_000))).status,
			'reserved',
		);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT unreserved_micros, settled_micros, reserved_micros
				FROM guardrail_budget_windows
			`).get()),
			{ unreserved_micros: 200_000, settled_micros: 300_000, reserved_micros: 500_000 },
		);
	} finally {
		database.close();
	}
});

test('D1 released request ids are reconciled as unreserved when a positive log arrives', async () => {
	const database = setupDatabase();
	try {
		const client = createD1Client(database);
		const repository = createD1GuardrailBudgetsRepository(client);
		const userIntent = [intent('user-assignment', 'user', 'user-1')];

		await repository.reserveMany(reservationParams('request-released-late', userIntent, 300_000));
		assert.equal(
			await repository.releaseMany('request-released-late', '2026-08-29T01:01:00.000Z', 'not_dispatched'),
			1,
		);
		await writeUsage(client, {
			id: 'request-released-late',
			chargedCost: 0.3,
			settlement: { requestId: 'request-released-late', mode: 'actual', reason: 'late_actual' },
		});
		assert.deepEqual(
			plain(database.prepare(`
				SELECT state, settled_micros FROM guardrail_budget_reservations
				WHERE request_id = 'request-released-late'
			`).get()),
			{ state: 'released', settled_micros: 0 },
		);
		assert.equal(
			(await repository.reserveMany(reservationParams('request-after-late-log-blocked', userIntent, 700_001))).status,
			'blocked',
		);
		assert.equal(
			(await repository.reserveMany(reservationParams('request-after-late-log', userIntent, 700_000))).status,
			'reserved',
		);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT unreserved_micros, settled_micros, reserved_micros
				FROM guardrail_budget_windows
			`).get()),
			{ unreserved_micros: 300_000, settled_micros: 0, reserved_micros: 700_000 },
		);
	} finally {
		database.close();
	}
});

test('D1 budget_accounted_at pins a cross-midnight log to its original window', async () => {
	const database = setupDatabase();
	try {
		const client = createD1Client(database);
		const repository = createD1GuardrailBudgetsRepository(client);
		const oldIntent = [intent('user-assignment', 'user', 'user-1')];

		await repository.reserveMany(reservationParams('request-cross-midnight', oldIntent, 400_000));
		await repository.markDispatched(
			'request-cross-midnight',
			'2026-08-29T23:59:59.000Z',
			'2026-08-30T00:15:00.000Z',
		);
		await writeUsage(client, {
			id: 'request-cross-midnight',
			chargedCost: 0.4,
			budgetAccountedAt: '2026-08-29T23:59:59.000Z',
			settlement: { requestId: 'request-cross-midnight', mode: 'actual', reason: 'usage_recorded' },
		});
		database.prepare('UPDATE api_key_request_logs SET created_at = ? WHERE id = ?')
			.run('2026-08-30T00:00:01.000Z', 'request-cross-midnight');
		assert.deepEqual(
			plain(database.prepare(`
				SELECT created_at, budget_accounted_at FROM api_key_request_logs
				WHERE id = 'request-cross-midnight'
			`).get()),
			{
				created_at: '2026-08-30T00:00:01.000Z',
				budget_accounted_at: '2026-08-29T23:59:59.000Z',
			},
		);

		const nextIntent: GuardrailBudgetIntent = {
			...oldIntent[0]!,
			periodStart: '2026-08-30T00:00:00.000Z',
			periodEnd: '2026-08-31T00:00:00.000Z',
		};
		assert.equal(
			(await repository.reserveMany(reservationParams('request-next-day', [nextIntent], 1_000_000))).status,
			'reserved',
		);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT period_start, unreserved_micros, settled_micros, reserved_micros
				FROM guardrail_budget_windows ORDER BY period_start
			`).all()),
			[
				{ period_start: PERIOD_START, unreserved_micros: 0, settled_micros: 400_000, reserved_micros: 0 },
				{ period_start: PERIOD_END, unreserved_micros: 0, settled_micros: 0, reserved_micros: 1_000_000 },
			],
		);
	} finally {
		database.close();
	}
});

test('D1 late actual overrun adds only the expired reservation delta and duplicate delivery is atomic', async () => {
	const database = setupDatabase();
	try {
		const client = createD1Client(database);
		const repository = createD1GuardrailBudgetsRepository(client);
		const userIntent = [intent('user-assignment', 'user', 'user-1')];

		await repository.reserveMany(reservationParams('request-late-actual', userIntent, 300_000));
		await repository.markDispatched(
			'request-late-actual',
			'2026-08-29T01:01:00.000Z',
			'2026-08-29T01:02:00.000Z',
		);
		assert.equal(await repository.expireBefore('2026-08-29T01:03:00.000Z'), 1);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 300_000, reserved_micros: 0 },
		);

		const lateActual = {
			id: 'request-late-actual',
			chargedCost: 0.5,
			settlement: { requestId: 'request-late-actual', mode: 'actual' as const, reason: 'late_actual' },
		};
		await writeUsage(client, lateActual);
		assert.deepEqual(
			plain(database.prepare(`
				SELECT state, reserved_micros, settled_micros
				FROM guardrail_budget_reservations WHERE request_id = 'request-late-actual'
			`).get()),
			{ state: 'expired', reserved_micros: 300_000, settled_micros: 500_000 },
		);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 500_000, reserved_micros: 0 },
			'only the 200,000 micro overrun delta is added after the 300,000 ceiling forfeit',
		);

		await assert.rejects(() => writeUsage(client, lateActual), /UNIQUE constraint failed/u);
		assert.deepEqual(
			plain(database.prepare('SELECT settled_micros, reserved_micros FROM guardrail_budget_windows').get()),
			{ settled_micros: 500_000, reserved_micros: 0 },
			'a duplicate critical write must roll back without settling the overrun twice',
		);
		assert.equal(
			(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs WHERE id = ?').get('request-late-actual') as { count: number }).count,
			1,
		);
		assert.equal(
			(database.prepare('SELECT budget_spent FROM users WHERE id = ?').get('user-1') as { budget_spent: number }).budget_spent,
			0.5,
		);
	} finally {
		database.close();
	}
});

test('D1 Guardrail settlement rejects mismatched or missing reservation identities atomically', async () => {
	const database = setupDatabase();
	try {
		const client = createD1Client(database);
		const repository = createD1GuardrailBudgetsRepository(client);
		const userIntent = [intent('user-assignment', 'user', 'user-1')];
		await repository.reserveMany(reservationParams('request-reserved', userIntent, 300_000));

		await assert.rejects(
			writeUsage(client, {
				id: 'request-log-mismatch',
				chargedCost: 0.2,
				settlement: { requestId: 'request-reserved', mode: 'actual', reason: 'actual_usage' },
			}),
			/settlement requestId must match request log id/,
		);
		await assert.rejects(
			writeUsage(client, {
				id: 'request-without-reservation',
				chargedCost: 0.2,
				settlement: { requestId: 'request-without-reservation', mode: 'actual', reason: 'actual_usage' },
			}),
			/no matching reservation window/,
		);
		assert.equal(
			Number(database.prepare(`SELECT COUNT(*) AS count FROM api_key_request_logs`).get().count),
			0,
		);
	} finally {
		database.close();
	}
});

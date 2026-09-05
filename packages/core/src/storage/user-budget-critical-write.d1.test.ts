import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	applyUserBudgetTransitionWithAuditD1,
	insertRequestUsageAndChargeTxD1,
	updateUserBudgetWithAuditTxD1,
} from '../db/d1/critical-writes.impl';
import type { InsertRequestLogParams } from '../db/request-logs-types';
import type { GuardrailBudgetIntent } from '../db/guardrail-budget-types';
import { applyBudgetTransition } from '../services/budget-transition-service';
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

type D1TestHooks = {
	beforeNextBatch?: () => void;
};

function createD1Client(database: DatabaseSync, hooks: D1TestHooks = {}): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			const beforeBatch = hooks.beforeNextBatch;
			hooks.beforeNextBatch = undefined;
			beforeBatch?.();
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
			workspace_id TEXT NOT NULL DEFAULT 'personal:user-1',
			status TEXT NOT NULL
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, workspace_id TEXT, user_email TEXT,
			model_id TEXT, provider_id TEXT, provider_model_name TEXT, model_name TEXT,
			provider_name TEXT, request_body TEXT, upstream_request_body TEXT,
			request_protocol TEXT, request_operation TEXT, upstream_protocol TEXT,
			upstream_operation TEXT, model_surface_id TEXT, route_pool_id TEXT,
			route_target_id TEXT, adapter TEXT, route_trace TEXT,
			input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
			cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER,
			metered_cost REAL, standard_cost REAL, charged_cost REAL,
			route_group TEXT, status TEXT, latency_ms INTEGER, gateway_overhead_ms INTEGER,
			upstream_response_ms INTEGER, final_upstream_headers_ms INTEGER,
			first_reasoning_token_ms INTEGER, first_token_ms INTEGER, stream_duration_ms INTEGER,
			upstream_attempt_count INTEGER, upstream_failover_count INTEGER,
			timing_metadata TEXT, error_message TEXT, raw_usage TEXT, pricing_audit TEXT,
			provider_key_id TEXT, provider_key_label TEXT, provider_key_fingerprint TEXT,
			upstream_request_id TEXT, upstream_message_id TEXT, billing_kind TEXT,
			input_image_count INTEGER, output_image_count INTEGER,
			audio_duration_seconds REAL, audio_characters INTEGER,
			request_origin TEXT, response_streamed INTEGER, data_region TEXT,
			is_byok INTEGER, charged_cost_usd REAL, upstream_inference_cost_usd REAL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE public_model_daily_stats (
			stat_date TEXT NOT NULL, model_id TEXT NOT NULL, shard INTEGER NOT NULL,
			request_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
			latency_total_ms INTEGER NOT NULL DEFAULT 0, latency_sample_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL, UNIQUE (stat_date, model_id, shard)
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL, request_log_id TEXT, change_payload TEXT,
			before_user_snapshot TEXT, after_user_snapshot TEXT, changed_fields TEXT,
			correlation_id TEXT, source TEXT, actor_id TEXT, reason_code TEXT,
			reason_text TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0039_guardrail_budget_reservations.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(`
		ALTER TABLE guardrail_budget_windows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal:user-1';
		ALTER TABLE guardrail_budget_reservations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal:user-1';
		ALTER TABLE guardrail_budget_reservations ADD COLUMN settlement_basis TEXT NOT NULL DEFAULT 'charged'
			CHECK (settlement_basis IN ('charged', 'gateway_key_route'));
	`);
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0040_user_budget_reservations.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0041_user_budget_spent_micros.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0056_request_session_id.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0061_provider_attempt_availability.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0062_public_model_total_tokens.sql', import.meta.url,
	).href), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL(
		'../../migrations-d1/0063_generation_service_tier.sql', import.meta.url,
	).href), 'utf8'));
	return database;
}

function insertUser(database: DatabaseSync, id = 'user-1'): void {
	database.prepare(`INSERT INTO users (
		id, budget_max, budget_base, budget_spent, budget_period, budget_reset_at, updated_at
	) VALUES (?, 1, 1, 0, 'monthly', '2026-09-29T00:00:00.000Z', ?)`)
		.run(id, '2026-08-29T00:00:00.000Z');
	database.prepare(`INSERT OR IGNORE INTO api_keys (id, user_id, status)
		VALUES ('key-1', ?, 'active')`).run(id);
}

function requestLog(id: string, chargedCost: number): InsertRequestLogParams {
	return {
		id,
		userId: 'user-1',
		apiKeyId: 'key-1',
		workspaceId: 'personal:user-1',
		userEmail: 'user@example.com',
		modelId: 'openai/test',
		providerId: 'provider-1',
		providerModelName: 'test',
		modelName: 'Test',
		providerName: 'Provider',
		requestBody: null,
		upstreamRequestBody: null,
		requestProtocol: 'openai',
		requestOperation: 'chat.completions',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat.completions',
		inputTokens: 10,
		outputTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 20,
		nativeTokensPrompt: 10,
		nativeTokensCompletion: 10,
		nativeTokensCached: 0,
		nativeTokensReasoning: 0,
		nativeTokensCompletionImages: null,
		meteredCost: chargedCost,
		standardCost: chargedCost,
		chargedCost,
		budgetAccountedAt: '2026-08-29T01:00:00.000Z',
		routeGroup: 'default',
		status: 'success',
		latencyMs: 10,
		errorMessage: null,
		rawUsage: null,
		serviceTier: 'priority',
		finishReason: 'stop',
		nativeFinishReason: 'end_turn',
		httpReferer: 'https://app.example',
		userAgent: 'CinaSDK/1.0',
		providerResponses: [{
			status: 200,
			endpoint_id: 'route-1',
			is_byok: false,
			latency: 7,
			model_permaslug: 'openai/test',
			provider_name: 'Provider',
			routed_service_tier: 'priority',
		}],
		providerAttempts: [{
			attemptIndex: 1,
			routeTargetId: 'route-1',
			providerId: 'provider-1',
			outcome: 'available',
			reason: 'accepted',
			httpStatus: 200,
			observedAtIso: '2026-08-29T01:00:00.000Z',
		}],
	};
}

async function reserveAndDispatch(client: D1DatabaseClient, requestId: string, micros: number): Promise<void> {
	const budgets = createD1Repositories(client).userBudgets;
	assert.equal((await budgets.reserve({
		requestId,
		userId: 'user-1',
		apiKeyId: 'key-1',
		expectedBudgetEpoch: 0,
		reservedMicros: micros,
		nowIso: '2026-08-29T01:00:00.000Z',
		expiresAtIso: '2026-08-29T01:02:00.000Z',
	})).status, 'reserved');
	assert.equal(await budgets.markDispatched(
		requestId,
		'2026-08-29T01:00:01.000Z',
		'2026-08-29T01:10:00.000Z',
	), true);
}

async function writeUsage(
	client: D1DatabaseClient,
	requestId: string,
	chargedCost: number,
	mode: 'actual' | 'reserved',
	shouldChargeBudget = true,
	auditSnapshots: {
		beforeUserSnapshot?: string;
		afterUserSnapshot?: string;
		changedFields?: string;
	} = {},
): Promise<void> {
	await insertRequestUsageAndChargeTxD1(client, {
		requestLog: requestLog(requestId, chargedCost),
		shouldChargeBudget,
		userId: 'user-1',
		beforeSpent: 0,
		chargedCost,
		userBudgetSettlement: { requestId, mode, reason: `test_${mode}` },
		audit: {
			apiKeyId: 'key-1',
			eventType: 'usage_charge',
			actorType: 'system',
			beforeSpent: 0,
			requestLogId: requestId,
			source: 'gateway_usage',
			...auditSnapshots,
		},
	});
}

function account(database: DatabaseSync): {
	budget_spent: number;
	budget_epoch: number;
	budget_reserved_micros: number;
} {
	const row = database.prepare(`SELECT budget_spent, budget_epoch, budget_reserved_micros
		FROM users WHERE id = 'user-1'`).get() as {
		budget_spent: number;
		budget_epoch: number;
		budget_reserved_micros: number;
	};
	return { ...row };
}

function reservation(database: DatabaseSync, requestId: string): {
	state: string;
	settled_micros: number;
} {
	const row = database.prepare(`SELECT state, settled_micros FROM user_budget_reservations
		WHERE request_id = ?`).get(requestId) as { state: string; settled_micros: number };
	return { ...row };
}

test('D1 critical write atomically settles actual usage and replays without duplicate side effects', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		await reserveAndDispatch(client, 'request-actual', 400_000);
		await writeUsage(client, 'request-actual', 0.25, 'actual');

		assert.deepEqual(account(database), {
			budget_spent: 0.25,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.deepEqual(reservation(database, 'request-actual'), {
			state: 'settled',
			settled_micros: 250_000,
		});
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT SUM(request_count) AS count FROM public_model_daily_stats').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 1);
		assert.deepEqual({ ...database.prepare(`SELECT service_tier, finish_reason, native_finish_reason,
			http_referer, user_agent, native_tokens_prompt, native_tokens_completion,
			native_tokens_cached, native_tokens_reasoning, native_tokens_completion_images,
			provider_responses
			FROM api_key_request_logs WHERE id = 'request-actual'`).get() }, {
			service_tier: 'priority',
			finish_reason: 'stop',
			native_finish_reason: 'end_turn',
			http_referer: 'https://app.example',
			user_agent: 'CinaSDK/1.0',
			native_tokens_prompt: 10,
			native_tokens_completion: 10,
			native_tokens_cached: 0,
			native_tokens_reasoning: 0,
			native_tokens_completion_images: null,
			provider_responses: JSON.stringify(requestLog('request-actual', 0.25).providerResponses),
		});
		assert.deepEqual({ ...database.prepare(`SELECT route_target_id, outcome, reason, http_status
			FROM provider_attempt_availability WHERE request_log_id = 'request-actual'`).get() }, {
			route_target_id: 'route-1',
			outcome: 'available',
			reason: 'accepted',
			http_status: 200,
		});

		await writeUsage(client, 'request-actual', 0.25, 'actual');
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT SUM(request_count) AS count FROM public_model_daily_stats').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 1);
		assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count
			FROM provider_attempt_availability WHERE request_log_id = 'request-actual'`).get()?.count), 1);
	} finally {
		database.close();
	}
});

test('D1 critical write charges the reserved ceiling when dispatched usage is unknowable', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		await reserveAndDispatch(client, 'request-unknown', 400_000);
		await writeUsage(client, 'request-unknown', 0, 'reserved', false);
		assert.equal(account(database).budget_spent, 0.4);
		assert.deepEqual(reservation(database, 'request-unknown'), {
			state: 'expired',
			settled_micros: 400_000,
		});
		assert.equal(Number(database.prepare(`SELECT budget_charged_micros
			FROM api_key_request_logs WHERE id = 'request-unknown'`).get()?.budget_charged_micros), 0);
	} finally {
		database.close();
	}
});

test('D1 late actual reconciles a forfeited ceiling while old-epoch settlement cannot debit a reset period', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		const budgets = createD1Repositories(client).userBudgets;
		await reserveAndDispatch(client, 'request-late', 400_000);
		assert.equal(await budgets.forfeitDispatched(
			'request-late', '2026-08-29T01:03:00.000Z', 'recovery_forfeit',
		), 1);
		assert.equal(account(database).budget_spent, 0.4);
		await writeUsage(client, 'request-late', 0.25, 'actual');
		assert.equal(account(database).budget_spent, 0.25);
		assert.deepEqual(reservation(database, 'request-late'), {
			state: 'expired',
			settled_micros: 250_000,
		});

		await reserveAndDispatch(client, 'request-old-epoch', 300_000);
		database.prepare(`UPDATE users SET budget_epoch = budget_epoch + 1,
			budget_reserved_micros = 0, budget_spent = 0 WHERE id = 'user-1'`).run();
		await writeUsage(client, 'request-old-epoch', 0.2, 'actual', true, {
			beforeUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 0 }),
			afterUserSnapshot: JSON.stringify({ budget_epoch: 0, budget_spent: 0.2 }),
			changedFields: JSON.stringify(['budget_spent']),
		});
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
		assert.deepEqual({ ...database.prepare(`SELECT before_user_snapshot, after_user_snapshot, changed_fields
			FROM user_audit_logs WHERE request_log_id = 'request-old-epoch'`).get() }, {
			before_user_snapshot: null,
			after_user_snapshot: null,
			changed_fields: null,
		});
	} finally {
		database.close();
	}
});

test('D1 actual settlement retries only once when expiry wins between reservation read and batch', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const hooks: D1TestHooks = {};
		const client = createD1Client(database, hooks);
		await reserveAndDispatch(client, 'request-expiry-race', 400_000);
		hooks.beforeNextBatch = () => {
			database.prepare(`UPDATE user_budget_reservations
				SET state = 'expired', settled_micros = reserved_micros,
					terminal_at = ?, terminal_reason = 'test_concurrent_expiry', updated_at = ?
				WHERE request_id = ? AND state = 'dispatched'`)
				.run(
					'2026-08-29T01:03:00.000Z',
					'2026-08-29T01:03:00.000Z',
					'request-expiry-race',
				);
		};

		await writeUsage(client, 'request-expiry-race', 0.25, 'actual');

		assert.deepEqual(account(database), {
			budget_spent: 0.25,
			budget_epoch: 0,
			budget_reserved_micros: 0,
		});
		assert.deepEqual(reservation(database, 'request-expiry-race'), {
			state: 'expired',
			settled_micros: 250_000,
		});
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT SUM(request_count) AS count FROM public_model_daily_stats').get()?.count), 1);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 1);
	} finally {
		database.close();
	}
});

test('D1 lazy reset CAS bumps epoch, clears reservations, and writes one audit row atomically', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		await reserveAndDispatch(client, 'request-reset', 400_000);
		const params = {
			userId: 'user-1',
			expectedBudgetMax: 1,
			expectedBudgetBase: 1,
			expectedBudgetSpent: 0,
			expectedBudgetPeriod: 'monthly',
			expectedBudgetResetAt: '2026-09-29T00:00:00.000Z',
			expectedBudgetEpoch: 0,
			expectedBudgetReservedMicros: 400_000,
			budgetSpent: 0,
			budgetResetAt: '2026-10-29T00:00:00.000Z',
			apiKeyId: 'key-1',
			audit: {
				eventType: 'period_reset' as const,
				actorType: 'system' as const,
				beforeSpent: 0,
				deltaSpent: 0,
				source: 'gateway_auth',
			},
		};
		// A concurrent plan edit that does not bump epoch/reset_at must still
		// invalidate the full calculation snapshot and preserve the new value.
		database.prepare(`UPDATE users SET budget_base = 2 WHERE id = 'user-1'`).run();
		assert.equal(await updateUserBudgetWithAuditTxD1(client, params), false);
		assert.equal(Number(database.prepare(`SELECT budget_base FROM users WHERE id = 'user-1'`).get()?.budget_base), 2);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 0);
		database.prepare(`UPDATE users SET budget_base = 1 WHERE id = 'user-1'`).run();
		assert.equal(await updateUserBudgetWithAuditTxD1(client, params), true);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
		assert.equal(await updateUserBudgetWithAuditTxD1(client, params), false);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 1);
	} finally {
		database.close();
	}
});

test('D1 critical write fails closed on unsafe costs and reservation identity mismatch', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		await reserveAndDispatch(client, 'request-invalid', 400_000);
		await assert.rejects(
			writeUsage(client, 'request-invalid', Number.NaN, 'actual'),
			/finite non-negative/,
		);
		await assert.rejects(
			writeUsage(client, 'request-invalid', Number.MAX_VALUE, 'actual'),
			/safe ordinary-user micro-unit range/,
		);
		const invalidTier = requestLog('request-invalid-tier', 0.25);
		invalidTier.serviceTier = 'untrusted' as InsertRequestLogParams['serviceTier'];
		await assert.rejects(
			insertRequestUsageAndChargeTxD1(client, {
				requestLog: invalidTier,
				shouldChargeBudget: false,
				userId: 'user-1',
				beforeSpent: 0,
				chargedCost: 0.25,
				audit: {
					apiKeyId: 'key-1', eventType: 'usage_charge', actorType: 'system',
					beforeSpent: 0, requestLogId: 'request-invalid-tier', source: 'gateway_usage',
				},
			}),
			/Generation service tier is invalid/,
		);
		for (const [requestId, mutate, expected] of [
			[
				'request-invalid-finish',
				(log: InsertRequestLogParams) => { log.finishReason = 'unknown' as InsertRequestLogParams['finishReason']; },
				/Generation finish reason is invalid/,
			],
			[
				'request-invalid-native-finish',
				(log: InsertRequestLogParams) => { log.nativeFinishReason = 'bad\nreason'; },
				/Generation native finish reason is invalid/,
			],
			[
				'request-invalid-http-referer',
				(log: InsertRequestLogParams) => { log.httpReferer = 'https://app.example/private'; },
				/Generation HTTP referer must be a canonical/,
			],
			[
				'request-invalid-user-agent',
				(log: InsertRequestLogParams) => { log.userAgent = 'bad\nagent'; },
				/Generation User-Agent is invalid/,
			],
			[
				'request-invalid-native-token',
				(log: InsertRequestLogParams) => { log.nativeTokensPrompt = -1; },
				/Generation native prompt tokens must be a safe non-negative integer or null/,
			],
			[
				'request-invalid-provider-response',
				(log: InsertRequestLogParams) => {
					log.providerResponses = [{ status: 200, provider_key: 'secret' } as never];
				},
				/Generation provider response contains an unsupported field/,
			],
		] as const) {
			const invalid = requestLog(requestId, 0.25);
			mutate(invalid);
			await assert.rejects(
				insertRequestUsageAndChargeTxD1(client, {
					requestLog: invalid,
					shouldChargeBudget: false,
					userId: 'user-1',
					beforeSpent: 0,
					chargedCost: 0.25,
					audit: {
						apiKeyId: 'key-1', eventType: 'usage_charge', actorType: 'system',
						beforeSpent: 0, requestLogId: requestId, source: 'gateway_usage',
					},
				}),
				expected,
			);
		}
		const mismatched = requestLog('request-invalid', 0.25);
		mismatched.apiKeyId = 'key-other';
		await assert.rejects(
			insertRequestUsageAndChargeTxD1(client, {
				requestLog: mismatched,
				shouldChargeBudget: true,
				userId: 'user-1',
				beforeSpent: 0,
				chargedCost: 0.25,
				userBudgetSettlement: {
					requestId: 'request-invalid',
					mode: 'actual',
					reason: 'identity_mismatch',
				},
				audit: {
					apiKeyId: 'key-other',
					eventType: 'usage_charge',
					actorType: 'system',
					beforeSpent: 0,
					requestLogId: 'request-invalid',
					source: 'gateway_usage',
				},
			}),
			/identity mismatch/,
		);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 0,
			budget_reserved_micros: 400_000,
		});
		assert.deepEqual(reservation(database, 'request-invalid'), {
			state: 'dispatched',
			settled_micros: 0,
		});
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM api_key_request_logs').get()?.count), 0);
	} finally {
		database.close();
	}
});

test('D1 direct plan updates bump epoch only when spent is reset or overridden', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const repos = createD1Repositories(createD1Client(database));
		assert.equal((await repos.userBudgets.reserve({
			requestId: 'request-plan',
			userId: 'user-1',
			apiKeyId: 'key-1',
			expectedBudgetEpoch: 0,
			reservedMicros: 400_000,
			nowIso: '2026-08-29T01:00:00.000Z',
			expiresAtIso: '2026-08-29T01:10:00.000Z',
		})).status, 'reserved');
		assert.equal(await repos.users.updateUserPlan(
			'user-1', 2, 'monthly', '2026-09-29T00:00:00.000Z', false,
		), true);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 0,
			budget_reserved_micros: 400_000,
		});
		assert.equal(await repos.users.updateUserPlan(
			'user-1', 2, 'monthly', '2026-09-29T00:00:00.000Z', true,
		), true);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
	} finally {
		database.close();
	}
});

test('D1 admin transition uses a full budget-input CAS and resets the generation atomically', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		const repos = createD1Repositories(client);
		assert.equal((await repos.userBudgets.reserve({
			requestId: 'request-transition',
			userId: 'user-1',
			apiKeyId: 'key-1',
			expectedBudgetEpoch: 0,
			reservedMicros: 400_000,
			nowIso: '2026-08-29T01:00:00.000Z',
			expiresAtIso: '2026-08-29T01:10:00.000Z',
		})).status, 'reserved');
		const params = {
			userId: 'user-1',
			expectedBudgetMax: 1,
			expectedBudgetBase: 1,
			expectedBudgetEpoch: 0,
			expectedBudgetReservedMicros: 400_000,
			expectedBudgetSpent: 0,
			expectedBudgetPeriod: 'monthly',
			expectedBudgetResetAt: '2026-09-29T00:00:00.000Z',
			budgetMax: 2,
			budgetBase: 2,
			budgetSpent: 0,
			budgetPeriod: 'monthly',
			budgetResetAt: '2026-09-29T00:00:00.000Z',
			resetEpoch: true,
			audit: {
				id: crypto.randomUUID(),
				userId: 'user-1',
				apiKeyId: null,
				eventType: 'admin_adjust' as const,
				actorType: 'admin' as const,
				actorId: 'master_key',
				reasonCode: 'budget_transition',
				reasonText: 'test transition',
				source: 'admin_budget_transition',
			},
		};
		database.prepare(`UPDATE users SET budget_period = 'weekly' WHERE id = 'user-1'`).run();
		assert.equal(await applyUserBudgetTransitionWithAuditD1(client, params), false);
		assert.equal(database.prepare(`SELECT budget_period FROM users WHERE id = 'user-1'`).get()?.budget_period, 'weekly');
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 0);
		database.prepare(`UPDATE users SET budget_period = 'monthly' WHERE id = 'user-1'`).run();
		assert.equal(await applyUserBudgetTransitionWithAuditD1(client, {
			...params,
			expectedBudgetReservedMicros: 399_999,
		}), false);
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 0);
		assert.equal(await applyUserBudgetTransitionWithAuditD1(client, params), true);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 1);
	} finally {
		database.close();
	}
});

test('D1 admin non-reset transition persists a due lazy reset before preserving the new epoch', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		const repos = createD1Repositories(client);
		await reserveAndDispatch(client, 'request-due-transition', 400_000);
		database.prepare(`UPDATE users SET budget_spent = 0.2,
			budget_reset_at = '2000-01-01T00:00:00.000Z' WHERE id = 'user-1'`).run();

		const result = await applyBudgetTransition(repos, 'user-1', {
			target_budget_base: 1,
			budget_period: 'monthly',
			carryover_strategy: 'none',
			reset_spent: false,
		});
		assert.ok(result);
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
		assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM user_audit_logs').get()?.count), 2);
		const lazyAudit = database.prepare(`SELECT after_user_snapshot, changed_fields
			FROM user_audit_logs WHERE event_type = 'period_reset'`).get() as {
			after_user_snapshot: string;
			changed_fields: string;
		};
		const lazyAfter = JSON.parse(lazyAudit.after_user_snapshot) as Record<string, unknown>;
		const lazyChanged = JSON.parse(lazyAudit.changed_fields) as string[];
		assert.equal(lazyAfter.budget_epoch, 1);
		assert.equal(lazyAfter.budget_reserved_micros, 0);
		assert.ok(lazyChanged.includes('budget_epoch'));
		assert.ok(lazyChanged.includes('budget_reserved_micros'));

		await writeUsage(client, 'request-due-transition', 0.25, 'actual');
		assert.deepEqual(account(database), {
			budget_spent: 0,
			budget_epoch: 1,
			budget_reserved_micros: 0,
		});
	} finally {
		database.close();
	}
});

test('D1 non-reset transition preserves authoritative micros above the REAL one-micro range', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const startingMicros = 8_589_934_592_000_001;
		database.prepare(`UPDATE users SET budget_max = ?, budget_base = ?,
			budget_spent = ?, budget_spent_micros = ? WHERE id = 'user-1'`)
			.run(
				Number.MAX_SAFE_INTEGER / 1_000_000,
				Number.MAX_SAFE_INTEGER / 1_000_000,
				startingMicros / 1_000_000,
				startingMicros,
			);
		const client = createD1Client(database);
		const repos = createD1Repositories(client);
		const before = await repos.users.getById('user-1');
		assert.ok(before);

		assert.equal(await applyUserBudgetTransitionWithAuditD1(client, {
			userId: 'user-1',
			expectedBudgetMax: before.budget_max,
			expectedBudgetBase: before.budget_base,
			expectedBudgetEpoch: before.budget_epoch,
			expectedBudgetReservedMicros: before.budget_reserved_micros,
			expectedBudgetSpent: before.budget_spent,
			expectedBudgetPeriod: before.budget_period,
			expectedBudgetResetAt: before.budget_reset_at,
			budgetMax: before.budget_max,
			budgetBase: before.budget_base,
			budgetSpent: before.budget_spent,
			budgetPeriod: before.budget_period,
			budgetResetAt: before.budget_reset_at,
			resetEpoch: false,
			audit: {
				id: crypto.randomUUID(),
				userId: 'user-1',
				apiKeyId: null,
				eventType: 'admin_adjust',
				actorType: 'admin',
				actorId: 'master_key',
				reasonCode: 'budget_transition',
				reasonText: 'preserve exact large spend',
				source: 'admin_budget_transition',
			},
		}), true);
		assert.equal(
			Number(database.prepare(`SELECT budget_spent_micros FROM users
				WHERE id = 'user-1'`).get()?.budget_spent_micros),
			startingMicros,
		);
	} finally {
		database.close();
	}
});

test('D1 request transaction settles ordinary and Guardrail reservations together', async () => {
	const database = setupDatabase();
	try {
		insertUser(database);
		const client = createD1Client(database);
		const repos = createD1Repositories(client);
		await reserveAndDispatch(client, 'request-combined', 400_000);
		const intent: GuardrailBudgetIntent = {
			workspaceId: 'personal:user-1',
			assignmentId: 'assignment-combined',
			guardrailId: 'guardrail-combined',
			guardrailVersion: 1,
			scopeType: 'user',
			scopeId: 'user-1',
			period: 'daily',
			periodStart: '2026-08-29T00:00:00.000Z',
			periodEnd: '2026-08-30T00:00:00.000Z',
			limitMicros: 1_000_000,
		};
		assert.deepEqual(await repos.guardrailBudgets.reserveMany({
			requestId: 'request-combined',
			intents: [intent],
			reservedMicros: 400_000,
			nowIso: '2026-08-29T01:00:00.000Z',
			expiresAtIso: '2026-08-29T01:10:00.000Z',
		}), { status: 'reserved', reservationCount: 1 });
		assert.equal(await repos.guardrailBudgets.markDispatched(
			'request-combined',
			'2026-08-29T01:00:01.000Z',
			'2026-08-29T01:10:00.000Z',
		), true);
		await insertRequestUsageAndChargeTxD1(client, {
			requestLog: requestLog('request-combined', 0.25),
			shouldChargeBudget: true,
			userId: 'user-1',
			beforeSpent: 0,
			chargedCost: 0.25,
			userBudgetSettlement: {
				requestId: 'request-combined',
				mode: 'actual',
				reason: 'combined_actual',
			},
			guardrailBudgetSettlement: {
				requestId: 'request-combined',
				mode: 'actual',
				reason: 'combined_actual',
			},
			audit: {
				apiKeyId: 'key-1',
				eventType: 'usage_charge',
				actorType: 'system',
				beforeSpent: 0,
				requestLogId: 'request-combined',
				source: 'gateway_usage',
			},
		});
		assert.equal(account(database).budget_spent, 0.25);
		assert.deepEqual(reservation(database, 'request-combined'), {
			state: 'settled',
			settled_micros: 250_000,
		});
		assert.deepEqual({ ...database.prepare(`SELECT state, settled_micros
			FROM guardrail_budget_reservations WHERE request_id = 'request-combined'`).get() }, {
			state: 'settled',
			settled_micros: 250_000,
		});
		assert.deepEqual({ ...database.prepare(`SELECT reserved_micros, settled_micros
			FROM guardrail_budget_windows WHERE scope_type = 'user' AND scope_id = 'user-1'`).get() }, {
			reserved_micros: 0,
			settled_micros: 250_000,
		});
	} finally {
		database.close();
	}
});

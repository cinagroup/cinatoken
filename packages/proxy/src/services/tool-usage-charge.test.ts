import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import {
	canAffordToolCost,
	chargeToolUsage,
	reserveToolOrdinaryBudget,
	toolFailureSettlement,
	toolUserBudgetSettlement,
} from './tool-usage-charge';

describe('fixed tool failure certainty', () => {
	it('keeps the reservation ceiling for provider-shaped errors without explicit zero evidence', () => {
		assert.deepEqual(
			toolFailureSettlement({
				name: 'WebSearchProviderError',
				status: 502,
				upstreamOutcome: 'unknown',
			}),
			{ mode: 'reserved', reason: 'tool_upstream_result_unknown' },
		);
		assert.deepEqual(
			toolFailureSettlement(new Error('2xx response could not be parsed')),
			{ mode: 'reserved', reason: 'tool_upstream_result_unknown' },
		);
	});

	it('releases the ceiling only for explicit known-zero or local evidence', () => {
		const expected = { mode: 'actual', reason: 'tool_upstream_error_settled' } as const;
		assert.deepEqual(toolFailureSettlement({ upstreamOutcome: 'known_zero' }), expected);
		assert.deepEqual(toolFailureSettlement(new Error('local validation'), {
			knownLocalFailure: true,
		}), expected);
	});
});

type CapturedStatement = { sql: string; values: unknown[] };

function repositoriesWithD1Capture(batches: CapturedStatement[][]): GatewayRepositories {
	class Statement {
		constructor(readonly sql: string, readonly values: unknown[] = []) {}
		bind(...values: unknown[]): Statement {
			return new Statement(this.sql, values);
		}
		async first<T>(): Promise<T | null> {
			if (this.sql.includes('SELECT budget_spent_micros')) {
				return { budget_spent_micros: 1_250_000 } as T;
			}
			if (this.sql.includes('FROM user_budget_reservations')) {
				return {
					request_id: String(this.values[0] ?? 'tool-request'),
					user_id: 'user-1',
					api_key_id: 'key-1',
					budget_epoch: 7,
					reserved_micros: 250_000,
					settled_micros: 0,
					state: 'dispatched',
				} as T;
			}
			if (this.sql.includes('FROM api_key_request_logs')) return null;
			return { present: 1 } as T;
		}
	}
	const raw = {
		prepare(sql: string): Statement {
			return new Statement(sql);
		},
		async batch(statements: Statement[]): Promise<Array<{ success: true; results: []; meta: { changes: number } }>> {
			batches.push(statements.map(({ sql, values }) => ({ sql, values })));
			return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
		},
	};
	const drizzle = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{
						budgetSpent: '1.25', budgetSpentMicros: 1_250_000,
						budgetMax: '10', budgetPeriod: 'monthly', budgetResetAt: null,
					}],
				}),
			}),
		}),
	};
	return {
		client: { driver: 'd1', raw, drizzle },
		users: { getById: async () => null },
	} as unknown as GatewayRepositories;
}

function requestInsert(batch: CapturedStatement[]): CapturedStatement {
	const statement = batch.find(({ sql }) => sql.includes('INSERT INTO api_key_request_logs'));
	assert.ok(statement);
	return statement;
}

function columnValue(statement: CapturedStatement, column: string): unknown {
	const columns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(statement.sql)![1]!
		.split(',')
		.map((value) => value.trim());
	return statement.values[columns.indexOf(column)];
}

describe('fixed tool usage Guardrail settlement', () => {
	it('atomically writes the fixed request identity, charge, accounting instant, and settlement', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'tool-request-success';
		const accountedAt = '2026-08-29T23:59:59.999Z';
		const result = await chargeToolUsage({
			repos: repositoriesWithD1Capture(batches),
			requestLogId: requestId,
			budgetAccountedAt: accountedAt,
			guardrailBudgetSettlement: {
				requestId, mode: 'actual', reason: 'tool_request_usage_settled',
			},
			apiKeyId: 'key-1', userId: 'user-1', userEmail: 'user@example.com',
			toolId: 'tool:web-search', toolProvider: 'bocha',
			meteredCost: 0.1, standardCost: 0.2, chargedCost: 0.25,
			latencyMs: 10, status: 'success',
		});

		assert.deepEqual(result, { requestLogId: requestId, chargedCost: 0.25 });
		assert.equal(batches.length, 1);
		const insert = requestInsert(batches[0]!);
		assert.equal(columnValue(insert, 'id'), requestId);
		assert.equal(columnValue(insert, 'budget_accounted_at'), accountedAt);
		assert.equal(columnValue(insert, 'budget_charged_micros'), 250_000);
		const settlement = batches[0]!.find(({ sql }) => sql.includes("SET state = 'settled'"));
		assert.ok(settlement);
		assert.ok(settlement.values.includes(requestId));
		assert.ok(settlement.values.includes(250_000));
	});

	it('settles a confirmed provider error at actual zero without debiting the user', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'tool-request-error';
		await chargeToolUsage({
			repos: repositoriesWithD1Capture(batches),
			requestLogId: requestId,
			budgetAccountedAt: '2026-08-29T01:00:00.000Z',
			guardrailBudgetSettlement: {
				requestId, mode: 'actual', reason: 'tool_upstream_error_settled',
			},
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			toolId: 'tool:web-fetch', toolProvider: 'jina',
			meteredCost: 9, standardCost: 9, chargedCost: 9,
			latencyMs: 8, status: 'error', errorMessage: 'HTTP 400',
		});

		assert.equal(batches.length, 1);
		const insert = requestInsert(batches[0]!);
		assert.equal(columnValue(insert, 'charged_cost'), 0);
		assert.equal(columnValue(insert, 'budget_charged_micros'), 0);
		assert.equal(batches[0]!.some(({ sql }) => sql.includes('UPDATE users SET budget_spent')), false);
		const settlement = batches[0]!.find(({ sql }) => sql.includes("SET state = 'settled'"));
		assert.ok(settlement);
		assert.ok(settlement.values.includes(requestId));
		assert.ok(settlement.values.includes(0));
	});

	it('records an output-Guardrail failure as an error while charging known upstream cost', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'tool-request-output-blocked';
		const result = await chargeToolUsage({
			repos: repositoriesWithD1Capture(batches),
			requestLogId: requestId,
			budgetAccountedAt: '2026-08-29T02:00:00.000Z',
			guardrailBudgetSettlement: {
				requestId, mode: 'actual', reason: 'tool_request_usage_settled',
			},
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			toolId: 'tool:web-deep-search', toolProvider: 'jina',
			meteredCost: 0.2, standardCost: 0.3, chargedCost: 0.4,
			latencyMs: 8, status: 'error', chargeOnError: true,
			errorMessage: 'Response blocked by output guardrail',
		});

		assert.equal(result.chargedCost, 0.4);
		const insert = requestInsert(batches[0]!);
		assert.equal(columnValue(insert, 'status'), 'error');
		assert.equal(columnValue(insert, 'charged_cost'), 0.4);
		assert.equal(columnValue(insert, 'budget_charged_micros'), 400_000);
		const settlement = batches[0]!.find(({ sql }) => sql.includes("SET state = 'settled'"));
		assert.ok(settlement);
		assert.ok(settlement.values.includes(400_000));
	});
});

describe('fixed tool affordability validation', () => {
	it('fails closed for non-finite and negative accounting inputs', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
			assert.equal(canAffordToolCost(10, 1, value), false);
			assert.equal(canAffordToolCost(10, value, 1), false);
			assert.equal(canAffordToolCost(value, 1, 1), false);
		}
	});

	it('validates costs even when the user budget is unlimited', () => {
		assert.equal(canAffordToolCost(null, 0, 1), true);
		assert.equal(canAffordToolCost(null, 0, Number.NaN), false);
		assert.equal(canAffordToolCost(null, -1, 1), false);
	});

	it('accepts the exact finite boundary and rejects an overrun', () => {
		assert.equal(canAffordToolCost(1, 0.75, 0.25), true);
		assert.equal(canAffordToolCost(1, 0.75, 0.250001), false);
	});
});

describe('fixed tool ordinary-budget lifecycle', () => {
	it('reserves the exact validated charged cost and rejects invalid prices for unlimited users', async () => {
		let captured: { reservedMicros: number; expectedBudgetEpoch: number } | null = null;
		const repos = {
			userBudgets: {
				expireBefore: async () => 0,
				reserve: async (params: { reservedMicros: number; expectedBudgetEpoch: number }) => {
					captured = params;
					return {
						status: 'reserved' as const,
						reservation: {
							requestId: 'tool-request-reserve', userId: 'user-1', apiKeyId: 'key-1',
							budgetEpoch: 7, limitMicros: 1_000_000, reservedMicros: params.reservedMicros,
						},
					};
				},
			},
		} as unknown as GatewayRepositories;
		const result = await reserveToolOrdinaryBudget(repos, {
			requestId: 'tool-request-reserve', userId: 'user-1', apiKeyId: 'key-1',
			budgetMax: 1, budgetEpoch: 7, chargedCost: 0.25,
			now: new Date('2026-08-29T00:00:00.000Z'),
		});
		assert.equal(result.ok, true);
		assert.ok(captured);
		assert.equal(captured.reservedMicros, 250_000);
		assert.equal(captured.expectedBudgetEpoch, 7);

		const invalid = await reserveToolOrdinaryBudget({} as GatewayRepositories, {
			requestId: 'tool-invalid', userId: 'user-1', apiKeyId: 'key-1',
			budgetMax: null, budgetEpoch: 7, chargedCost: Number.NaN, now: new Date(),
		});
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.equal(invalid.error.code, 'estimate_non_finite');
	});

	it('atomically settles known actual cost and unknown reserved ceiling with the request id', async () => {
		const batches: CapturedStatement[][] = [];
		const base = {
			repos: repositoriesWithD1Capture(batches),
			budgetAccountedAt: '2026-08-29T00:00:00.000Z',
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			toolId: 'tool:web-search', toolProvider: 'bocha', latencyMs: 10,
		};
		await chargeToolUsage({
			...base,
			requestLogId: 'tool-actual',
			userBudgetSettlement: {
				requestId: 'tool-actual', mode: 'actual', reason: 'tool_request_usage_settled',
				budgetEpoch: 7, reservedMicros: 250_000,
			},
			meteredCost: 0.1, standardCost: 0.2, chargedCost: 0.25,
			status: 'success',
		});
		const actualTransition = batches[0]!.find(({ sql }) => sql.includes('UPDATE user_budget_reservations'));
		assert.ok(actualTransition);
		assert.ok(actualTransition.values.includes('settled'));
		assert.ok(actualTransition.values.includes(250_000));
		assert.ok(actualTransition.values.includes('tool-actual'));

		await chargeToolUsage({
			...base,
			requestLogId: 'tool-known-error',
			userBudgetSettlement: {
				requestId: 'tool-known-error', mode: 'actual', reason: 'tool_provider_error',
				budgetEpoch: 7, reservedMicros: 250_000,
			},
			meteredCost: 0, standardCost: 0, chargedCost: 0,
			status: 'error',
		});
		const knownErrorTransition = batches[1]!.find(({ sql }) => sql.includes('UPDATE user_budget_reservations'));
		assert.ok(knownErrorTransition);
		assert.ok(knownErrorTransition.values.includes('settled'));
		assert.ok(knownErrorTransition.values.includes(0));
		assert.ok(knownErrorTransition.values.includes('tool-known-error'));

		await chargeToolUsage({
			...base,
			requestLogId: 'tool-unknown',
			userBudgetSettlement: {
				requestId: 'tool-unknown', mode: 'reserved', reason: 'tool_upstream_result_unknown',
				budgetEpoch: 7, reservedMicros: 250_000,
			},
			meteredCost: 0, standardCost: 0, chargedCost: 0,
			status: 'error',
		});
		const unknownTransition = batches[2]!.find(({ sql }) => sql.includes('UPDATE user_budget_reservations'));
		assert.ok(unknownTransition);
		assert.ok(unknownTransition.values.includes('expired'));
		assert.ok(unknownTransition.values.includes(250_000));
		assert.ok(unknownTransition.values.includes('tool-unknown'));
	});

	it('builds settlement metadata only for a real ordinary reservation', async () => {
		const unlimited = await reserveToolOrdinaryBudget({} as GatewayRepositories, {
			requestId: 'tool-unlimited', userId: 'user-1', apiKeyId: 'key-1',
			budgetMax: null, budgetEpoch: 7, chargedCost: 0.25, now: new Date(),
		});
		assert.equal(unlimited.ok, true);
		if (!unlimited.ok) return;
		assert.equal(toolUserBudgetSettlement(unlimited.lease, 'actual', 'settled'), undefined);
	});
});

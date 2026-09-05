import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, VerifiedModelEndpointSnapshot } from '@octafuse/core';
import { EMPTY_USAGE } from './proxy';
import { recordUsage } from './usage-tracker';

type CapturedStatement = { sql: string; values: unknown[] };

function textEndpoint(): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-text-byok',
		modelId: 'openai/model',
		providerId: 'provider-1',
		providerSlug: 'openai',
		selectorSlug: 'openai',
		endpointClass: 'standard',
		region: null,
		contextLength: 128_000,
		maxPromptTokens: null,
		maxCompletionTokens: 8_192,
		quantization: null,
		supportedParameters: [],
		pricing: {
			currency: 'USD',
			prompt: '0.000001',
			completion: '0.000002',
		},
		capabilities: {
			implicit_caching: null,
			voice_cloning: null,
			tool_choice: { auto: true, function: true, none: true, required: true },
		},
		imageCapabilities: null,
		evidenceUrl: 'https://evidence.example/endpoint-text-byok',
		verifiedBy: 'auditor-1',
		verifiedAt: '2026-09-03T00:00:00.000Z',
		expiresAt: '2027-09-03T00:00:00.000Z',
	};
}

function captureD1Repositories(batches: CapturedStatement[][]): GatewayRepositories {
	class Statement {
		constructor(readonly sql: string, readonly values: unknown[] = []) {}
		bind(...values: unknown[]): Statement { return new Statement(this.sql, values); }
		async first<T>(): Promise<T | null> {
			if (this.sql.includes('FROM api_key_request_logs')) return null;
			if (this.sql.includes('SELECT budget_spent_micros')) {
				return { budget_spent_micros: 1_000_000 } as T;
			}
			if (this.sql.includes('FROM user_budget_reservations')) {
				return {
					request_id: this.values[0],
					user_id: 'user-1',
					api_key_id: 'key-1',
					budget_epoch: 7,
					reserved_micros: 2_000,
					settled_micros: 0,
					state: 'dispatched',
				} as T;
			}
			return { present: 1 } as T;
		}
		async all<T>(): Promise<{ results: T[] }> {
			return { results: [{
				assignment_id: 'gateway-key-limit:key-1',
				scope_type: 'api_key',
				scope_id: 'key-1',
				settlement_basis: 'gateway_key_route',
			} as T] };
		}
	}
	const raw = {
		prepare(sql: string): Statement { return new Statement(sql); },
		async batch(statements: Statement[]) {
			batches.push(statements.map(({ sql, values }) => ({ sql, values })));
			return statements.map(() => ({ success: true as const, results: [], meta: { changes: 1 } }));
		},
	};
	const drizzle = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{
						budgetSpentMicros: 1_000_000,
						budgetMax: '10',
						budgetPeriod: 'monthly',
						budgetResetAt: null,
					}],
				}),
			}),
		}),
	};
	return {
		client: { driver: 'd1', raw, drizzle },
		systemConfig: { getConfig: async () => null },
		users: { getById: async () => null },
	} as unknown as GatewayRepositories;
}

function findRequestLogInsert(batch: CapturedStatement[]): CapturedStatement {
	const statement = batch.find(({ sql }) => sql.includes('INSERT INTO api_key_request_logs'));
	assert.ok(statement);
	return statement;
}

function requestLogColumn(statement: CapturedStatement, name: string): unknown {
	const columns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(statement.sql)![1]!
		.split(',')
		.map((column) => column.trim());
	return statement.values[columns.indexOf(name)];
}

describe('text private BYOK settlement', () => {
	it('records list-price equivalence while preserving an unknown route-inclusive key ceiling', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'text-private-byok';
		await recordUsage(captureD1Repositories(batches), {
			request_log_id: requestId,
			api_key_id: 'key-1',
			workspace_id: 'workspace-1',
			user_id: 'user-1',
			user_email: null,
			model_id: 'openai/model',
			provider_id: 'provider-1',
			request_origin: 'https://cinatoken.com',
			response_streamed: false,
			request_protocol: 'openai',
			request_operation: 'chat',
			upstream_protocol: 'openai',
			upstream_operation: 'chat',
			route_target_id: 'target-text-byok',
			route_group: 'default',
			status: 'success',
			usage: {
				...EMPTY_USAGE,
				input_tokens: 1_000,
				output_tokens: 100,
				total_tokens: 1_100,
				raw_usage: '{}',
			},
			endpoint_pricing_snapshot: textEndpoint(),
			provider_key_id: 'byok:text-1',
			guardrail_budget_settlement: { requestId, unknownCost: true },
			ordinary_budget_settlement: {
				requestId,
				budgetEpoch: 7,
				reservedMicros: 2_000,
				unknownCost: true,
			},
		});

		assert.equal(batches.length, 1);
		const insert = findRequestLogInsert(batches[0]!);
		assert.equal(requestLogColumn(insert, 'metered_cost'), 0);
		assert.equal(requestLogColumn(insert, 'standard_cost'), 0.0012);
		assert.equal(requestLogColumn(insert, 'charged_cost'), 0);
		assert.equal(requestLogColumn(insert, 'is_byok'), 1);
		assert.equal(requestLogColumn(insert, 'charged_cost_usd'), 0);
		assert.equal(requestLogColumn(insert, 'upstream_inference_cost_usd'), 0);
		const audit = JSON.parse(String(requestLogColumn(insert, 'pricing_audit'))) as {
			byok?: Record<string, unknown>;
		};
		assert.equal(audit.byok?.policy, 'fee_waived_until_entitlement_v1');
		assert.equal(audit.byok?.standard_equivalent_cost_usd, 0.0012);
		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.equal(ordinaryTransition?.values[0], 'settled');
		assert.equal(ordinaryTransition?.values[1], 0);
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
		assert.equal(
			batches[0]!.some(({ sql }) => sql.includes('UPDATE users SET budget_spent')),
			false,
		);
	});
});

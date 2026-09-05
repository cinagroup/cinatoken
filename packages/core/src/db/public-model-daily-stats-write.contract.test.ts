import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../storage/database-client';
import type { InsertRequestLogParams } from './request-logs-types';
import { insertRequestUsageAndChargeTxD1 } from './d1/critical-writes.impl';

type CapturedStatement = D1PreparedStatement & { sqlText: string; bindValues: unknown[] };

function requestLog(): InsertRequestLogParams {
	return {
		id: 'request-1', userId: 'user-1', apiKeyId: 'key-1', workspaceId: 'personal:user-1', userEmail: null,
		modelId: 'vendor/model', providerId: 'provider-1', providerModelName: null,
		modelName: null, providerName: null, requestBody: null, upstreamRequestBody: null,
		requestProtocol: 'openai', upstreamProtocol: 'openai', inputTokens: 1, outputTokens: 2,
		cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 3,
		meteredCost: 0, standardCost: 0, chargedCost: 0, routeGroup: 'default',
		status: 'success', latencyMs: 50, errorMessage: null, rawUsage: null,
	};
}

test('D1 request logging batches the raw log and public rollup atomically even without budget charging', async () => {
	let batch: CapturedStatement[] = [];
	const raw = {
		prepare(sqlText: string) {
			const statement = {
				sqlText,
				bindValues: [] as unknown[],
				bind(...values: unknown[]) {
					statement.bindValues = values;
					return statement;
				},
				async first() {
					return { present: 1 };
				},
				async all() {
					return {
						results: [{
							assignment_id: 'guardrail-1',
							scope_type: 'user',
							scope_id: 'user-1',
							settlement_basis: 'charged',
						}],
					};
				},
			} as unknown as CapturedStatement;
			return statement;
		},
		async batch(statements: CapturedStatement[]) {
			batch = statements;
			return [];
		},
	};
	const client = { raw } as unknown as D1DatabaseClient;
	await insertRequestUsageAndChargeTxD1(client, {
		requestLog: requestLog(), shouldChargeBudget: false, userId: 'user-1',
		beforeSpent: 0, chargedCost: 0,
		audit: {
			apiKeyId: 'key-1', eventType: 'usage_charge', actorType: 'system',
			beforeSpent: 0, requestLogId: 'request-1', source: 'gateway_usage',
		},
	});

	assert.equal(batch.length, 2);
	assert.match(batch[0]!.sqlText, /INSERT INTO api_key_request_logs/);
	assert.match(batch[0]!.sqlText, /budget_charged_micros/);
	assert.equal((batch[0]!.sqlText.match(/\?/g) ?? []).length, batch[0]!.bindValues.length);
	const requestLogColumns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(batch[0]!.sqlText)![1]!
		.split(',')
		.map((column) => column.trim());
	assert.equal(batch[0]!.bindValues[requestLogColumns.indexOf('budget_charged_micros')], 0);
	assert.match(batch[1]!.sqlText, /INSERT INTO public_model_daily_stats/);
	assert.match(batch[1]!.sqlText, /total_tokens = total_tokens \+ excluded\.total_tokens/);
	assert.match(batch[1]!.sqlText, /ON CONFLICT\(stat_date, model_id, shard\) DO UPDATE/);
	assert.equal(batch[1]!.bindValues[7], 3);
	assert.equal(batch[0]!.bindValues.at(-1), batch[1]!.bindValues.at(-1));
});

test('D1 request logging settles an unknown Guardrail charge in the same batch', async () => {
	let batch: CapturedStatement[] = [];
	const raw = {
		prepare(sqlText: string) {
			const statement = {
				sqlText,
				bindValues: [] as unknown[],
				bind(...values: unknown[]) {
					statement.bindValues = values;
					return statement;
				},
				async first() {
					return { present: 1 };
				},
				async all() {
					return {
						results: [{
							assignment_id: 'guardrail-1',
							scope_type: 'user',
							scope_id: 'user-1',
							settlement_basis: 'charged',
						}],
					};
				},
			} as unknown as CapturedStatement;
			return statement;
		},
		async batch(statements: CapturedStatement[]) {
			batch = statements;
			return [];
		},
	};
	const client = { raw } as unknown as D1DatabaseClient;
	await insertRequestUsageAndChargeTxD1(client, {
		requestLog: requestLog(), shouldChargeBudget: false, userId: 'user-1',
		beforeSpent: 0, chargedCost: 0,
		guardrailBudgetSettlement: {
			requestId: 'request-1', mode: 'reserved', reason: 'usage_unavailable_after_dispatch',
		},
		audit: {
			apiKeyId: 'key-1', eventType: 'usage_charge', actorType: 'system',
			beforeSpent: 0, requestLogId: 'request-1', source: 'gateway_usage',
		},
	});

	assert.equal(batch.length, 3);
	assert.match(batch[2]!.sqlText, /state = 'expired'/);
	assert.match(batch[2]!.sqlText, /settled_micros = reserved_micros/);
	assert.equal(batch[2]!.bindValues.at(-1), 'request-1');
});

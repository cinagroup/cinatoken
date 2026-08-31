import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiKeyRow, RequestLogRow, UserRow } from '@octafuse/core';
import {
	exportUserActivityCsvService,
	listUserActivityService,
	normalizeUserActivityQuery,
	userActivityCsv,
	type UserActivityLog,
	type UserActivityRepositories,
} from './activity-service';

const USER: UserRow = {
	id: 'user-1',
	email: 'user@example.com',
	budget_max: 10,
	budget_base: 10,
	budget_spent: 2,
	budget_period: 'monthly',
	budget_reset_at: '2026-09-01T00:00:00.000Z',
	budget_epoch: 3,
	budget_reserved_micros: 250_000,
	status: 'active',
	metadata: null,
	charged_cost_factors: null,
	external_system: 'cinaauth',
	external_user_id: 'subject-1',
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-08-30T00:00:00.000Z',
};

const KEY: ApiKeyRow = {
	id: 'key-1',
	key: 'sk-test…1234',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: 'Production',
	status: 'active',
	metadata: null,
	expires_at: null,
	limit_micros: null,
	limit_reset: null,
	include_byok_in_limit: false,
	limit_epoch: 0,
	last_used_at: null,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
};

const LOG: RequestLogRow = {
	id: 'request-1',
	user_id: 'user-1',
	api_key_id: 'key-1',
	workspace_id: 'personal:user-1',
	user_email: 'user@example.com',
	model_id: 'openai/gpt-test',
	provider_id: 'secret-provider-route',
	provider_model_name: 'upstream-secret-model-name',
	model_name: 'GPT Test',
	provider_name: 'Internal Provider',
	request_body: '{"prompt":"must never leave"}',
	upstream_request_body: '{"wire":"must never leave"}',
	request_protocol: 'openai',
	request_operation: 'chat.completions',
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	model_surface_id: null,
	route_pool_id: 'private-pool',
	route_target_id: 'private-target',
	adapter: 'passthrough',
	route_trace: '{"private":true}',
	input_tokens: 10,
	output_tokens: 5,
	cache_read_tokens: 2,
	cache_write_tokens: 0,
	reasoning_tokens: 0,
	total_tokens: 15,
	metered_cost: 0.1,
	standard_cost: 0.3,
	charged_cost: 0.2,
	route_group: 'default',
	status: 'success',
	latency_ms: 321,
	gateway_overhead_ms: 10,
	upstream_response_ms: 300,
	final_upstream_headers_ms: 100,
	first_reasoning_token_ms: null,
	first_token_ms: 120,
	stream_duration_ms: 200,
	upstream_attempt_count: 1,
	upstream_failover_count: 0,
	timing_metadata: null,
	error_message: 'private upstream diagnostic',
	raw_usage: '{"private":true}',
	pricing_audit: '{"private":true}',
	provider_key_id: 'private-provider-key',
	provider_key_label: 'private label',
	provider_key_fingerprint: 'private fingerprint',
	upstream_request_id: 'private-upstream-request',
	upstream_message_id: 'private-upstream-message',
	billing_kind: 'llm_tokens',
	input_image_count: 0,
	output_image_count: 0,
	audio_duration_seconds: null,
	audio_characters: null,
	created_at: '2026-08-30T00:00:00.000Z',
};

function activityRepositories(calls: Array<Record<string, unknown>>): UserActivityRepositories {
	return {
		users: { getById: async () => USER },
		apiKeys: {
			listKeysByWorkspaceId: async (workspaceId, options) => {
				calls.push({ kind: 'keys', workspaceId, userId: options?.creatorUserId });
				return [KEY];
			},
		},
		systemConfig: { getConfig: async () => 'cny' },
		requestLogs: {
			getRequestLogs: async (options) => {
				calls.push({ kind: 'logs', ...options });
				return { logs: [LOG], total: 1 };
			},
			getRequestStatsByRange: async (options) => {
				calls.push({ kind: 'stats', ...options });
				return {
					totalRequests: 1,
					errorCount: 0,
					successCount: 1,
					chargedCost: 0.2,
					meteredCost: 0.1,
					standardCost: 0.3,
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 0,
					totalTokens: 15,
					avgLatencyMs: 321,
				};
			},
		},
	};
}

test('ordinary Activity forces user scope and returns only allowlisted log fields', async () => {
	const calls: Array<Record<string, unknown>> = [];
	const output = await listUserActivityService(activityRepositories(calls), 'user-1', 'personal:user-1', {
		range: '30d',
		page: '2',
		page_size: '50',
		api_key_id: 'key-1',
		model_id: 'openai/gpt-test',
		status: 'success',
	}, Date.parse('2026-08-30T12:00:00.000Z'));

	assert.ok(output);
	assert.equal(output.workspaceId, 'personal:user-1');
	assert.equal(output.billingCurrency, 'CNY');
	assert.equal(calls.length, 3);
	assert.equal(calls.every((call) => call.userId === 'user-1'), true);
	assert.equal(calls.every((call) => call.workspaceId === 'personal:user-1'), true);
	assert.equal(calls.find((call) => call.kind === 'logs')?.apiKeyId, 'key-1');
	assert.deepEqual(output.budget, {
		status: 'finite',
		budgetMax: 10,
		budgetBase: 10,
		budgetSpent: 2,
		budgetReserved: 0.25,
		budgetReservedMicros: 250_000,
		budgetRemaining: 7.75,
		budgetPeriod: 'monthly',
		budgetResetAt: '2026-09-01T00:00:00.000Z',
	});
	assert.deepEqual(output.logs[0], {
		id: 'request-1',
		apiKeyId: 'key-1',
		apiKeyName: 'Production',
		modelId: 'openai/gpt-test',
		modelName: 'GPT Test',
		protocol: 'openai',
		operation: 'chat.completions',
		status: 'success',
		inputTokens: 10,
		outputTokens: 5,
		totalTokens: 15,
		chargedCost: 0.2,
		latencyMs: 321,
		billingKind: 'llm_tokens',
		inputImageCount: 0,
		outputImageCount: 0,
		audioDurationSeconds: null,
		audioCharacters: null,
		createdAt: '2026-08-30T00:00:00.000Z',
	});
	const publicLog = output.logs[0] as Record<string, unknown>;
	for (const forbidden of [
		'providerId', 'providerName', 'requestBody', 'upstreamRequestBody', 'errorMessage',
		'routeTrace', 'providerKeyId', 'upstreamRequestId', 'pricingAudit',
	]) {
		assert.equal(Object.hasOwn(publicLog, forbidden), false, forbidden);
	}
});

test('Activity query bounds pagination and ignores unknown filters', () => {
	assert.deepEqual(normalizeUserActivityQuery({
		range: 'forever', page: '-4', page_size: '999', status: 'provider-secret',
	}), {
		range: '7d', page: 1, pageSize: 100,
		apiKeyId: undefined, modelId: undefined, status: undefined,
	});
});

test('CSV export is user-scoped, bounded, and neutralizes spreadsheet formulas', async () => {
	const calls: Array<Record<string, unknown>> = [];
	const exported = await exportUserActivityCsvService(
		activityRepositories(calls),
		'user-1',
		'personal:user-1',
		{ range: '7d', api_key_id: 'key-1' },
		Date.parse('2026-08-30T12:00:00.000Z'),
	);
	assert.ok(exported);
	assert.equal(calls.every((call) => call.userId === 'user-1'), true);
	assert.equal(calls.every((call) => call.workspaceId === 'personal:user-1'), true);
	assert.equal(exported.rowCount, 1);
	assert.equal(exported.truncated, false);
	assert.equal(exported.billingCurrency, 'CNY');
	assert.match(exported.csv, /charged_cost_cny/u);

	const formulaRow: UserActivityLog = {
		id: 'request-2',
		apiKeyId: 'key-1',
		apiKeyName: '=HYPERLINK("https://evil")',
		modelId: 'model',
		modelName: 'Model',
		protocol: 'openai',
		operation: 'chat',
		status: 'success',
		inputTokens: 1,
		outputTokens: 1,
		totalTokens: 2,
		chargedCost: 0,
		latencyMs: 1,
		billingKind: null,
		inputImageCount: 0,
		outputImageCount: 0,
		audioDurationSeconds: null,
		audioCharacters: null,
		createdAt: '2026-08-30T00:00:00.000Z',
	};
	assert.match(userActivityCsv([formulaRow]), /"'=HYPERLINK\(""https:\/\/evil""\)"/u);
});

test('CSV export keeps a stable page size so later offsets cannot overlap', async () => {
	const pageSizes: number[] = [];
	const repos = activityRepositories([]);
	repos.requestLogs.getRequestLogs = async (options) => {
		pageSizes.push(options.pageSize ?? 0);
		const start = ((options.page ?? 1) - 1) * (options.pageSize ?? 100);
		const count = Math.max(0, Math.min(options.pageSize ?? 100, 150 - start));
		return {
			logs: Array.from({ length: count }, (_, offset) => ({
				...LOG,
				id: `request-${start + offset + 1}`,
			})),
			total: 150,
		};
	};
	const exported = await exportUserActivityCsvService(
		repos,
		'user-1',
		'personal:user-1',
		{ range: '7d' },
		Date.parse('2026-08-30T12:00:00.000Z'),
	);
	assert.ok(exported);
	assert.deepEqual(pageSizes, [100, 100]);
	assert.equal(exported.rowCount, 150);
	assert.match(exported.csv, /request-150/u);
});

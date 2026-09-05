import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type {
	ApiKeyRow,
	GatewayRepositories,
	GenerationRequestLogRow,
	RequestLogRow,
	UserRow,
	WorkspaceContextProjection,
} from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import type { UserPrincipal } from '@/lib/user-auth';
import { userActivityRoutes } from '@/lib/routes/user/activity';
import {
	exportUserActivityCsvService,
	getUserActivityGenerationService,
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
	provider_name: 'DeepSeek',
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

const GENERATION: GenerationRequestLogRow = {
	id: 'gen-owned_123',
	request_operation: 'chat',
	status: 'success',
	created_at: '2026-08-30T00:00:00.000Z',
	latency_ms: 321,
	final_upstream_headers_ms: 100,
	stream_duration_ms: 200,
	model_id: 'deepseek/deepseek-chat',
	provider_name: 'DeepSeek',
	input_tokens: 10,
	output_tokens: 5,
	cache_read_tokens: 2,
	reasoning_tokens: 1,
	native_tokens_prompt: 10,
	native_tokens_completion: 5,
	native_tokens_cached: 2,
	native_tokens_reasoning: 1,
	native_tokens_completion_images: null,
	input_image_count: 0,
	output_image_count: 0,
	upstream_message_id: 'chatcmpl-safe-123',
	session_id: 'session-public',
	workspace_id: 'personal:user-1',
	request_origin: 'https://cinatoken.com',
	http_referer: 'https://app.example',
	user_agent: 'CinaToken SDK/1.0',
	response_streamed: true,
	data_region: 'global',
	is_byok: false,
	charged_cost_usd: '0.00042',
	upstream_inference_cost_usd: '0.00021',
	service_tier: 'default',
	finish_reason: 'stop',
	native_finish_reason: 'stop',
	provider_responses: JSON.stringify([{
		status: 200,
		endpoint_id: 'deepseek-official',
		provider_name: 'DeepSeek',
		model_permaslug: 'deepseek-chat',
		latency: 300,
		is_byok: false,
	}]),
};

const PRINCIPAL: UserPrincipal = {
	userId: 'user-1',
	subject: 'cinaauth-subject-1',
	email: 'user@example.com',
	isAdmin: false,
	capabilities: [],
};

const WORKSPACE_CONTEXT: WorkspaceContextProjection = {
	workspaces: [],
	currentWorkspace: {
		id: 'personal:user-1', name: 'Personal', slug: 'personal-user-1', description: null,
		scopeType: 'personal', organizationId: null, organizationName: null, organizationSlug: null,
		personalOwnerUserId: 'user-1', isDefault: true, status: 'active', role: 'owner',
		accessSource: 'personal_owner', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
	},
	preferredWorkspaceAvailable: true,
};
WORKSPACE_CONTEXT.workspaces.push(WORKSPACE_CONTEXT.currentWorkspace);

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
			getRequestLogByIdForOwner: async () => null,
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
			getRequestActivityGroups: async (options) => {
				calls.push({ kind: `groups:${options.dimension}`, ...options });
				if (options.dimension === 'model') return [{
						id: 'openai/gpt-test',
						name: 'GPT Test',
						requestCount: 1,
						successCount: 1,
						errorCount: 0,
						totalTokens: 15,
						chargedCost: 0.2,
					}];
				if (options.dimension === 'provider') return [{
					id: 'DeepSeek',
					name: null,
					requestCount: 1,
					successCount: 1,
					errorCount: 0,
					totalTokens: 15,
					chargedCost: 0.2,
				}];
				return [{
						id: 'key-1',
						name: 'must-not-be-trusted',
						requestCount: 1,
						successCount: 1,
						errorCount: 0,
						totalTokens: 15,
						chargedCost: 0.2,
					}];
			},
			queryRequestTimeseries: async (options) => {
				calls.push({ kind: 'timeline', ...options });
				return [{
					bucket: options.granularity === 'hour' ? '2026-08-30 12:00:00' : '2026-08-30',
					requestCount: 1,
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 0,
					totalTokens: 15,
					chargedCost: 0.2,
					avgLatencyMs: 321,
				}];
			},
		},
	};
}

test('Activity Generation detail is tenant-scoped and exposes only the shared safe projection', async () => {
	const calls: Array<Record<string, unknown>> = [];
	const repos = activityRepositories(calls);
	repos.requestLogs.getRequestLogByIdForOwner = async (options) => {
		calls.push({ kind: 'generation', ...options });
		return GENERATION;
	};

	const output = await getUserActivityGenerationService(
		repos,
		'user-1',
		'personal:user-1',
		'gen-owned_123',
	);

	assert.ok(output);
	assert.deepEqual(calls, [{
		kind: 'generation',
		id: 'gen-owned_123',
		userId: 'user-1',
		workspaceId: 'personal:user-1',
	}]);
	assert.equal(output.model, 'deepseek/deepseek-chat');
	assert.equal(output.total_cost, 0.00042);
	assert.equal(output.provider_responses?.[0]?.provider_name, 'DeepSeek');
	const publicDetail = output as unknown as Record<string, unknown>;
	for (const forbidden of [
		'request_body', 'upstream_request_body', 'error_message', 'route_trace',
		'provider_key_id', 'provider_key_label', 'provider_key_fingerprint',
		'upstream_request_id', 'pricing_audit', 'raw_usage',
	]) {
		assert.equal(Object.hasOwn(publicDetail, forbidden), false, forbidden);
	}
});

test('Activity Generation detail fails closed before or after the tenant lookup', async () => {
	let calls = 0;
	const repos = activityRepositories([]);
	repos.requestLogs.getRequestLogByIdForOwner = async () => {
		calls += 1;
		return GENERATION;
	};

	assert.equal(await getUserActivityGenerationService(
		repos, 'user-1', 'personal:user-1', 'request-1',
	), null);
	assert.equal(calls, 0);

	assert.equal(await getUserActivityGenerationService(
		repos, 'user-1', 'organization:other', 'gen-owned_123',
	), null);
	assert.equal(calls, 1);
});

test('Activity Generation detail remains available when a non-USD deployment has no USD charge snapshot', async () => {
	const repos = activityRepositories([]);
	repos.requestLogs.getRequestLogByIdForOwner = async () => ({
		...GENERATION,
		charged_cost_usd: null,
	});

	const output = await getUserActivityGenerationService(
		repos, 'user-1', 'personal:user-1', 'gen-owned_123',
	);
	assert.ok(output);
	assert.equal(output.total_cost, null);
	assert.equal(output.usage, null);
});

test('Activity Generation route returns a no-store portal response without Gateway key material', async () => {
	const repos = activityRepositories([]);
	repos.requestLogs.getRequestLogByIdForOwner = async (options) => {
		assert.deepEqual(options, {
			id: 'gen-owned_123',
			userId: 'user-1',
			workspaceId: 'personal:user-1',
		});
		return GENERATION;
	};
	const app = new Hono<UserEnv>();
	app.use('*', async (c, next) => {
		c.set('repositories', repos as unknown as GatewayRepositories);
		c.set('principal', PRINCIPAL);
		c.set('workspaceContext', WORKSPACE_CONTEXT);
		await next();
	});
	app.route('/activity', userActivityRoutes);

	const response = await app.request('/activity/gen-owned_123');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	const body = await response.text();
	assert.match(body, /"id":"gen-owned_123"/u);
	assert.doesNotMatch(body, /request_body|route_trace|provider_key|pricing_audit|secret-provider/u);
});

test('ordinary Activity forces user scope and returns only allowlisted log fields', async () => {
	const calls: Array<Record<string, unknown>> = [];
	const output = await listUserActivityService(activityRepositories(calls), 'user-1', 'personal:user-1', {
		range: '30d',
		page: '2',
		page_size: '50',
		api_key_id: 'key-1',
		model_id: 'openai/gpt-test',
		provider_name: 'DeepSeek',
		status: 'success',
	}, Date.parse('2026-08-30T12:00:00.000Z'));

	assert.ok(output);
	assert.equal(output.workspaceId, 'personal:user-1');
	assert.equal(output.billingCurrency, 'CNY');
	assert.equal(calls.length, 7);
	assert.equal(calls.every((call) => call.userId === 'user-1'), true);
	assert.equal(calls.every((call) => call.workspaceId === 'personal:user-1'), true);
	assert.equal(calls.find((call) => call.kind === 'logs')?.apiKeyId, 'key-1');
	for (const kind of ['stats', 'groups:model', 'groups:apiKey', 'groups:provider', 'timeline']) {
		const call = calls.find((entry) => entry.kind === kind);
		assert.equal(call?.apiKeyId, 'key-1');
		assert.equal(call?.modelId, 'openai/gpt-test');
		assert.equal(call?.providerName, 'DeepSeek');
		assert.equal(call?.status, 'success');
	}
	assert.equal(calls.find((entry) => entry.kind === 'timeline')?.granularity, 'day');
	assert.deepEqual(output.analytics, {
		limit: 10,
		models: [{
			id: 'openai/gpt-test',
			name: 'GPT Test',
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 15,
			chargedCost: 0.2,
		}],
		apiKeys: [{
			id: 'key-1',
			name: 'Production',
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 15,
			chargedCost: 0.2,
		}],
		providers: [{
			id: 'DeepSeek',
			name: 'DeepSeek',
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 15,
			chargedCost: 0.2,
		}],
	});
	assert.deepEqual(output.timeline, {
		granularity: 'day',
		points: [{
			bucket: '2026-08-30T00:00:00.000Z',
			requestCount: 1,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 0,
			totalTokens: 15,
			chargedCost: 0.2,
			avgLatencyMs: 321,
		}],
	});
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
		providerName: 'DeepSeek',
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
		'providerId', 'requestBody', 'upstreamRequestBody', 'errorMessage',
		'routeTrace', 'providerKeyId', 'upstreamRequestId', 'pricingAudit',
	]) {
		assert.equal(Object.hasOwn(publicLog, forbidden), false, forbidden);
	}
});

test('Activity query bounds pagination and ignores unknown filters', () => {
	assert.deepEqual(normalizeUserActivityQuery({
		range: 'forever', page: '-4', page_size: '999', status: 'provider-secret',
		provider_name: 'DeepSeek\nprivate-diagnostic',
	}), {
		range: '7d', page: 1, pageSize: 100,
		apiKeyId: undefined, modelId: undefined, providerName: undefined, status: undefined,
	});
});

test('Activity drops unsafe Provider display-name snapshots', async () => {
	const repos = activityRepositories([]);
	repos.requestLogs.getRequestLogs = async () => ({
		logs: [{ ...LOG, provider_name: 'DeepSeek\u0000private' }],
		total: 1,
	});
	const originalGroups = repos.requestLogs.getRequestActivityGroups;
	repos.requestLogs.getRequestActivityGroups = async (options) => options.dimension === 'provider'
		? [{
			id: 'DeepSeek\u0000private', name: null, requestCount: 1,
			successCount: 1, errorCount: 0, totalTokens: 15, chargedCost: 0.2,
		}]
		: originalGroups(options);
	repos.requestLogs.queryRequestTimeseries = async () => [{
		bucket: '2026-02-30 12:00:00', requestCount: 1, inputTokens: 1,
		outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
		totalTokens: 2, chargedCost: 0.1, avgLatencyMs: 10,
	}, {
		bucket: '2026-08-30 12:00:00', requestCount: -1, inputTokens: Number.POSITIVE_INFINITY,
		outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0,
		totalTokens: 15, chargedCost: Number.NaN, avgLatencyMs: -20,
	}];

	const output = await listUserActivityService(
		repos,
		'user-1',
		'personal:user-1',
		{ range: '7d' },
		Date.parse('2026-08-30T12:00:00.000Z'),
	);

	assert.ok(output);
	assert.equal(output.logs[0]?.providerName, null);
	assert.deepEqual(output.analytics.providers, []);
	assert.deepEqual(output.timeline.points, [{
		bucket: '2026-08-30T12:00:00.000Z',
		requestCount: 0,
		inputTokens: 0,
		outputTokens: 5,
		cacheReadTokens: 2,
		cacheWriteTokens: 0,
		totalTokens: 15,
		chargedCost: 0,
		avgLatencyMs: null,
	}]);
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
		providerName: '+malicious-provider',
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
	assert.match(userActivityCsv([formulaRow]), /"'\+malicious-provider"/u);
	assert.match(userActivityCsv([formulaRow]), /"input_image_count","output_image_count","audio_duration_seconds","audio_characters"/u);
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

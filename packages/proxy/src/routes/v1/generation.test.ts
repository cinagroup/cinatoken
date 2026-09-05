import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	GenerationRequestLogRow,
	InsertGenerationFeedbackForManagementAccountParams,
	ManagementApiKeyRow,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { Hono } from 'hono';
import { createProxyApp, type Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { toGenerationMetadataData } from './generation';

const GENERATION: GenerationRequestLogRow = {
	id: 'gen-owned',
	model_id: 'vendor/model',
	provider_name: 'Provider One',
	request_operation: 'chat',
	input_tokens: 11,
	output_tokens: 22,
	cache_read_tokens: 3,
	reasoning_tokens: 4,
	native_tokens_prompt: 9,
	native_tokens_completion: 20,
	native_tokens_cached: 2,
	native_tokens_reasoning: 4,
	native_tokens_completion_images: 1,
	input_image_count: 0,
	output_image_count: 0,
	status: 'success',
	latency_ms: 1250,
	final_upstream_headers_ms: 250,
	stream_duration_ms: 750,
	upstream_message_id: 'chatcmpl-public-123',
	session_id: 'session-public-123',
	workspace_id: 'workspace-1',
	request_origin: 'https://cinatoken.com',
	http_referer: 'https://app.example',
	user_agent: 'CinaSDK/1.0',
	response_streamed: 1,
	data_region: 'global',
	is_byok: 0,
	charged_cost_usd: '0.001500000000',
	upstream_inference_cost_usd: '0.001200000000',
	service_tier: 'priority',
	finish_reason: 'stop',
	native_finish_reason: 'end_turn',
	provider_responses: JSON.stringify([
		{
			status: 503,
			endpoint_id: 'endpoint-fallback',
			is_byok: false,
			latency: 100,
			model_permaslug: 'vendor/model',
			provider_name: 'Provider Zero',
		},
		{
			status: 200,
			endpoint_id: 'endpoint-selected',
			id: 'chatcmpl-public-123',
			is_byok: false,
			latency: 250,
			model_permaslug: 'vendor/model',
			provider_name: 'Provider One',
			routed_service_tier: 'priority',
		},
	]),
	created_at: '2026-08-30T00:00:00.000Z',
};

const MANAGEMENT_SECRET = `sk-cina-mgmt-${'a'.repeat(64)}`;
const MANAGEMENT_ROW: ManagementApiKeyRow = {
	id: 'management-1',
	key_hash: `sha256:${'b'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-aaaa…aaaa',
	account_type: 'personal',
	personal_owner_user_id: 'user-1',
	organization_id: null,
	name: 'Feedback automation',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-1',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
};

function gatewayKey(): ResolvedGatewayKeyRow {
	return {
		id: 'key-1',
		key: 'sk-test',
		user_id: 'user-1',
		workspace_id: 'workspace-1',
		name: 'Test',
		status: 'active',
		metadata: null,
		last_used_at: null,
		created_at: '2026-08-30T00:00:00.000Z',
		updated_at: '2026-08-30T00:00:00.000Z',
		user_email: 'owner@example.com',
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: 1,
		budget_base: 1,
		budget_spent: 1,
		budget_period: 'none',
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
	};
}

function testRepositories(options?: {
	throwLookup?: boolean;
	throwFeedback?: boolean;
	feedbackInserted?: boolean;
}) {
	const lookups: Array<{ id: string; userId: string; workspaceId: string }> = [];
	const feedback: InsertGenerationFeedbackForManagementAccountParams[] = [];
	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async (key: string) => key === 'sk-test' ? gatewayKey() : null,
		},
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === MANAGEMENT_SECRET ? MANAGEMENT_ROW : null,
		},
		requestLogs: {
			insertGenerationFeedbackForManagementAccount: async (
				params: InsertGenerationFeedbackForManagementAccountParams,
			) => {
				feedback.push(params);
				if (options?.throwFeedback) {
					throw new Error('postgres://feedback-secret.example comment=private');
				}
				return options?.feedbackInserted ?? params.generationId === GENERATION.id;
			},
			getRequestLogByIdForOwner: async (scope: { id: string; userId: string; workspaceId: string }) => {
				lookups.push(scope);
				if (options?.throwLookup) throw new Error('postgres://db-secret.example route_trace=private');
				return scope.id === GENERATION.id
					&& scope.userId === 'user-1'
					&& scope.workspaceId === 'workspace-1'
					? GENERATION
					: null;
			},
		},
	} as GatewayRepositories;
	return { repositories, lookups, feedback };
}

function request(path: string, init?: RequestInit) {
	const { repositories } = testRepositories();
	const app = createProxyApp(async () => ({ repositories } as StorageContext));
	return app.request(path, init, { REQUEST_BODY_LOGGING: 'off' });
}

describe('GET generation metadata', () => {
	it('mounts canonical and legacy aliases behind Bearer auth and ignores exhausted inference budget', async () => {
		const { repositories, lookups } = testRepositories();
		const app = createProxyApp(async () => ({ repositories } as StorageContext));
		for (const path of [
			'/api/v1/generation?id=gen-owned',
			'/v1/generation?id=gen-owned',
		]) {
			assert.equal((await app.request(path, {}, { REQUEST_BODY_LOGGING: 'off' })).status, 401);
			const response = await app.request(path, {
				headers: { Authorization: 'Bearer sk-test' },
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get('cache-control'), 'private, no-store');
		}
		assert.deepEqual(lookups, [
			{ id: 'gen-owned', userId: 'user-1', workspaceId: 'workspace-1' },
			{ id: 'gen-owned', userId: 'user-1', workspaceId: 'workspace-1' },
		]);
	});

	it('returns an SDK-compatible proven metadata snapshot without internal request-log columns', async () => {
		const response = await request('/api/v1/generation?id=gen-owned', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { data: Record<string, unknown> };
		assert.deepEqual(body.data, {
			api_type: 'completions',
			app_id: null,
			cache_discount: null,
			cancelled: false,
			created_at: '2026-08-30T00:00:00.000Z',
			data_region: 'global',
			external_user: null,
			finish_reason: 'stop',
			generation_time: 1000,
			http_referer: 'https://app.example',
			id: 'gen-owned',
			is_byok: false,
			latency: 1250,
			model: 'vendor/model',
			moderation_latency: null,
			native_finish_reason: 'end_turn',
			native_tokens_cached: 2,
			native_tokens_completion: 20,
			native_tokens_completion_images: 1,
			native_tokens_prompt: 9,
			native_tokens_reasoning: 4,
			num_fetches: null,
			num_input_audio_prompt: null,
			num_media_completion: null,
			num_media_prompt: null,
			num_search_results: null,
			origin: 'https://cinatoken.com',
			preset_id: null,
			provider_name: 'Provider One',
			provider_responses: JSON.parse(GENERATION.provider_responses!),
			request_id: null,
			router: null,
			service_tier: 'priority',
			session_id: 'session-public-123',
			streamed: true,
			tokens_completion: 22,
			tokens_prompt: 11,
			total_cost: 0.0015,
			upstream_id: 'chatcmpl-public-123',
			upstream_inference_cost: 0.0012,
			usage: 0.0015,
			user_agent: 'CinaSDK/1.0',
			web_search_engine: null,
			workspace_id: 'workspace-1',
		});

		const serialized = JSON.stringify(body);
		for (const forbiddenKey of [
			'api_key_id', 'user_id', 'provider_id', 'provider_model_name',
			'model_surface_id', 'route_pool_id', 'route_target_id',
			'request_body', 'upstream_request_body', 'route_trace', 'error_message',
			'raw_usage', 'pricing_audit', 'provider_key_fingerprint',
		]) {
			assert.equal(Object.hasOwn(body.data, forbiddenKey), false);
		}
		assert.equal(
			toGenerationMetadataData({ ...GENERATION, request_operation: 'models.generate' })?.api_type,
			'completions',
		);
		assert.equal(
			toGenerationMetadataData({ ...GENERATION, request_operation: 'completions' })?.api_type,
			'completions',
		);
	});

	it('rejects incomplete, malformed, or non-canonical mandatory snapshots', () => {
		const data = toGenerationMetadataData({
			...GENERATION,
			id: 'invalid\ngeneration',
			created_at: 'invalid\ndate',
			model_id: 'm'.repeat(201),
			provider_name: 'unsafe\u0000provider',
			upstream_message_id: 'bad\nupstream-id',
		});
		assert.equal(data, null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, request_origin: 'https://cinatoken.com/path' }), null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, data_region: 'unknown' }), null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, is_byok: null }), null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, charged_cost_usd: '-1' }), null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, service_tier: 'untrusted' })?.service_tier, null);
		assert.equal(toGenerationMetadataData({ ...GENERATION, finish_reason: 'untrusted' })?.finish_reason, null);
		assert.equal(
			toGenerationMetadataData({ ...GENERATION, http_referer: 'https://app.example/private' })?.http_referer,
			null,
		);
		assert.equal(toGenerationMetadataData({ ...GENERATION, user_agent: 'bad\nagent' })?.user_agent, null);
		assert.equal(
			toGenerationMetadataData({ ...GENERATION, native_finish_reason: 'bad\nreason' })?.native_finish_reason,
			null,
		);
		assert.equal(
			toGenerationMetadataData({ ...GENERATION, stream_duration_ms: null })?.generation_time,
			null,
		);
		const missingNative = toGenerationMetadataData({
			...GENERATION,
			native_tokens_prompt: null,
			native_tokens_completion: null,
		});
		assert.deepEqual(
			missingNative && {
				native: missingNative.native_tokens_prompt,
				prompt: missingNative.tokens_prompt,
				completion: missingNative.tokens_completion,
			},
			{ native: null, prompt: null, completion: null },
		);
		assert.equal(
			toGenerationMetadataData({
				...GENERATION,
				provider_responses: '[{"status":200,"provider_key":"secret"}]',
			})?.provider_responses,
			null,
		);
	});

	it('keeps legacy rows without immutable USD/origin snapshots unavailable', async () => {
		const { repositories } = testRepositories();
		(repositories.requestLogs.getRequestLogByIdForOwner as unknown as () => Promise<GenerationRequestLogRow>) =
			async () => ({ ...GENERATION, request_origin: null, charged_cost_usd: null });
		const app = createProxyApp(async () => ({ repositories } as StorageContext));
		const response = await app.request('/api/v1/generation?id=gen-owned', {
			headers: { Authorization: 'Bearer sk-test' },
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, 404);
	});

	it('uses one indistinguishable 404 for other users, other Workspaces, missing rows, and invalid ids', async () => {
		const bodies: unknown[] = [];
		for (const id of ['gen-other-user', 'gen-other-workspace', 'gen-missing', 'not-a-generation']) {
			const response = await request(`/api/v1/generation?id=${id}`, {
				headers: { Authorization: 'Bearer sk-test' },
			});
			assert.equal(response.status, 404, id);
			bodies.push(await response.json());
		}
		assert.equal(bodies.slice(1).every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])), true);
		assert.deepEqual(bodies[0], {
			error: {
				code: 404,
				message: 'Resource not found',
				metadata: { error_type: 'not_found' },
			},
			code: GatewayErrorCode.modelNotFound,
		});
	});

	it('rejects missing or ambiguous id parameters without querying storage', async () => {
		const { repositories, lookups } = testRepositories();
		const app = createProxyApp(async () => ({ repositories } as StorageContext));
		for (const path of [
			'/api/v1/generation',
			'/api/v1/generation?id=',
			'/api/v1/generation?id=gen-owned&id=gen-other',
		]) {
			const response = await app.request(path, {
				headers: { Authorization: 'Bearer sk-test' },
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 400, path);
		}
		assert.deepEqual(lookups, []);
	});

	it('uses the unified 500 envelope and does not expose repository failures', async () => {
		const { repositories } = testRepositories({ throwLookup: true });
		const app = createProxyApp(async () => ({ repositories } as StorageContext));
		const response = await app.request('/api/v1/generation?id=gen-owned', {
			headers: { Authorization: 'Bearer sk-test' },
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, 500);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const body = await response.json();
		assert.deepEqual(body, {
			error: {
				code: 500,
				message: 'Internal server error',
				metadata: { error_type: 'server' },
			},
			code: GatewayErrorCode.internalError,
		});
		assert.doesNotMatch(JSON.stringify(body), /db-secret|route_trace|postgres/iu);
	});

	it('does not expose a generation content endpoint', async () => {
		const response = await request('/api/v1/generation/content?id=gen-owned', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(response.status, 404);
	});
});

describe('POST generation feedback', () => {
	function feedbackRequest(
		body: unknown,
		options?: Parameters<typeof testRepositories>[0],
	) {
		const fixture = testRepositories(options);
		const app = createProxyApp(async () => ({ repositories: fixture.repositories } as StorageContext));
		return {
			...fixture,
			request: (path = '/api/v1/generation/feedback', init?: RequestInit) => app.request(path, {
				...init,
				method: init?.method ?? 'POST',
				headers: {
					Authorization: `Bearer ${MANAGEMENT_SECRET}`,
					'Content-Type': 'application/json',
					...init?.headers,
				},
				body: init != null && 'body' in init ? init.body : JSON.stringify(body),
			}, { REQUEST_BODY_LOGGING: 'off' }),
		};
	}

	it('records the official contract through canonical and legacy paths with a Management key', async () => {
		const fixture = feedbackRequest({
			generation_id: 'gen-owned',
			category: 'incorrect_response',
			comment: 'The response repeated the same paragraph.',
			extra_client_field: 'ignored',
		});
		for (const path of ['/api/v1/generation/feedback', '/v1/generation/feedback']) {
			const response = await fixture.request(path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get('cache-control'), 'private, no-store');
			assert.deepEqual(await response.json(), { data: { success: true } });
		}
		assert.equal(fixture.feedback.length, 2);
		for (const inserted of fixture.feedback) {
			assert.match(inserted.id, /^gfb_[0-9a-f-]{36}$/u);
			assert.equal(inserted.generationId, 'gen-owned');
			assert.equal(inserted.managementApiKeyId, 'management-1');
			assert.deepEqual(inserted.account, {
				accountType: 'personal',
				personalOwnerUserId: 'user-1',
				organizationId: null,
			});
			assert.equal(inserted.category, 'incorrect_response');
			assert.equal(inserted.comment, 'The response repeated the same paragraph.');
			assert.equal(Number.isFinite(Date.parse(inserted.createdAtIso)), true);
			assert.equal(Object.hasOwn(inserted, 'extra_client_field'), false);
		}
	});

	it('requires a Management key and never accepts an ordinary Gateway key', async () => {
		const fixture = feedbackRequest({ generation_id: 'gen-owned', category: 'latency' });
		assert.equal((await fixture.request(undefined, {
			headers: { Authorization: '' },
		})).status, 401);
		assert.equal((await fixture.request(undefined, {
			headers: { Authorization: 'Bearer sk-test' },
		})).status, 401);
		assert.equal(fixture.feedback.length, 0);
	});

	it('validates the exact category set, Unicode comment length, JSON, media type, and byte ceiling', async () => {
		const invalidBodies = [
			{},
			{ generation_id: '', category: 'latency' },
			{ generation_id: 'gen-owned' },
			{ generation_id: 'gen-owned', category: 'unsupported' },
			{ generation_id: 'gen-owned', category: 'other', comment: null },
			{ generation_id: 'gen-owned', category: 'other', comment: 7 },
			{ generation_id: 'gen-owned', category: 'other', comment: '🧭'.repeat(1_001) },
		];
		for (const body of invalidBodies) {
			const fixture = feedbackRequest(body);
			assert.equal((await fixture.request()).status, 400, JSON.stringify(body).slice(0, 120));
			assert.equal(fixture.feedback.length, 0);
		}

		const malformed = feedbackRequest({});
		assert.equal((await malformed.request(undefined, { body: '{' })).status, 400);
		assert.equal(malformed.feedback.length, 0);

		const wrongMedia = feedbackRequest({ generation_id: 'gen-owned', category: 'other' });
		assert.equal((await wrongMedia.request(undefined, {
			headers: { 'Content-Type': 'text/plain' },
		})).status, 400);
		assert.equal(wrongMedia.feedback.length, 0);

		const oversized = feedbackRequest({});
		assert.equal((await oversized.request(undefined, {
			body: JSON.stringify({
				generation_id: 'gen-owned',
				category: 'other',
				comment: 'x'.repeat(8 * 1024),
			}),
		})).status, 413);
		assert.equal(oversized.feedback.length, 0);
	});

	it('uses one indistinguishable 404 for malformed, missing, and foreign generations', async () => {
		const bodies: unknown[] = [];
		for (const generationId of ['not-a-generation', 'gen-missing', 'gen-foreign']) {
			const fixture = feedbackRequest(
				{ generation_id: generationId, category: 'api_error' },
				{ feedbackInserted: false },
			);
			const response = await fixture.request();
			assert.equal(response.status, 404, generationId);
			bodies.push(await response.json());
			assert.equal(fixture.feedback.length, generationId === 'not-a-generation' ? 0 : 1);
		}
		assert.equal(bodies.slice(1).every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])), true);
	});

	it('masks storage errors and never reflects the submitted comment', async () => {
		const privateComment = 'private support context sk-secret-value';
		const fixture = feedbackRequest(
			{ generation_id: 'gen-owned', category: 'billing', comment: privateComment },
			{ throwFeedback: true },
		);
		const response = await fixture.request();
		assert.equal(response.status, 500);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const serialized = JSON.stringify(await response.json());
		assert.doesNotMatch(serialized, /feedback-secret|private support|sk-secret/iu);
	});

	it('does not expose Generation content even to a Management key', async () => {
		const fixture = feedbackRequest({});
		const response = await fixture.request('/api/v1/generation/content', {
			method: 'GET',
			body: undefined,
		});
		assert.equal(response.status, 404);
		assert.equal(fixture.feedback.length, 0);
	});
});

describe('generation metadata budget exemption', () => {
	it('is GET-only and path-exact while still requiring a valid Gateway key', async () => {
		const { repositories } = testRepositories();
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.use('*', requireApiKey);
		app.all('*', (c) => c.json({ ok: true }));
		const env = { REQUEST_BODY_LOGGING: 'off' } as Env['Bindings'];

		for (const path of ['/api/v1/generation', '/v1/generation']) {
			assert.equal((await app.request(path, {
				headers: { Authorization: 'Bearer sk-test' },
			}, env)).status, 200, path);
			assert.equal((await app.request(path, {}, env)).status, 401, `${path} must still authenticate`);
		}

		for (const [method, path] of [
			['POST', '/api/v1/generation'],
			['GET', '/api/v1/generation/'],
			['GET', '/api/v1/generation/content'],
			['GET', '/v1/generation/extra'],
			['GET', '/other/v1/generation'],
		] as const) {
			assert.equal((await app.request(path, {
				method,
				headers: { Authorization: 'Bearer sk-test' },
			}, env)).status, 402, `${method} ${path} must not bypass budget enforcement`);
		}
	});
});

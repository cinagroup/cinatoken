import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	GenerationRequestLogRow,
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
	input_image_count: 0,
	output_image_count: 0,
	status: 'success',
	latency_ms: 1250,
	upstream_message_id: 'chatcmpl-public-123',
	workspace_id: 'workspace-1',
	request_origin: 'https://cinatoken.com',
	response_streamed: 1,
	data_region: 'global',
	is_byok: 0,
	charged_cost_usd: '0.001500000000',
	upstream_inference_cost_usd: '0.001200000000',
	created_at: '2026-08-30T00:00:00.000Z',
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

function testRepositories(options?: { throwLookup?: boolean }) {
	const lookups: Array<{ id: string; userId: string; workspaceId: string }> = [];
	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async (key: string) => key === 'sk-test' ? gatewayKey() : null,
		},
		requestLogs: {
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
	return { repositories, lookups };
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
			finish_reason: null,
			generation_time: null,
			http_referer: null,
			id: 'gen-owned',
			is_byok: false,
			latency: 1250,
			model: 'vendor/model',
			moderation_latency: null,
			native_finish_reason: null,
			native_tokens_cached: 3,
			native_tokens_completion: 22,
			native_tokens_completion_images: null,
			native_tokens_prompt: 11,
			native_tokens_reasoning: 4,
			num_fetches: null,
			num_input_audio_prompt: null,
			num_media_completion: null,
			num_media_prompt: null,
			num_search_results: null,
			origin: 'https://cinatoken.com',
			preset_id: null,
			provider_name: 'Provider One',
			provider_responses: null,
			request_id: null,
			router: null,
			service_tier: null,
			session_id: null,
			streamed: true,
			tokens_completion: 22,
			tokens_prompt: 11,
			total_cost: 0.0015,
			upstream_id: 'chatcmpl-public-123',
			upstream_inference_cost: 0.0012,
			usage: 0.0015,
			user_agent: null,
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

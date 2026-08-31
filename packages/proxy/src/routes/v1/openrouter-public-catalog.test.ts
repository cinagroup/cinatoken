import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type GatewayRepositories,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
	type ModelRow,
	type ProviderRow,
	type RouteDataPolicyRow,
	type StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';
import { drainNodeBackgroundWork } from '../../runtime/schedule-background-work';

const MODEL: ModelRow = {
	id: 'vendor/model-one',
	display_name: 'Model One',
	vendor: 'Vendor',
	context_window: 128_000,
	max_tokens: 8_000,
	pricing_profile: JSON.stringify({
		tiers: [{ upto: null, input_price: 3, output_price: 6 }],
	}),
	tags: '["chat"]',
	description: 'Public model description',
	metadata: JSON.stringify({
		private_endpoint: 'https://private.example/v1',
		upstream_secret: 'must-not-leak',
	}),
	input_modalities: '["text"]',
	output_modalities: '["text"]',
	released_at: '2026-08-01',
	created_at: '2026-08-01T00:00:00.000Z',
};

const PROVIDER: ProviderRow = {
	id: 'provider-internal-id',
	name: 'Serving Provider',
	endpoints: JSON.stringify({ openai: { base: 'https://private.example/v1' } }),
	api_key: 'sk-provider-must-not-leak',
	status: 'active',
	description: null,
	shared_channel_type: null,
	created_at: '2026-08-01T00:00:00.000Z',
};

const ROUTE: ModelRouteJoinRow = {
	id: 'route-internal-id',
	model_id: MODEL.id,
	provider_id: PROVIDER.id,
	provider_model_name: 'private-upstream-model',
	priority: 0,
	status: 'active',
	route_group: 'default',
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: JSON.stringify({
		supported_parameters: ['temperature'],
		quantization: 'fp16',
		endpoint_slug: 'serving-provider',
		endpoint_class: 'standard',
		region: 'us',
		context_length: 128_000,
		max_prompt_tokens: 120_000,
		max_completion_tokens: 8_000,
	}),
	upstream_protocol: 'openai',
	route_pool_id: 'pool-internal-id',
	upstream_operation: 'chat',
	adapter: 'passthrough',
	surfaces: null,
	pool_name: null,
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: 'active',
	model_name: MODEL.display_name,
	provider_name: PROVIDER.name,
	provider_status: PROVIDER.status,
};

const ENDPOINT: ModelEndpointRow = {
	id: 'endpoint-internal-id',
	model_id: MODEL.id,
	provider_id: PROVIDER.id,
	provider_slug: 'serving-provider',
	tag: 'serving-provider',
	endpoint_class: 'standard',
	region: 'us',
	context_length: 128_000,
	max_prompt_tokens: 120_000,
	max_completion_tokens: 8_000,
	quantization: 'fp16',
	supported_parameters: '["temperature"]',
	pricing: '{"currency":"USD","prompt":"0.000003","completion":"0.000006"}',
	supports_implicit_caching: false,
	supports_voice_cloning: false,
	supports_tool_choice: '{"auto":true,"function":false,"none":true,"required":false}',
	image_capabilities: '{}',
	evidence_url: 'https://evidence.example/private-record',
	verified_by: 'console:private-operator',
	verified_at: '2026-08-01T00:00:00.000Z',
	expires_at: '2099-08-01T00:00:00.000Z',
	status: 'verified',
	created_at: '2026-08-01T00:00:00.000Z',
	updated_at: '2026-08-01T00:00:00.000Z',
};

function assertEvidenceBoundCache(response: Response): void {
	const cacheControl = response.headers.get('cache-control') ?? '';
	assert.match(cacheControl, /^public, max-age=(?:[1-5]?\d|60), must-revalidate$/u);
	assert.doesNotMatch(cacheControl, /stale-while-revalidate/u);
}

async function testRepositories(options?: {
	endpointExpiresAt?: string;
	policyExpiresAt?: string;
}) {
	const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(ROUTE, PROVIDER);
	const endpoint = options?.endpointExpiresAt
		? { ...ENDPOINT, expires_at: options.endpointExpiresAt }
		: ENDPOINT;
	const policies: RouteDataPolicyRow[] = options?.policyExpiresAt
		? [{
			route_target_id: ROUTE.id,
			subject_fingerprint: fingerprint,
			retention_days: 0,
			training_allowed: false,
			zdr_supported: true,
			evidence_url: 'https://evidence.example/zdr',
			verified_by: 'console:operator',
			verified_at: new Date(Date.now() - 60_000).toISOString(),
			expires_at: options.policyExpiresAt,
			status: 'verified',
			invalidated_at: null,
			invalidation_reason: null,
			updated_at: new Date(Date.now() - 60_000).toISOString(),
		}]
		: [];
	const binding: ModelEndpointDiscoveryRouteBindingRow = {
		endpoint_id: endpoint.id,
		subject_fingerprint: fingerprint,
		id: ROUTE.id,
		model_id: ROUTE.model_id,
		provider_id: ROUTE.provider_id,
		provider_model_name: ROUTE.provider_model_name,
		status: ROUTE.status,
		route_group: ROUTE.route_group,
		custom_params: ROUTE.custom_params,
		routing_metadata: ROUTE.routing_metadata,
		upstream_protocol: ROUTE.upstream_protocol,
		upstream_operation: ROUTE.upstream_operation,
		adapter: ROUTE.adapter,
		route_pool_id: ROUTE.route_pool_id,
		pool_status: ROUTE.pool_status,
	};
	let apiKeyReads = 0;
	let modelListReads = 0;
	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async () => {
				apiKeyReads += 1;
				return null;
			},
		},
		modelRouting: {
			listModelsWithActiveRoutes: async () => {
				modelListReads += 1;
				return [MODEL];
			},
			getModelById: async (id: string) => id === MODEL.id ? MODEL : null,
		},
		providers: {
			getProvidersByIds: async (ids: string[]) => ids.includes(PROVIDER.id) ? [PROVIDER] : [],
		},
		modelEndpoints: {
			list: async (filters: { offset?: number }) => (filters.offset ?? 0) === 0 ? [endpoint] : [],
			listByModelId: async (id: string, filters: { offset?: number }) =>
				id === MODEL.id && (filters.offset ?? 0) === 0 ? [endpoint] : [],
			listDiscoveryRouteBindings: async (ids: string[]) => ids.includes(endpoint.id) ? [binding] : [],
		},
		routeDataPolicies: { getByRouteTargetIds: async () => policies },
	} as unknown as GatewayRepositories;
	return {
		repositories,
		apiKeyReads: () => apiKeyReads,
		modelListReads: () => modelListReads,
	};
}

async function testApp(options?: Parameters<typeof testRepositories>[0]) {
	const fixture = await testRepositories(options);
	return {
		...fixture,
		app: createProxyApp(async () => ({ repositories: fixture.repositories } as StorageContext)),
	};
}

describe('anonymous OpenRouter public catalog', () => {
	it('serves both Provider paths with the exact nullable OpenRouter DTO and no API-key lookup', async () => {
		const { app, apiKeyReads } = await testApp();
		for (const path of ['/api/v1/providers', '/v1/providers']) {
			const response = await app.request(path, {}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200, path);
			assertEvidenceBoundCache(response);
			assert.deepEqual(await response.json(), {
				data: [{
					name: 'Serving Provider',
					slug: 'serving-provider',
					privacy_policy_url: null,
					terms_of_service_url: null,
					status_page_url: null,
					headquarters: null,
					datacenters: null,
				}],
			});
		}
		assert.equal(apiKeyReads(), 0);
	});

	it('publishes the OpenRouter model DTO and pagination envelope without raw metadata', async () => {
		const { app, apiKeyReads } = await testApp();
		const response = await app.request('/api/v1/models', {}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, 200);
		assert.equal(apiKeyReads(), 0);
		assertEvidenceBoundCache(response);
		const body = await response.json();
		assert.deepEqual(body, {
			data: [{
				id: MODEL.id,
				canonical_slug: MODEL.id,
				hugging_face_id: null,
				name: 'Model One',
				created: 1785542400,
				description: 'Public model description',
				context_length: 128_000,
				architecture: {
					modality: 'text->text',
					input_modalities: ['text'],
					output_modalities: ['text'],
					tokenizer: null,
					instruct_type: null,
				},
				pricing: {
					completion: '0.000006',
					prompt: '0.000003',
				},
				top_provider: null,
				per_request_limits: null,
				supported_parameters: ['temperature'],
				default_parameters: {},
				supported_voices: null,
				knowledge_cutoff: null,
				expiration_date: null,
				links: { details: '/api/v1/models/vendor/model-one/endpoints' },
				reasoning: null,
			}],
			total_count: 1,
			links: { next: null },
		});
		assert.doesNotMatch(JSON.stringify(body), /private\.example|must-not-leak|private-upstream|internal-id/iu);

		const legacy = await app.request('/v1/models', {}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(legacy.status, 401);
		assert.equal(apiKeyReads(), 0, 'missing credentials should be rejected before a repository key lookup');
	});

	it('applies bounded fact-backed filters and rejects every unsupported query value', async () => {
		const { app, modelListReads } = await testApp();
		const filtered = await app.request(
			'/api/v1/models?q=model&input_modalities=text&providers=Serving%20Provider&region=us&sort=newest&limit=1&offset=0',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(filtered.status, 200);
		assert.equal(filtered.headers.get('cache-control'), 'no-store');
		assert.deepEqual(
			(await filtered.json() as { data: Array<{ id: string }>; total_count: number }).data
				.map((model) => model.id),
			[MODEL.id],
		);

		const zdr = await app.request(
			'/api/v1/models?zdr=true',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(zdr.status, 200);
		assert.deepEqual(await zdr.json(), {
			data: [],
			total_count: 0,
			links: { next: null },
		});
		assert.equal(modelListReads(), 1, 'query variants must reuse one bounded catalog snapshot');

		const readsBeforeInvalidRequests = modelListReads();
		for (const query of [
			'limit=0',
			'limit=1001',
			'limit=1&limit=2',
			'offset=-1',
			'offset=1000001',
			'q=',
			'input_modalities=unknown',
			'providers=',
			'zdr=false',
			'region=apac',
			'sort=price-low-to-high',
			'route_groups=default',
		]) {
			const response = await app.request(
				`/api/v1/models?${query}`,
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 400, query);
			assert.equal(response.headers.get('cache-control'), 'no-store', query);
			assert.equal(
				response.headers.get('x-octafuse-error-code'),
				'gateway.invalid_request',
				query,
			);
		}
		assert.equal(
			modelListReads(),
			readsBeforeInvalidRequests,
			'invalid queries must be rejected before catalog repository reads',
		);
	});

	it('uses one bounded snapshot cache key for high-cardinality queries and never stores errors', async () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
		const entries = new Map<string, Response>();
		let puts = 0;
		Object.defineProperty(globalThis, 'caches', {
			configurable: true,
			value: {
				default: {
					match: async (request: Request) => entries.get(request.url)?.clone(),
					put: async (request: Request, response: Response) => {
						puts += 1;
						entries.set(request.url, response.clone());
					},
				},
			},
		});
		try {
			const fixture = await testApp();
			const first = await fixture.app.request(
				'/api/v1/models?limit=1&providers=SERVING-PROVIDER&offset=0',
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(first.status, 200);
			await drainNodeBackgroundWork();
			const second = await fixture.app.request(
				'/api/v1/models?offset=0&providers=serving-provider&limit=1',
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(second.status, 200);
			assert.equal(second.headers.get('access-control-allow-origin'), '*');
			assert.equal(fixture.modelListReads(), 1);
			assert.equal(puts, 1);
			assert.equal(entries.size, 1);
			assert.match([...entries.keys()][0] ?? '', /__cinatoken\/cache\/openrouter-public-catalog-v1$/u);

			for (let index = 0; index < 10; index += 1) {
				const variant = await fixture.app.request(
					`/api/v1/models?q=missing-${index}&offset=${index}`,
					{},
					{ REQUEST_BODY_LOGGING: 'off' },
				);
				assert.equal(variant.status, 200);
				assert.equal(variant.headers.get('cache-control'), 'no-store');
			}
			for (const path of [
				'/api/v1/models/random/not-found/endpoints',
				'/api/v1/models/another/not-found/endpoints',
			]) {
				assert.equal(
					(await fixture.app.request(path, {}, { REQUEST_BODY_LOGGING: 'off' })).status,
					404,
				);
			}
			assert.equal(fixture.modelListReads(), 1);
			assert.equal(puts, 1);

			let failures = 0;
			entries.clear();
			fixture.repositories.modelRouting.listModelsWithActiveRoutes = async () => {
				failures += 1;
				throw new Error('private repository failure');
			};
			const failingApp = createProxyApp(async () => ({
				repositories: fixture.repositories,
			} as StorageContext));
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const failed = await failingApp.request(
					'/api/v1/models?q=uncached-failure',
					{},
					{ REQUEST_BODY_LOGGING: 'off' },
				);
				assert.equal(failed.status, 500);
				assert.equal(failed.headers.get('cache-control'), 'no-store');
				assert.doesNotMatch(await failed.text(), /private repository failure/iu);
			}
			assert.equal(failures, 2);
			assert.equal(puts, 1, 'only the successful response may enter edge cache');
		} finally {
			await drainNodeBackgroundWork();
			if (previous) Object.defineProperty(globalThis, 'caches', previous);
			else Reflect.deleteProperty(globalThis, 'caches');
		}
	});

	it('serves canonical model endpoints anonymously without widening legacy or sensitive discovery', async () => {
		const { app, apiKeyReads } = await testApp();
		const response = await app.request(
			'/api/v1/models/vendor/model-one/endpoints',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(response.status, 200);
		assert.equal(apiKeyReads(), 0);
		assertEvidenceBoundCache(response);
		const body = await response.json() as { data: Record<string, unknown> };
		assert.equal(body.data.id, MODEL.id);
		assert.doesNotMatch(
			JSON.stringify(body),
			/private\.example|sk-provider|evidence\.example|console:|private-upstream|internal-id/iu,
		);

		for (const path of [
			'/v1/models/vendor/model-one/endpoints',
			'/api/v1/endpoints/zdr',
			'/api/v1/images/models',
		]) {
			assert.equal(
				(await app.request(path, {}, { REQUEST_BODY_LOGGING: 'off' })).status,
				401,
				path,
			);
		}
	});

	it('never caches beyond endpoint or ZDR evidence expiry and fails closed on miss limiting', async () => {
		for (const options of [
			{ endpointExpiresAt: new Date(Date.now() + 4_500).toISOString() },
			{ policyExpiresAt: new Date(Date.now() + 4_500).toISOString() },
		]) {
			const { app } = await testApp(options);
			const response = await app.request(
				'/api/v1/providers',
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 200);
			assert.match(
				response.headers.get('cache-control') ?? '',
				/^public, max-age=[1-4], must-revalidate$/u,
			);
			assert.doesNotMatch(response.headers.get('cache-control') ?? '', /stale/u);
		}

		const limited = await testApp();
		const limitedResponse = await limited.app.request(
			'/api/v1/providers',
			{},
			{
				REQUEST_BODY_LOGGING: 'off',
				PUBLIC_STATS_RATE_LIMITER: { limit: async () => ({ success: false }) },
			},
		);
		assert.equal(limitedResponse.status, 429);
		assert.equal(
			limitedResponse.headers.get('x-octafuse-error-code'),
			'gateway.public_catalog_rate_limited',
		);
		assert.equal(limited.modelListReads(), 0);

		const guarded = await testApp();
		const limiterKeys: string[] = [];
		const guardedEnv = {
			REQUEST_BODY_LOGGING: 'off',
			PUBLIC_STATS_RATE_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					limiterKeys.push(key);
					return { success: !key.includes(':query:') && !key.includes(':detail:') };
				},
			},
		};
		assert.equal(
			(await guarded.app.request('/api/v1/providers', {}, guardedEnv)).status,
			200,
		);
		assert.equal(
			(await guarded.app.request('/api/v1/models?q=variant', {}, guardedEnv)).status,
			429,
		);
		assert.equal(
			(await guarded.app.request(
				'/api/v1/models/vendor/model-one/endpoints',
				{},
				guardedEnv,
			)).status,
			429,
		);
		assert.ok(limiterKeys.some((key) => key.includes(':query:unknown')));
		assert.ok(limiterKeys.some((key) => key.includes(':detail:unknown')));
		assert.equal(guarded.modelListReads(), 1);
	});
});

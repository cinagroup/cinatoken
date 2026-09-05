import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type GatewayRepositories,
	type ManagementApiKeyRow,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
	type ModelRow,
	type ProviderRow,
	type PublicModelAnalyticsRow,
	type RouteAvailabilityAggregate,
	type RoutePerformanceSample,
	type RouteDataPolicyRow,
	type StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';
import { drainNodeBackgroundWork } from '../../runtime/schedule-background-work';

const MANAGEMENT_SECRET = `sk-cina-mgmt-${'a'.repeat(64)}`;
const MANAGEMENT_ROW: ManagementApiKeyRow = {
	id: 'management-1',
	key_hash: `sha256:${'a'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-aaaa…aaaa',
	account_type: 'personal',
	personal_owner_user_id: 'user-1',
	organization_id: null,
	name: 'Endpoint discovery',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-1',
	created_at: '2026-08-31T00:00:00.000Z',
	updated_at: '2026-08-31T00:00:00.000Z',
};

function managementBearer(): RequestInit {
	return { headers: { Authorization: `Bearer ${MANAGEMENT_SECRET}` } };
}

const MODEL: ModelRow = {
	id: 'vendor/model-one',
	display_name: 'Model One',
	vendor: 'Vendor',
	context_window: 128_000,
	max_tokens: 8_000,
	pricing_profile: JSON.stringify({
		tiers: [{ upto: null, input_price: 3, output_price: 6 }],
	}),
	tags: '["chat","programming"]',
	description: 'Public model description',
	metadata: JSON.stringify({
		private_endpoint: 'https://private.example/v1',
		upstream_secret: 'must-not-leak',
		architecture: 'GPT',
		tokenizer: 'CinaTokenizer',
		instruct_type: 'chatml',
		distillable_text: true,
		categories: ['technology'],
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

function discoveryBinding(
	endpoint: ModelEndpointRow,
	route: ModelRouteJoinRow,
	subjectFingerprint: string
): ModelEndpointDiscoveryRouteBindingRow {
	return {
		endpoint_id: endpoint.id,
		subject_fingerprint: subjectFingerprint,
		id: route.id,
		model_id: route.model_id,
		provider_id: route.provider_id,
		provider_model_name: route.provider_model_name,
		status: route.status,
		route_group: route.route_group,
		custom_params: route.custom_params,
		routing_metadata: route.routing_metadata,
		upstream_protocol: route.upstream_protocol,
		upstream_operation: route.upstream_operation,
		adapter: route.adapter,
		route_pool_id: route.route_pool_id,
		pool_status: route.pool_status,
	};
}

function assertEvidenceBoundCache(response: Response): void {
	const cacheControl = response.headers.get('cache-control') ?? '';
	assert.match(cacheControl, /^public, max-age=(?:[1-5]?\d|60), must-revalidate$/u);
	assert.doesNotMatch(cacheControl, /stale-while-revalidate/u);
}

async function testRepositories(options?: {
	endpointExpiresAt?: string;
	policyExpiresAt?: string;
	model?: ModelRow;
	route?: ModelRouteJoinRow;
	endpoint?: ModelEndpointRow;
	performanceSamples?: RoutePerformanceSample[];
	availabilityAggregates?: RouteAvailabilityAggregate[];
	popularityRows?: PublicModelAnalyticsRow[];
}) {
	const model = options?.model ?? MODEL;
	const route = options?.route ?? { ...ROUTE, model_id: model.id };
	const baseEndpoint = options?.endpoint ?? { ...ENDPOINT, model_id: model.id };
	const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, PROVIDER);
	const endpoint = options?.endpointExpiresAt
		? { ...baseEndpoint, expires_at: options.endpointExpiresAt }
		: baseEndpoint;
	const policies: RouteDataPolicyRow[] = options?.policyExpiresAt
		? [{
			route_target_id: route.id,
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
	const binding = discoveryBinding(endpoint, route, fingerprint);
	let apiKeyReads = 0;
	let modelListReads = 0;
	let performanceReads = 0;
	let popularityReads = 0;
	const repositories = {
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === MANAGEMENT_SECRET ? MANAGEMENT_ROW : null,
		},
		apiKeys: {
			getApiKeyWithUserByKey: async () => {
				apiKeyReads += 1;
				return null;
			},
		},
		modelRouting: {
			listModelsWithActiveRoutes: async () => {
				modelListReads += 1;
				return [model];
			},
			getModelById: async (id: string) => id === model.id ? model : null,
		},
		providers: {
			getProvidersByIds: async (ids: string[]) => ids.includes(PROVIDER.id) ? [PROVIDER] : [],
		},
		modelEndpoints: {
			list: async (filters: { offset?: number }) => (filters.offset ?? 0) === 0 ? [endpoint] : [],
			listByModelId: async (id: string, filters: { offset?: number }) =>
				id === model.id && (filters.offset ?? 0) === 0 ? [endpoint] : [],
			listDiscoveryRouteBindings: async (ids: string[]) => ids.includes(endpoint.id) ? [binding] : [],
		},
		routeDataPolicies: { getByRouteTargetIds: async () => policies },
		analytics: {
			queryPublicModelAnalytics: async () => {
				popularityReads += 1;
				return options?.popularityRows ?? [];
			},
		},
		requestLogs: {
			getRecentRoutePerformanceSamples: async () => {
				performanceReads += 1;
				return options?.performanceSamples ?? [];
			},
			getRouteAvailabilityAggregates: async () => options?.availabilityAggregates ?? [],
		},
	} as unknown as GatewayRepositories;
	return {
		repositories,
		apiKeyReads: () => apiKeyReads,
		modelListReads: () => modelListReads,
		performanceReads: () => performanceReads,
		popularityReads: () => popularityReads,
	};
}

async function testApp(options?: Parameters<typeof testRepositories>[0]) {
	const fixture = await testRepositories(options);
	return {
		...fixture,
		app: createProxyApp(async () => ({ repositories: fixture.repositories } as StorageContext)),
	};
}

describe('OpenRouter public catalog and managed endpoint details', () => {
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
					tokenizer: 'CinaTokenizer',
					instruct_type: 'chatml',
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

	it('serves the matching anonymous model count contract from the same bounded snapshot', async () => {
		const { app, modelListReads, apiKeyReads } = await testApp();
		const defaultResponse = await app.request(
			'/api/v1/models/count',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(defaultResponse.status, 200);
		assertEvidenceBoundCache(defaultResponse);
		assert.deepEqual(await defaultResponse.json(), { data: { count: 1 } });

		const imageResponse = await app.request(
			'/api/v1/models/count?output_modalities=image',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(imageResponse.status, 200);
		assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await imageResponse.json(), { data: { count: 0 } });

		const allResponse = await app.request(
			'/api/v1/models/count?output_modalities=all',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(allResponse.status, 200);
		assert.deepEqual(await allResponse.json(), { data: { count: 1 } });
		assert.equal(modelListReads(), 1);
		assert.equal(apiKeyReads(), 0);

		const invalid = await testApp();
		const invalidResponse = await invalid.app.request(
			'/api/v1/models/count?q=model',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(invalidResponse.status, 400);
		assert.equal(invalid.modelListReads(), 0, 'invalid count queries must fail before catalog reads');
	});

	it('serves an exact anonymous single-model DTO without widening discovery', async () => {
		const { app, apiKeyReads, modelListReads } = await testApp();
		const response = await app.request(
			'/api/v1/model/vendor/model-one',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(response.status, 200);
		assertEvidenceBoundCache(response);
		const body = await response.json() as { data: { id: string; links: { details: string } } };
		assert.equal(body.data.id, MODEL.id);
		assert.equal(body.data.links.details, '/api/v1/models/vendor/model-one/endpoints');
		assert.equal(apiKeyReads(), 0);
		assert.equal(modelListReads(), 1);
		assert.doesNotMatch(
			JSON.stringify(body),
			/private\.example|must-not-leak|private-upstream|internal-id/iu,
		);

		const missing = await app.request(
			'/api/v1/model/vendor/missing',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(missing.status, 404);
		assert.equal(missing.headers.get('cache-control'), 'no-store');
		assert.equal(modelListReads(), 1);

		const invalid = await testApp();
		const invalidQuery = await invalid.app.request(
			'/api/v1/model/vendor/model-one?q=model',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(invalidQuery.status, 400);
		assert.equal(invalid.modelListReads(), 0);
	});

	it('applies bounded fact-backed filters and rejects every unsupported query value', async () => {
		const { app, modelListReads } = await testApp();
		const filtered = await app.request(
			'/api/v1/models?q=model&input_modalities=text&supported_parameters=temperature&context=128000&model_authors=Vendor&providers=Serving%20Provider&region=us&category=programming&arch=gpt&distillable=true&min_age_days=0&max_age_days=1000000&min_price=3&max_price=3&min_output_price=6&max_output_price=6&sort=newest&limit=1&offset=0',
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
		for (const query of [
			'context=128001',
			'supported_parameters=tools',
			'model_authors=another-vendor',
			'category=legal',
			'arch=claude',
			'distillable=false',
			'max_age_days=0',
		]) {
			const response = await app.request(
				`/api/v1/models?${query}`,
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 200, query);
			assert.equal((await response.json() as { total_count: number }).total_count, 0, query);
		}
		const metadataCategory = await app.request(
			'/api/v1/models?category=technology',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(metadataCategory.status, 200);
		assert.equal(
			(await metadataCategory.json() as { total_count: number }).total_count,
			1,
		);
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
			'output_modalities=',
			'output_modalities=unknown',
			'output_modalities=all,text',
			'output_modalities=speech,speech',
			'output_modalities=speech&output_modalities=text',
			'supported_parameters=',
			'supported_parameters=temperature,temperature',
			'context=0',
			'context=-1',
			'context=1000000001',
			'context=1&context=2',
			'model_authors=',
			'model_authors=vendor,vendor',
			'providers=',
			'zdr=false',
			'region=apac',
			'category=unknown',
			'category=programming&category=legal',
			'arch=',
			'distillable=yes',
			'distillable=true&distillable=false',
			'min_age_days=-1',
			'min_age_days=1000001',
			'min_age_days=1&min_age_days=2',
			'max_age_days=-1',
			'max_age_days=1000001',
			'min_age_days=2&max_age_days=1',
			'min_price=-1',
			'min_price=Infinity',
			'min_price=1&min_price=2',
			'max_price=9007199254740992',
			'min_price=2&max_price=1',
			'min_output_price=-1',
			'max_output_price=NaN',
			'min_output_price=2&max_output_price=1',
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

	it('uses an explicitly selected top endpoint for effective prices, filters, and stable price sorts', async () => {
		const selectedModel: ModelRow = {
			...MODEL,
			id: 'vendor/selected-price',
			display_name: 'Selected Price',
			metadata: JSON.stringify({
				private_endpoint: 'https://private.example/selected',
				public_catalog_top_provider: {
					endpoint_tag: 'selected-premium',
					is_moderated: true,
				},
			}),
		};
		const lowModel: ModelRow = {
			...MODEL,
			id: 'vendor/low-price',
			display_name: 'Low Price',
			metadata: '{}',
		};
		const invalidSelectorModel: ModelRow = {
			...MODEL,
			id: 'vendor/unknown-price',
			display_name: 'Unknown Price',
			metadata: JSON.stringify({
				public_catalog_top_provider: {
					endpoint_tag: 'missing-endpoint',
					is_moderated: false,
				},
			}),
		};
		const models = [selectedModel, lowModel, invalidSelectorModel];
		const endpointInputs = [
			{ model: selectedModel, tag: 'selected-cheap', prompt: '0.000001', completion: '0.000002' },
			{
				model: selectedModel,
				tag: 'selected-premium',
				prompt: '0.00001',
				completion: '0.00002',
				discount: 0.7,
			},
			{ model: lowModel, tag: 'low-only', prompt: '0.000001', completion: '0.000002' },
			{ model: invalidSelectorModel, tag: 'unknown-one', prompt: '0.000002', completion: '0.000003' },
			{ model: invalidSelectorModel, tag: 'unknown-two', prompt: '0.000004', completion: '0.000005' },
		] as const;
		const endpoints = endpointInputs.map((input, index): ModelEndpointRow => ({
			...ENDPOINT,
			id: `price-endpoint-${index}`,
			model_id: input.model.id,
			tag: input.tag,
			pricing: JSON.stringify({
				currency: 'USD',
				prompt: input.prompt,
				completion: input.completion,
				...('discount' in input ? { discount: input.discount } : {}),
			}),
		}));
		const routes = endpointInputs.map((input, index): ModelRouteJoinRow => ({
			...ROUTE,
			id: `price-route-${index}`,
			model_id: input.model.id,
			provider_model_name: `price-upstream-${index}`,
			route_pool_id: `price-pool-${index}`,
			routing_metadata: null,
			model_name: input.model.display_name,
		}));
		const fingerprints = await Promise.all(
			routes.map((route) => computeRouteDataPolicySubjectFingerprintFromRows(route, PROVIDER)),
		);
		const bindings = routes.map((route, index) => discoveryBinding(
			endpoints[index]!,
			route,
			fingerprints[index]!,
		));
		const fixture = await testRepositories();
		fixture.repositories.modelRouting.listModelsWithActiveRoutes = async () => models;
		fixture.repositories.modelEndpoints.list = async (filters) => (
			(filters.offset ?? 0) === 0 ? endpoints : []
		);
		fixture.repositories.modelEndpoints.listDiscoveryRouteBindings = async (ids) => (
			bindings.filter((binding) => ids.includes(binding.endpoint_id))
		);
		const app = createProxyApp(async () => ({
			repositories: fixture.repositories,
		} as StorageContext));

		const selectedResponse = await app.request(
			'/api/v1/models?q=selected-price',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(selectedResponse.status, 200);
		const selectedBody = await selectedResponse.json() as {
			data: Array<{
				pricing: Record<string, string>;
				top_provider: unknown;
			}>;
		};
		assert.deepEqual(selectedBody.data[0]?.pricing, {
			completion: '0.000006',
			prompt: '0.000003',
		});
		assert.deepEqual(selectedBody.data[0]?.top_provider, {
			context_length: 128_000,
			max_completion_tokens: 8_000,
			is_moderated: true,
		});
		assert.doesNotMatch(JSON.stringify(selectedBody), /private\.example|discount/iu);

		const selectedFilter = await app.request(
			'/api/v1/models?min_price=3&max_price=4&min_output_price=5&max_output_price=7',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(selectedFilter.status, 200);
		assert.deepEqual(
			(await selectedFilter.json() as { data: Array<{ id: string }> }).data.map((model) => model.id),
			[selectedModel.id],
		);

		for (const [sort, expected] of [
			['pricing-low-to-high', [lowModel.id, selectedModel.id, invalidSelectorModel.id]],
			['pricing-high-to-low', [selectedModel.id, lowModel.id, invalidSelectorModel.id]],
		] as const) {
			const response = await app.request(
				`/api/v1/models?sort=${sort}`,
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 200, sort);
			const body = await response.json() as { data: Array<{ id: string; pricing: unknown }> };
			assert.deepEqual(body.data.map((model) => model.id), expected, sort);
			assert.deepEqual(body.data.at(-1)?.pricing, {}, 'invalid selector must fail closed');
		}

		const page = await app.request(
			'/api/v1/models?sort=pricing-low-to-high&min_price=0&max_price=10&min_output_price=0&max_output_price=10&limit=1',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(page.status, 200);
		const pageBody = await page.json() as { links: { next: string | null }; total_count: number };
		assert.equal(pageBody.total_count, 2, 'unknown prices must not satisfy any price bound');
		const next = new URL(pageBody.links.next ?? '', 'https://cinatoken.test');
		assert.equal(next.searchParams.get('sort'), 'pricing-low-to-high');
		assert.equal(next.searchParams.get('min_price'), '0');
		assert.equal(next.searchParams.get('max_price'), '10');
		assert.equal(next.searchParams.get('min_output_price'), '0');
		assert.equal(next.searchParams.get('max_output_price'), '10');
	});

	it('sorts models by privacy-qualified p50 performance and places missing evidence last', async () => {
		const models = [
			{
				...MODEL,
				id: 'vendor/high-throughput',
				display_name: 'High Throughput',
			},
			{
				...MODEL,
				id: 'vendor/low-latency',
				display_name: 'Low Latency',
			},
			{
				...MODEL,
				id: 'vendor/no-performance-data',
				display_name: 'No Performance Data',
			},
		] satisfies ModelRow[];
		const routes = models.map((model, index): ModelRouteJoinRow => ({
			...ROUTE,
			id: `performance-route-${index}`,
			model_id: model.id,
			provider_model_name: `provider-performance-model-${index}`,
			route_pool_id: `performance-pool-${index}`,
			model_name: model.display_name,
		}));
		const endpoints = models.map((model, index): ModelEndpointRow => ({
			...ENDPOINT,
			id: `performance-endpoint-${index}`,
			model_id: model.id,
		}));
		const fingerprints = await Promise.all(
			routes.map((route) => computeRouteDataPolicySubjectFingerprintFromRows(route, PROVIDER))
		);
		const bindings = routes.map((route, index) => discoveryBinding(
			endpoints[index]!,
			route,
			fingerprints[index]!
		));
		const samples = routes.slice(0, 2).flatMap((route, routeIndex) => (
			Array.from({ length: 20 }, (): RoutePerformanceSample => ({
				route_target_id: route.id,
				output_tokens: routeIndex === 0 ? 100 : 10,
				latency_ms: null,
				upstream_response_ms: null,
				final_upstream_headers_ms: 100,
				first_reasoning_token_ms: null,
				first_token_ms: routeIndex === 0 ? 1_000 : 200,
				stream_duration_ms: 900,
				created_at: new Date().toISOString(),
			}))
		));
		const fixture = await testRepositories({
			performanceSamples: samples,
			popularityRows: [
				{ model_id: models[0]!.id, request_count: 20, success_count: 20, error_count: 0, output_tokens: 80, total_tokens: 200, avg_latency_ms: 20 },
				{ model_id: models[1]!.id, request_count: 20, success_count: 20, error_count: 0, output_tokens: 200, total_tokens: 500, avg_latency_ms: 20 },
				{ model_id: models[2]!.id, request_count: 19, success_count: 19, error_count: 0, output_tokens: 900, total_tokens: 1_000, avg_latency_ms: 20 },
			],
		});
		fixture.repositories.modelRouting.listModelsWithActiveRoutes = async () => models;
		fixture.repositories.modelEndpoints.list = async (filters) => (
			(filters.offset ?? 0) === 0 ? endpoints : []
		);
		fixture.repositories.modelEndpoints.listDiscoveryRouteBindings = async (ids) => (
			bindings.filter((binding) => ids.includes(binding.endpoint_id))
		);
		const app = createProxyApp(async () => ({
			repositories: fixture.repositories,
		} as StorageContext));

		const throughputResponse = await app.request(
			'/api/v1/models?sort=throughput-high-to-low&limit=1&category=programming&arch=gpt&distillable=true&min_age_days=0&max_age_days=1000000',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(throughputResponse.status, 200);
		assert.equal(throughputResponse.headers.get('cache-control'), 'no-store');
		const throughput = await throughputResponse.json() as {
			data: Array<{ id: string }>;
			links: { next: string | null };
		};
		assert.deepEqual(throughput.data.map((model) => model.id), ['vendor/high-throughput']);
		const next = new URL(throughput.links.next ?? '', 'https://cinatoken.test');
		assert.equal(next.searchParams.get('sort'), 'throughput-high-to-low');
		assert.equal(next.searchParams.get('category'), 'programming');
		assert.equal(next.searchParams.get('arch'), 'gpt');
		assert.equal(next.searchParams.get('distillable'), 'true');
		assert.equal(next.searchParams.get('min_age_days'), '0');
		assert.equal(next.searchParams.get('max_age_days'), '1000000');

		const latencyResponse = await app.request(
			'/api/v1/models?sort=latency-low-to-high',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(latencyResponse.status, 200);
		const latency = await latencyResponse.json() as { data: Array<{ id: string }> };
		assert.deepEqual(latency.data.map((model) => model.id), [
			'vendor/low-latency',
			'vendor/high-throughput',
			'vendor/no-performance-data',
		]);
		assert.equal(fixture.performanceReads(), 1, 'query variants must reuse one bounded metric snapshot');
		assert.doesNotMatch(JSON.stringify(latency), /latencyP50|throughputP50/u);

		for (const sort of ['most-popular', 'top-weekly'] as const) {
			const popularityResponse = await app.request(
				`/api/v1/models?sort=${sort}`,
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(popularityResponse.status, 200, sort);
			const popularity = await popularityResponse.json() as { data: Array<{ id: string }> };
			assert.deepEqual(popularity.data.map((model) => model.id), [
				'vendor/low-latency',
				'vendor/high-throughput',
				'vendor/no-performance-data',
			], sort);
			assert.doesNotMatch(JSON.stringify(popularity), /weeklyTokens|total_tokens/u);
		}
		assert.equal(fixture.popularityReads(), 1, 'sort aliases must reuse one bounded weekly snapshot');
	});

	it('normalizes legacy TTS rows for the OpenRouter output_modalities contract', async () => {
		const model: ModelRow = {
			...MODEL,
			id: 'vendor/tts-one',
			display_name: 'TTS One',
			context_window: null,
			max_tokens: null,
			pricing_profile: JSON.stringify({
				audio_billing_mode: 'per_character',
				audio: { price_per_character: 0.00002 },
			}),
			input_modalities: '["text"]',
			output_modalities: '["audio"]',
		};
		const route: ModelRouteJoinRow = {
			...ROUTE,
			id: 'tts-route',
			model_id: model.id,
			routing_metadata: null,
			upstream_operation: 'audio.speech',
		};
		const endpoint: ModelEndpointRow = {
			...ENDPOINT,
			id: 'tts-endpoint',
			model_id: model.id,
			context_length: null,
			max_prompt_tokens: null,
			max_completion_tokens: null,
			pricing: '{}',
			audio_capabilities: JSON.stringify({
				v: 1,
				pricing_by_operation: {
					'audio.speech': {
						currency: 'USD',
						meter: {
							kind: 'characters',
							unit: 'unicode_code_point',
							price: '0.00002',
							minimum_units: 0,
							increment_units: 1,
						},
					},
				},
			}),
		};
		const { app, modelListReads } = await testApp({ model, route, endpoint });

		const defaultResponse = await app.request(
			'/api/v1/models',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(defaultResponse.status, 200);
		assert.deepEqual((await defaultResponse.json() as { data: unknown[] }).data, []);

		const speechResponse = await app.request(
			'/api/v1/models?output_modalities=speech',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(speechResponse.status, 200);
		assert.equal(speechResponse.headers.get('cache-control'), 'no-store');
		const speechBody = await speechResponse.json() as {
			data: Array<{
				id: string;
				context_length: number;
				architecture: { output_modalities: string[] };
				pricing: Record<string, string>;
			}>;
		};
		assert.equal(speechBody.data[0]?.id, model.id);
		assert.equal(speechBody.data[0]?.context_length, 0);
		assert.deepEqual(speechBody.data[0]?.architecture.output_modalities, ['speech']);
		assert.deepEqual(speechBody.data[0]?.pricing, {
			completion: '0',
			prompt: '0.00002',
		});
		const priceFilteredSpeech = await app.request(
			'/api/v1/models?output_modalities=speech&max_price=100',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(priceFilteredSpeech.status, 200);
		assert.equal(
			(await priceFilteredSpeech.json() as { total_count: number }).total_count,
			0,
			'per-character prices must not be compared as token prices per million',
		);

		const allResponse = await app.request(
			'/api/v1/models?output_modalities=all',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(allResponse.status, 200);
		assert.equal((await allResponse.json() as { total_count: number }).total_count, 1);
		assert.equal(modelListReads(), 1);
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
			assert.match([...entries.keys()][0] ?? '', /__cinatoken\/cache\/openrouter-public-catalog-v6$/u);

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
					(await fixture.app.request(
						path,
						managementBearer(),
						{ REQUEST_BODY_LOGGING: 'off' },
					)).status,
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

	it('requires a Management key for canonical model endpoints without widening other discovery', async () => {
		const performanceSamples = Array.from({ length: 20 }, (_, index): RoutePerformanceSample => ({
			route_target_id: ROUTE.id,
			output_tokens: index + 1,
			latency_ms: null,
			upstream_response_ms: null,
			final_upstream_headers_ms: 0,
			first_reasoning_token_ms: null,
			first_token_ms: (index + 1) * 100,
			stream_duration_ms: 1_000,
			created_at: new Date().toISOString(),
		}));
		const availabilityAggregates: RouteAvailabilityAggregate[] = [{
			route_target_id: ROUTE.id,
			available_5m: 100,
			total_5m: 100,
			available_30m: 190,
			total_30m: 200,
			available_1d: 990,
			total_1d: 1_000,
		}];
		const { app, apiKeyReads, performanceReads } = await testApp({
			performanceSamples,
			availabilityAggregates,
		});
		const unauthenticated = await app.request(
			'/api/v1/models/vendor/model-one/endpoints',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(unauthenticated.status, 401);
		const response = await app.request(
			'/api/v1/models/vendor/model-one/endpoints',
			managementBearer(),
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(response.status, 200);
		assert.equal(apiKeyReads(), 0);
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
		const body = await response.json() as {
			data: Record<string, unknown> & {
				endpoints: Array<{
					latency_last_30m: unknown;
					throughput_last_30m: unknown;
					uptime_last_30m: unknown;
				}>;
			};
		};
		assert.equal(body.data.id, MODEL.id);
		assert.deepEqual(body.data.endpoints[0]?.latency_last_30m, {
			p50: 1, p75: 1.5, p90: 1.8, p99: 2,
		});
		assert.deepEqual(body.data.endpoints[0]?.throughput_last_30m, {
			p50: 10, p75: 5, p90: 2, p99: 1,
		});
		assert.equal(body.data.endpoints[0]?.uptime_last_30m, 95);
		assert.equal(performanceReads(), 1);
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
			(await guarded.app.request('/api/v1/model/vendor/model-one', {}, guardedEnv)).status,
			429,
		);
		assert.equal(
			(await guarded.app.request(
				'/api/v1/models/vendor/model-one/endpoints',
				managementBearer(),
				guardedEnv,
			)).status,
			200,
		);
		assert.ok(limiterKeys.some((key) => key.includes(':query:unknown')));
		assert.ok(limiterKeys.some((key) => key.includes(':detail:unknown')));
		assert.equal(guarded.modelListReads(), 1);
	});
});

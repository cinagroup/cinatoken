import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeRouteDataPolicySubjectFingerprintFromRows, type GatewayRepositories, type StorageContext } from '@octafuse/core';
import { Hono } from 'hono';
import { createProxyApp, type Env } from '../app';
import { listCatalogDiscoveryModels } from '../services/catalog-discovery';
import { createInMemoryPublicStatsRuntimeGuard } from '../services/public-stats-runtime-guard';
import { catalogRoutes, createCatalogRoutes } from './catalog';

function cachedStats(range = '7d') {
	const end = new Date();
	const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
	const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
	start.setUTCDate(start.getUTCDate() - (days - 1));
	return {
		object: 'list',
		data: [],
		range,
		window_start: start.toISOString(),
		window_end: end.toISOString(),
		minimum_sample_size: 20,
		generated_at: end.toISOString(),
	};
}

function emptyCatalogRepositories(options: { currency?: unknown; modelFailure?: boolean; analyticsFailure?: boolean } = {}) {
	const calls = { models: 0, analytics: 0, currency: 0 };
	const repositories = {
		modelRouting: {
			listModelsWithActiveRoutes: async () => {
				calls.models += 1;
				if (options.modelFailure) throw new Error('private-provider-key/internal-database');
				return [];
			},
		},
		routeDataPolicies: { getByRouteTargetIds: async () => [] },
		systemConfig: {
			getConfig: async () => {
				calls.currency += 1;
				if (options.currency instanceof Error) throw options.currency;
				return Object.hasOwn(options, 'currency') ? options.currency : 'USD';
			},
		},
		analytics: {
			queryPublicModelAnalytics: async () => {
				calls.analytics += 1;
				if (options.analyticsFailure) throw new Error('private-provider-key/internal-database');
				return [];
			},
		},
	} as unknown as GatewayRepositories;
	return { repositories, calls };
}

function publicCatalogApp(repositories: GatewayRepositories, routes = createCatalogRoutes()) {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('repositories', repositories);
		await next();
	});
	app.route('/catalog', routes);
	return app;
}

async function assertUnavailable(response: Response) {
	assert.equal(response.status, 503);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('retry-after'), '60');
	assert.deepEqual(await response.json(), {
		error: { code: 'public_catalog_temporarily_unavailable', message: 'Public catalog is temporarily unavailable' },
	});
}

describe('GET /catalog/models', () => {
	it('returns sanitized list, detail, and provider aggregates without authentication', async () => {
		let rawAnalyticsCalls = 0;
		let publicAnalyticsCalls = 0;
		let pricingProfile: unknown = { tiers: [{ upto: null, input_price: 1, output_price: 3 }] };
		let billingCurrency = 'cny';
		let requestCount = 25;
		const provider = {
			id: 'provider-1',
			name: 'Provider',
			endpoints: '{"openai":{"base":"https://api.example/v1"}}',
			api_key: 'secret',
			status: 'active',
			description: null,
			shared_channel_type: null,
			created_at: '2026-08-01T00:00:00.000Z',
		};
		const route = {
			id: 'route-1',
			model_id: 'vendor/model',
			provider_id: 'provider-1',
			provider_model_name: 'upstream-model',
			priority: 0,
			status: 'active',
			route_group: 'default',
			weight: 1,
			price_override: null,
			custom_params: null,
			routing_metadata: JSON.stringify({
				supported_parameters: ['tools'],
				quantization: 'fp8',
				endpoint_slug: 'provider/turbo',
				endpoint_class: 'standard',
				region: 'eu',
			}),
			upstream_protocol: 'openai',
			route_pool_id: 'pool-1',
			upstream_operation: 'chat',
			adapter: 'passthrough',
			surfaces: null,
			pool_name: null,
			pool_strategy: null,
			pool_tier_strategies: null,
			pool_status: 'active',
			model_name: 'Model',
			provider_name: 'Provider',
			provider_status: 'active',
		};
		const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const endpoint = {
			id: 'endpoint-1',
			model_id: route.model_id,
			provider_id: provider.id,
			provider_slug: 'provider',
			tag: 'provider/turbo',
			endpoint_class: 'standard',
			region: 'eu',
			context_length: 128_000,
			max_prompt_tokens: 120_000,
			max_completion_tokens: 8_000,
			quantization: 'fp8',
			supported_parameters: '["tools"]',
			pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000003"}',
			supports_implicit_caching: false,
			supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":false}',
			image_capabilities: '{}',
			evidence_url: 'https://provider.example/endpoint-evidence',
			verified_by: 'console:admin',
			verified_at: '2026-08-01T00:00:00.000Z',
			expires_at: '2099-08-01T00:00:00.000Z',
			status: 'verified',
			created_at: '2026-08-01T00:00:00.000Z',
			updated_at: '2026-08-01T00:00:00.000Z',
		};
		const repositories = {
			modelRouting: {
				listModelsWithActiveRoutes: async () => [
					{
						id: 'vendor/model',
						display_name: 'Model',
						vendor: 'Vendor',
						context_window: 128_000,
						max_tokens: 8_192,
						pricing_profile: JSON.stringify(pricingProfile),
						tags: '[]',
						description: 'Public description',
						input_modalities: JSON.stringify(['text']),
						output_modalities: JSON.stringify(['text']),
						released_at: '2026-08-01',
						metadata: JSON.stringify({ upstream_secret: 'must-not-leak' }),
					},
				],
			},
			routes: {
				listModelRoutesWithJoins: async () => {
					throw new Error('catalog must not scan all routes');
				},
			},
			providers: { getProvidersByIds: async (ids: string[]) => (ids.includes(provider.id) ? [provider] : []) },
			modelEndpoints: {
				list: async (filters: { offset?: number }) => ((filters.offset ?? 0) === 0 ? [endpoint] : []),
				listDiscoveryRouteBindings: async (ids: string[]) =>
					ids.includes(endpoint.id)
						? [
								{
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
								},
							]
						: [],
			},
			routeDataPolicies: {
				getByRouteTargetIds: async () => [
					{
						route_target_id: 'route-1',
						subject_fingerprint: subjectFingerprint,
						retention_days: 0,
						training_allowed: false,
						zdr_supported: true,
						evidence_url: 'https://provider.example/privacy',
						verified_by: 'console:admin',
						verified_at: '2026-08-01T00:00:00.000Z',
						expires_at: '2099-08-01T00:00:00.000Z',
						status: 'verified',
						invalidated_at: null,
						invalidation_reason: null,
						updated_at: '2026-08-01T00:00:00.000Z',
					},
				],
			},
			systemConfig: { getConfig: async () => billingCurrency },
			analytics: {
				queryModelAnalytics: async () => {
					rawAnalyticsCalls += 1;
					throw new Error('public route must not scan request logs');
				},
				queryPublicModelAnalytics: async () => {
					publicAnalyticsCalls += 1;
					return [
						{
							model_id: 'vendor/model',
							route_group: 'default',
							request_count: requestCount,
							success_count: 24,
							error_count: 1,
							input_tokens: 100,
							output_tokens: 200,
							total_tokens: 300,
							avg_latency_ms: 120,
						},
					];
				},
			},
		} as unknown as GatewayRepositories;
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.route('/catalog', catalogRoutes);

		const response = await app.request('/catalog/models');
		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.billing_currency, 'CNY');
		assert.equal(response.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=300');
		const models = body.data as Array<Record<string, unknown>>;
		assert.equal(models[0]?.slug, '~dmVuZG9yL21vZGVs');
		assert.equal('metadata' in models[0]!, false);
		assert.deepEqual(models[0]?.endpoint_slugs, ['provider/turbo']);
		assert.deepEqual(models[0]?.regions, ['eu']);
		assert.equal(JSON.stringify(models[0]).includes('api.example'), false);
		assert.deepEqual(models[0]?.data_policy_summary, {
			verified_route_count: 1,
			zdr_available: true,
			latest_verified_at: '2026-08-01T00:00:00.000Z',
		});

		const detailResponse = await app.request('/catalog/models/vendor/~dmVuZG9yL21vZGVs');
		assert.equal(detailResponse.status, 200);
		const detail = (await detailResponse.json()) as { data: { id: string } };
		assert.equal(detail.data.id, 'vendor/model');

		const providersResponse = await app.request('/catalog/providers');
		assert.equal(providersResponse.status, 200);
		const providers = (await providersResponse.json()) as { data: Array<{ id: string; model_count: number }> };
		assert.deepEqual(providers.data, [
			{
				id: 'vendor',
				display_name: 'Vendor',
				model_count: 1,
				protocols: ['openai'],
				route_groups: ['default'],
				input_modalities: ['text'],
				output_modalities: ['text'],
				latest_released_at: '2026-08-01',
			},
		]);

		let limiterCalls = 0;
		const statsResponse = await app.request('/catalog/stats/models?range=7d', undefined, {
			PUBLIC_STATS_RATE_LIMITER: {
				limit: async () => {
					limiterCalls += 1;
					return { success: true };
				},
			},
		});
		assert.equal(statsResponse.status, 200);
		const stats = (await statsResponse.json()) as { minimum_sample_size: number; data: Array<Record<string, unknown>> };
		assert.equal(stats.minimum_sample_size, 20);
		assert.deepEqual(stats.data, [
			{
				id: 'vendor/model',
				slug: '~dmVuZG9yL21vZGVs',
				display_name: 'Model',
				vendor: 'Vendor',
				request_count: 25,
				success_rate: 96,
				avg_latency_ms: 120,
				output_tokens: 200,
				total_tokens: 300,
			},
		]);
		assert.equal(statsResponse.headers.get('x-cinatoken-cache'), 'MISS');
		assert.equal(rawAnalyticsCalls, 0);
		assert.equal(publicAnalyticsCalls, 1);
		assert.equal(limiterCalls, 1);
		assert.equal((await app.request('/catalog/stats/models?range=all')).status, 400);
		assert.equal(publicAnalyticsCalls, 1);

		const limited = await app.request('/catalog/stats/models?range=30d', undefined, {
			PUBLIC_STATS_RATE_LIMITER: { limit: async () => ({ success: false }) },
		});
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get('retry-after'), '60');
		assert.equal(limited.headers.get('cache-control'), 'no-store');
		assert.equal(publicAnalyticsCalls, 1);

		const unavailable = await app.request('/catalog/stats/models?range=90d', undefined, {
			PUBLIC_STATS_RATE_LIMITER: {
				limit: async () => {
					throw new Error('binding unavailable');
				},
			},
		});
		assert.equal(unavailable.status, 503);
		assert.equal(publicAnalyticsCalls, 1);

		const tokenTier = {
			upto: null,
			label: null,
			input_price: -0.000000001,
			output_price: 0,
			cache_read_price: -0.5,
			cache_write_price: 0,
			image_input_price: 0,
			image_input_cache_price: 0.000000001,
			image_output_price: 1.5,
		};
		const priceModes = [
			{ tiers: [tokenTier], audio_billing_mode: 'token' },
			{
				tiers: [],
				image_billing_mode: 'per_image',
				image: {
					default: 0.000000001,
					by_quality: { high: 0 },
					by_size: { '1024x1024': 0.3 },
					by_quality_size: { 'high:1024x1024': 0.4 },
					input: { default: 0 },
					uncertain_result_policy: 'zero',
				},
			},
			{ tiers: [], audio_billing_mode: 'per_second', audio: { price_per_second: 0.000000001, minimum_seconds: 1.5 } },
			{ tiers: [], audio_billing_mode: 'per_character', audio: { price_per_character: 0, minimum_characters: 20 } },
		];
		billingCurrency = ' eur ';
		for (const expected of priceModes) {
			pricingProfile = { ...expected, supplier_cost: 999, credentials: 'private-price-secret' };
			for (const path of ['/catalog/models', '/catalog/models/vendor/~dmVuZG9yL21vZGVs']) {
				const response = await app.request(path);
				assert.equal(response.status, 200);
				const body = (await response.json()) as { billing_currency: string; data: unknown };
				assert.equal(body.billing_currency, 'EUR');
				const row = (Array.isArray(body.data) ? body.data[0] : body.data) as { pricing_profile: unknown };
				assert.deepEqual(row.pricing_profile, expected);
				assert.equal(JSON.stringify(body).includes('private-price-secret'), false);
				assert.equal(JSON.stringify(body).includes('supplier_cost'), false);
			}
		}
		requestCount = 25.5;
		let cachePuts = 0;
		const malformedStatsApp = publicCatalogApp(
			repositories,
			createCatalogRoutes({
				...createInMemoryPublicStatsRuntimeGuard(),
				cache: {
					match: async () => undefined,
					put: async () => {
						cachePuts += 1;
					},
				},
			}),
		);
		await assertUnavailable(await malformedStatsApp.request('/catalog/stats/models?range=7d'));
		assert.equal(cachePuts, 0);
	});

	it('does not publish a default currency or a cacheable success when config storage fails', async () => {
		const fixture = emptyCatalogRepositories({ currency: new Error('private-provider-key/internal-database') });
		const app = publicCatalogApp(fixture.repositories);
		for (const path of ['/catalog/models', '/catalog/models/vendor/model', '/catalog/providers']) {
			await assertUnavailable(await app.request(path));
		}
		assert.equal(fixture.calls.currency, 3);
	});

	it('rejects malformed authoritative currencies instead of truncating, coercing, or choosing USD', async () => {
		for (const currency of ['', ' ', 'US', 'USDD', 'US1', 'USD\nCNY', 123, {}, undefined]) {
			const fixture = emptyCatalogRepositories({ currency });
			const app = publicCatalogApp(fixture.repositories);
			for (const path of ['/catalog/models', '/catalog/models/vendor/model', '/catalog/providers']) {
				await assertUnavailable(await app.request(path));
			}
		}
	});

	it('keeps an absent config as the explicit default and preserves valid non-USD currencies', async () => {
		for (const [currency, expected] of [
			[null, 'USD'],
			[' cny ', 'CNY'],
			['eur', 'EUR'],
			[' JpY ', 'JPY'],
			['zzz', 'ZZZ'],
		] as const) {
			const fixture = emptyCatalogRepositories({ currency });
			const app = publicCatalogApp(fixture.repositories);
			for (const path of ['/catalog/models', '/catalog/providers']) {
				const response = await app.request(path);
				assert.equal(response.status, 200);
				assert.equal(response.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=300');
				assert.deepEqual(((await response.json()) as { billing_currency: string; data: unknown[] }).data, []);
				const repeated = await app.request(path);
				assert.equal(((await repeated.json()) as { billing_currency: string }).billing_currency, expected);
			}
			const missing = await app.request('/catalog/models/vendor/model');
			assert.equal(missing.status, 404);
			assert.equal(missing.headers.get('cache-control'), 'no-store');
		}
	});

	it('returns uncached safe errors for exhausted catalog retries and recovers on the next request', async () => {
		const options = { modelFailure: true };
		const fixture = emptyCatalogRepositories(options);
		const app = publicCatalogApp(fixture.repositories);
		for (const path of ['/catalog/models', '/catalog/models/vendor/model', '/catalog/providers']) {
			const before = fixture.calls.models;
			await assertUnavailable(await app.request(path));
			assert.equal(fixture.calls.models - before, 2);
		}
		options.modelFailure = false;
		const recovered = await app.request('/catalog/models');
		assert.equal(recovered.status, 200);
		assert.equal(((await recovered.json()) as { billing_currency: string }).billing_currency, 'USD');
	});

	it('a failed currency read cannot poison a later recovered non-USD response', async () => {
		const options: { currency: unknown } = { currency: new Error('private-provider-key/internal-database') };
		const fixture = emptyCatalogRepositories(options);
		const app = publicCatalogApp(fixture.repositories);
		await assertUnavailable(await app.request('/catalog/models'));
		options.currency = ' cny ';
		const recovered = await app.request('/catalog/models');
		assert.equal(recovered.status, 200);
		assert.equal(((await recovered.json()) as { billing_currency: string }).billing_currency, 'CNY');
	});

	it('keeps catalog faults as safe 503 through the complete Proxy middleware instead of the global 500 handler', async () => {
		const options: { currency: unknown; analyticsFailure: boolean } = {
			currency: new Error('private-provider-key/internal-database'),
			analyticsFailure: true,
		};
		const fixture = emptyCatalogRepositories(options);
		const app = createProxyApp(async () => ({ repositories: fixture.repositories }) as StorageContext, {
			requestBodyLogging: 'off',
			publicStatsRuntime: createInMemoryPublicStatsRuntimeGuard(),
		});
		for (const path of ['/catalog/models', '/catalog/models/vendor/model', '/catalog/providers', '/catalog/stats/models?range=7d']) {
			await assertUnavailable(await app.request(path));
		}
		options.currency = ' eur ';
		options.analyticsFailure = false;
		const recovered = await app.request('/catalog/models');
		assert.equal(recovered.status, 200);
		assert.equal(((await recovered.json()) as { billing_currency: string }).billing_currency, 'EUR');
		const recoveredStats = await app.request('/catalog/stats/models?range=7d');
		assert.equal(recoveredStats.status, 200);
		assert.equal(recoveredStats.headers.get('x-cinatoken-cache'), 'MISS');
	});

	it('does not publish data-policy claims for routes whose shared credential can replace the verified account', async () => {
		const provider = {
			id: 'provider-shared',
			name: 'Shared Provider',
			endpoints: '{"openai":{"base":"https://api.example/v1"}}',
			api_key: 'default-secret',
			status: 'active',
			description: null,
			shared_channel_type: 'openai',
			created_at: '2026-08-01T00:00:00.000Z',
		};
		const route = {
			id: 'route-shared',
			model_id: 'vendor/shared-model',
			provider_id: provider.id,
			provider_model_name: 'upstream-model',
			priority: 0,
			status: 'active',
			route_group: 'default',
			weight: 1,
			price_override: null,
			custom_params: null,
			routing_metadata: null,
			upstream_protocol: 'openai',
			route_pool_id: 'pool-shared',
			upstream_operation: 'chat',
			adapter: 'passthrough',
			surfaces: null,
			pool_name: null,
			pool_strategy: null,
			pool_tier_strategies: null,
			pool_status: 'active',
			model_name: 'Shared Model',
			provider_name: provider.name,
			provider_status: 'active',
		};
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const endpoint = {
			id: 'endpoint-shared',
			model_id: route.model_id,
			provider_id: provider.id,
			provider_slug: 'shared',
			tag: 'shared/default',
			endpoint_class: 'standard',
			region: null,
			context_length: 8_192,
			max_prompt_tokens: 7_168,
			max_completion_tokens: 1_024,
			quantization: null,
			supported_parameters: '[]',
			pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
			supports_implicit_caching: false,
			supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":false,"none":true,"required":false}',
			image_capabilities: '{}',
			evidence_url: 'https://provider.example/evidence',
			verified_by: 'console:admin',
			verified_at: '2026-08-01T00:00:00.000Z',
			expires_at: '2099-08-01T00:00:00.000Z',
			status: 'verified',
			created_at: '2026-08-01T00:00:00.000Z',
			updated_at: '2026-08-01T00:00:00.000Z',
		};
		const repositories = {
			modelRouting: {
				listModelsWithActiveRoutes: async () => [
					{
						id: route.model_id,
						display_name: 'Shared Model',
						vendor: 'Vendor',
						context_window: 8_192,
						max_tokens: 1_024,
						pricing_profile: null,
						tags: '[]',
						description: null,
						metadata: null,
						input_modalities: '["text"]',
						output_modalities: '["text"]',
						released_at: null,
					},
				],
			},
			providers: { getProvidersByIds: async () => [provider] },
			modelEndpoints: {
				list: async (filters: { offset?: number }) => ((filters.offset ?? 0) === 0 ? [endpoint] : []),
				listDiscoveryRouteBindings: async () => [
					{
						endpoint_id: endpoint.id,
						subject_fingerprint: fingerprint,
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
					},
				],
			},
			routeDataPolicies: {
				getByRouteTargetIds: async () => [
					{
						route_target_id: route.id,
						subject_fingerprint: fingerprint,
						retention_days: 0,
						training_allowed: false,
						zdr_supported: true,
						evidence_url: 'https://provider.example/privacy',
						verified_by: 'console:admin',
						verified_at: '2026-08-01T00:00:00.000Z',
						expires_at: '2099-08-01T00:00:00.000Z',
						status: 'verified',
						invalidated_at: null,
						invalidation_reason: null,
						updated_at: '2026-08-01T00:00:00.000Z',
					},
				],
			},
		} as unknown as GatewayRepositories;

		const models = await listCatalogDiscoveryModels(repositories);
		assert.deepEqual(models, []);
	});

	it('retries an idempotent catalog read once after a transient database failure', async () => {
		let modelReads = 0;
		const repositories = {
			modelRouting: {
				listModelsWithActiveRoutes: async () => {
					modelReads += 1;
					if (modelReads === 1) throw new Error('socket closed');
					return [];
				},
			},
			routes: { listModelRoutesWithJoins: async () => [] },
			routeDataPolicies: { getByRouteTargetIds: async () => [] },
			systemConfig: { getConfig: async () => 'USD' },
		} as unknown as GatewayRepositories;
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.route('/catalog', catalogRoutes);

		const response = await app.request('/catalog/providers');
		assert.equal(response.status, 200);
		assert.equal(modelReads, 2);
		assert.deepEqual(((await response.json()) as { data: unknown[] }).data, []);
	});

	it('canonicalizes cache keys and serves a hit before analytics or rate limiting', async () => {
		let analyticsCalls = 0;
		let limiterCalls = 0;
		let matchedUrl = '';
		const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
		Object.defineProperty(globalThis, 'caches', {
			configurable: true,
			value: {
				default: {
					match: async (request: Request) => {
						matchedUrl = request.url;
						return new Response(JSON.stringify(cachedStats()), {
							headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
						});
					},
					put: async () => undefined,
				},
			},
		});
		try {
			const repositories = {
				analytics: {
					queryPublicModelAnalytics: async () => {
						analyticsCalls += 1;
						return [];
					},
				},
			} as unknown as GatewayRepositories;
			const app = new Hono<Env>();
			app.use('*', async (c, next) => {
				c.set('repositories', repositories);
				await next();
			});
			app.route('/catalog', catalogRoutes);
			const response = await app.request('/catalog/stats/models?unused=1&range=7d&range=90d', undefined, {
				PUBLIC_STATS_RATE_LIMITER: {
					limit: async () => {
						limiterCalls += 1;
						return { success: true };
					},
				},
			});
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('x-cinatoken-cache'), 'HIT');
			assert.equal(new URL(matchedUrl).search, '?range=7d');
			assert.equal(analyticsCalls, 0);
			assert.equal(limiterCalls, 0);
		} finally {
			if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
			else Reflect.deleteProperty(globalThis, 'caches');
		}
	});

	it('Node fallback coalesces concurrent misses and serves later requests from memory', async () => {
		let analyticsCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [] },
			routeDataPolicies: { getByRouteTargetIds: async () => [] },
			analytics: {
				queryPublicModelAnalytics: async () => {
					analyticsCalls += 1;
					await gate;
					return [
						{
							model_id: 'vendor/model',
							request_count: 20,
							success_count: 20,
							error_count: 0,
							output_tokens: 10,
							total_tokens: 15,
							avg_latency_ms: 20,
						},
					];
				},
			},
		} as unknown as GatewayRepositories;
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.route('/catalog', createCatalogRoutes(createInMemoryPublicStatsRuntimeGuard()));

		const first = app.request('/catalog/stats/models?range=7d');
		const second = app.request('/catalog/stats/models?range=%37d&unused=1');
		await Promise.resolve();
		release();
		const responses = await Promise.all([first, second]);
		assert.deepEqual(
			responses.map((response) => response.status),
			[200, 200],
		);
		assert.equal(analyticsCalls, 1);
		const cached = await app.request('/catalog/stats/models?range=7d');
		assert.equal(cached.headers.get('x-cinatoken-cache'), 'HIT');
		assert.equal(analyticsCalls, 1);
	});

	it('stats read failures never enter cache and a recovered request can be cached', async () => {
		for (const fault of ['modelFailure', 'analyticsFailure'] as const) {
			const options = { modelFailure: false, analyticsFailure: false };
			options[fault] = true;
			const fixture = emptyCatalogRepositories(options);
			const guard = createInMemoryPublicStatsRuntimeGuard();
			const app = publicCatalogApp(fixture.repositories, createCatalogRoutes(guard));
			const key = new Request('http://localhost/catalog/stats/models?range=7d');
			await assertUnavailable(await app.request('/catalog/stats/models?range=7d'));
			assert.equal(await guard.cache!.match(key), undefined);
			options[fault] = false;
			const recovered = await app.request('/catalog/stats/models?range=7d');
			assert.equal(recovered.status, 200);
			assert.equal(recovered.headers.get('x-cinatoken-cache'), 'MISS');
			assert.deepEqual(((await recovered.json()) as { data: unknown[] }).data, []);
			const calls = { ...fixture.calls };
			const hit = await app.request('/catalog/stats/models?range=7d');
			assert.equal(hit.status, 200);
			assert.equal(hit.headers.get('x-cinatoken-cache'), 'HIT');
			assert.deepEqual(fixture.calls, calls);
		}
	});

	it('coalesced stats failures clear singleflight and do not become a cached false success', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let failed = true;
		let calls = 0;
		const fixture = emptyCatalogRepositories();
		fixture.repositories.analytics.queryPublicModelAnalytics = async () => {
			calls += 1;
			await gate;
			if (failed) throw new Error('private-provider-key/internal-database');
			return [];
		};
		const guard = createInMemoryPublicStatsRuntimeGuard();
		const app = publicCatalogApp(fixture.repositories, createCatalogRoutes(guard));
		const first = app.request('/catalog/stats/models?range=7d');
		const second = app.request('/catalog/stats/models?range=7d');
		while (calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		release();
		for (const response of await Promise.all([first, second])) await assertUnavailable(response);
		assert.equal(calls, 1);
		assert.equal(await guard.cache!.match(new Request('http://localhost/catalog/stats/models?range=7d')), undefined);
		failed = false;
		assert.equal((await app.request('/catalog/stats/models?range=7d')).status, 200);
		assert.equal(calls, 2);
	});

	it('validates cached status, headers and the complete public stats DTO before accepting a HIT', async () => {
		const good = cachedStats();
		const row = {
			id: 'model',
			slug: 'model',
			display_name: 'Model',
			vendor: 'Vendor',
			request_count: 20,
			success_rate: 100,
			avg_latency_ms: null,
			output_tokens: 0,
			total_tokens: 0,
		};
		const bodyFaults: unknown[] = [
			{},
			{ ...good, object: 'error' },
			{ ...good, range: '30d' },
			{ ...good, minimum_sample_size: 0 },
			{ ...good, window_start: good.window_end },
			{ ...good, generated_at: 'bad-date' },
			{ ...good, provider_key: 'private-cache-secret' },
			{ ...good, data: [row, row] },
			{ ...good, data: [{ ...row, provider_key: 'private-cache-secret' }] },
			{ ...good, data: [{ ...row, request_count: 19 }] },
			{ ...good, data: [{ ...row, success_rate: 101 }] },
			{ ...good, data: [{ ...row, avg_latency_ms: -1 }] },
			{ ...good, data: [{ ...row, slug: '../private' }] },
			{ ...good, data: [{ ...row, total_tokens: Number.MAX_SAFE_INTEGER + 1 }] },
			{ ...good, data: [{ ...row, output_tokens: 1 }] },
			{ ...good, data: [{ ...row, request_count: 20.5 }] },
			{ ...good, data: Array.from({ length: 5_001 }, () => row) },
		];
		const headers = { 'Cache-Control': 'public, max-age=60' };
		const poison = [
			...bodyFaults.map((body) => () => Response.json(body, { headers })),
			() => Response.json(good, { status: 503, headers }),
			() => new Response(JSON.stringify(good), { headers }),
			() => new Response('{', { headers: { ...headers, 'Content-Type': 'application/json' } }),
			() => Response.json(good, { headers: { 'Cache-Control': 'no-store' } }),
			() => Response.json(good, { headers: { 'Cache-Control': 'public, max-age=60, no-store' } }),
			() => Response.json(good, { headers: { 'Cache-Control': 'private, max-age=60' } }),
			() => Response.json(good, { headers: { ...headers, 'Set-Cookie': 'private-cache-secret' } }),
			() => Response.json(good, { headers: { ...headers, 'Content-Length': String(17 * 1_024 * 1_024) } }),
		];
		for (const cached of poison) {
			const fixture = emptyCatalogRepositories();
			let puts = 0;
			const app = publicCatalogApp(
				fixture.repositories,
				createCatalogRoutes({
					...createInMemoryPublicStatsRuntimeGuard(),
					cache: {
						match: async () => cached(),
						put: async (_key, response) => {
							puts += 1;
							assert.equal(response.status, 200);
							assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
						},
					},
				}),
			);
			const response = await app.request('/catalog/stats/models?range=7d');
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('x-cinatoken-cache'), 'MISS');
			assert.equal(response.headers.get('set-cookie'), null);
			assert.equal((await response.text()).includes('private-cache-secret'), false);
			assert.equal(fixture.calls.analytics, 1);
			assert.equal(puts, 1);
		}
	});

	it('serves valid complete cached rows without forwarding unapproved cache headers', async () => {
		const body = {
			...cachedStats(),
			data: [
				{
					id: 'model',
					slug: 'model',
					display_name: 'Model',
					vendor: 'Vendor',
					request_count: 20,
					success_rate: 100,
					avg_latency_ms: 0,
					output_tokens: 0,
					total_tokens: 0,
				},
			],
		};
		const fixture = emptyCatalogRepositories({ modelFailure: true, analyticsFailure: true });
		let puts = 0;
		const app = publicCatalogApp(
			fixture.repositories,
			createCatalogRoutes({
				...createInMemoryPublicStatsRuntimeGuard(),
				cache: {
					match: async () =>
						Response.json(body, {
							headers: { 'Cache-Control': 'public, max-age=60', 'X-Internal-Origin': 'private-cache-secret' },
						}),
					put: async () => {
						puts += 1;
					},
				},
			}),
		);
		const response = await app.request('/catalog/stats/models?range=7d');
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('x-cinatoken-cache'), 'HIT');
		assert.equal(response.headers.get('x-internal-origin'), null);
		assert.deepEqual(await response.json(), body);
		assert.deepEqual(fixture.calls, { models: 0, analytics: 0, currency: 0 });
		assert.equal(puts, 0);
	});

	it('rejects and cancels oversized or invalid UTF-8 cached streams before authoritative recovery', async () => {
		for (const bytes of [new Uint8Array(17 * 1_024 * 1_024), new Uint8Array([0xff])]) {
			let cancelled = false;
			const fixture = emptyCatalogRepositories();
			const app = publicCatalogApp(
				fixture.repositories,
				createCatalogRoutes({
					...createInMemoryPublicStatsRuntimeGuard(),
					cache: {
						match: async () =>
							new Response(
								new ReadableStream<Uint8Array>({
									start(controller) {
										controller.enqueue(bytes);
									},
									cancel() {
										cancelled = true;
									},
								}),
								{ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } },
							),
						put: async () => undefined,
					},
				}),
			);
			const response = await app.request('/catalog/stats/models?range=7d');
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('x-cinatoken-cache'), 'MISS');
			assert.equal(cancelled, true);
			assert.equal(fixture.calls.analytics, 1);
		}
	});

	it('does not publish a poisoned cached success when the authoritative MISS also fails', async () => {
		const fixture = emptyCatalogRepositories({ analyticsFailure: true });
		let puts = 0;
		const app = publicCatalogApp(
			fixture.repositories,
			createCatalogRoutes({
				...createInMemoryPublicStatsRuntimeGuard(),
				cache: {
					match: async () =>
						Response.json(
							{ ...cachedStats(), data: [{ secret: 'private-cache-secret' }] },
							{
								headers: { 'Cache-Control': 'public, max-age=60' },
							},
						),
					put: async () => {
						puts += 1;
					},
				},
			}),
		);
		await assertUnavailable(await app.request('/catalog/stats/models?range=7d'));
		assert.equal(puts, 0);
	});
});

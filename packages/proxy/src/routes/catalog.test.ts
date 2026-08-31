import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeRouteDataPolicySubjectFingerprintFromRows, type GatewayRepositories } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../app';
import { listCatalogDiscoveryModels } from '../services/catalog-discovery';
import { createInMemoryPublicStatsRuntimeGuard } from '../services/public-stats-runtime-guard';
import { catalogRoutes, createCatalogRoutes } from './catalog';

describe('GET /catalog/models', () => {
	it('returns sanitized list, detail, and provider aggregates without authentication', async () => {
		let rawAnalyticsCalls = 0;
		let publicAnalyticsCalls = 0;
		const provider = {
			id: 'provider-1', name: 'Provider', endpoints: '{"openai":{"base":"https://api.example/v1"}}',
			api_key: 'secret', status: 'active', description: null, shared_channel_type: null, created_at: '2026-08-01T00:00:00.000Z',
		};
		const route = {
			id: 'route-1', model_id: 'vendor/model', provider_id: 'provider-1', provider_model_name: 'upstream-model',
			priority: 0, status: 'active', route_group: 'default', weight: 1, price_override: null,
			custom_params: null,
			routing_metadata: JSON.stringify({
				supported_parameters: ['tools'], quantization: 'fp8', endpoint_slug: 'provider/turbo', endpoint_class: 'standard', region: 'eu',
			}),
			upstream_protocol: 'openai', route_pool_id: 'pool-1',
			upstream_operation: 'chat', adapter: 'passthrough', surfaces: null, pool_name: null, pool_strategy: null,
			pool_tier_strategies: null, pool_status: 'active', model_name: 'Model', provider_name: 'Provider',
			provider_status: 'active',
		};
		const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const endpoint = {
			id: 'endpoint-1', model_id: route.model_id, provider_id: provider.id,
			provider_slug: 'provider', tag: 'provider/turbo', endpoint_class: 'standard', region: 'eu',
			context_length: 128_000, max_prompt_tokens: 120_000, max_completion_tokens: 8_000,
			quantization: 'fp8', supported_parameters: '["tools"]',
			pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000003"}',
			supports_implicit_caching: false, supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":false}',
			image_capabilities: '{}', evidence_url: 'https://provider.example/endpoint-evidence',
			verified_by: 'console:admin', verified_at: '2026-08-01T00:00:00.000Z',
			expires_at: '2099-08-01T00:00:00.000Z', status: 'verified',
			created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
		};
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [{
				id: 'vendor/model',
				display_name: 'Model',
				vendor: 'Vendor',
				context_window: 128_000,
				max_tokens: 8_192,
				pricing_profile: JSON.stringify({ tiers: [{ upto: null, input_price: 1, output_price: 3 }] }),
				tags: '[]',
				description: 'Public description',
				input_modalities: JSON.stringify(['text']),
				output_modalities: JSON.stringify(['text']),
				released_at: '2026-08-01',
				metadata: JSON.stringify({ upstream_secret: 'must-not-leak' }),
			}] },
			routes: { listModelRoutesWithJoins: async () => { throw new Error('catalog must not scan all routes'); } },
			providers: { getProvidersByIds: async (ids: string[]) => ids.includes(provider.id) ? [provider] : [] },
			modelEndpoints: {
				list: async (filters: { offset?: number }) => (filters.offset ?? 0) === 0 ? [endpoint] : [],
				listDiscoveryRouteBindings: async (ids: string[]) => ids.includes(endpoint.id) ? [{
					endpoint_id: endpoint.id, subject_fingerprint: subjectFingerprint,
					id: route.id, model_id: route.model_id, provider_id: route.provider_id,
					provider_model_name: route.provider_model_name, status: route.status,
					route_group: route.route_group, custom_params: route.custom_params,
					routing_metadata: route.routing_metadata, upstream_protocol: route.upstream_protocol,
					upstream_operation: route.upstream_operation, adapter: route.adapter,
					route_pool_id: route.route_pool_id, pool_status: route.pool_status,
				}] : [],
			},
			routeDataPolicies: { getByRouteTargetIds: async () => [{
				route_target_id: 'route-1', subject_fingerprint: subjectFingerprint, retention_days: 0, training_allowed: false, zdr_supported: true,
				evidence_url: 'https://provider.example/privacy', verified_by: 'console:admin',
				verified_at: '2026-08-01T00:00:00.000Z', expires_at: '2099-08-01T00:00:00.000Z',
				status: 'verified', invalidated_at: null, invalidation_reason: null, updated_at: '2026-08-01T00:00:00.000Z',
			}] },
			systemConfig: { getConfig: async () => 'cny' },
			analytics: {
				queryModelAnalytics: async () => {
					rawAnalyticsCalls += 1;
					throw new Error('public route must not scan request logs');
				},
				queryPublicModelAnalytics: async () => {
					publicAnalyticsCalls += 1;
					return [{
				model_id: 'vendor/model', route_group: 'default', request_count: 25,
				success_count: 24, error_count: 1, input_tokens: 100, output_tokens: 200,
				avg_latency_ms: 120,
					}];
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
		const body = await response.json() as Record<string, unknown>;
		assert.equal(body.billing_currency, 'CNY');
		assert.equal(response.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=300');
		const models = body.data as Array<Record<string, unknown>>;
		assert.equal(models[0]?.slug, '~dmVuZG9yL21vZGVs');
		assert.equal('metadata' in models[0]!, false);
		assert.deepEqual(models[0]?.endpoint_slugs, ['provider/turbo']);
		assert.deepEqual(models[0]?.regions, ['eu']);
		assert.equal(JSON.stringify(models[0]).includes('api.example'), false);
		assert.deepEqual(models[0]?.data_policy_summary, {
			verified_route_count: 1, zdr_available: true, latest_verified_at: '2026-08-01T00:00:00.000Z',
		});

		const detailResponse = await app.request('/catalog/models/vendor/~dmVuZG9yL21vZGVs');
		assert.equal(detailResponse.status, 200);
		const detail = await detailResponse.json() as { data: { id: string } };
		assert.equal(detail.data.id, 'vendor/model');

		const providersResponse = await app.request('/catalog/providers');
		assert.equal(providersResponse.status, 200);
		const providers = await providersResponse.json() as { data: Array<{ id: string; model_count: number }> };
		assert.deepEqual(providers.data, [{
			id: 'vendor',
			display_name: 'Vendor',
			model_count: 1,
			protocols: ['openai'],
			route_groups: ['default'],
			input_modalities: ['text'],
			output_modalities: ['text'],
			latest_released_at: '2026-08-01',
		}]);

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
		const stats = await statsResponse.json() as { minimum_sample_size: number; data: Array<Record<string, unknown>> };
		assert.equal(stats.minimum_sample_size, 20);
		assert.deepEqual(stats.data, [{
			id: 'vendor/model', slug: '~dmVuZG9yL21vZGVs', display_name: 'Model', vendor: 'Vendor',
			request_count: 25, success_rate: 96, avg_latency_ms: 120, output_tokens: 200,
		}]);
		assert.equal(statsResponse.headers.get('x-cinatoken-cache'), 'MISS');
		assert.equal(rawAnalyticsCalls, 0);
		assert.equal(publicAnalyticsCalls, 1);
		assert.equal(limiterCalls, 1);
		assert.equal(await app.request('/catalog/stats/models?range=all').then((res) => res.status), 400);
		assert.equal(publicAnalyticsCalls, 1);

		const limited = await app.request('/catalog/stats/models?range=30d', undefined, {
			PUBLIC_STATS_RATE_LIMITER: { limit: async () => ({ success: false }) },
		});
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get('retry-after'), '60');
		assert.equal(limited.headers.get('cache-control'), 'no-store');
		assert.equal(publicAnalyticsCalls, 1);

		const unavailable = await app.request('/catalog/stats/models?range=90d', undefined, {
			PUBLIC_STATS_RATE_LIMITER: { limit: async () => { throw new Error('binding unavailable'); } },
		});
		assert.equal(unavailable.status, 503);
		assert.equal(publicAnalyticsCalls, 1);
	});

	it('keeps public discovery available with the default currency when config storage is transiently unavailable', async () => {
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [] },
			routes: { listModelRoutesWithJoins: async () => [] },
			routeDataPolicies: { getByRouteTargetIds: async () => [] },
			systemConfig: { getConfig: async () => { throw new Error('connection closed'); } },
		} as unknown as GatewayRepositories;
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.route('/catalog', catalogRoutes);

		for (const path of ['/catalog/models', '/catalog/providers']) {
			const response = await app.request(path);
			assert.equal(response.status, 200);
			const body = await response.json() as { billing_currency: string; data: unknown[] };
			assert.equal(body.billing_currency, 'USD');
			assert.deepEqual(body.data, []);
		}
	});

	it('does not publish data-policy claims for routes whose shared credential can replace the verified account', async () => {
		const provider = {
			id: 'provider-shared', name: 'Shared Provider', endpoints: '{"openai":{"base":"https://api.example/v1"}}',
			api_key: 'default-secret', status: 'active', description: null, shared_channel_type: 'openai',
			created_at: '2026-08-01T00:00:00.000Z',
		};
		const route = {
			id: 'route-shared', model_id: 'vendor/shared-model', provider_id: provider.id,
			provider_model_name: 'upstream-model', priority: 0, status: 'active', route_group: 'default',
			weight: 1, price_override: null, custom_params: null, routing_metadata: null,
			upstream_protocol: 'openai', route_pool_id: 'pool-shared', upstream_operation: 'chat',
			adapter: 'passthrough', surfaces: null, pool_name: null, pool_strategy: null,
			pool_tier_strategies: null, pool_status: 'active', model_name: 'Shared Model',
			provider_name: provider.name, provider_status: 'active',
		};
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const endpoint = {
			id: 'endpoint-shared', model_id: route.model_id, provider_id: provider.id,
			provider_slug: 'shared', tag: 'shared/default', endpoint_class: 'standard', region: null,
			context_length: 8_192, max_prompt_tokens: 7_168, max_completion_tokens: 1_024,
			quantization: null, supported_parameters: '[]',
			pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
			supports_implicit_caching: false, supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":false,"none":true,"required":false}',
			image_capabilities: '{}', evidence_url: 'https://provider.example/evidence',
			verified_by: 'console:admin', verified_at: '2026-08-01T00:00:00.000Z',
			expires_at: '2099-08-01T00:00:00.000Z', status: 'verified',
			created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
		};
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [{
				id: route.model_id, display_name: 'Shared Model', vendor: 'Vendor', context_window: 8_192,
				max_tokens: 1_024, pricing_profile: null, tags: '[]', description: null, metadata: null,
				input_modalities: '["text"]', output_modalities: '["text"]', released_at: null,
			}] },
			providers: { getProvidersByIds: async () => [provider] },
			modelEndpoints: {
				list: async (filters: { offset?: number }) => (filters.offset ?? 0) === 0 ? [endpoint] : [],
				listDiscoveryRouteBindings: async () => [{
					endpoint_id: endpoint.id, subject_fingerprint: fingerprint,
					id: route.id, model_id: route.model_id, provider_id: route.provider_id,
					provider_model_name: route.provider_model_name, status: route.status,
					route_group: route.route_group, custom_params: route.custom_params,
					routing_metadata: route.routing_metadata, upstream_protocol: route.upstream_protocol,
					upstream_operation: route.upstream_operation, adapter: route.adapter,
					route_pool_id: route.route_pool_id, pool_status: route.pool_status,
				}],
			},
			routeDataPolicies: { getByRouteTargetIds: async () => [{
				route_target_id: route.id, subject_fingerprint: fingerprint, retention_days: 0,
				training_allowed: false, zdr_supported: true, evidence_url: 'https://provider.example/privacy',
				verified_by: 'console:admin', verified_at: '2026-08-01T00:00:00.000Z',
				expires_at: '2099-08-01T00:00:00.000Z', status: 'verified', invalidated_at: null,
				invalidation_reason: null, updated_at: '2026-08-01T00:00:00.000Z',
			}] },
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
		assert.deepEqual((await response.json() as { data: unknown[] }).data, []);
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
						return new Response(JSON.stringify({ object: 'list', data: [{ id: 'cached' }] }), {
							headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
						});
					},
					put: async () => undefined,
				},
			},
		});
		try {
			const repositories = {
				analytics: { queryPublicModelAnalytics: async () => { analyticsCalls += 1; return []; } },
			} as unknown as GatewayRepositories;
			const app = new Hono<Env>();
			app.use('*', async (c, next) => {
				c.set('repositories', repositories);
				await next();
			});
			app.route('/catalog', catalogRoutes);
			const response = await app.request('/catalog/stats/models?unused=1&range=7d&range=90d', undefined, {
				PUBLIC_STATS_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
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
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [] },
			routeDataPolicies: { getByRouteTargetIds: async () => [] },
			analytics: {
				queryPublicModelAnalytics: async () => {
					analyticsCalls += 1;
					await gate;
					return [{
						model_id: 'vendor/model', request_count: 20, success_count: 20,
						error_count: 0, output_tokens: 10, avg_latency_ms: 20,
					}];
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
		assert.deepEqual(responses.map((response) => response.status), [200, 200]);
		assert.equal(analyticsCalls, 1);
		const cached = await app.request('/catalog/stats/models?range=7d');
		assert.equal(cached.headers.get('x-cinatoken-cache'), 'HIT');
		assert.equal(analyticsCalls, 1);
	});
});

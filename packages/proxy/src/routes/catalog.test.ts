import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../app';
import { createInMemoryPublicStatsRuntimeGuard } from '../services/public-stats-runtime-guard';
import { catalogRoutes, createCatalogRoutes } from './catalog';

describe('GET /catalog/models', () => {
	it('returns sanitized list, detail, and provider aggregates without authentication', async () => {
		let rawAnalyticsCalls = 0;
		let publicAnalyticsCalls = 0;
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
			routes: { listModelRoutesWithJoins: async () => [{
				model_id: 'vendor/model',
				status: 'active',
				route_group: 'default',
				upstream_protocol: 'openai',
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
			modelRouting: { listModelsWithActiveRoutes: async () => [{
				id: 'vendor/model', display_name: 'Model', vendor: 'Vendor',
				pricing_profile: JSON.stringify({ tiers: [{ upto: null, input_price: 1, output_price: 3 }] }),
			}] },
			routes: { listModelRoutesWithJoins: async () => [{
				model_id: 'vendor/model', status: 'active', route_group: 'default', upstream_protocol: 'openai',
			}] },
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

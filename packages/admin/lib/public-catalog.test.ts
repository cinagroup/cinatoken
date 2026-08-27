import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	parsePublicCatalogModelResponse,
	parsePublicCatalogProvidersResponse,
	parsePublicCatalogResponse,
	parsePublicModelStatsResponse,
	resolvePublicApiOrigin,
} from './public-catalog';

describe('public catalog boundary', () => {
	it('sanitizes a valid public model and preserves billing metadata', () => {
		const result = parsePublicCatalogResponse({
			billing_currency: 'cny',
			generated_at: '2026-08-27T00:00:00.000Z',
			data: [{
				id: 'vendor/model',
				display_name: 'Model',
				vendor: 'vendor',
				protocols: ['openai', 'unknown'],
				recommended_protocol: 'openai',
				context_window: 128000,
				pricing_profile: { tiers: [{ upto: null, input_price: 1, output_price: 3 }] },
				input_modalities: ['text'],
				output_modalities: ['text'],
				released_at: '2026-08-01',
			}],
		});

		assert.equal(result.status, 'ready');
		assert.equal(result.billingCurrency, 'CNY');
		assert.equal(result.models.length, 1);
		assert.equal(result.models[0]?.slug, '~dmVuZG9yL21vZGVs');
		assert.deepEqual(result.models[0]?.protocols, ['openai']);
		assert.deepEqual(result.models[0]?.pricingProfile?.tiers[0], {
			upto: null,
			input_price: 1,
			output_price: 3,
		});
	});

	it('accepts only bounded privacy-safe public model statistics', () => {
		const result = parsePublicModelStatsResponse({
			range: '30d', minimum_sample_size: 20,
			data: [{ id: 'model', slug: 'model', display_name: 'Model', vendor: 'Vendor', request_count: 50, success_rate: 98, avg_latency_ms: 120, output_tokens: 1000 }],
		}, '7d');
		assert.equal(result.status, 'ready');
		assert.equal(result.range, '30d');
		assert.deepEqual(result.models[0], { id: 'model', slug: 'model', displayName: 'Model', vendor: 'Vendor', requestCount: 50, successRate: 98, avgLatencyMs: 120, outputTokens: 1000 });
		assert.equal(parsePublicModelStatsResponse({ data: [{ id: 'x', slug: 'x', vendor: 'v', request_count: 1, success_rate: 101, output_tokens: 0 }] }, '7d').models.length, 0);
	});

	it('sanitizes one model detail and provider aggregates', () => {
		const detail = parsePublicCatalogModelResponse({
			billing_currency: 'usd',
			data: {
				id: 'model-safe',
				slug: 'model-safe',
				vendor: 'Vendor',
				protocols: ['openai'],
				recommended_protocol: 'openai',
				metadata: { secret: 'must-not-cross-boundary' },
			},
		});
		assert.equal(detail.status, 'ready');
		assert.equal(detail.model?.slug, 'model-safe');
		assert.equal('metadata' in (detail.model ?? {}), false);

		const providers = parsePublicCatalogProvidersResponse({
			billing_currency: 'cny',
			data: [{
				id: 'vendor',
				display_name: 'Vendor',
				model_count: 2,
				protocols: ['openai', 'smtp'],
				output_modalities: ['text'],
				latest_released_at: '2026-08-20',
			}],
		});
		assert.equal(providers.status, 'ready');
		assert.equal(providers.billingCurrency, 'CNY');
		assert.deepEqual(providers.providers[0], {
			id: 'vendor',
			displayName: 'Vendor',
			modelCount: 2,
			protocols: ['openai'],
			routeGroups: [],
			inputModalities: [],
			outputModalities: ['text'],
			latestReleasedAt: '2026-08-20',
		});
	});

	it('rejects malformed responses and models without a supported protocol', () => {
		assert.equal(parsePublicCatalogResponse(null).status, 'unavailable');
		assert.deepEqual(parsePublicCatalogResponse({ data: [{ id: 'x', protocols: ['smtp'] }] }).models, []);
	});

	it('accepts only credential-free HTTP origins', () => {
		assert.equal(resolvePublicApiOrigin('https://gateway.example/path'), 'https://gateway.example');
		assert.equal(resolvePublicApiOrigin('https://user:secret@gateway.example'), 'https://api.cinatoken.com');
		assert.equal(resolvePublicApiOrigin('file:///tmp/catalog.json'), 'https://api.cinatoken.com');
	});
});

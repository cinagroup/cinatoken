import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import { applyImageProviderPriceRouting } from './image-provider-price-routing';

function estimate(
	chargedCost: number,
	imagePrice: number,
	requestPrice: number,
	provable = true,
) {
	return {
		chargedCost,
		chargedOutputUnitPrice: imagePrice,
		chargedRequestPrice: requestPrice,
		pricingAuditJson: JSON.stringify(provable ? { source: 'verified_model_endpoint' } : { error: 'missing_price' }),
	};
}

function route(
	targetId: string,
	options: {
		maxPrice?: Record<string, number> | null;
		sort?: string | null;
		partition?: 'model' | 'none';
	} = {},
): RouteResult {
	return {
		targetId,
		routePriority: 10,
		providerRoutingTrace: {
			configured_target_ids: ['a', 'b', 'c'],
			eligible_target_ids: ['a', 'b', 'c'],
			sort: options.sort ?? null,
			partition: options.partition ?? 'model',
			global_endpoint_rank: null,
			require_parameters: false,
			data_collection: 'allow',
			zdr: false,
			quantizations: null,
			max_price: options.maxPrice ?? null,
		},
	} as RouteResult;
}

function candidate(
	targetId: string,
	requestPrice: number,
	imagePrice: number,
	options: Parameters<typeof route>[1] = {},
	provable = true,
	fixedRequestPrice = 0,
) {
	return {
		route: route(targetId, options),
		requestEstimate: estimate(requestPrice, imagePrice, fixedRequestPrice, provable),
	};
}

describe('image provider price routing', () => {
	it('filters against the per-output-image and fixed-request ceilings', () => {
		const options = { maxPrice: { image: 0.05, request: 0.2 } };
		const result = applyImageProviderPriceRouting([
			candidate('a', 0.15, 0.04, options, true, 0.1),
			candidate('b', 0.25, 0.03, options, true, 0.25),
			candidate('c', 0.10, 0.06, options, true, 0.1),
		]);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidates.map(({ route: item }) => item.targetId), ['a']);
			assert.deepEqual(result.candidates[0]?.route.providerRoutingTrace?.eligible_target_ids, ['a']);
		}
	});

	it('sorts by the complete request price with stable ties', () => {
		const options = { sort: 'price', partition: 'none' as const };
		const result = applyImageProviderPriceRouting([
			candidate('a', 0.3, 0.1, options),
			candidate('b', 0.1, 0.08, options),
			candidate('c', 0.1, 0.09, options),
		]);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidates.map(({ route: item }) => item.targetId), ['b', 'c', 'a']);
			assert.deepEqual(result.candidates.map(({ route: item }) => item.routePriority), [3, 2, 1]);
			assert.deepEqual(result.candidates.map(({ route: item }) => item.gatewayGlobalEndpointRank), [1, 2, 3]);
		}
	});

	it('keeps a soft-performance-qualified route ahead of a cheaper route', () => {
		const options = { sort: 'price' };
		const qualified = candidate('qualified', 0.2, 0.1, options);
		qualified.route.gatewayPerformancePreferred = true;
		const result = applyImageProviderPriceRouting([
			candidate('cheap', 0.1, 0.05, options),
			qualified,
		]);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.candidates.map(({ route: item }) => item.targetId),
				['qualified', 'cheap'],
			);
		}
	});

	it('fails closed for unsupported dimensions and unprovable prices', () => {
		const unsupported = applyImageProviderPriceRouting([
			candidate('a', 0.1, 0.05, { maxPrice: { prompt: 1 } }),
		]);
		assert.deepEqual(unsupported, {
			ok: false,
			message: 'Images provider.max_price supports only image and request; unsupported key: prompt',
		});

		const unknown = applyImageProviderPriceRouting([
			candidate('a', 0, 0, { sort: 'price' }, false),
		]);
		assert.deepEqual(unknown, {
			ok: false,
			message: 'No configured image route has a provable price for provider.sort=price',
		});
	});
});

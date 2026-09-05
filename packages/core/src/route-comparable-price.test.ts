import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	comparableRoutePriceSortScore,
	resolveComparableRoutePrice,
	routeSatisfiesComparableMaxPrice,
} from './route-comparable-price';

describe('comparable route prices', () => {
	it('uses charged factors and endpoint discounts in runtime units', () => {
		const price = resolveComparableRoutePrice({
			pricing: {
				currency: 'USD',
				prompt: '0.000001',
				completion: '0.000002',
				request: '0.01',
				discount: 0.5,
			},
			priceOverrideRaw: JSON.stringify({ charged_factor: 2 }),
			pricingAt: new Date('2026-09-02T00:00:00.000Z'),
			businessTimezone: 'UTC',
		});

		assert.deepEqual(price, { prompt: 1, completion: 2, request: 0.01, image: null });
		assert.equal(routeSatisfiesComparableMaxPrice(price, { prompt: 1, completion: 2 }), true);
		assert.equal(routeSatisfiesComparableMaxPrice(price, { completion: 1.99 }), false);
		assert.equal(routeSatisfiesComparableMaxPrice(price, { image: 1 }), false);
		assert.equal(comparableRoutePriceSortScore(price), 3);
	});
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicModelAnalyticsRow } from '@octafuse/core';
import type { CatalogDiscoveryModel } from './catalog-discovery';
import { aggregatePublicModelStats } from './public-catalog-stats';

describe('aggregatePublicModelStats', () => {
	it('publishes only active catalog models above the privacy threshold', () => {
		const models = [{ id: 'published', slug: 'published', display_name: 'Published', vendor: 'Vendor' }] as CatalogDiscoveryModel[];
		const rows = [
			{ model_id: 'published', request_count: 15, success_count: 14, output_tokens: 100, avg_latency_ms: 100 },
			{ model_id: 'published', request_count: 10, success_count: 9, output_tokens: 50, avg_latency_ms: 200 },
			{ model_id: 'hidden', request_count: 1_000, success_count: 1_000, output_tokens: 99, avg_latency_ms: 1 },
		] as PublicModelAnalyticsRow[];
		assert.deepEqual(aggregatePublicModelStats(models, rows), [{
			id: 'published', slug: 'published', display_name: 'Published', vendor: 'Vendor',
			request_count: 25, success_rate: 92, avg_latency_ms: 140, output_tokens: 150,
		}]);
	});

	it('suppresses low-volume rows', () => {
		const models = [{ id: 'small', slug: 'small', display_name: 'Small', vendor: 'Vendor' }] as CatalogDiscoveryModel[];
		assert.deepEqual(aggregatePublicModelStats(models, [{ model_id: 'small', request_count: 19, success_count: 19 }] as PublicModelAnalyticsRow[]), []);
	});
});

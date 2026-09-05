import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicModelAnalyticsRow } from '@octafuse/core';
import type { CatalogDiscoveryModel } from './catalog-discovery';
import {
	aggregatePublicModelStats,
	privacyQualifiedWeeklyTokenTotals,
} from './public-catalog-stats';

describe('aggregatePublicModelStats', () => {
	it('publishes only active catalog models above the privacy threshold', () => {
		const models = [{ id: 'published', slug: 'published', display_name: 'Published', vendor: 'Vendor' }] as CatalogDiscoveryModel[];
		const rows = [
			{ model_id: 'published', request_count: 15, success_count: 14, error_count: 1, output_tokens: 100, total_tokens: 180, avg_latency_ms: 100 },
			{ model_id: 'published', request_count: 10, success_count: 9, error_count: 1, output_tokens: 50, total_tokens: 90, avg_latency_ms: 200 },
			{ model_id: 'hidden', request_count: 1_000, success_count: 1_000, error_count: 0, output_tokens: 99, total_tokens: 120, avg_latency_ms: 1 },
		] as PublicModelAnalyticsRow[];
		assert.deepEqual(aggregatePublicModelStats(models, rows), [{
			id: 'published', slug: 'published', display_name: 'Published', vendor: 'Vendor',
			request_count: 25, success_rate: 92, avg_latency_ms: 140, output_tokens: 150, total_tokens: 270,
		}]);
	});

	it('suppresses low-volume rows', () => {
		const models = [{ id: 'small', slug: 'small', display_name: 'Small', vendor: 'Vendor' }] as CatalogDiscoveryModel[];
		assert.deepEqual(aggregatePublicModelStats(models, [{
			model_id: 'small', request_count: 19, success_count: 19, error_count: 0,
			output_tokens: 10, total_tokens: 20, avg_latency_ms: null,
		}]), []);
	});

	it('publishes weekly token totals only after the privacy threshold and fails closed on unsafe totals', () => {
		const scores = privacyQualifiedWeeklyTokenTotals([
			{ model_id: 'popular', request_count: 12, success_count: 12, error_count: 0, output_tokens: 30, total_tokens: 70, avg_latency_ms: 10 },
			{ model_id: 'popular', request_count: 8, success_count: 8, error_count: 0, output_tokens: 20, total_tokens: 50, avg_latency_ms: 10 },
			{ model_id: 'private', request_count: 19, success_count: 19, error_count: 0, output_tokens: 99, total_tokens: 999, avg_latency_ms: 10 },
			{ model_id: 'unsafe', request_count: 20, success_count: 20, error_count: 0, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1, avg_latency_ms: 10 },
		]);
		assert.deepEqual([...scores.entries()], [['popular', 120]]);
	});
});

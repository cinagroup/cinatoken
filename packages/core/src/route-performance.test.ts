import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoutePerformanceSample } from './db/request-logs-types';
import {
	collectRoutePerformanceSeries,
	routePerformanceLatencySeconds,
	routePerformancePercentile,
	routePerformanceThroughputTokensPerSecond,
} from './route-performance';

function sample(patch: Partial<RoutePerformanceSample> = {}): RoutePerformanceSample {
	return {
		route_target_id: 'route-1',
		output_tokens: 20,
		latency_ms: 1_000,
		upstream_response_ms: 800,
		final_upstream_headers_ms: 500,
		first_reasoning_token_ms: null,
		first_token_ms: 200,
		stream_duration_ms: 1_000,
		created_at: '2026-09-02T00:00:00.000Z',
		...patch,
	};
}

describe('route performance metrics', () => {
	it('keeps TTFT and complete-generation throughput as distinct metrics', () => {
		assert.equal(routePerformanceLatencySeconds(sample()), 0.2);
		assert.equal(routePerformanceLatencySeconds(sample({ first_reasoning_token_ms: 100 })), 0.1);
		assert.equal(routePerformanceLatencySeconds(sample({ first_token_ms: null })), null);
		assert.equal(routePerformanceLatencySeconds(sample({
			first_token_ms: null,
			first_reasoning_token_ms: null,
			final_upstream_headers_ms: 50,
			latency_ms: 75,
		})), null);
		assert.equal(routePerformanceThroughputTokensPerSecond(sample()), 20_000 / 1_500);
		assert.equal(routePerformanceThroughputTokensPerSecond(sample({ stream_duration_ms: 0 })), 40);
		assert.equal(routePerformanceThroughputTokensPerSecond(sample({
			final_upstream_headers_ms: null,
		})), null);
	});

	it('collects only allowed bounded samples and preserves percentile direction', () => {
		const series = collectRoutePerformanceSeries({
			samples: [sample(), sample({ first_token_ms: 400 }), sample({ route_target_id: 'route-2' })],
			allowedRouteTargetIds: new Set(['route-1']),
			maxSamplesPerRoute: 2,
		});
		assert.equal(series.get('route-1')?.sampleCount, 2);
		assert.deepEqual(series.get('route-1')?.latencySeconds, [0.2, 0.4]);
		assert.equal(routePerformancePercentile([0.1, 0.2, 0.3, 0.4], 'p90'), 0.4);
		assert.equal(routePerformancePercentile([10, 20, 30, 40], 'p90', true), 10);
	});
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, RoutePerformanceSample } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { applyProviderPerformanceRouting } from './provider-performance-routing';
import type { ProviderPreferences } from './provider-routing-preferences';

function route(id: string): RouteResult {
	return {
		targetId: id, modelSurfaceId: null, routePoolId: 'pool', providerId: id,
		providerName: id, providerModelName: 'model', upstreamProtocol: 'openai',
		upstreamOperation: 'chat', adapter: 'passthrough', providerEndpoints: {},
		providerApiKey: 'secret', providerSharedChannelType: null, priceOverrideRaw: null,
		routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null,
		routeGroup: 'default', routePriority: 1, routeWeight: 1,
	};
}

function preferences(overrides: Partial<ProviderPreferences>): ProviderPreferences {
	return {
		order: [], only: null, ignore: [], allowFallbacks: true, requireZdr: false,
		requireParameters: false, dataCollection: 'allow', enforceDistillableText: false,
		quantizations: null, sort: null, preferredMinThroughput: null,
		preferredMaxLatency: null, maxPrice: null, ...overrides,
	};
}

function sample(routeTargetId: string, firstTokenMs: number, outputTokens: number, streamDurationMs: number): RoutePerformanceSample {
	return {
		route_target_id: routeTargetId, first_token_ms: firstTokenMs, output_tokens: outputTokens,
		stream_duration_ms: streamDurationMs, latency_ms: null, upstream_response_ms: null,
		final_upstream_headers_ms: null, created_at: '2026-08-30T00:00:00.000Z',
	};
}

type PerformanceRepositories = {
	requestLogs: Pick<GatewayRepositories['requestLogs'], 'getRecentRoutePerformanceSamples'>;
};

function repositories(samples: RoutePerformanceSample[]): PerformanceRepositories {
	return { requestLogs: { getRecentRoutePerformanceSamples: async () => samples } };
}

type SampleQuery = {
	routeTargetIds: string[];
	sinceIso: string;
	maxSamplesPerRoute: number;
};

function repositoriesWithLoader(
	loader: (options: SampleQuery) => Promise<RoutePerformanceSample[]>,
): PerformanceRepositories {
	return { requestLogs: { getRecentRoutePerformanceSamples: loader } };
}

describe('provider performance routing', () => {
	it('sorts by recent latency and throughput with unknown endpoints last', async () => {
		const routes = [route('slow'), route('fast'), route('unknown')];
		const samples = [sample('slow', 2_000, 100, 2_000), sample('fast', 200, 100, 500)];
		const latency = await applyProviderPerformanceRouting(
			repositories(samples), routes, preferences({ sort: { by: 'latency', partition: 'model' } }),
		);
		assert.deepEqual(latency.map((item) => item.targetId), ['fast', 'slow', 'unknown']);
		const throughput = await applyProviderPerformanceRouting(
			repositories(samples), routes, preferences({ sort: { by: 'throughput', partition: 'model' } }),
		);
		assert.deepEqual(throughput.map((item) => item.targetId), ['fast', 'slow', 'unknown']);
	});

	it('uses thresholds as soft preferences and retains fallback routes', async () => {
		const result = await applyProviderPerformanceRouting(
			repositories([
				sample('slow', 2_000, 10, 2_000),
				sample('slow', 3_000, 10, 2_000),
				sample('fast', 200, 100, 1_000),
				sample('fast', 400, 100, 1_000),
			]),
			[route('slow'), route('fast')],
			preferences({ preferredMaxLatency: { p50: 0.3, p90: 0.5 }, preferredMinThroughput: { p50: 50, p90: 50 } }),
		);
		assert.equal(result.length, 2);
		assert.ok(result.find((item) => item.targetId === 'fast')!.routePriority > result.find((item) => item.targetId === 'slow')!.routePriority);
	});

	it('evaluates every percentile-map cutoff and treats throughput p90 as the low tail', async () => {
		const samples = [
			...Array.from({ length: 9 }, () => sample('stable', 500, 100, 1_000)),
			sample('stable', 500, 20, 1_000),
			...Array.from({ length: 10 }, () => sample('reliable', 500, 60, 1_000)),
		];
		const result = await applyProviderPerformanceRouting(
			repositories(samples),
			[route('stable'), route('reliable')],
			preferences({ preferredMinThroughput: { p50: 50, p90: 50 } }),
		);

		assert.ok(
			result.find((item) => item.targetId === 'reliable')!.routePriority
				> result.find((item) => item.targetId === 'stable')!.routePriority,
		);
	});

	it('keeps threshold-qualified routes ahead of a better secondary sort metric', async () => {
		const result = await applyProviderPerformanceRouting(
			repositories([
				sample('qualified', 5_000, 100, 1_000),
				sample('unqualified', 100, 1, 1_000),
			]),
			[route('unqualified'), route('qualified')],
			preferences({
				preferredMinThroughput: { p50: 50 },
				sort: { by: 'latency', partition: 'model' },
			}),
		);

		assert.deepEqual(result.map((item) => item.targetId), ['qualified', 'unqualified']);
	});

	it('queries every route in bounded batches instead of silently dropping targets after 64', async () => {
		const calls: SampleQuery[] = [];
		const routes = Array.from({ length: 130 }, (_, index) => route(`route-${index}`));
		const result = await applyProviderPerformanceRouting(
			repositoriesWithLoader(async (options) => {
				calls.push(options);
				return options.routeTargetIds.map((targetId) => sample(
					targetId,
					targetId === 'route-129' ? 1 : 1_000,
					10,
					1_000,
				));
			}),
			routes,
			preferences({ sort: { by: 'latency', partition: 'model' } }),
			new Date('2026-08-30T00:05:00.000Z'),
		);

		assert.deepEqual(calls.map((call) => call.routeTargetIds.length), [64, 64, 2]);
		assert.ok(calls.every((call) => call.maxSamplesPerRoute === 100));
		assert.ok(calls.every((call) => call.sinceIso === '2026-08-30T00:00:00.000Z'));
		assert.equal(result[0]?.targetId, 'route-129');
	});
});

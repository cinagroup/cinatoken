import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	RouteAvailabilityAggregate,
	RoutePerformanceSample,
} from '@octafuse/core';
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
		quantizations: null, configuredSort: null, sort: null, preferredMinThroughput: null,
		preferredMaxLatency: null, maxPrice: null, serviceTier: null, explicitServiceTier: null,
		requestedSpeed: null, speedControlled: false, modelVariant: null,
		...overrides,
	};
}

function sample(routeTargetId: string, firstTokenMs: number, outputTokens: number, streamDurationMs: number): RoutePerformanceSample {
	return {
		route_target_id: routeTargetId, first_reasoning_token_ms: null,
		first_token_ms: firstTokenMs, output_tokens: outputTokens,
		stream_duration_ms: streamDurationMs, latency_ms: null, upstream_response_ms: null,
		final_upstream_headers_ms: 100, created_at: '2026-08-30T00:00:00.000Z',
	};
}

type PerformanceRepositories = {
	requestLogs: Pick<
		GatewayRepositories['requestLogs'],
		'getRecentRoutePerformanceSamples' | 'getRouteAvailabilityAggregates'
	>;
};

function enoughSamples(samples: RoutePerformanceSample[]): RoutePerformanceSample[] {
	return samples.flatMap((item) => Array.from({ length: 5 }, () => ({ ...item })));
}

function repositories(samples: RoutePerformanceSample[]): PerformanceRepositories {
	return { requestLogs: {
		getRecentRoutePerformanceSamples: async () => enoughSamples(samples),
		getRouteAvailabilityAggregates: async () => [],
	} };
}

type SampleQuery = {
	routeTargetIds: string[];
	sinceIso: string;
	maxSamplesPerRoute: number;
};

function repositoriesWithLoader(
	loader: (options: SampleQuery) => Promise<RoutePerformanceSample[]>,
	availabilityLoader: () => Promise<RouteAvailabilityAggregate[]> = async () => [],
): PerformanceRepositories {
	return { requestLogs: {
		getRecentRoutePerformanceSamples: async (options) => enoughSamples(await loader(options)),
		getRouteAvailabilityAggregates: availabilityLoader,
	} };
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

	it('requires enough metric samples before one request can change provider order', async () => {
		const routes = [route('configured-first'), route('one-fast-sample')];
		const result = await applyProviderPerformanceRouting({ requestLogs: {
			getRecentRoutePerformanceSamples: async () => [
				sample('configured-first', 1_000, 10, 1_000),
				sample('one-fast-sample', 1, 10, 1_000),
			],
			getRouteAvailabilityAggregates: async () => [],
		} }, routes, preferences({ sort: { by: 'latency', partition: 'model' } }));

		assert.deepEqual(result.map((item) => item.targetId), [
			'configured-first',
			'one-fast-sample',
		]);
	});

	it('demotes endpoints with 100-sample degraded or down uptime before speed', async () => {
		const result = await applyProviderPerformanceRouting(
			repositoriesWithLoader(
				async () => [
					sample('fast-down', 10, 100, 100),
					sample('slower-healthy', 500, 100, 1_000),
				],
				async () => [{
					route_target_id: 'fast-down',
					available_5m: 70,
					total_5m: 100,
					available_30m: 70,
					total_30m: 100,
					available_1d: 70,
					total_1d: 100,
				}],
			),
			[route('fast-down'), route('slower-healthy')],
			preferences({ sort: { by: 'latency', partition: 'model' } }),
		);

		assert.deepEqual(result.map((item) => item.targetId), [
			'slower-healthy',
			'fast-down',
		]);
	});

	it('fails open with sanitized warnings when optional telemetry is unavailable', async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (value?: unknown) => warnings.push(String(value));
		try {
			const routes = [route('first'), route('second')];
			const result = await applyProviderPerformanceRouting({ requestLogs: {
				getRecentRoutePerformanceSamples: async () => {
					throw new Error('private performance database detail');
				},
				getRouteAvailabilityAggregates: async () => {
					throw new Error('private availability database detail');
				},
			} }, routes, preferences({ sort: { by: 'latency', partition: 'model' } }));
			assert.deepEqual(result.map((item) => item.targetId), ['first', 'second']);
			assert.equal(warnings.length, 2);
			assert.match(warnings[0]!, /provider performance samples unavailable/u);
			assert.match(warnings[1]!, /provider availability aggregates unavailable/u);
			assert.doesNotMatch(warnings.join(' '), /private/u);
		} finally {
			console.warn = originalWarn;
		}
	});
});

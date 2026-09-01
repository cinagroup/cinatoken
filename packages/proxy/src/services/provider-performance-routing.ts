import type { GatewayRepositories, RoutePerformanceSample } from '@octafuse/core';
import type { RouteResult } from './model-router';
import type {
	ProviderPerformancePreference,
	ProviderPercentile,
	ProviderPreferences,
} from './provider-routing-preferences';

const PERFORMANCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ROUTES_PER_QUERY = 64;
const MAX_SAMPLES_PER_ROUTE = 100;

type RoutePerformance = {
	latencySeconds: number[];
	throughputTokensPerSecond: number[];
};

type ProviderPerformanceRepositories = {
	requestLogs: Pick<GatewayRepositories['requestLogs'], 'getRecentRoutePerformanceSamples'>;
};

function finiteNonNegative(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

function latencySeconds(sample: RoutePerformanceSample): number | null {
	for (const value of [
		sample.first_token_ms,
		sample.final_upstream_headers_ms,
		sample.upstream_response_ms,
		sample.latency_ms,
	]) {
		const milliseconds = finiteNonNegative(value);
		if (milliseconds != null) return milliseconds / 1_000;
	}
	return null;
}

function throughputTokensPerSecond(sample: RoutePerformanceSample): number | null {
	const tokens = finiteNonNegative(sample.output_tokens);
	const duration = finiteNonNegative(sample.stream_duration_ms);
	if (tokens == null || tokens <= 0 || duration == null || duration <= 0) return null;
	return tokens * 1_000 / duration;
}

function percentile(
	values: number[],
	requested: ProviderPercentile,
	higherIsBetter = false,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const ratio = Number(requested.slice(1)) / 100;
	// Latency p90 is the slow-tail percentile. Throughput p90 means 90% of
	// requests achieved at least the returned rate, so it uses the low tail.
	const index = higherIsBetter
		? Math.max(0, Math.ceil((1 - ratio) * sorted.length) - 1)
		: Math.max(0, Math.ceil(ratio * sorted.length) - 1);
	return sorted[index] ?? null;
}

function preferenceEntries(
	preference: ProviderPerformancePreference,
): Array<readonly [ProviderPercentile, number]> {
	if (typeof preference === 'number') return [['p50', preference]];
	return (['p50', 'p75', 'p90', 'p99'] as const).flatMap((requested) => {
		const threshold = preference[requested];
		return threshold === undefined ? [] : [[requested, threshold] as const];
	});
}

function routeMeetsThresholds(
	metric: RoutePerformance | undefined,
	preferences: ProviderPreferences,
): boolean {
	if (!metric) return false;
	if (preferences.preferredMinThroughput != null) {
		for (const [requested, threshold] of preferenceEntries(preferences.preferredMinThroughput)) {
			const actual = percentile(metric.throughputTokensPerSecond, requested, true);
			if (actual == null || actual < threshold) return false;
		}
	}
	if (preferences.preferredMaxLatency != null) {
		for (const [requested, threshold] of preferenceEntries(preferences.preferredMaxLatency)) {
			const actual = percentile(metric.latencySeconds, requested);
			if (actual == null || actual > threshold) return false;
		}
	}
	return true;
}

function sortMetric(metric: RoutePerformance | undefined, by: 'latency' | 'throughput'): number | null {
	if (!metric) return null;
	return percentile(
		by === 'latency' ? metric.latencySeconds : metric.throughputTokensPerSecond,
		'p50',
		by === 'throughput',
	);
}

/** Apply OpenRouter-style recent performance preferences using a bounded five-minute sample. */
export async function applyProviderPerformanceRouting(
	repos: ProviderPerformanceRepositories,
	routes: RouteResult[],
	preferences: ProviderPreferences,
	now = new Date(),
): Promise<RouteResult[]> {
	const usesPerformance =
		preferences.sort?.by === 'latency' ||
		preferences.sort?.by === 'throughput' ||
		preferences.preferredMinThroughput != null ||
		preferences.preferredMaxLatency != null;
	if (!usesPerformance || routes.length <= 1) return routes;

	const routeTargetIds = [...new Set(routes.map((route) => route.targetId))];
	const routeTargetIdSet = new Set(routeTargetIds);
	const metrics = new Map<string, RoutePerformance>();
	const sampleCounts = new Map<string, number>();
	const sinceIso = new Date(now.getTime() - PERFORMANCE_WINDOW_MS).toISOString();
	for (let offset = 0; offset < routeTargetIds.length; offset += MAX_ROUTES_PER_QUERY) {
		const routeTargetBatch = routeTargetIds.slice(offset, offset + MAX_ROUTES_PER_QUERY);
		const samples = await repos.requestLogs.getRecentRoutePerformanceSamples({
			routeTargetIds: routeTargetBatch,
			sinceIso,
			maxSamplesPerRoute: MAX_SAMPLES_PER_ROUTE,
		});
		for (const sample of samples) {
			if (!routeTargetIdSet.has(sample.route_target_id)) continue;
			const count = sampleCounts.get(sample.route_target_id) ?? 0;
			if (count >= MAX_SAMPLES_PER_ROUTE) continue;
			sampleCounts.set(sample.route_target_id, count + 1);
			const metric = metrics.get(sample.route_target_id) ?? {
				latencySeconds: [],
				throughputTokensPerSecond: [],
			};
			const latency = latencySeconds(sample);
			if (latency != null) metric.latencySeconds.push(latency);
			const throughput = throughputTokensPerSecond(sample);
			if (throughput != null) metric.throughputTokensPerSecond.push(throughput);
			metrics.set(sample.route_target_id, metric);
		}
	}

	let ordered = [...routes];
	let preferredIds: Set<string> | null = null;
	if (preferences.preferredMinThroughput != null || preferences.preferredMaxLatency != null) {
		const thresholdPreferredIds = new Set(
			ordered
				.filter((route) => routeMeetsThresholds(metrics.get(route.targetId), preferences))
				.map((route) => route.targetId),
		);
		preferredIds = thresholdPreferredIds;
		ordered = ordered.map((route) => ({
			...route,
			gatewayPerformancePreferred: thresholdPreferredIds.has(route.targetId),
		}));
		if (thresholdPreferredIds.size > 0) {
			ordered = ordered.map((route) => ({
				...route,
				routePriority: thresholdPreferredIds.has(route.targetId)
					? route.routePriority + 1_000_000
					: route.routePriority,
			}));
		}
	}

	const sortBy = preferences.sort?.by;
	if (sortBy === 'latency' || sortBy === 'throughput') {
		ordered.sort((left, right) => {
			if (preferredIds && preferredIds.size > 0) {
				const preferredDelta = Number(preferredIds.has(right.targetId))
					- Number(preferredIds.has(left.targetId));
				if (preferredDelta !== 0) return preferredDelta;
			}
			const leftMetric = sortMetric(metrics.get(left.targetId), sortBy);
			const rightMetric = sortMetric(metrics.get(right.targetId), sortBy);
			if (leftMetric == null && rightMetric == null) return 0;
			if (leftMetric == null) return 1;
			if (rightMetric == null) return -1;
			return sortBy === 'latency' ? leftMetric - rightMetric : rightMetric - leftMetric;
		});
		ordered = ordered.map((route, index) => ({ ...route, routePriority: ordered.length - index }));
	}
	return ordered;
}

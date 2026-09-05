import type {
	GatewayRepositories,
	RouteAvailabilityAggregate,
	RoutePerformanceSample,
} from '@octafuse/core';
import {
	collectRoutePerformanceSeries,
	MIN_ROUTE_AVAILABILITY_OBSERVATIONS,
	ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY,
	ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
	ROUTE_PERFORMANCE_WINDOW_MS,
	routePerformanceMetricIsReady,
	routePerformancePercentile,
	type RoutePerformanceSeries,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import type {
	ProviderPerformancePreference,
	ProviderPercentile,
	ProviderPreferences,
} from './provider-routing-preferences';

type ProviderPerformanceRepositories = {
	requestLogs: Pick<
		GatewayRepositories['requestLogs'],
		'getRecentRoutePerformanceSamples' | 'getRouteAvailabilityAggregates'
	>;
};

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
	metric: RoutePerformanceSeries | undefined,
	preferences: ProviderPreferences,
): boolean {
	if (!metric) return false;
	if (preferences.preferredMinThroughput != null) {
		for (const [requested, threshold] of preferenceEntries(preferences.preferredMinThroughput)) {
			const actual = routePerformanceMetricIsReady(metric.throughputTokensPerSecond)
				? routePerformancePercentile(metric.throughputTokensPerSecond, requested, true)
				: null;
			if (actual == null || actual < threshold) return false;
		}
	}
	if (preferences.preferredMaxLatency != null) {
		for (const [requested, threshold] of preferenceEntries(preferences.preferredMaxLatency)) {
			const actual = routePerformanceMetricIsReady(metric.latencySeconds)
				? routePerformancePercentile(metric.latencySeconds, requested)
				: null;
			if (actual == null || actual > threshold) return false;
		}
	}
	return true;
}

function sortMetric(metric: RoutePerformanceSeries | undefined, by: 'latency' | 'throughput'): number | null {
	if (!metric) return null;
	const values = by === 'latency' ? metric.latencySeconds : metric.throughputTokensPerSecond;
	if (!routePerformanceMetricIsReady(values)) return null;
	return routePerformancePercentile(
		values,
		'p50',
		by === 'throughput',
	);
}

/** 0 = normal/insufficient evidence, 1 = degraded, 2 = down. */
function routeReliabilityRank(aggregate: RouteAvailabilityAggregate | undefined): number {
	if (!aggregate || aggregate.total_5m < MIN_ROUTE_AVAILABILITY_OBSERVATIONS) return 0;
	const uptime = aggregate.available_5m / aggregate.total_5m;
	if (uptime >= 0.95) return 0;
	return uptime >= 0.8 ? 1 : 2;
}

function telemetryWarning(message: string): void {
	console.warn(JSON.stringify({ message }));
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
	const sinceIso = new Date(now.getTime() - ROUTE_PERFORMANCE_WINDOW_MS).toISOString();
	const since30mIso = new Date(now.getTime() - 30 * 60 * 1_000).toISOString();
	const since1dIso = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
	const sampleBatches: RoutePerformanceSample[] = [];
	const availabilityByRoute = new Map<string, RouteAvailabilityAggregate>();
	let performanceTelemetryFailed = false;
	let availabilityTelemetryFailed = false;
	for (let offset = 0; offset < routeTargetIds.length; offset += ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY) {
		const routeTargetBatch = routeTargetIds.slice(offset, offset + ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY);
		const [samples, availability] = await Promise.allSettled([
			repos.requestLogs.getRecentRoutePerformanceSamples({
				routeTargetIds: routeTargetBatch,
				sinceIso,
				maxSamplesPerRoute: ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
			}),
			repos.requestLogs.getRouteAvailabilityAggregates({
				routeTargetIds: routeTargetBatch,
				since5mIso: sinceIso,
				since30mIso,
				since1dIso,
			}),
		]);
		if (samples.status === 'fulfilled') sampleBatches.push(...samples.value);
		else performanceTelemetryFailed = true;
		if (availability.status === 'fulfilled') {
			for (const aggregate of availability.value) {
				if (routeTargetIdSet.has(aggregate.route_target_id)) {
					availabilityByRoute.set(aggregate.route_target_id, aggregate);
				}
			}
		} else availabilityTelemetryFailed = true;
	}
	if (performanceTelemetryFailed) telemetryWarning('provider performance samples unavailable');
	if (availabilityTelemetryFailed) telemetryWarning('provider availability aggregates unavailable');
	const metrics = collectRoutePerformanceSeries({
		samples: sampleBatches,
		allowedRouteTargetIds: routeTargetIdSet,
		maxSamplesPerRoute: ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
	});

	let ordered = [...routes];
	const reliabilityRank = (route: RouteResult) => routeReliabilityRank(
		availabilityByRoute.get(route.targetId),
	);
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
			const reliabilityDelta = reliabilityRank(left) - reliabilityRank(right);
			if (reliabilityDelta !== 0) return reliabilityDelta;
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
	} else if (preferredIds != null || ordered.some((route) => reliabilityRank(route) > 0)) {
		ordered.sort((left, right) => {
			const reliabilityDelta = reliabilityRank(left) - reliabilityRank(right);
			if (reliabilityDelta !== 0) return reliabilityDelta;
			if (preferredIds && preferredIds.size > 0) {
				const preferredDelta = Number(preferredIds.has(right.targetId))
					- Number(preferredIds.has(left.targetId));
				if (preferredDelta !== 0) return preferredDelta;
			}
			return right.routePriority - left.routePriority;
		});
		ordered = ordered.map((route, index) => ({ ...route, routePriority: ordered.length - index }));
	}
	return ordered;
}

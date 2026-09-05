import type { RoutePerformanceSample } from './db/request-logs-types';

export const ROUTE_PERFORMANCE_WINDOW_MS = 5 * 60 * 1000;
export const ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY = 64;
export const ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE = 100;
/** Avoid letting one anomalous request control live provider routing. */
export const ROUTE_PERFORMANCE_MIN_SAMPLES_PER_METRIC = 5;

export type RoutePerformancePercentile = 'p50' | 'p75' | 'p90' | 'p99';

export type RoutePerformanceSeries = {
	latencySeconds: number[];
	throughputTokensPerSecond: number[];
	sampleCount: number;
};

function finiteNonNegative(value: unknown): number | null {
	if (value == null || value === '' || typeof value === 'boolean') return null;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

export function routePerformanceLatencySeconds(sample: RoutePerformanceSample): number | null {
	const reasoning = finiteNonNegative(sample.first_reasoning_token_ms);
	const content = finiteNonNegative(sample.first_token_ms);
	if (reasoning == null && content == null) return null;
	// Reasoning-capable models can emit a reasoning token before visible content.
	// Endpoint latency is strict TTFT, never a fallback to headers or total time.
	return Math.min(reasoning ?? Number.POSITIVE_INFINITY, content ?? Number.POSITIVE_INFINITY) / 1_000;
}

export function routePerformanceThroughputTokensPerSecond(
	sample: RoutePerformanceSample,
): number | null {
	const tokens = finiteNonNegative(sample.output_tokens);
	const fetchDuration = finiteNonNegative(sample.final_upstream_headers_ms);
	const responseDuration = finiteNonNegative(sample.stream_duration_ms);
	if (tokens == null || tokens <= 0 || fetchDuration == null || responseDuration == null) return null;
	// OpenRouter defines generation time as fetch latency + TTFT + streaming.
	// final_upstream_headers_ms is scoped to the selected attempt; the stream
	// duration then covers everything from its response headers through EOF.
	const generationDuration = fetchDuration + responseDuration;
	if (generationDuration <= 0) return null;
	return tokens * 1_000 / generationDuration;
}

export function routePerformanceMetricIsReady(values: readonly number[]): boolean {
	return values.length >= ROUTE_PERFORMANCE_MIN_SAMPLES_PER_METRIC;
}

export function routePerformancePercentile(
	values: readonly number[],
	requested: RoutePerformancePercentile,
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

export function collectRoutePerformanceSeries(params: {
	samples: readonly RoutePerformanceSample[];
	allowedRouteTargetIds?: ReadonlySet<string>;
	maxSamplesPerRoute?: number;
}): Map<string, RoutePerformanceSeries> {
	const maxSamplesPerRoute = Math.max(
		0,
		Math.min(
			Math.trunc(params.maxSamplesPerRoute ?? ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE),
			ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
		),
	);
	const metrics = new Map<string, RoutePerformanceSeries>();
	if (maxSamplesPerRoute === 0) return metrics;
	for (const sample of params.samples) {
		if (params.allowedRouteTargetIds && !params.allowedRouteTargetIds.has(sample.route_target_id)) continue;
		const metric = metrics.get(sample.route_target_id) ?? {
			latencySeconds: [],
			throughputTokensPerSecond: [],
			sampleCount: 0,
		};
		if (metric.sampleCount >= maxSamplesPerRoute) continue;
		metric.sampleCount += 1;
		const latency = routePerformanceLatencySeconds(sample);
		if (latency != null) metric.latencySeconds.push(latency);
		const throughput = routePerformanceThroughputTokensPerSecond(sample);
		if (throughput != null) metric.throughputTokensPerSecond.push(throughput);
		metrics.set(sample.route_target_id, metric);
	}
	return metrics;
}

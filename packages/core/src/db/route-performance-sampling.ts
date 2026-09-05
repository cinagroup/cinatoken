export const MAX_ROUTE_PERFORMANCE_SAMPLES_PER_TARGET = 100;

export type RoutePerformanceSamplingDialect = 'd1' | 'postgres' | 'mysql';

/** Keep request-time performance sampling bounded even if a future caller passes an unsafe value. */
export function normalizeRoutePerformanceSamplesPerTarget(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.trunc(value), MAX_ROUTE_PERFORMANCE_SAMPLES_PER_TARGET);
}

/**
 * Select the newest bounded sample independently for every route target.
 *
 * D1 may contain both SQLite `CURRENT_TIMESTAMP` values and ISO-8601 values,
 * so it compares and orders via `julianday` instead of lexicographic text.
 */
export function buildRecentRoutePerformanceSamplesSql(
	dialect: RoutePerformanceSamplingDialect,
	routeTargetCount: number,
): string {
	if (!Number.isInteger(routeTargetCount) || routeTargetCount <= 0) {
		throw new RangeError('routeTargetCount must be a positive integer');
	}
	const placeholders = Array.from({ length: routeTargetCount }, () => '?').join(', ');
	const sincePredicate = dialect === 'd1'
		? 'julianday(created_at) >= julianday(?)'
		: 'created_at >= ?';
	const newestFirst = dialect === 'd1'
		? 'julianday(created_at) DESC, created_at DESC, id DESC'
		: 'created_at DESC, id DESC';
	const createdAtProjection = dialect === 'postgres'
		? 'created_at::text AS created_at'
		: 'created_at';

	return `WITH ranked_samples AS (
		SELECT route_target_id, output_tokens, latency_ms, upstream_response_ms,
		       final_upstream_headers_ms, first_reasoning_token_ms, first_token_ms,
		       stream_duration_ms, created_at,
		       ROW_NUMBER() OVER (
			       PARTITION BY route_target_id
			       ORDER BY ${newestFirst}
		       ) AS sample_rank
		FROM api_key_request_logs
		WHERE status = 'success'
		  AND route_target_id IN (${placeholders})
		  AND ${sincePredicate}
	)
	SELECT route_target_id, output_tokens, latency_ms, upstream_response_ms,
	       final_upstream_headers_ms, first_reasoning_token_ms, first_token_ms,
	       stream_duration_ms, ${createdAtProjection}
	FROM ranked_samples
	WHERE sample_rank <= ?
	ORDER BY route_target_id ASC, sample_rank ASC`;
}

export const MAX_PROVIDER_ATTEMPT_FACTS_PER_REQUEST = 128;
export const MAX_ROUTE_AVAILABILITY_ROUTES_PER_QUERY = 64;
/** OpenRouter does not classify endpoint uptime before 100 eligible observations. */
export const MIN_ROUTE_AVAILABILITY_OBSERVATIONS = 100;
export const MIN_PROVIDER_ATTEMPT_RETENTION_DAYS = 2;
export const DEFAULT_PROVIDER_ATTEMPT_RETENTION_DAYS = 7;
export const MAX_PROVIDER_ATTEMPT_RETENTION_DAYS = 30;
export const MAX_PROVIDER_ATTEMPT_RETENTION_DELETE_BATCH = 5_000;

export type ProviderAttemptAvailabilityOutcome = 'available' | 'unavailable' | 'excluded';

export type ProviderAttemptAvailabilityReason =
	| 'accepted'
	| 'provider_http_error'
	| 'rate_limited'
	| 'network_error'
	| 'invalid_response'
	| 'client_error'
	| 'client_cancelled'
	| 'unknown';

export function providerAttemptAvailabilityForHttpStatus(status: number): {
	outcome: ProviderAttemptAvailabilityOutcome;
	reason: ProviderAttemptAvailabilityReason;
} {
	if (status === 101 || (status >= 200 && status <= 299)) {
		return { outcome: 'available', reason: 'accepted' };
	}
	if (status === 429) {
		// OpenRouter tracks throttling separately from endpoint uptime.
		return { outcome: 'excluded', reason: 'rate_limited' };
	}
	if (status === 403) {
		// Geographic/policy restrictions do not prove that the endpoint is down.
		return { outcome: 'excluded', reason: 'client_error' };
	}
	if (
		(status >= 300 && status <= 399)
		|| [401, 402, 404, 405, 407, 408, 410, 421, 423, 424, 425, 426, 451].includes(status)
		|| (status >= 500 && status <= 599)
	) {
		return { outcome: 'unavailable', reason: 'provider_http_error' };
	}
	if (status >= 400 && status <= 499) {
		return { outcome: 'excluded', reason: 'client_error' };
	}
	return { outcome: 'excluded', reason: 'unknown' };
}

/**
 * Minimal, credential-free fact persisted for endpoint availability aggregation.
 * It intentionally excludes provider keys, URLs, bodies and raw error messages.
 */
export type InsertProviderAttemptAvailability = {
	attemptIndex: number;
	routeTargetId: string;
	providerId: string;
	outcome: ProviderAttemptAvailabilityOutcome;
	reason: ProviderAttemptAvailabilityReason;
	httpStatus: number | null;
	observedAtIso: string;
};

export type RouteAvailabilityAggregate = {
	route_target_id: string;
	available_5m: number;
	total_5m: number;
	available_30m: number;
	total_30m: number;
	available_1d: number;
	total_1d: number;
};

export type RouteAvailabilityAggregateDialect = 'd1' | 'postgres' | 'mysql';

export type ProviderAttemptRetentionDeleteParams = {
	cutoffIso: string;
	limit: number;
};

export function assertProviderAttemptRetentionDeleteParams(
	params: ProviderAttemptRetentionDeleteParams,
): void {
	if (
		!canonicalIsoTimestamp(params.cutoffIso)
		|| !Number.isSafeInteger(params.limit)
		|| params.limit <= 0
		|| params.limit > MAX_PROVIDER_ATTEMPT_RETENTION_DELETE_BATCH
	) {
		throw new TypeError('Provider attempt retention delete parameters are invalid');
	}
}

/**
 * Bounded oldest-first deletion. Each dialect also refuses to delete facts
 * newer than 25 hours, preserving the longest public uptime window even if a
 * caller is compromised or misconfigured.
 */
export function buildProviderAttemptRetentionDeleteSql(
	dialect: RouteAvailabilityAggregateDialect,
): string {
	if (dialect === 'postgres') {
		return `SELECT cinatoken_gateway.delete_provider_attempt_availability_before(?, ?) AS deleted_count`;
	}
	if (dialect === 'mysql') {
		return `DELETE FROM provider_attempt_availability
		WHERE observed_at < ?
			AND ? <= UTC_TIMESTAMP(6) - INTERVAL 25 HOUR
		ORDER BY observed_at ASC
		LIMIT ?`;
	}
	return `DELETE FROM provider_attempt_availability
	WHERE rowid IN (
		SELECT rowid
		FROM provider_attempt_availability
		WHERE observed_at < ?
			AND ? <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')
		ORDER BY observed_at ASC
		LIMIT ?
	)`;
}

function availabilityObservedPredicate(
	_dialect: RouteAvailabilityAggregateDialect,
): string {
	return 'observed_at >= ?';
}

/** One grouped row per requested Route; raw attempt rows never cross the repository boundary. */
export function buildRouteAvailabilityAggregateSql(
	dialect: RouteAvailabilityAggregateDialect,
	routeTargetCount: number,
): string {
	if (
		!Number.isSafeInteger(routeTargetCount)
		|| routeTargetCount <= 0
		|| routeTargetCount > MAX_ROUTE_AVAILABILITY_ROUTES_PER_QUERY
	) {
		throw new RangeError('Route availability query exceeds the route bound');
	}
	const placeholders = Array.from({ length: routeTargetCount }, () => '?').join(', ');
	const observed = availabilityObservedPredicate(dialect);
	return `SELECT route_target_id,
		SUM(CASE WHEN ${observed} AND outcome = 'available' THEN 1 ELSE 0 END) AS available_5m,
		SUM(CASE WHEN ${observed} THEN 1 ELSE 0 END) AS total_5m,
		SUM(CASE WHEN ${observed} AND outcome = 'available' THEN 1 ELSE 0 END) AS available_30m,
		SUM(CASE WHEN ${observed} THEN 1 ELSE 0 END) AS total_30m,
		SUM(CASE WHEN ${observed} AND outcome = 'available' THEN 1 ELSE 0 END) AS available_1d,
		SUM(CASE WHEN ${observed} THEN 1 ELSE 0 END) AS total_1d
	FROM provider_attempt_availability
	WHERE route_target_id IN (${placeholders})
		AND outcome IN ('available', 'unavailable')
		AND ${observed}
	GROUP BY route_target_id
	ORDER BY route_target_id`;
}

export function routeAvailabilityAggregateParams(options: {
	routeTargetIds: readonly string[];
	since5mIso: string;
	since30mIso: string;
	since1dIso: string;
}): Array<string> {
	if (
		options.routeTargetIds.length === 0
		|| options.routeTargetIds.length > MAX_ROUTE_AVAILABILITY_ROUTES_PER_QUERY
		|| new Set(options.routeTargetIds).size !== options.routeTargetIds.length
		|| options.routeTargetIds.some((id) => !boundedIdentity(id))
		|| !canonicalIsoTimestamp(options.since5mIso)
		|| !canonicalIsoTimestamp(options.since30mIso)
		|| !canonicalIsoTimestamp(options.since1dIso)
		|| options.since1dIso > options.since30mIso
		|| options.since30mIso > options.since5mIso
	) {
		throw new TypeError('Route availability aggregate options are invalid');
	}
	return [
		options.since5mIso,
		options.since5mIso,
		options.since30mIso,
		options.since30mIso,
		options.since1dIso,
		options.since1dIso,
		...options.routeTargetIds,
		options.since1dIso,
	];
}

export function normalizeRouteAvailabilityAggregate(
	row: Record<string, unknown>,
): RouteAvailabilityAggregate {
	if (typeof row.route_target_id !== 'string' || row.route_target_id.length === 0) {
		throw new TypeError('Route availability aggregate identity is invalid');
	}
	const value = (key: keyof Omit<RouteAvailabilityAggregate, 'route_target_id'>): number => {
		const numeric = Number(row[key]);
		if (!Number.isSafeInteger(numeric) || numeric < 0) {
			throw new TypeError('Route availability aggregate count is invalid');
		}
		return numeric;
	};
	const aggregate: RouteAvailabilityAggregate = {
		route_target_id: row.route_target_id,
		available_5m: value('available_5m'),
		total_5m: value('total_5m'),
		available_30m: value('available_30m'),
		total_30m: value('total_30m'),
		available_1d: value('available_1d'),
		total_1d: value('total_1d'),
	};
	if (
		aggregate.available_5m > aggregate.total_5m
		|| aggregate.available_30m > aggregate.total_30m
		|| aggregate.available_1d > aggregate.total_1d
		|| aggregate.available_5m > aggregate.available_30m
		|| aggregate.available_30m > aggregate.available_1d
		|| aggregate.total_5m > aggregate.total_30m
		|| aggregate.total_30m > aggregate.total_1d
	) {
		throw new TypeError('Route availability aggregate violates count invariants');
	}
	return aggregate;
}

const OUTCOMES = new Set<ProviderAttemptAvailabilityOutcome>([
	'available',
	'unavailable',
	'excluded',
]);
const REASONS = new Set<ProviderAttemptAvailabilityReason>([
	'accepted',
	'provider_http_error',
	'rate_limited',
	'network_error',
	'invalid_response',
	'client_error',
	'client_cancelled',
	'unknown',
]);

function boundedIdentity(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function canonicalIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
		return false;
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function assertProviderAttemptAvailabilityFacts(
	facts: readonly InsertProviderAttemptAvailability[] | undefined,
): void {
	if (facts === undefined) return;
	if (!Array.isArray(facts) || facts.length > MAX_PROVIDER_ATTEMPT_FACTS_PER_REQUEST) {
		throw new TypeError('Provider attempt availability facts exceed the request bound');
	}
	const indexes = new Set<number>();
	for (const fact of facts) {
		if (
			!fact
			|| !Number.isSafeInteger(fact.attemptIndex)
			|| fact.attemptIndex <= 0
			|| indexes.has(fact.attemptIndex)
			|| !boundedIdentity(fact.routeTargetId)
			|| !boundedIdentity(fact.providerId)
			|| !OUTCOMES.has(fact.outcome)
			|| !REASONS.has(fact.reason)
			|| !canonicalIsoTimestamp(fact.observedAtIso)
			|| (
				fact.httpStatus !== null
				&& (
					!Number.isSafeInteger(fact.httpStatus)
					|| fact.httpStatus < 100
					|| fact.httpStatus > 599
				)
			)
		) {
			throw new TypeError('Provider attempt availability fact is invalid');
		}
		const httpAvailability = fact.httpStatus === null
			? null
			: providerAttemptAvailabilityForHttpStatus(fact.httpStatus);
		const expected = fact.reason === 'client_cancelled'
			&& (httpAvailability === null || httpAvailability.outcome === 'available')
			? { outcome: 'excluded', reason: 'client_cancelled' } as const
			: fact.reason === 'invalid_response' && httpAvailability?.outcome === 'available'
				? { outcome: 'unavailable', reason: 'invalid_response' } as const
				: httpAvailability ?? { outcome: 'unavailable', reason: 'network_error' } as const;
		if (fact.outcome !== expected.outcome || fact.reason !== expected.reason) {
			throw new TypeError('Provider attempt availability outcome and reason disagree');
		}
		indexes.add(fact.attemptIndex);
	}
}

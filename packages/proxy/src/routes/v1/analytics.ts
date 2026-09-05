import {
	ANALYTICS_DIMENSIONS,
	ANALYTICS_FILTER_OPERATORS,
	ANALYTICS_GRANULARITIES,
	ANALYTICS_METRICS,
	type AnalyticsDimension,
	type AnalyticsFilter,
	type AnalyticsFilterOperator,
	type AnalyticsFilterValue,
	type AnalyticsGranularity,
	type AnalyticsMetric,
	type AnalyticsOrderBy,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireStrictManagementApiKey } from '../../middleware/management-auth';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type AnalyticsEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

type JsonObject = Record<string, unknown>;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VALUE_LENGTH = 512;
const DEFAULT_LIMIT = 1_000;
const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1_000;
const SHORT_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
const MINUTE_RANGE_MS = 3 * 60 * 60 * 1_000;
const UTC_WITH_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const KEY_HASH = /^[0-9a-f]{64}$/u;
const ALLOWED_FIELDS = new Set([
	'metrics',
	'dimensions',
	'filters',
	'granularity',
	'group_limit',
	'limit',
	'order_by',
	'time_range',
]);
const METRICS = new Set<string>(ANALYTICS_METRICS);
const DIMENSIONS = new Set<string>(ANALYTICS_DIMENSIONS);
const GRANULARITIES = new Set<string>(ANALYTICS_GRANULARITIES);
const OPERATORS = new Set<string>(ANALYTICS_FILTER_OPERATORS);
const SHORT_RANGE_METRICS = new Set<AnalyticsMetric>(['avg_latency']);
const SHORT_RANGE_DIMENSIONS = new Set<AnalyticsDimension>([
	'provider',
	'app',
	'generation_id',
	'session_id',
	'finish_reason',
	'service_tier',
]);

const METRIC_META = [
	{ name: 'request_count', display_label: 'Request Count', is_rate: false, display_format: 'number' },
	{ name: 'total_usage', display_label: 'Total Usage', is_rate: false, display_format: 'currency' },
	{ name: 'credits_usage', display_label: 'Credits Usage', is_rate: false, display_format: 'currency' },
	{ name: 'openrouter_usage', display_label: 'Platform Usage', is_rate: false, display_format: 'currency' },
	{ name: 'byok_usage', display_label: 'BYOK Usage', is_rate: false, display_format: 'currency' },
	{ name: 'byok_fees', display_label: 'BYOK Fees', is_rate: false, display_format: 'currency' },
	{ name: 'usage_upstream', display_label: 'Upstream Usage', is_rate: false, display_format: 'currency' },
	{ name: 'tokens_total', display_label: 'Total Tokens', is_rate: false, display_format: 'number' },
	{ name: 'tokens_prompt', display_label: 'Prompt Tokens', is_rate: false, display_format: 'number' },
	{ name: 'tokens_completion', display_label: 'Completion Tokens', is_rate: false, display_format: 'number' },
	{ name: 'reasoning_tokens', display_label: 'Reasoning Tokens', is_rate: false, display_format: 'number' },
	{ name: 'cached_tokens', display_label: 'Cached Tokens', is_rate: false, display_format: 'number' },
	{ name: 'byok_request_count', display_label: 'BYOK Request Count', is_rate: false, display_format: 'number' },
	{ name: 'avg_latency', display_label: 'Average Latency', is_rate: false, display_format: 'latency' },
	{ name: 'cache_hit_rate', display_label: 'Cache Hit Rate', is_rate: true, display_format: 'percent' },
] as const;

const DIMENSION_META = [
	{ name: 'model', display_label: 'Model' },
	{ name: 'provider', display_label: 'Provider' },
	{ name: 'api_key_id', display_label: 'API Key' },
	{ name: 'user', display_label: 'User' },
	{ name: 'workspace', display_label: 'Workspace' },
	{ name: 'app', display_label: 'App' },
	{ name: 'generation_id', display_label: 'Generation ID' },
	{ name: 'session_id', display_label: 'Session ID' },
	{ name: 'finish_reason', display_label: 'Finish Reason' },
	{ name: 'service_tier', display_label: 'Service Tier' },
	{ name: 'is_byok', display_label: 'BYOK' },
] as const;

const GRANULARITY_META = [
	{ name: 'minute', display_label: 'Minute' },
	{ name: 'hour', display_label: 'Hour' },
	{ name: 'day', display_label: 'Day' },
	{ name: 'week', display_label: 'Week' },
	{ name: 'month', display_label: 'Month' },
] as const;

const OPERATOR_META = [
	{ name: 'eq', value_type: 'scalar' },
	{ name: 'neq', value_type: 'scalar' },
	{ name: 'gt', value_type: 'scalar' },
	{ name: 'gte', value_type: 'scalar' },
	{ name: 'lt', value_type: 'scalar' },
	{ name: 'lte', value_type: 'scalar' },
	{ name: 'in', value_type: 'array' },
	{ name: 'not_in', value_type: 'array' },
] as const;

function account(principal: ManagementApiKeyPrincipal): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function invalid(c: Parameters<typeof gatewayErrorJson>[0], message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStringArray<T extends string>(
	value: unknown,
	allowed: ReadonlySet<string>,
	label: string,
	params: { min: number; max: number },
): T[] {
	if (!Array.isArray(value) || value.length < params.min || value.length > params.max) {
		throw new TypeError(`${label} must contain between ${params.min} and ${params.max} entries`);
	}
	const result: T[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !allowed.has(item)) {
			throw new TypeError(`${label} contains an unsupported value`);
		}
		result.push(item as T);
	}
	if (new Set(result).size !== result.length) {
		throw new TypeError(`${label} must not contain duplicates`);
	}
	return result;
}

function integer(value: unknown, label: string, fallback?: number): number {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10_000) {
		throw new TypeError(`${label} must be an integer between 1 and 10000`);
	}
	return Number(value);
}

function filterAtom(value: unknown): string | number {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('filter values must be finite');
		return value;
	}
	if (typeof value !== 'string' || value.length < 1 || value.length > MAX_VALUE_LENGTH) {
		throw new TypeError(`filter strings must contain between 1 and ${MAX_VALUE_LENGTH} characters`);
	}
	return value;
}

function parseFilters(value: unknown): AnalyticsFilter[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 20) {
		throw new TypeError('filters must be an array with at most 20 entries');
	}
	return value.map((raw) => {
		if (!isObject(raw)) throw new TypeError('each filter must be an object');
		if (Object.keys(raw).some((field) => !['field', 'operator', 'value', 'include_unset'].includes(field))) {
			throw new TypeError('filter contains unsupported fields');
		}
		if (typeof raw.field !== 'string' || !DIMENSIONS.has(raw.field)) {
			throw new TypeError('filter field is unsupported');
		}
		if (typeof raw.operator !== 'string' || !OPERATORS.has(raw.operator)) {
			throw new TypeError('filter operator is unsupported');
		}
		const field = raw.field as AnalyticsDimension;
		const operator = raw.operator as AnalyticsFilterOperator;
		const expectsArray = operator === 'in' || operator === 'not_in';
		let parsedValue: AnalyticsFilterValue;
		if (expectsArray) {
			if (!Array.isArray(raw.value) || raw.value.length < 1 || raw.value.length > 100) {
				throw new TypeError(`${operator} requires an array with between 1 and 100 entries`);
			}
			parsedValue = raw.value.map(filterAtom);
		} else {
			if (Array.isArray(raw.value)) throw new TypeError(`${operator} requires a scalar value`);
			parsedValue = filterAtom(raw.value);
		}
		if (raw.include_unset !== undefined && typeof raw.include_unset !== 'boolean') {
			throw new TypeError('include_unset must be a boolean');
		}
		if (raw.include_unset !== undefined && !expectsArray) {
			throw new TypeError('include_unset is only valid for in and not_in');
		}
		const values = Array.isArray(parsedValue) ? parsedValue : [parsedValue];
		if (field === 'api_key_id' && values.some((item) => typeof item !== 'string' || !KEY_HASH.test(item))) {
			throw new TypeError('api_key_id filters require 64-character lowercase key hashes');
		}
		if (field === 'is_byok' && values.some((item) => item !== 'true' && item !== 'false')) {
			throw new TypeError('is_byok filters accept only "true" or "false"');
		}
		return {
			field,
			operator,
			value: parsedValue,
			...(raw.include_unset === undefined ? {} : { includeUnset: raw.include_unset }),
		};
	});
}

function utcDate(value: unknown, label: string): Date {
	if (typeof value !== 'string') {
		throw new TypeError(`${label} must be an ISO 8601 UTC timestamp including seconds`);
	}
	const match = UTC_WITH_SECONDS.exec(value);
	if (!match) throw new TypeError(`${label} must be an ISO 8601 UTC timestamp including seconds`);
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid`);
	const parts = match.slice(1, 7).map(Number);
	if (
		date.getUTCFullYear() !== parts[0]
		|| date.getUTCMonth() + 1 !== parts[1]
		|| date.getUTCDate() !== parts[2]
		|| date.getUTCHours() !== parts[3]
		|| date.getUTCMinutes() !== parts[4]
		|| date.getUTCSeconds() !== parts[5]
	) {
		throw new TypeError(`${label} is invalid`);
	}
	return date;
}

function timeRange(value: unknown, now: Date): { startDate: string; endDate: string } {
	if (value === undefined) {
		return {
			startDate: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
			endDate: now.toISOString(),
		};
	}
	if (!isObject(value) || Object.keys(value).some((field) => field !== 'start' && field !== 'end')) {
		throw new TypeError('time_range must contain only start and end');
	}
	const start = utcDate(value.start, 'time_range.start');
	const end = utcDate(value.end, 'time_range.end');
	if (start.getTime() >= end.getTime()) {
		throw new TypeError('time_range.start must be before time_range.end');
	}
	return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function parseOrderBy(
	value: unknown,
	metrics: readonly AnalyticsMetric[],
	dimensions: readonly AnalyticsDimension[],
	granularity: AnalyticsGranularity | undefined,
): AnalyticsOrderBy | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value) || Object.keys(value).some((field) => field !== 'field' && field !== 'direction')) {
		throw new TypeError('order_by must contain only field and direction');
	}
	if (value.direction !== 'asc' && value.direction !== 'desc') {
		throw new TypeError('order_by.direction must be asc or desc');
	}
	if (typeof value.field !== 'string') throw new TypeError('order_by.field is invalid');
	const valid = value.field === 'request_count'
		|| metrics.includes(value.field as AnalyticsMetric)
		|| dimensions.includes(value.field as AnalyticsDimension)
		|| (value.field === 'date' && granularity !== undefined);
	if (!valid) throw new TypeError('order_by.field must be a requested metric, dimension, request_count, or date');
	return { field: value.field as AnalyticsOrderBy['field'], direction: value.direction };
}

function parseQuery(body: JsonObject, principal: ManagementApiKeyPrincipal, now: Date) {
	const unsupported = Object.keys(body).filter((field) => !ALLOWED_FIELDS.has(field));
	if (unsupported.length > 0) {
		throw new TypeError(`Unsupported analytics fields: ${unsupported.join(', ')}`);
	}
	const metrics = uniqueStringArray<AnalyticsMetric>(
		body.metrics,
		METRICS,
		'metrics',
		{ min: 1, max: ANALYTICS_METRICS.length },
	);
	const dimensions = body.dimensions === undefined
		? []
		: uniqueStringArray<AnalyticsDimension>(body.dimensions, DIMENSIONS, 'dimensions', { min: 0, max: 2 });
	const filters = parseFilters(body.filters);
	let granularity: AnalyticsGranularity | undefined;
	if (body.granularity !== undefined) {
		if (typeof body.granularity !== 'string' || !GRANULARITIES.has(body.granularity)) {
			throw new TypeError('granularity is unsupported');
		}
		granularity = body.granularity as AnalyticsGranularity;
	}
	const range = timeRange(body.time_range, now);
	const duration = new Date(range.endDate).getTime() - new Date(range.startDate).getTime();
	const shortRange = metrics.some((metric) => SHORT_RANGE_METRICS.has(metric))
		|| dimensions.some((dimension) => SHORT_RANGE_DIMENSIONS.has(dimension))
		|| filters.some((filter) => SHORT_RANGE_DIMENSIONS.has(filter.field));
	const maximum = granularity === 'minute'
		? MINUTE_RANGE_MS
		: shortRange
			? SHORT_RANGE_MS
			: MAX_RANGE_MS;
	if (duration > maximum) {
		throw new TypeError(
			granularity === 'minute'
				? 'minute granularity supports at most 3 hours'
				: shortRange
					? 'requested metrics or dimensions support at most 31 days'
					: 'analytics queries support at most 365 days',
		);
	}
	const limit = integer(body.limit, 'limit', DEFAULT_LIMIT);
	const groupLimit = body.group_limit === undefined
		? undefined
		: integer(body.group_limit, 'group_limit');
	return {
		account: account(principal),
		metrics,
		dimensions,
		filters,
		...(granularity ? { granularity } : {}),
		...range,
		orderBy: parseOrderBy(body.order_by, metrics, dimensions, granularity),
		limit,
		...(groupLimit === undefined ? {} : { groupLimit }),
	};
}

export const analyticsRoutes = new Hono<AnalyticsEnv>();

analyticsRoutes.use('*', requireStrictManagementApiKey);

analyticsRoutes.use('/query', async (c, next) => {
	const limiter = c.env?.ANALYTICS_RATE_LIMITER;
	if (!limiter) {
		await next();
		return;
	}
	try {
		const result = await limiter.limit({
			key: `management-key:${c.get('managementKey').keyId}`,
		});
		if (!result.success) {
			return gatewayErrorJson(c, {
				status: 429,
				code: GatewayErrorCode.analyticsRateLimited,
				message: 'Analytics queries are rate limited to 64 requests per minute',
				headers: { 'Retry-After': '60' },
			});
		}
	} catch (error) {
		console.error('analytics rate limiter failed', {
			error_type: error instanceof Error ? error.name : typeof error,
		});
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: 'Analytics service is temporarily unavailable',
		});
	}
	await next();
});

analyticsRoutes.get('/meta', (c) => {
	c.header('Cache-Control', 'private, no-store');
	return c.json({
		data: {
			metrics: METRIC_META,
			dimensions: DIMENSION_META,
			operators: OPERATOR_META,
			granularities: GRANULARITY_META,
		},
	});
});

analyticsRoutes.post('/query', async (c) => {
	let body: JsonObject;
	try {
		body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MAX_BODY_BYTES,
			label: 'Analytics query',
		});
	} catch (error) {
		if (error instanceof BoundedJsonRequestError) {
			return gatewayErrorJson(c, {
				status: error.kind === 'payload_too_large' ? 413 : 400,
				code: error.kind === 'payload_too_large'
					? GatewayErrorCode.payloadTooLarge
					: GatewayErrorCode.invalidRequest,
				message: error.message,
			});
		}
		throw error;
	}

	let query: ReturnType<typeof parseQuery>;
	try {
		query = parseQuery(body, c.get('managementKey'), new Date());
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : 'Invalid request parameters');
	}
	const startedAt = Date.now();
	const result = await c.get('repositories').requestLogs.queryManagementAnalytics(query);
	c.header('Cache-Control', 'private, no-store');
	return c.json({
		data: {
			data: result.rows,
			metadata: {
				query_time_ms: Math.max(0, Date.now() - startedAt),
				row_count: result.rows.length,
				truncated: result.truncated,
			},
		},
	});
});

import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from './management-api-keys-types';

export const ANALYTICS_METRICS = [
	'request_count',
	'total_usage',
	'credits_usage',
	'openrouter_usage',
	'byok_usage',
	'byok_fees',
	'usage_upstream',
	'tokens_total',
	'tokens_prompt',
	'tokens_completion',
	'reasoning_tokens',
	'cached_tokens',
	'byok_request_count',
	'avg_latency',
	'cache_hit_rate',
] as const;

export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export const ANALYTICS_DIMENSIONS = [
	'model',
	'provider',
	'api_key_id',
	'user',
	'workspace',
	'app',
	'generation_id',
	'session_id',
	'finish_reason',
	'service_tier',
	'is_byok',
] as const;

export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

export const ANALYTICS_GRANULARITIES = [
	'minute',
	'hour',
	'day',
	'week',
	'month',
] as const;

export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

export const ANALYTICS_FILTER_OPERATORS = [
	'eq',
	'neq',
	'gt',
	'gte',
	'lt',
	'lte',
	'in',
	'not_in',
] as const;

export type AnalyticsFilterOperator =
	(typeof ANALYTICS_FILTER_OPERATORS)[number];

export type AnalyticsFilterValue =
	| string
	| number
	| readonly (string | number)[];

export type AnalyticsFilter = {
	field: AnalyticsDimension;
	operator: AnalyticsFilterOperator;
	value: AnalyticsFilterValue;
	includeUnset?: boolean;
};

export type AnalyticsOrderBy = {
	field: AnalyticsMetric | AnalyticsDimension | 'date';
	direction: 'asc' | 'desc';
};

export type ManagementAnalyticsQuery = {
	account: ManagementApiKeyAccount;
	metrics: readonly AnalyticsMetric[];
	dimensions: readonly AnalyticsDimension[];
	filters: readonly AnalyticsFilter[];
	granularity?: AnalyticsGranularity;
	startDate: string;
	endDate: string;
	orderBy?: AnalyticsOrderBy;
	limit: number;
	groupLimit?: number;
};

export type AnalyticsQueryValue = string | number | null;
export type AnalyticsQueryRow = Record<string, AnalyticsQueryValue>;

export type ManagementAnalyticsQueryResult = {
	rows: AnalyticsQueryRow[];
	truncated: boolean;
};

export type AnalyticsSqlDialect = 'd1' | 'postgres' | 'mysql';

export type BuiltAnalyticsQuery = {
	sql: string;
	values: unknown[];
	publicFields: string[];
};

const COUNT_METRICS = new Set<AnalyticsMetric>([
	'request_count',
	'tokens_total',
	'tokens_prompt',
	'tokens_completion',
	'reasoning_tokens',
	'cached_tokens',
	'byok_request_count',
]);
const METRIC_SET = new Set<string>(ANALYTICS_METRICS);
const DIMENSION_SET = new Set<string>(ANALYTICS_DIMENSIONS);
const GRANULARITY_SET = new Set<string>(ANALYTICS_GRANULARITIES);
const FILTER_OPERATOR_SET = new Set<string>(ANALYTICS_FILTER_OPERATORS);

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw new TypeError(`${label} must not contain duplicates`);
	}
}

function quoteIdentifier(dialect: AnalyticsSqlDialect, value: string): string {
	return dialect === 'postgres' ? `"${value}"` : `\`${value}\``;
}

function bucketExpression(
	dialect: AnalyticsSqlDialect,
	granularity: AnalyticsGranularity,
): string {
	if (dialect === 'postgres') {
		const format = granularity === 'minute'
			? 'YYYY-MM-DD"T"HH24:MI:00.000"Z"'
			: granularity === 'hour'
				? 'YYYY-MM-DD"T"HH24:00:00.000"Z"'
				: 'YYYY-MM-DD"T"00:00:00.000"Z"';
		return `to_char(date_trunc('${granularity}', rl.created_at AT TIME ZONE 'UTC'), '${format}')`;
	}
	if (dialect === 'mysql') {
		if (granularity === 'minute') {
			return "DATE_FORMAT(rl.created_at, '%Y-%m-%dT%H:%i:00.000Z')";
		}
		if (granularity === 'hour') {
			return "DATE_FORMAT(rl.created_at, '%Y-%m-%dT%H:00:00.000Z')";
		}
		if (granularity === 'week') {
			return "DATE_FORMAT(DATE_SUB(rl.created_at, INTERVAL WEEKDAY(rl.created_at) DAY), '%Y-%m-%dT00:00:00.000Z')";
		}
		if (granularity === 'month') {
			return "DATE_FORMAT(rl.created_at, '%Y-%m-01T00:00:00.000Z')";
		}
		return "DATE_FORMAT(rl.created_at, '%Y-%m-%dT00:00:00.000Z')";
	}
	if (granularity === 'minute') {
		return "strftime('%Y-%m-%dT%H:%M:00.000Z', rl.created_at)";
	}
	if (granularity === 'hour') {
		return "strftime('%Y-%m-%dT%H:00:00.000Z', rl.created_at)";
	}
	if (granularity === 'week') {
		return "strftime('%Y-%m-%dT00:00:00.000Z', date(rl.created_at, printf('-%d days', (CAST(strftime('%w', rl.created_at) AS INTEGER) + 6) % 7)))";
	}
	if (granularity === 'month') {
		return "strftime('%Y-%m-01T00:00:00.000Z', rl.created_at)";
	}
	return "strftime('%Y-%m-%dT00:00:00.000Z', rl.created_at)";
}

function byokPredicate(dialect: AnalyticsSqlDialect): string {
	return dialect === 'postgres'
		? 'COALESCE(rl.is_byok, FALSE) = TRUE'
		: 'COALESCE(rl.is_byok, 0) = 1';
}

function dimensionSelectExpression(
	dialect: AnalyticsSqlDialect,
	dimension: AnalyticsDimension,
): string {
	switch (dimension) {
		case 'model':
			return "COALESCE(NULLIF(rl.model_id, ''), 'unknown')";
		case 'provider':
			return "COALESCE(NULLIF(rl.provider_name, ''), 'unknown')";
		case 'api_key_id':
			return "COALESCE(NULLIF(ak.name, ''), NULLIF(ak.key_preview, ''), 'unknown')";
		case 'user':
			return "COALESCE(NULLIF(u.email, ''), 'unknown')";
		case 'workspace':
			return "COALESCE(NULLIF(w.name, ''), 'unknown')";
		case 'app':
			return "COALESCE(NULLIF(rl.http_referer, ''), 'unknown')";
		case 'generation_id':
			return 'rl.id';
		case 'session_id':
			return "COALESCE(NULLIF(rl.session_id, ''), 'none')";
		case 'finish_reason':
			return "COALESCE(NULLIF(rl.finish_reason, ''), 'unknown')";
		case 'service_tier':
			return "COALESCE(NULLIF(rl.service_tier, ''), 'unknown')";
		case 'is_byok':
			return dialect === 'postgres'
				? "CASE WHEN COALESCE(rl.is_byok, FALSE) = TRUE THEN 'true' ELSE 'false' END"
				: "CASE WHEN COALESCE(rl.is_byok, 0) = 1 THEN 'true' ELSE 'false' END";
	}
}

function dimensionFilterExpression(
	dialect: AnalyticsSqlDialect,
	dimension: AnalyticsDimension,
): string {
	switch (dimension) {
		case 'model':
			return 'rl.model_id';
		case 'provider':
			return 'rl.provider_name';
		case 'api_key_id':
			return 'ak.key_hash';
		case 'user':
			return 'rl.user_id';
		case 'workspace':
			return 'rl.workspace_id';
		case 'app':
			return 'rl.http_referer';
		case 'generation_id':
			return 'rl.id';
		case 'session_id':
			return 'rl.session_id';
		case 'finish_reason':
			return 'rl.finish_reason';
		case 'service_tier':
			return 'rl.service_tier';
		case 'is_byok':
			return dialect === 'postgres'
				? "CASE WHEN COALESCE(rl.is_byok, FALSE) = TRUE THEN 'true' ELSE 'false' END"
				: "CASE WHEN COALESCE(rl.is_byok, 0) = 1 THEN 'true' ELSE 'false' END";
	}
}

function dimensionGroupExpression(
	dialect: AnalyticsSqlDialect,
	dimension: AnalyticsDimension,
): string {
	switch (dimension) {
		case 'api_key_id':
			return "COALESCE(NULLIF(rl.api_key_id, ''), 'unknown')";
		case 'user':
			return "COALESCE(NULLIF(rl.user_id, ''), 'unknown')";
		case 'workspace':
			return "COALESCE(NULLIF(rl.workspace_id, ''), 'unknown')";
		default:
			return dimensionSelectExpression(dialect, dimension);
	}
}

function metricExpression(
	dialect: AnalyticsSqlDialect,
	metric: AnalyticsMetric,
): string {
	const byok = byokPredicate(dialect);
	switch (metric) {
		case 'request_count':
			return 'COUNT(*)';
		case 'total_usage':
			return `ROUND(COALESCE(SUM(CASE WHEN ${byok} THEN rl.standard_cost ELSE rl.charged_cost END), 0), 6)`;
		case 'credits_usage':
			return 'ROUND(COALESCE(SUM(rl.charged_cost), 0), 6)';
		case 'openrouter_usage':
			return `ROUND(COALESCE(SUM(CASE WHEN ${byok} THEN 0 ELSE rl.charged_cost END), 0), 6)`;
		case 'byok_usage':
			return `ROUND(COALESCE(SUM(CASE WHEN ${byok} THEN rl.standard_cost ELSE 0 END), 0), 6)`;
		case 'byok_fees':
			return 'COALESCE(SUM(0), 0)';
		case 'usage_upstream':
			return 'ROUND(COALESCE(SUM(rl.metered_cost), 0), 6)';
		case 'tokens_total':
			return 'COALESCE(SUM(rl.total_tokens), 0)';
		case 'tokens_prompt':
			return 'COALESCE(SUM(rl.input_tokens), 0)';
		case 'tokens_completion':
			return 'COALESCE(SUM(rl.output_tokens), 0)';
		case 'reasoning_tokens':
			return 'COALESCE(SUM(rl.reasoning_tokens), 0)';
		case 'cached_tokens':
			return 'COALESCE(SUM(rl.cache_read_tokens), 0)';
		case 'byok_request_count':
			return `COALESCE(SUM(CASE WHEN ${byok} THEN 1 ELSE 0 END), 0)`;
		case 'avg_latency':
			return 'COALESCE(AVG(rl.latency_ms), 0)';
		case 'cache_hit_rate':
			return 'COALESCE(SUM(rl.cache_read_tokens) * 1.0 / NULLIF(SUM(rl.input_tokens), 0), 0)';
	}
}

function normalizeFilterValues(filter: AnalyticsFilter): readonly (string | number)[] {
	const array = Array.isArray(filter.value) ? filter.value : [filter.value];
	return filter.field === 'api_key_id'
		? array.map((value) => `sha256:${String(value)}`)
		: array;
}

function validateQuery(query: ManagementAnalyticsQuery): void {
	assertManagementApiKeyAccount(query.account);
	if (query.metrics.length < 1) throw new TypeError('metrics is required');
	if (query.dimensions.length > 2) throw new TypeError('dimensions supports at most 2 entries');
	if (query.filters.length > 20) throw new TypeError('filters supports at most 20 entries');
	if (query.metrics.some((metric) => !METRIC_SET.has(metric))) {
		throw new TypeError('metrics contains an unsupported value');
	}
	if (query.dimensions.some((dimension) => !DIMENSION_SET.has(dimension))) {
		throw new TypeError('dimensions contains an unsupported value');
	}
	if (query.granularity !== undefined && !GRANULARITY_SET.has(query.granularity)) {
		throw new TypeError('granularity is unsupported');
	}
	const start = new Date(query.startDate).getTime();
	const end = new Date(query.endDate).getTime();
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
		throw new TypeError('startDate must be before endDate');
	}
	if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000) {
		throw new TypeError('limit must be an integer between 1 and 10000');
	}
	if (
		query.groupLimit !== undefined
		&& (!Number.isSafeInteger(query.groupLimit) || query.groupLimit < 1 || query.groupLimit > 10_000)
	) {
		throw new TypeError('group_limit must be an integer between 1 and 10000');
	}
	assertUnique(query.metrics, 'metrics');
	assertUnique(query.dimensions, 'dimensions');
	for (const filter of query.filters) {
		if (!DIMENSION_SET.has(filter.field)) {
			throw new TypeError('filter field is unsupported');
		}
		if (!FILTER_OPERATOR_SET.has(filter.operator)) {
			throw new TypeError('filter operator is unsupported');
		}
		if (filter.includeUnset !== undefined && typeof filter.includeUnset !== 'boolean') {
			throw new TypeError('filter includeUnset must be a boolean');
		}
		if (
			filter.includeUnset !== undefined
			&& filter.operator !== 'in'
			&& filter.operator !== 'not_in'
		) {
			throw new TypeError('filter includeUnset is only valid for set operators');
		}
	}
	if (query.orderBy) {
		if (query.orderBy.direction !== 'asc' && query.orderBy.direction !== 'desc') {
			throw new TypeError('orderBy direction is unsupported');
		}
		const field = query.orderBy.field;
		const valid = field === 'request_count'
			|| query.metrics.includes(field as AnalyticsMetric)
			|| query.dimensions.includes(field as AnalyticsDimension)
			|| (field === 'date' && query.granularity !== undefined);
		if (!valid) throw new TypeError('orderBy field is not selected');
	}
}

export function buildManagementAnalyticsQuery(
	dialect: AnalyticsSqlDialect,
	query: ManagementAnalyticsQuery,
): BuiltAnalyticsQuery {
	validateQuery(query);
	const values: unknown[] = [];
	const bind = (value: unknown): string => {
		values.push(value);
		return dialect === 'postgres' ? `$${values.length}` : '?';
	};
	const fields: Array<{ expression: string; alias: string }> = [];
	const dimensionGroupAliases: string[] = [];
	if (query.granularity) {
		fields.push({
			expression: bucketExpression(dialect, query.granularity),
			alias: `date__${query.granularity}`,
		});
	}
	for (const [index, dimension] of query.dimensions.entries()) {
		const selectExpression = dimensionSelectExpression(dialect, dimension);
		const groupExpression = dimensionGroupExpression(dialect, dimension);
		fields.push({ expression: selectExpression, alias: dimension });
		if (groupExpression === selectExpression) {
			dimensionGroupAliases.push(dimension);
		} else {
			const alias = `__dimension_${index}`;
			fields.push({ expression: groupExpression, alias });
			dimensionGroupAliases.push(alias);
		}
	}
	const aggregateMetrics = [...query.metrics];
	if (
		query.orderBy?.field === 'request_count'
		&& !aggregateMetrics.includes('request_count')
	) {
		aggregateMetrics.push('request_count');
	}
	for (const metric of aggregateMetrics) {
		fields.push({ expression: metricExpression(dialect, metric), alias: metric });
	}

	const conditions = [
		`rl.created_at >= ${bind(query.startDate)}`,
		`rl.created_at < ${bind(query.endDate)}`,
	];
	if (query.account.accountType === 'personal') {
		conditions.push(
			"w.scope_type = 'personal'",
			`w.personal_owner_user_id = ${bind(query.account.personalOwnerUserId)}`,
			'w.organization_id IS NULL',
			`rl.user_id = ${bind(query.account.personalOwnerUserId)}`,
		);
	} else {
		conditions.push(
			"w.scope_type = 'organization'",
			'w.personal_owner_user_id IS NULL',
			`w.organization_id = ${bind(query.account.organizationId)}`,
		);
	}
	conditions.push("w.status = 'active'");

	for (const filter of query.filters) {
		const expression = dimensionFilterExpression(dialect, filter.field);
		const filterValues = normalizeFilterValues(filter);
		const scalar = filter.operator !== 'in' && filter.operator !== 'not_in';
		if ((scalar && filterValues.length !== 1) || (!scalar && filterValues.length < 1)) {
			throw new TypeError(`${filter.operator} has an invalid filter value`);
		}
		if (filterValues.length > 100) throw new TypeError('filter arrays support at most 100 values');
		const comparison = scalar
			? `${expression} ${({ eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[filter.operator as 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte']} ${bind(filterValues[0])}`
			: `${expression} ${filter.operator === 'in' ? 'IN' : 'NOT IN'} (${filterValues.map(bind).join(', ')})`;
		if (!scalar && filter.includeUnset) {
			conditions.push(`(${comparison} OR ${expression} IS NULL OR ${expression} = '')`);
		} else {
			conditions.push(comparison);
		}
	}

	const select = fields.map(({ expression, alias }) =>
		`${expression} AS ${quoteIdentifier(dialect, alias)}`
	).join(',\n\t\t');
	const groupExpressions = fields
		.filter(({ alias }) =>
			alias.startsWith('date__')
			|| alias.startsWith('__dimension_')
			|| query.dimensions.includes(alias as AnalyticsDimension)
		)
		.map(({ expression }) => expression);
	const joins = [
		'JOIN workspaces w ON w.id = rl.workspace_id',
		(query.dimensions.includes('api_key_id') || query.filters.some(({ field }) => field === 'api_key_id'))
			? 'LEFT JOIN api_keys ak ON ak.id = rl.api_key_id'
			: '',
		(query.dimensions.includes('user') || query.filters.some(({ field }) => field === 'user'))
			? 'LEFT JOIN users u ON u.id = rl.user_id'
			: '',
	].filter(Boolean).join('\n\t');
	const aggregateSql = `SELECT
		${select}
	FROM api_key_request_logs rl
	${joins}
	WHERE ${conditions.join('\n\t\tAND ')}${
		groupExpressions.length > 0 ? `\n\tGROUP BY ${groupExpressions.join(', ')}` : ''
	}`;

	const dateAlias = query.granularity
		? quoteIdentifier(dialect, `date__${query.granularity}`)
		: null;
	const requestedOrderAlias = query.orderBy?.field === 'date'
		? dateAlias
		: query.orderBy
			? quoteIdentifier(dialect, query.orderBy.field)
			: null;
	const orderAlias = requestedOrderAlias
		?? dateAlias
		?? quoteIdentifier(dialect, query.metrics[0]!);
	const orderDirection = (query.orderBy?.direction ?? 'desc').toUpperCase();
	const tieBreakers = [
		...query.dimensions.map((dimension) => `${quoteIdentifier(dialect, dimension)} ASC`),
		...(dateAlias && orderAlias !== dateAlias ? [`${dateAlias} DESC`] : []),
	].join(', ');
	const orderSql = `${orderAlias} ${orderDirection}${tieBreakers ? `, ${tieBreakers}` : ''}`;
	const applyGroupLimit = query.groupLimit !== undefined
		&& query.granularity !== undefined
		&& query.dimensions.length > 0;
	const publicFields = [
		...(query.granularity ? [`date__${query.granularity}`] : []),
		...query.dimensions,
		...query.metrics,
	];
	let sql: string;
	if (applyGroupLimit) {
		const partition = dimensionGroupAliases
			.map((dimension) => quoteIdentifier(dialect, dimension))
			.join(', ');
		const groupLimit = bind(query.groupLimit);
		const totalLimit = bind(query.limit + 1);
		sql = `WITH analytics_rows AS (
	${aggregateSql}
), ranked_rows AS (
	SELECT analytics_rows.*,
		ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${dateAlias} DESC) AS __group_rank
	FROM analytics_rows
)
SELECT ${publicFields.map((field) => quoteIdentifier(dialect, field)).join(', ')}
FROM ranked_rows
WHERE __group_rank <= ${groupLimit}
ORDER BY ${orderSql}
LIMIT ${totalLimit}`;
	} else {
		const totalLimit = bind(query.limit + 1);
		sql = `WITH analytics_rows AS (
	${aggregateSql}
)
		SELECT ${publicFields.map((field) => quoteIdentifier(dialect, field)).join(', ')}
FROM analytics_rows
ORDER BY ${orderSql}
LIMIT ${totalLimit}`;
	}
	return { sql, values, publicFields };
}

export function mapManagementAnalyticsResult(
	rows: readonly Record<string, unknown>[],
	query: ManagementAnalyticsQuery,
): ManagementAnalyticsQueryResult {
	const truncated = rows.length > query.limit;
	const publicFields = [
		...(query.granularity ? [`date__${query.granularity}`] : []),
		...query.dimensions,
		...query.metrics,
	];
	return {
		rows: rows.slice(0, query.limit).map((row) => {
			const mapped: AnalyticsQueryRow = {};
			for (const field of publicFields) {
				const value = row[field];
				if (COUNT_METRICS.has(field as AnalyticsMetric)) {
					mapped[field] = String(Math.max(0, Math.trunc(Number(value ?? 0))));
				} else if (query.metrics.includes(field as AnalyticsMetric)) {
					const number = Number(value ?? 0);
					mapped[field] = Number.isFinite(number) ? number : 0;
				} else {
					mapped[field] = value == null ? null : String(value);
				}
			}
			return mapped;
		}),
		truncated,
	};
}

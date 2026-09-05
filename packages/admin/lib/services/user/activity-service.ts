import type {
	ApiKeyRow,
	GatewayRepositories,
	PortalGenerationMetadataData,
	RequestActivityGroupRow,
	RequestLogRow,
	RequestStatsByRangeRow,
	RequestTimeseriesRow,
	UserRow,
} from '@octafuse/core';
import { GENERATION_ID_PATTERN, toPortalGenerationMetadataData } from '@octafuse/core';
import {
	BILLING_CURRENCY_KEY,
	normalizeBillingCurrencyCode,
} from '@octafuse/core/lib/billing-currency';

const ACTIVITY_RANGES = {
	'7d': 7,
	'30d': 30,
	'90d': 90,
} as const;
const ACTIVITY_STATUSES = new Set(['success', 'error', 'incomplete', 'cancelled']);
const EXPORT_ROW_LIMIT = 1_000;
const ACTIVITY_GROUP_LIMIT = 10;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

export type UserActivityRange = keyof typeof ACTIVITY_RANGES;

export type UserActivityRepositories = {
	users: Pick<GatewayRepositories['users'], 'getById'>;
	apiKeys: Pick<GatewayRepositories['apiKeys'], 'listKeysByWorkspaceId'>;
	systemConfig: Pick<GatewayRepositories['systemConfig'], 'getConfig'>;
	requestLogs: Pick<
		GatewayRepositories['requestLogs'],
		'getRequestLogs' | 'getRequestStatsByRange' | 'getRequestActivityGroups' | 'getRequestLogByIdForOwner' | 'queryRequestTimeseries'
	>;
};

export type UserActivityQuery = {
	range?: unknown;
	page?: unknown;
	page_size?: unknown;
	api_key_id?: unknown;
	model_id?: unknown;
	provider_name?: unknown;
	status?: unknown;
};

export type NormalizedUserActivityQuery = {
	range: UserActivityRange;
	page: number;
	pageSize: number;
	apiKeyId?: string;
	modelId?: string;
	providerName?: string;
	status?: string;
};

export type UserActivityLog = {
	id: string;
	apiKeyId: string | null;
	apiKeyName: string | null;
	modelId: string | null;
	modelName: string | null;
	providerName: string | null;
	protocol: string | null;
	operation: string | null;
	status: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	chargedCost: number;
	latencyMs: number | null;
	billingKind: string | null;
	inputImageCount: number;
	outputImageCount: number;
	audioDurationSeconds: number | null;
	audioCharacters: number | null;
	createdAt: string;
};

export type UserBudgetOverview = {
	status: 'finite' | 'unlimited' | 'unavailable';
	budgetMax: number | null;
	budgetBase: number | null;
	budgetSpent: number | null;
	budgetReserved: number | null;
	budgetReservedMicros: number | null;
	budgetRemaining: number | null;
	budgetPeriod: string;
	budgetResetAt: string | null;
};

export type UserActivityGroup = {
	id: string;
	name: string | null;
	requestCount: number;
	successCount: number;
	errorCount: number;
	totalTokens: number;
	chargedCost: number;
};

export type UserActivityTimelinePoint = {
	bucket: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	chargedCost: number;
	avgLatencyMs: number | null;
};

export type UserActivityOutput = {
	workspaceId: string;
	billingCurrency: string;
	range: {
		id: UserActivityRange;
		startAt: string;
		endAt: string;
	};
	budget: UserBudgetOverview;
	summary: RequestStatsByRangeRow;
	analytics: {
		limit: number;
		models: UserActivityGroup[];
		apiKeys: UserActivityGroup[];
		providers: UserActivityGroup[];
	};
	timeline: {
		granularity: 'hour' | 'day';
		points: UserActivityTimelinePoint[];
	};
	keys: Array<{ id: string; name: string | null; status: string }>;
	logs: UserActivityLog[];
	pagination: {
		page: number;
		pageSize: number;
		total: number;
		totalPages: number;
	};
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boundedFilter(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	return normalized !== ''
		&& normalized.length <= maximumLength
		&& !CONTROL_CHARACTERS.test(normalized)
		? normalized
		: undefined;
}

export function normalizeUserActivityQuery(input: UserActivityQuery): NormalizedUserActivityQuery {
	const range = typeof input.range === 'string' && input.range in ACTIVITY_RANGES
		? input.range as UserActivityRange
		: '7d';
	const statusCandidate = boundedFilter(input.status, 32);
	return {
		range,
		page: boundedInteger(input.page, 1, 1, 100_000),
		pageSize: boundedInteger(input.page_size, 20, 1, 100),
		apiKeyId: boundedFilter(input.api_key_id, 128),
		modelId: boundedFilter(input.model_id, 256),
		providerName: boundedFilter(input.provider_name, 200),
		status: statusCandidate && ACTIVITY_STATUSES.has(statusCandidate)
			? statusCandidate
			: undefined,
	};
}

function activityWindow(range: UserActivityRange, nowMs: number): { startAt: string; endAt: string } {
	const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
	return {
		startAt: new Date(safeNowMs - ACTIVITY_RANGES[range] * 24 * 60 * 60 * 1_000).toISOString(),
		endAt: new Date(safeNowMs).toISOString(),
	};
}

function nonnegativeFinite(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function userBudgetOverview(user: UserRow): UserBudgetOverview {
	const budgetSpent = nonnegativeFinite(user.budget_spent);
	const budgetBase = nonnegativeFinite(user.budget_base);
	const reservedMicros = Number(user.budget_reserved_micros);
	const reservedIsValid = Number.isSafeInteger(reservedMicros) && reservedMicros >= 0;
	const budgetReserved = reservedIsValid ? reservedMicros / 1_000_000 : null;
	if (user.budget_max == null) {
		return {
			status: budgetSpent != null && budgetBase != null && reservedIsValid ? 'unlimited' : 'unavailable',
			budgetMax: null,
			budgetBase,
			budgetSpent,
			budgetReserved,
			budgetReservedMicros: reservedIsValid ? reservedMicros : null,
			budgetRemaining: null,
			budgetPeriod: user.budget_period,
			budgetResetAt: user.budget_reset_at,
		};
	}
	const budgetMax = nonnegativeFinite(user.budget_max);
	if (budgetMax == null || budgetSpent == null || budgetBase == null || budgetReserved == null) {
		return {
			status: 'unavailable',
			budgetMax,
			budgetBase,
			budgetSpent,
			budgetReserved,
			budgetReservedMicros: reservedIsValid ? reservedMicros : null,
			budgetRemaining: null,
			budgetPeriod: user.budget_period,
			budgetResetAt: user.budget_reset_at,
		};
	}
	return {
		status: 'finite',
		budgetMax,
		budgetBase,
		budgetSpent,
		budgetReserved,
		budgetReservedMicros: reservedMicros,
		budgetRemaining: Math.max(0, budgetMax - budgetSpent - budgetReserved),
		budgetPeriod: user.budget_period,
		budgetResetAt: user.budget_reset_at,
	};
}

function safeCount(value: unknown): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeAmount(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safePublicSnapshot(value: unknown, maximumLength: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized !== ''
		&& normalized.length <= maximumLength
		&& !CONTROL_CHARACTERS.test(normalized)
		? normalized
		: null;
}

function normalizeActivityBucket(value: unknown, granularity: 'hour' | 'day'): string | null {
	if (typeof value !== 'string') return null;
	const normalized = granularity === 'hour'
		? /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/u.test(value) ? `${value.replace(' ', 'T')}.000Z` : null
		: /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : null;
	if (!normalized) return null;
	const timestamp = Date.parse(normalized);
	if (!Number.isFinite(timestamp)) return null;
	const canonical = new Date(timestamp).toISOString();
	return canonical === normalized ? canonical : null;
}

function sanitizeUserActivityTimeline(
	rows: RequestTimeseriesRow[],
	granularity: 'hour' | 'day',
): UserActivityTimelinePoint[] {
	return rows.slice(0, 200).flatMap((row) => {
		const bucket = normalizeActivityBucket(row.bucket, granularity);
		if (!bucket) return [];
		return [{
			bucket,
			requestCount: safeCount(row.requestCount),
			inputTokens: safeCount(row.inputTokens),
			outputTokens: safeCount(row.outputTokens),
			cacheReadTokens: safeCount(row.cacheReadTokens),
			cacheWriteTokens: safeCount(row.cacheWriteTokens),
			totalTokens: safeCount(row.totalTokens),
			chargedCost: safeAmount(row.chargedCost),
			avgLatencyMs: row.avgLatencyMs == null ? null : nonnegativeFinite(row.avgLatencyMs),
		}];
	});
}

function keyNameMap(keys: ApiKeyRow[]): Map<string, string | null> {
	return new Map(keys.map((key) => [key.id, key.name]));
}

function sanitizeUserActivityGroup(
	row: RequestActivityGroupRow,
	nameOverride?: string | null,
): UserActivityGroup {
	return {
		id: row.id,
		name: nameOverride === undefined ? row.name : nameOverride,
		requestCount: safeCount(row.requestCount),
		successCount: safeCount(row.successCount),
		errorCount: safeCount(row.errorCount),
		totalTokens: safeCount(row.totalTokens),
		chargedCost: safeAmount(row.chargedCost),
	};
}

export function sanitizeUserActivityLog(
	row: RequestLogRow,
	ownedKeyNames: ReadonlyMap<string, string | null>,
): UserActivityLog {
	const apiKeyId = row.api_key_id ?? null;
	return {
		id: row.id,
		apiKeyId,
		apiKeyName: apiKeyId ? ownedKeyNames.get(apiKeyId) ?? null : null,
		modelId: row.model_id ?? null,
		modelName: row.model_name ?? null,
		providerName: safePublicSnapshot(row.provider_name, 200),
		protocol: row.request_protocol || row.upstream_protocol || null,
		operation: row.request_operation ?? null,
		status: ACTIVITY_STATUSES.has(row.status) ? row.status : 'unknown',
		inputTokens: safeCount(row.input_tokens),
		outputTokens: safeCount(row.output_tokens),
		totalTokens: safeCount(row.total_tokens),
		chargedCost: safeAmount(row.charged_cost),
		latencyMs: row.latency_ms == null ? null : nonnegativeFinite(row.latency_ms),
		billingKind: row.billing_kind ?? null,
		inputImageCount: safeCount(row.input_image_count),
		outputImageCount: safeCount(row.output_image_count),
		audioDurationSeconds: row.audio_duration_seconds == null
			? null
			: safeAmount(row.audio_duration_seconds),
		audioCharacters: row.audio_characters == null ? null : safeCount(row.audio_characters),
		createdAt: row.created_at,
	};
}

function requestLogOptions(
	userId: string,
	workspaceId: string,
	query: NormalizedUserActivityQuery,
	window: { startAt: string; endAt: string },
	page: number = query.page,
	pageSize: number = query.pageSize,
) {
	return {
		page,
		pageSize,
		userId,
		workspaceId,
		apiKeyId: query.apiKeyId,
		modelId: query.modelId,
		providerName: query.providerName,
		status: query.status,
		startDate: window.startAt,
		endDate: window.endAt,
	};
}

function activityAggregateOptions(
	userId: string,
	workspaceId: string,
	query: NormalizedUserActivityQuery,
	window: { startAt: string; endAt: string },
) {
	return {
		startDate: window.startAt,
		endDate: window.endAt,
		endExclusive: true,
		userId,
		workspaceId,
		apiKeyId: query.apiKeyId,
		modelId: query.modelId,
		providerName: query.providerName,
		status: query.status,
	};
}

export async function listUserActivityService(
	repos: UserActivityRepositories,
	userId: string,
	workspaceId: string,
	input: UserActivityQuery,
	nowMs: number = Date.now(),
): Promise<UserActivityOutput | null> {
	const query = normalizeUserActivityQuery(input);
	const window = activityWindow(query.range, nowMs);
	const timelineGranularity = query.range === '7d' ? 'hour' : 'day';
	const aggregateOptions = activityAggregateOptions(userId, workspaceId, query, window);
	const [user, keys, billingCurrency, pageResult, summary, modelGroups, apiKeyGroups, providerGroups, timelineRows] = await Promise.all([
		repos.users.getById(userId),
		repos.apiKeys.listKeysByWorkspaceId(workspaceId, { creatorUserId: userId }),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
		repos.requestLogs.getRequestLogs(requestLogOptions(userId, workspaceId, query, window)),
		repos.requestLogs.getRequestStatsByRange(aggregateOptions),
		repos.requestLogs.getRequestActivityGroups({
			...aggregateOptions,
			dimension: 'model',
			limit: ACTIVITY_GROUP_LIMIT,
		}),
		repos.requestLogs.getRequestActivityGroups({
			...aggregateOptions,
			dimension: 'apiKey',
			limit: ACTIVITY_GROUP_LIMIT,
		}),
		repos.requestLogs.getRequestActivityGroups({
			...aggregateOptions,
			dimension: 'provider',
			limit: ACTIVITY_GROUP_LIMIT,
		}),
		repos.requestLogs.queryRequestTimeseries({
			...aggregateOptions,
			granularity: timelineGranularity,
		}),
	]);
	if (!user) return null;
	const names = keyNameMap(keys);
	return {
		workspaceId,
		billingCurrency: normalizeBillingCurrencyCode(billingCurrency),
		range: { id: query.range, ...window },
		budget: userBudgetOverview(user),
		summary,
		analytics: {
			limit: ACTIVITY_GROUP_LIMIT,
			models: modelGroups.map((row) => sanitizeUserActivityGroup(row)),
			apiKeys: apiKeyGroups.map((row) => sanitizeUserActivityGroup(row, names.get(row.id) ?? null)),
			providers: providerGroups.flatMap((row) => {
				const providerName = safePublicSnapshot(row.id, 200);
				return providerName
					? [sanitizeUserActivityGroup({ ...row, id: providerName }, providerName)]
					: [];
			}),
		},
		timeline: {
			granularity: timelineGranularity,
			points: sanitizeUserActivityTimeline(timelineRows, timelineGranularity),
		},
		keys: keys.map((key) => ({ id: key.id, name: key.name, status: key.status })),
		logs: pageResult.logs.map((row) => sanitizeUserActivityLog(row, names)),
		pagination: {
			page: query.page,
			pageSize: query.pageSize,
			total: pageResult.total,
			totalPages: Math.max(1, Math.ceil(pageResult.total / query.pageSize)),
		},
	};
}

/**
 * Returns the same least-privilege Generation projection as the public Gateway
 * endpoint, but authenticates with the portal session and active Workspace.
 */
export async function getUserActivityGenerationService(
	repos: UserActivityRepositories,
	userId: string,
	workspaceId: string,
	id: string,
): Promise<PortalGenerationMetadataData | null> {
	if (!GENERATION_ID_PATTERN.test(id)) return null;
	const row = await repos.requestLogs.getRequestLogByIdForOwner({ id, userId, workspaceId });
	if (!row || row.id !== id || row.workspace_id !== workspaceId) return null;
	const data = toPortalGenerationMetadataData(row);
	return data?.workspace_id === workspaceId ? data : null;
}

function csvCell(value: string | number | null): string {
	let text = value == null ? '' : String(value);
	if (/^[=+\-@]/u.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

export function userActivityCsv(rows: UserActivityLog[], billingCurrency: string = 'USD'): string {
	const normalizedCurrency = normalizeBillingCurrencyCode(billingCurrency).toLowerCase();
	const columns: Array<[string, (row: UserActivityLog) => string | number | null]> = [
		['time', (row) => row.createdAt],
		['request_id', (row) => row.id],
		['api_key_id', (row) => row.apiKeyId],
		['api_key_name', (row) => row.apiKeyName],
		['model_id', (row) => row.modelId],
		['model_name', (row) => row.modelName],
		['provider_name', (row) => row.providerName],
		['protocol', (row) => row.protocol],
		['operation', (row) => row.operation],
		['status', (row) => row.status],
		['input_tokens', (row) => row.inputTokens],
		['output_tokens', (row) => row.outputTokens],
		['total_tokens', (row) => row.totalTokens],
		['input_image_count', (row) => row.inputImageCount],
		['output_image_count', (row) => row.outputImageCount],
		['audio_duration_seconds', (row) => row.audioDurationSeconds],
		['audio_characters', (row) => row.audioCharacters],
		[`charged_cost_${normalizedCurrency}`, (row) => row.chargedCost],
		['latency_ms', (row) => row.latencyMs],
		['billing_kind', (row) => row.billingKind],
	];
	return `\uFEFF${[
		columns.map(([name]) => csvCell(name)).join(','),
		...rows.map((row) => columns.map(([, read]) => csvCell(read(row))).join(',')),
	].join('\r\n')}\r\n`;
}

export async function exportUserActivityCsvService(
	repos: UserActivityRepositories,
	userId: string,
	workspaceId: string,
	input: UserActivityQuery,
	nowMs: number = Date.now(),
): Promise<{
	csv: string;
	rowCount: number;
	total: number;
	truncated: boolean;
	billingCurrency: string;
} | null> {
	const query = { ...normalizeUserActivityQuery(input), page: 1, pageSize: 100 };
	const window = activityWindow(query.range, nowMs);
	const [user, keys, billingCurrencyRaw, firstPage] = await Promise.all([
		repos.users.getById(userId),
		repos.apiKeys.listKeysByWorkspaceId(workspaceId, { creatorUserId: userId }),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
		repos.requestLogs.getRequestLogs(requestLogOptions(userId, workspaceId, query, window, 1, 100)),
	]);
	if (!user) return null;
	const rawRows = [...firstPage.logs];
	const targetCount = Math.min(firstPage.total, EXPORT_ROW_LIMIT);
	for (let page = 2; rawRows.length < targetCount; page += 1) {
		const next = await repos.requestLogs.getRequestLogs(
			requestLogOptions(userId, workspaceId, query, window, page, 100),
		);
		if (next.logs.length === 0) break;
		rawRows.push(...next.logs);
	}
	const names = keyNameMap(keys);
	const rows = rawRows.slice(0, EXPORT_ROW_LIMIT).map((row) => sanitizeUserActivityLog(row, names));
	const billingCurrency = normalizeBillingCurrencyCode(billingCurrencyRaw);
	return {
		csv: userActivityCsv(rows, billingCurrency),
		rowCount: rows.length,
		total: firstPage.total,
		truncated: firstPage.total > rows.length,
		billingCurrency,
	};
}

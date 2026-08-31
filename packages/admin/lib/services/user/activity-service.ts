import type {
	ApiKeyRow,
	GatewayRepositories,
	RequestLogRow,
	RequestStatsByRangeRow,
	UserRow,
} from '@octafuse/core';
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

export type UserActivityRange = keyof typeof ACTIVITY_RANGES;

export type UserActivityRepositories = {
	users: Pick<GatewayRepositories['users'], 'getById'>;
	apiKeys: Pick<GatewayRepositories['apiKeys'], 'listKeysByWorkspaceId'>;
	systemConfig: Pick<GatewayRepositories['systemConfig'], 'getConfig'>;
	requestLogs: Pick<
		GatewayRepositories['requestLogs'],
		'getRequestLogs' | 'getRequestStatsByRange'
	>;
};

export type UserActivityQuery = {
	range?: unknown;
	page?: unknown;
	page_size?: unknown;
	api_key_id?: unknown;
	model_id?: unknown;
	status?: unknown;
};

export type NormalizedUserActivityQuery = {
	range: UserActivityRange;
	page: number;
	pageSize: number;
	apiKeyId?: string;
	modelId?: string;
	status?: string;
};

export type UserActivityLog = {
	id: string;
	apiKeyId: string | null;
	apiKeyName: string | null;
	modelId: string | null;
	modelName: string | null;
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
	return normalized !== '' && normalized.length <= maximumLength ? normalized : undefined;
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

function keyNameMap(keys: ApiKeyRow[]): Map<string, string | null> {
	return new Map(keys.map((key) => [key.id, key.name]));
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
		protocol: row.request_protocol || row.upstream_protocol || null,
		operation: row.request_operation ?? null,
		status: ACTIVITY_STATUSES.has(row.status) ? row.status : 'unknown',
		inputTokens: safeCount(row.input_tokens),
		outputTokens: safeCount(row.output_tokens),
		totalTokens: safeCount(row.total_tokens),
		chargedCost: safeAmount(row.charged_cost),
		latencyMs: row.latency_ms == null ? null : safeAmount(row.latency_ms),
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
		status: query.status,
		startDate: window.startAt,
		endDate: window.endAt,
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
	const [user, keys, billingCurrency, pageResult, summary] = await Promise.all([
		repos.users.getById(userId),
		repos.apiKeys.listKeysByWorkspaceId(workspaceId, { creatorUserId: userId }),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
		repos.requestLogs.getRequestLogs(requestLogOptions(userId, workspaceId, query, window)),
		repos.requestLogs.getRequestStatsByRange({
			startDate: window.startAt,
			endDate: window.endAt,
			endExclusive: true,
			userId,
			workspaceId,
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
		['protocol', (row) => row.protocol],
		['operation', (row) => row.operation],
		['status', (row) => row.status],
		['input_tokens', (row) => row.inputTokens],
		['output_tokens', (row) => row.outputTokens],
		['total_tokens', (row) => row.totalTokens],
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

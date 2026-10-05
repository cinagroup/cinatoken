/**
 * 管理后台聚合服务：仪表盘 KPI、全局请求日志列表、`system_config` 读写，以及模型/供应商/用户/可靠性分析 API 的数据装配。
 */
import type { GatewayRepositories, RequestLogRow } from "@octafuse/core";
import type { AdminPrincipal } from "@/lib/admin-principal";
import {
	BILLING_CURRENCY_KEY,
	tryParseGatewaySupportedBillingCurrencyInput,
} from "@octafuse/core/lib/billing-currency";
import {
	DEFAULT_ROUTE_STRATEGY,
	isRouteStrategyName,
	ROUTE_STRATEGY_NAMES,
} from "@octafuse/core/db/model-route-policy";
import { ROUTE_STRATEGY_KEY } from "@octafuse/core/lib/route-strategy-system-config";
import { badRequest } from "./errors";
import {
	toolConfigGenericFamily,
	updateGenericToolConfig,
} from "./tool-config-service";
import {
	clampAnalyticsRange,
	rangeToDates,
	resolveStatsDateRange,
} from "./shared";
import {
	getBusinessDayWindow,
	getBusinessTimezone,
	parseBusinessTimezoneInput,
} from "@octafuse/core/lib/business-timezone";
import { normalizeUpstreamProtocol } from "@octafuse/core/upstream-protocol";
import type {
	AdminConfigRow,
	AdminConfigUpdateInput,
	AdminModelAnalyticsOutput,
	AdminModelAnalyticsRow,
	AdminProviderAnalyticsOutput,
	AdminProviderAnalyticsRow,
	AdminReliabilityAnalyticsOutput,
	AdminReliabilityModelProviderRow,
	AdminReliabilityProviderRow,
	AdminRequestLogsOutput,
	AdminAnalyticsRecentLog,
	AdminStatsOutput,
	AdminUserAnalyticsRow,
	AdminGlobalBudgetAuditLogsOutput,
} from "./types";
import type { BudgetAuditLogQuery } from "./budget-audit-log-query";

function mapAnalyticsTtftFields(r: {
	avg_first_reasoning_token_ms?: unknown;
	avg_first_token_ms?: unknown;
	avg_effective_ttft_ms?: unknown;
	avg_reasoning_phase_ms?: unknown;
	reasoning_ttft_rate?: unknown;
	content_ttft_rate?: unknown;
}) {
	return {
		avg_first_reasoning_token_ms:
			r.avg_first_reasoning_token_ms != null
				? Number(r.avg_first_reasoning_token_ms)
				: null,
		avg_first_token_ms:
			r.avg_first_token_ms != null ? Number(r.avg_first_token_ms) : null,
		avg_effective_ttft_ms:
			r.avg_effective_ttft_ms != null ? Number(r.avg_effective_ttft_ms) : null,
		avg_reasoning_phase_ms:
			r.avg_reasoning_phase_ms != null
				? Number(r.avg_reasoning_phase_ms)
				: null,
		reasoning_ttft_rate: Number(r.reasoning_ttft_rate ?? 0),
		content_ttft_rate: Number(r.content_ttft_rate ?? 0),
	};
}

/**
 * Prompt cache 命中率（%）。
 * 网关语义：`input_tokens = regular + cache_read + cache_write`，故分母用 `input_tokens`。
 */
function computeCacheHitRate(
	inputTokens: number,
	cacheReadTokens: number
): number {
	return inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : 0;
}

/**
 * 全局请求日志分页（将查询字符串参数映射为 `getRequestLogs` 的 options）。
 * @param input.page / page_size 字符串或数字均可，非法时由 parseInt 处理
 */
export async function listAdminGlobalRequestLogsService(
	repos: GatewayRepositories,
	input: {
		page?: number | string;
		page_size?: number | string;
		api_key_id?: string;
		user_id?: string;
		user_email?: string;
		model_id?: string;
		provider_id?: string;
		route_group?: string;
		protocol?: string;
		status?: string;
		start_date?: string;
		end_date?: string;
	}
): Promise<AdminRequestLogsOutput> {
	let protocol: string | undefined;
	if (input.protocol != null && input.protocol.trim() !== "") {
		try {
			protocol = normalizeUpstreamProtocol(input.protocol);
		} catch (e) {
			throw badRequest(e instanceof Error ? e.message : "Invalid protocol");
		}
	}
	const page = Math.max(1, Number.parseInt(String(input.page ?? "1"), 10));
	const pageSize = Math.min(
		100,
		Math.max(1, Number.parseInt(String(input.page_size ?? "20"), 10))
	);
	const userId = input.user_id?.trim();
	if (
		input.user_id &&
		(!userId || userId.length > 600 || /\p{Cc}/u.test(userId))
	) {
		throw badRequest("Invalid user ID");
	}
	const result = await repos.requestLogs.getRequestLogs({
		page,
		pageSize,
		apiKeyId: input.api_key_id,
		userId,
		userEmail: input.user_email,
		modelId: input.model_id,
		providerId: input.provider_id,
		routeGroup: input.route_group,
		protocol,
		status: input.status,
		startDate: input.start_date,
		endDate: input.end_date,
	});
	return { ...result, page, page_size: pageSize };
}

/**
 * 全局 `user_audit_logs` 分页（可选 api_key_id、user_email、event_type、actor_type、actor_id、actor_kind、时间窗）。
 */
export async function listAdminGlobalBudgetAuditLogsService(
	repos: GatewayRepositories,
	query: BudgetAuditLogQuery
): Promise<AdminGlobalBudgetAuditLogsOutput> {
	const result = await repos.userAuditLogs.getGlobalUserAuditLogs({
		...query.filters,
		page: query.page,
		pageSize: query.pageSize,
	});
	return { ...result, page: query.page, page_size: query.pageSize };
}

export async function listAdminGlobalBudgetAuditLogFilterOptionsService(
	repos: GatewayRepositories
) {
	return repos.userAuditLogs.getGlobalUserAuditLogFilterOptions();
}

/** 配置列表；空 value 转为 `''` 便于前端表单展示。 */
export async function listAdminSystemConfigService(
	repos: GatewayRepositories
): Promise<AdminConfigRow[]> {
	const rows = await repos.systemConfig.listSystemConfigRows();
	return rows.map((r) => ({
		key: r.key,
		value: r.value ?? "",
		description: r.description ?? null,
	}));
}

/**
 * 更新或插入一条 `system_config`；校验失败抛 `badRequest`。
 * @param body.value `null`/`undefined` 会写成空字符串
 */
export function updateAdminSystemConfigService(
	repos: GatewayRepositories,
	body: AdminConfigUpdateInput,
	principal: AdminPrincipal
): Promise<void>;
export function updateAdminSystemConfigService(
	repos: GatewayRepositories,
	body: AdminConfigUpdateInput,
	principal: AdminPrincipal,
	expectedRevision: string | null
): Promise<{ committed: boolean; revision: string | null }>;
export function updateAdminSystemConfigService(
	repos: GatewayRepositories,
	body: AdminConfigUpdateInput,
	principal: AdminPrincipal,
	expectedRevision: string | null | undefined,
	options: { requireToolsVersion: boolean }
): Promise<{ committed: boolean; revision: string | null }>;
export async function updateAdminSystemConfigService(
	repos: GatewayRepositories,
	body: AdminConfigUpdateInput,
	principal: AdminPrincipal,
	expectedRevision?: string | null,
	options?: { requireToolsVersion: boolean }
): Promise<void | { committed: boolean; revision: string | null }> {
	if (typeof body.key !== "string" || body.key.trim() === "") {
		throw badRequest("key is required");
	}
	if (
		body.value !== undefined &&
		body.value !== null &&
		typeof body.value !== "string"
	) {
		throw badRequest("value must be string");
	}
	const key = body.key.trim();
	if (key === "MASTER_KEY") {
		throw badRequest("MASTER_KEY is removed; use Integration Keys");
	}
	let value = body.value == null ? "" : String(body.value);
	if (key === "BUSINESS_TIMEZONE") {
		const parsed = parseBusinessTimezoneInput(value);
		if (!parsed)
			throw badRequest("BUSINESS_TIMEZONE must be a valid IANA timezone");
		value = parsed;
	}
	if (key === BILLING_CURRENCY_KEY) {
		const parsed = tryParseGatewaySupportedBillingCurrencyInput(value);
		if (!parsed) {
			throw badRequest("BILLING_CURRENCY must be USD or CNY");
		}
		value = parsed;
	}
	if (key === ROUTE_STRATEGY_KEY) {
		const normalized = value.trim().toLowerCase();
		if (!isRouteStrategyName(normalized)) {
			throw badRequest(
				`ROUTE_STRATEGY must be one of: ${ROUTE_STRATEGY_NAMES.join(
					", "
				)} (default ${DEFAULT_ROUTE_STRATEGY})`
			);
		}
		value = normalized;
	}
	const legacyToolKeys = new Set([
		"WEB_SEARCH_PROVIDER",
		"WEB_SEARCH_API_KEY",
		"WEB_SEARCH_COST",
		"WEB_FETCH_PROVIDER",
		"WEB_FETCH_API_KEY",
		"WEB_FETCH_COST",
	]);
	if (legacyToolKeys.has(key)) {
		throw badRequest(
			`${key} is deprecated; use Tools → Configuration (WEB_*_ACTIVE / WEB_*_CATALOG) instead`
		);
	}
	if (toolConfigGenericFamily(key)) {
		const result = await updateGenericToolConfig(
			repos,
			principal,
			{ ...body, key, value },
			{
				requireVersion: options?.requireToolsVersion,
				expectedRevision,
			}
		);
		return expectedRevision !== undefined || options ? result : undefined;
	}

	const write = {
		auditId: crypto.randomUUID(),
		key,
		value,
		actorKind: principal.type === "console" ? "console" : "admin_key",
		actorId: principal.id,
		nowIso: new Date().toISOString(),
	} as const;
	if (expectedRevision !== undefined) {
		return repos.systemConfig.upsertSystemConfigValueWithAuditIfRevision({
			...write,
			expectedRevision,
		});
	}
	await repos.systemConfig.upsertSystemConfigValueWithAudit(write);
}

/** The analytics permission exposes only an occurrence summary, never a log detail. */
function analyticsRecentLog(row: RequestLogRow): AdminAnalyticsRecentLog {
	return {
		id: row.id,
		model_id: row.model_id ?? null,
		provider_id: row.provider_id ?? null,
		provider_name: row.provider_name ?? null,
		status: row.status,
		created_at: row.created_at,
	};
}

/**
 * 仪表盘汇总：今日业务时区日界请求、活跃密钥数、近期日志/错误、区间 KPI 与去重活跃用户。
 * @param input.range 预设 `1h` | `1d` | `24h` | `7d` | …（无显式起止时默认 `1d`）
 * @param input.startDate / input.endDate UTC `YYYY-MM-DD HH:mm:ss`；与 Request Logs / Analytics 一致，优先于 `range`
 */
export async function getAdminStatsService(
	repos: GatewayRepositories,
	input?: { range?: string; startDate?: string; endDate?: string }
): Promise<AdminStatsOutput> {
	const { startDate, endDate, granularity } = resolveStatsDateRange({
		range: input?.range,
		startDate: input?.startDate,
		endDate: input?.endDate,
	});
	const businessTimeZone = await getBusinessTimezone(repos);
	const { startUtcSql: dayStart, endExclusiveUtcSql: dayEndExclusive } =
		getBusinessDayWindow(new Date(), businessTimeZone);

	const [
		keysCount,
		accountsCount,
		todayStats,
		recentLogs,
		recentErrors,
		kpiStats,
		activeUsers,
		throughput,
		modelRows,
		userRows,
		timeseries,
	] = await Promise.all([
		repos.apiKeys.getApiKeysCount(),
		repos.users.getUsersCount(),
		repos.requestLogs.getRequestStatsByRange({
			startDate: dayStart,
			endDate: dayEndExclusive,
			endExclusive: true,
		}),
		repos.requestLogs.getRecentLogs(5),
		repos.requestLogs.getRecentErrors(5),
		repos.requestLogs.getRequestStatsByRange({ startDate, endDate }),
		repos.requestLogs.getDistinctActiveUsersCount({ startDate, endDate }),
		repos.requestLogs.getThroughputLastMinute(),
		repos.analytics.queryModelAnalytics({ start: startDate, end: endDate }),
		repos.analytics.queryUserAnalytics({ start: startDate, end: endDate }),
		repos.requestLogs.queryRequestTimeseries({
			startDate,
			endDate,
			granularity,
		}),
	]);

	const modelDistributionMap = new Map<
		string,
		{
			model_id: string;
			request_count: number;
			input_tokens: number;
			output_tokens: number;
			total_tokens: number;
			charged_cost: number;
			metered_cost: number;
			standard_cost: number;
		}
	>();
	for (const row of modelRows) {
		const modelId = String(row.model_id ?? "unknown");
		const existing = modelDistributionMap.get(modelId) ?? {
			model_id: modelId,
			request_count: 0,
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
			charged_cost: 0,
			metered_cost: 0,
			standard_cost: 0,
		};
		existing.request_count += Number(row.request_count);
		existing.input_tokens += Number(row.input_tokens);
		existing.output_tokens += Number(row.output_tokens);
		existing.total_tokens +=
			Number(row.input_tokens) + Number(row.output_tokens);
		existing.charged_cost += Number(row.charged_cost);
		existing.metered_cost += Number(row.metered_cost);
		existing.standard_cost += Number(row.standard_cost);
		modelDistributionMap.set(modelId, existing);
	}
	const modelDistribution = [...modelDistributionMap.values()]
		.sort((a, b) => b.request_count - a.request_count)
		.slice(0, 10);

	const topUsers = [...userRows]
		.map((row) => ({
			user_email: String(row.user_email),
			request_count: Number(row.request_count),
			input_tokens: Number(row.input_tokens),
			output_tokens: Number(row.output_tokens),
			total_tokens: Number(row.input_tokens) + Number(row.output_tokens),
			charged_cost: Number(row.charged_cost),
			metered_cost: Number(row.metered_cost),
			standard_cost: Number(row.standard_cost),
		}))
		.sort((a, b) => b.charged_cost - a.charged_cost)
		.slice(0, 12);

	const todayRequestsCount = todayStats.totalRequests;
	const gatewayStats = {
		activeKeysCount: keysCount.active,
		keysTotal: keysCount.total,
		keysActive: keysCount.active,
		accountsTotal: accountsCount.total,
		accountsActive: accountsCount.active,
		todayRequestsCount,
		todayCost: todayStats.chargedCost,
		todayTokens: todayStats.totalTokens,
		errorRate:
			todayRequestsCount > 0
				? (todayStats.errorCount / todayRequestsCount) * 100
				: 0,
	};
	const kpi = {
		totalRequests: kpiStats.totalRequests,
		successRate:
			kpiStats.totalRequests > 0
				? (kpiStats.successCount / kpiStats.totalRequests) * 100
				: 0,
		totalCost: kpiStats.chargedCost,
		meteredCost: kpiStats.meteredCost,
		standardCost: kpiStats.standardCost,
		activeUsers,
		errorRate:
			kpiStats.totalRequests > 0
				? (kpiStats.errorCount / kpiStats.totalRequests) * 100
				: 0,
		inputTokens: kpiStats.inputTokens,
		outputTokens: kpiStats.outputTokens,
		cacheReadTokens: kpiStats.cacheReadTokens,
		cacheWriteTokens: kpiStats.cacheWriteTokens,
		totalTokens: kpiStats.totalTokens,
		avgLatencyMs: kpiStats.avgLatencyMs,
		rpm: throughput.rpm,
		tpm: throughput.tpm,
	};

	return {
		gateway: gatewayStats,
		kpi,
		modelDistribution,
		topUsers,
		timeseries: timeseries.map((row) => ({
			bucket: row.bucket,
			request_count: row.requestCount,
			input_tokens: row.inputTokens,
			output_tokens: row.outputTokens,
			cache_read_tokens: row.cacheReadTokens,
			cache_write_tokens: row.cacheWriteTokens,
			total_tokens: row.totalTokens,
			charged_cost: row.chargedCost,
			avg_latency_ms: row.avgLatencyMs,
			cache_hit_rate: computeCacheHitRate(row.inputTokens, row.cacheReadTokens),
		})),
		granularity,
		recentLogs: recentLogs.map(analyticsRecentLog),
		recentErrors: recentErrors.map(analyticsRecentLog),
	};
}

/**
 * 模型维度分析 + 全量标签列表；时间窗经 `clampAnalyticsRange` 限制最大跨度。
 * @param input.tag 可选，按模型标签过滤（JOIN `model_tags`）
 */
export async function getModelAnalyticsService(
	repos: GatewayRepositories,
	input: {
		start_date?: string;
		end_date?: string;
		tag?: string;
		provider_id?: string;
		user_email?: string;
	}
): Promise<AdminModelAnalyticsOutput> {
	const { start, end } = clampAnalyticsRange(
		input.start_date ?? undefined,
		input.end_date ?? undefined
	);
	const tagRaw = input.tag;
	const hasTag = tagRaw != null && tagRaw.trim() !== "";
	const tagValue = hasTag ? tagRaw.trim() : "";
	const providerIdRaw = input.provider_id;
	const hasProviderId = providerIdRaw != null && providerIdRaw.trim() !== "";
	const userEmailRaw = input.user_email;
	const hasUserEmail = userEmailRaw != null && userEmailRaw.trim() !== "";
	const rows = await repos.analytics.queryModelAnalytics({
		start,
		end,
		tag: hasTag ? tagValue : undefined,
		providerId: hasProviderId ? providerIdRaw.trim() : undefined,
		userEmail: hasUserEmail ? userEmailRaw.trim() : undefined,
	});
	const data = rows.map((r) => {
		const reqCount = Number(r.request_count);
		const successCount = Number(r.success_count);
		const chargedCost = Number(r.charged_cost);
		const inputTokens = Number(r.input_tokens);
		const cacheReadTokens = Number(r.cache_read_tokens ?? 0);
		const cacheWriteTokens = Number(r.cache_write_tokens ?? 0);
		return {
			model_id: r.model_id,
			route_group: r.route_group ?? "default",
			request_count: reqCount,
			charged_cost: chargedCost,
			metered_cost: Number(r.metered_cost),
			standard_cost: Number(r.standard_cost),
			input_tokens: inputTokens,
			output_tokens: Number(r.output_tokens),
			cache_read_tokens: cacheReadTokens,
			cache_write_tokens: cacheWriteTokens,
			cache_hit_rate: computeCacheHitRate(inputTokens, cacheReadTokens),
			success_count: successCount,
			error_count: Number(r.error_count),
			success_rate: reqCount > 0 ? (successCount / reqCount) * 100 : 0,
			avg_latency_ms:
				r.avg_latency_ms != null ? Number(r.avg_latency_ms) : null,
			...mapAnalyticsTtftFields(r),
			avg_upstream_response_ms:
				r.avg_upstream_response_ms != null
					? Number(r.avg_upstream_response_ms)
					: null,
			tokens_per_second:
				r.tokens_per_second != null ? Number(r.tokens_per_second) : null,
			failover_rate: Number(r.failover_rate ?? 0),
			avg_attempts: r.avg_attempts != null ? Number(r.avg_attempts) : null,
			avg_charged_per_request: reqCount > 0 ? chargedCost / reqCount : 0,
		};
	}) as AdminModelAnalyticsRow[];
	const tags = await repos.analytics.queryDistinctModelTags();
	return { data, tags };
}

/**
 * 供应商维度分析 + 全量标签列表；时间窗经 `clampAnalyticsRange` 限制最大跨度。
 * @param input.tag 可选，按模型标签过滤（JOIN `model_tags`）
 */
export async function getProviderAnalyticsService(
	repos: GatewayRepositories,
	input: {
		start_date?: string;
		end_date?: string;
		tag?: string;
		model_id?: string;
		route_group?: string;
	}
): Promise<AdminProviderAnalyticsOutput> {
	const { start, end } = clampAnalyticsRange(
		input.start_date ?? undefined,
		input.end_date ?? undefined
	);
	const tagRaw = input.tag;
	const hasTag = tagRaw != null && tagRaw.trim() !== "";
	const tagValue = hasTag ? tagRaw.trim() : "";
	const modelIdRaw = input.model_id;
	const hasModelId = modelIdRaw != null && modelIdRaw.trim() !== "";
	const routeGroupRaw = input.route_group;
	const hasRouteGroup = routeGroupRaw != null && routeGroupRaw.trim() !== "";
	const rows = await repos.analytics.queryProviderAnalytics({
		start,
		end,
		tag: hasTag ? tagValue : undefined,
		modelId: hasModelId ? modelIdRaw.trim() : undefined,
		routeGroup: hasRouteGroup ? routeGroupRaw.trim() : undefined,
	});
	const data = rows.map((r) => {
		const reqCount = Number(r.request_count);
		const successCount = Number(r.success_count);
		const chargedCost = Number(r.charged_cost);
		const inputTokens = Number(r.input_tokens);
		const cacheReadTokens = Number(r.cache_read_tokens ?? 0);
		const cacheWriteTokens = Number(r.cache_write_tokens ?? 0);
		const nameRaw = r.provider_name;
		return {
			provider_id: r.provider_id,
			provider_name:
				nameRaw != null && String(nameRaw).trim() !== ""
					? String(nameRaw)
					: null,
			request_count: reqCount,
			charged_cost: chargedCost,
			metered_cost: Number(r.metered_cost),
			standard_cost: Number(r.standard_cost),
			input_tokens: inputTokens,
			output_tokens: Number(r.output_tokens),
			cache_read_tokens: cacheReadTokens,
			cache_write_tokens: cacheWriteTokens,
			cache_hit_rate: computeCacheHitRate(inputTokens, cacheReadTokens),
			distinct_models: Number(r.distinct_models),
			success_count: successCount,
			error_count: Number(r.error_count),
			success_rate: reqCount > 0 ? (successCount / reqCount) * 100 : 0,
			avg_latency_ms:
				r.avg_latency_ms != null ? Number(r.avg_latency_ms) : null,
			...mapAnalyticsTtftFields(r),
			avg_upstream_response_ms:
				r.avg_upstream_response_ms != null
					? Number(r.avg_upstream_response_ms)
					: null,
			tokens_per_second:
				r.tokens_per_second != null ? Number(r.tokens_per_second) : null,
			failover_rate: Number(r.failover_rate ?? 0),
			avg_attempts: r.avg_attempts != null ? Number(r.avg_attempts) : null,
			avg_charged_per_request: reqCount > 0 ? chargedCost / reqCount : 0,
		};
	}) as AdminProviderAnalyticsRow[];
	const tags = await repos.analytics.queryDistinctModelTags();
	return { data, tags };
}

/**
 * 用户（邮箱）维度分析；可选邮箱模糊筛。
 */
export async function getUserAnalyticsService(
	repos: GatewayRepositories,
	input: { start_date?: string; end_date?: string; email?: string }
): Promise<AdminUserAnalyticsRow[]> {
	const { start, end } = clampAnalyticsRange(
		input.start_date ?? undefined,
		input.end_date ?? undefined
	);
	const rows = await repos.analytics.queryUserAnalytics({
		start,
		end,
		email: input.email,
	});
	return rows.map((r) => {
		const reqCount = Number(r.request_count);
		const successCount = Number(r.success_count);
		const budgetMax = r.budget_max != null ? Number(r.budget_max) : null;
		const budgetSpent = Number(r.budget_spent ?? 0);
		return {
			user_email: r.user_email,
			request_count: reqCount,
			input_tokens: Number(r.input_tokens),
			output_tokens: Number(r.output_tokens),
			charged_cost: Number(r.charged_cost),
			metered_cost: Number(r.metered_cost),
			standard_cost: Number(r.standard_cost),
			distinct_models: Number(r.distinct_models),
			last_active_at: r.last_active_at,
			budget_max: budgetMax,
			budget_spent: budgetSpent,
			budget_usage_rate:
				budgetMax != null && budgetMax > 0
					? (budgetSpent / budgetMax) * 100
					: null,
			success_rate: reqCount > 0 ? (successCount / reqCount) * 100 : 0,
			error_count: Number(r.error_count),
		};
	}) as AdminUserAnalyticsRow[];
}

/**
 * 供应商可靠性 + 模型×供应商矩阵 + 最近错误日志片段。
 */
export async function getReliabilityAnalyticsService(
	repos: GatewayRepositories,
	input: { start_date?: string; end_date?: string }
): Promise<AdminReliabilityAnalyticsOutput> {
	const { start, end } = clampAnalyticsRange(
		input.start_date ?? undefined,
		input.end_date ?? undefined
	);
	const [providers, modelProviders, recentErrors] = await Promise.all([
		repos.analytics.queryProviderReliability({ start, end }),
		repos.analytics.queryModelProviderReliability({ start, end }),
		repos.requestLogs.getRecentErrors(10),
	]);

	const providerRows = providers.map((r) => {
		const requestCount = Number(r.request_count);
		return {
			provider_id: r.provider_id,
			provider_name: r.provider_name ?? null,
			request_count: requestCount,
			success_count: Number(r.success_count),
			error_count: Number(r.error_count),
			success_rate:
				requestCount > 0 ? (Number(r.success_count) / requestCount) * 100 : 0,
			avg_latency_ms:
				r.avg_latency_ms != null ? Number(r.avg_latency_ms) : null,
			avg_upstream_response_ms:
				r.avg_upstream_response_ms != null
					? Number(r.avg_upstream_response_ms)
					: null,
			failover_rate: Number(r.failover_rate ?? 0),
			avg_attempts: r.avg_attempts != null ? Number(r.avg_attempts) : null,
			charged_cost: Number(r.charged_cost),
			metered_cost: Number(r.metered_cost),
			standard_cost: Number(r.standard_cost),
		};
	}) as AdminReliabilityProviderRow[];
	const modelProviderRows = modelProviders.map((r) => {
		const requestCount = Number(r.request_count);
		return {
			model_id: r.model_id,
			provider_id: r.provider_id,
			provider_name: r.provider_name ?? null,
			request_count: requestCount,
			success_rate:
				requestCount > 0 ? (Number(r.success_count) / requestCount) * 100 : 0,
			avg_latency_ms:
				r.avg_latency_ms != null ? Number(r.avg_latency_ms) : null,
			avg_upstream_response_ms:
				r.avg_upstream_response_ms != null
					? Number(r.avg_upstream_response_ms)
					: null,
			failover_rate: Number(r.failover_rate ?? 0),
			avg_attempts: r.avg_attempts != null ? Number(r.avg_attempts) : null,
			charged_cost: Number(r.charged_cost),
			metered_cost: Number(r.metered_cost),
			standard_cost: Number(r.standard_cost),
		};
	}) as AdminReliabilityModelProviderRow[];

	return {
		providers: providerRows,
		modelProviders: modelProviderRows,
		recentErrors: recentErrors.map(analyticsRecentLog),
	};
}

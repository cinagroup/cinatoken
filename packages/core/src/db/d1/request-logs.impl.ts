/**
 * D1：`api_key_request_logs` 读路径与插入语句构造。
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { roundGatewayMoney, sqlMoneyRound } from '../../lib/money-precision';
import {
	mapRequestActivityGroupRows,
	mapRequestStatsByRangeRow,
	mapRequestTimeseriesRows,
	mapThroughputSnapshot,
	mapUserTokenTimeseriesRows,
	REQUEST_STATS_SELECT_SQL,
	REQUEST_TIMESERIES_SELECT_SQL,
} from '../../lib/dashboard-request-stats';
import type { RequestLogRow } from '../../types';
import type { D1DatabaseClient } from '../../storage/database-client';
import type { RequestLogsRepository } from '../../storage/gateway-repository-interfaces';
import type { RequestLogsD1Statements } from './d1-repository-extras';
import {
	assertGenerationSnapshotIsValid,
	serializeGenerationProviderResponses,
	type GenerationRequestLogRow,
	type InsertRequestLogParams,
	type RoutePerformanceSample,
} from '../request-logs-types';
import { filterAllowedRequestLogStatuses } from '../request-log-status-filter';
import {
	buildRecentRoutePerformanceSamplesSql,
	normalizeRoutePerformanceSamplesPerTarget,
} from '../route-performance-sampling';
import { assertGenerationFeedbackInsertParams } from '../generation-feedback-types';
import {
	assertProviderAttemptRetentionDeleteParams,
	buildProviderAttemptRetentionDeleteSql,
	buildRouteAvailabilityAggregateSql,
	normalizeRouteAvailabilityAggregate,
	routeAvailabilityAggregateParams,
} from '../provider-attempt-availability';
import {
	buildManagementAnalyticsQuery,
	mapManagementAnalyticsResult,
} from '../analytics-query';

export function buildInsertRequestLogStatement(
	db: D1Database,
	params: InsertRequestLogParams,
	createdAtIso = new Date().toISOString()
): D1PreparedStatement {
	assertGenerationSnapshotIsValid(params);
	return db
		.prepare(
			`INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id, user_email, model_id, provider_id, provider_model_name, model_name, provider_name, request_body, upstream_request_body, request_protocol, request_operation, upstream_protocol, upstream_operation, model_surface_id, route_pool_id, route_target_id, adapter, route_trace, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, native_tokens_prompt, native_tokens_completion, native_tokens_cached, native_tokens_reasoning, native_tokens_completion_images, metered_cost, standard_cost, charged_cost, budget_charged_micros, budget_accounted_at, route_group, status, latency_ms, gateway_overhead_ms, upstream_response_ms, final_upstream_headers_ms, first_reasoning_token_ms, first_token_ms, stream_duration_ms, upstream_attempt_count, upstream_failover_count, timing_metadata, error_message, raw_usage, pricing_audit, provider_key_id, provider_key_label, provider_key_fingerprint, upstream_request_id, upstream_message_id, billing_kind, input_image_count, output_image_count, audio_duration_seconds, audio_characters, session_id, request_origin, response_streamed, data_region, is_byok, charged_cost_usd, upstream_inference_cost_usd, service_tier, finish_reason, native_finish_reason, provider_responses, http_referer, user_agent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			params.id,
			params.userId,
			params.apiKeyId,
			params.workspaceId,
			params.userEmail,
			params.modelId,
			params.providerId,
			params.providerModelName,
			params.modelName,
			params.providerName,
			params.requestBody,
			params.upstreamRequestBody,
			params.requestProtocol,
			params.requestOperation ?? null,
			params.upstreamProtocol,
			params.upstreamOperation ?? null,
			params.modelSurfaceId ?? null,
			params.routePoolId ?? null,
			params.routeTargetId ?? null,
			params.adapter ?? null,
			params.routeTrace ?? null,
			params.inputTokens,
			params.outputTokens,
			params.cacheReadTokens,
			params.cacheWriteTokens,
			params.reasoningTokens,
			params.totalTokens,
			params.nativeTokensPrompt ?? null,
			params.nativeTokensCompletion ?? null,
			params.nativeTokensCached ?? null,
			params.nativeTokensReasoning ?? null,
			params.nativeTokensCompletionImages ?? null,
			roundGatewayMoney(params.meteredCost),
			roundGatewayMoney(params.standardCost),
			roundGatewayMoney(params.chargedCost),
			params.budgetChargedMicros ?? null,
			params.budgetAccountedAt ?? null,
			params.routeGroup,
			params.status,
			params.latencyMs,
			params.gatewayOverheadMs ?? null,
			params.upstreamResponseMs ?? null,
			params.finalUpstreamHeadersMs ?? null,
			params.firstReasoningTokenMs ?? null,
			params.firstTokenMs ?? null,
			params.streamDurationMs ?? null,
			params.upstreamAttemptCount ?? null,
			params.upstreamFailoverCount ?? null,
			params.timingMetadata ?? null,
			params.errorMessage,
			params.rawUsage,
			params.pricingAudit ?? null,
			params.providerKeyId ?? null,
			params.providerKeyLabel ?? null,
			params.providerKeyFingerprint ?? null,
			params.upstreamRequestId ?? null,
			params.upstreamMessageId ?? null,
			params.billingKind ?? null,
			params.inputImageCount ?? 0,
			params.outputImageCount ?? 0,
			params.audioDurationSeconds ?? null,
			params.audioCharacters ?? null,
			params.sessionId ?? null,
			params.requestOrigin ?? null,
			params.responseStreamed == null ? null : Number(params.responseStreamed),
			params.dataRegion ?? null,
			params.isByok == null ? null : Number(params.isByok),
			params.chargedCostUsd == null ? null : roundGatewayMoney(params.chargedCostUsd),
			params.upstreamInferenceCostUsd == null
				? null
				: roundGatewayMoney(params.upstreamInferenceCostUsd),
			params.serviceTier ?? null,
			params.finishReason ?? null,
			params.nativeFinishReason ?? null,
			serializeGenerationProviderResponses(params.providerResponses),
			params.httpReferer ?? null,
			params.userAgent ?? null,
			createdAtIso
		);
}

export function createD1RequestLogsRepository(db: D1DatabaseClient): RequestLogsRepository & RequestLogsD1Statements {
	const raw = db.raw;
	return {
		buildInsertRequestLogStatement,

		async queryManagementAnalytics(query) {
			const built = buildManagementAnalyticsQuery('d1', query);
			const rows = await raw
				.prepare(built.sql)
				.bind(...built.values)
				.all<Record<string, unknown>>();
			return mapManagementAnalyticsResult(rows.results ?? [], query);
		},

		async insertGenerationFeedbackForManagementAccount(params): Promise<boolean> {
			assertGenerationFeedbackInsertParams(params);
			const personal = params.account.accountType === 'personal';
			const ownerId = personal
				? params.account.personalOwnerUserId!
				: params.account.organizationId!;
			const accountPredicate = personal
				? `mk.account_type = 'personal'
				   AND mk.personal_owner_user_id = ?
				   AND mk.organization_id IS NULL
				   AND w.scope_type = 'personal'
				   AND w.personal_owner_user_id = mk.personal_owner_user_id
				   AND w.organization_id IS NULL
				   AND rl.user_id = mk.personal_owner_user_id`
				: `mk.account_type = 'organization'
				   AND mk.organization_id = ?
				   AND mk.personal_owner_user_id IS NULL
				   AND w.scope_type = 'organization'
				   AND w.organization_id = mk.organization_id
				   AND w.personal_owner_user_id IS NULL`;
			const result = await raw.prepare(
				`INSERT INTO generation_feedback (
					id, generation_id, workspace_id, management_api_key_id,
					account_type, personal_owner_user_id, organization_id,
					category, comment, created_at
				 )
				 SELECT ?, rl.id, rl.workspace_id, mk.id,
				        mk.account_type, mk.personal_owner_user_id, mk.organization_id,
				        ?, ?, ?
				 FROM api_key_request_logs rl
				 JOIN workspaces w ON w.id = rl.workspace_id
				 JOIN management_api_keys mk ON mk.id = ? AND mk.status = 'active'
				 WHERE rl.id = ?
				   AND ${accountPredicate}`
			).bind(
				params.id,
				params.category,
				params.comment,
				params.createdAtIso,
				params.managementApiKeyId,
				params.generationId,
				ownerId,
			).run();
			return Number(result.meta.changes ?? 0) === 1;
		},

		async getRequestLogByIdForOwner(options): Promise<GenerationRequestLogRow | null> {
			return raw
				.prepare(
					`SELECT rl.id, rl.request_operation, rl.status, rl.created_at,
					        rl.latency_ms, rl.final_upstream_headers_ms, rl.stream_duration_ms,
					        rl.model_id, rl.provider_name,
					        rl.input_tokens, rl.output_tokens, rl.cache_read_tokens,
					        rl.reasoning_tokens, rl.native_tokens_prompt,
					        rl.native_tokens_completion, rl.native_tokens_cached,
					        rl.native_tokens_reasoning, rl.native_tokens_completion_images,
					        rl.input_image_count, rl.output_image_count,
					        rl.upstream_message_id, rl.session_id, rl.workspace_id, rl.request_origin,
					        rl.http_referer, rl.user_agent,
					        rl.response_streamed, rl.data_region, rl.is_byok,
					        rl.charged_cost_usd, rl.upstream_inference_cost_usd, rl.service_tier,
					        rl.finish_reason, rl.native_finish_reason, rl.provider_responses
					 FROM api_key_request_logs rl
					 WHERE rl.id = ?
					   AND rl.user_id = ?
					   AND rl.workspace_id = ?
					 LIMIT 1`
				)
				.bind(options.id, options.userId, options.workspaceId)
				.first<GenerationRequestLogRow>();
		},

		async getRequestLogsByKeyId(
			apiKeyId: string,
			page: number,
			pageSize: number,
			filter?: { excludeStatus?: string; includeStatuses?: string[] }
		): Promise<{ logs: RequestLogRow[]; total: number }> {
			const offset = (page - 1) * pageSize;
			const include = filterAllowedRequestLogStatuses(filter?.includeStatuses);
			if (include.length > 0) {
				const placeholders = include.map(() => '?').join(', ');
				const countWhere = `api_key_id = ? AND status IN (${placeholders})`;
				const countBind = raw
					.prepare(`SELECT COUNT(*) as total FROM api_key_request_logs WHERE ${countWhere}`)
					.bind(apiKeyId, ...include);
				const countRow = await countBind.first<{ total: number }>();
				const total = countRow?.total ?? 0;

				const selectBind = raw
					.prepare(
						`SELECT * FROM api_key_request_logs WHERE ${countWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`
					)
					.bind(apiKeyId, ...include, pageSize, offset);
				const rows = await selectBind.all<RequestLogRow>();
				return { logs: rows.results ?? [], total };
			}

			const excludeStatus = filter?.excludeStatus;
			const countWhere = excludeStatus
				? 'api_key_id = ? AND (status IS NULL OR status != ?)'
				: 'api_key_id = ?';
			const countBind = excludeStatus
				? raw.prepare(`SELECT COUNT(*) as total FROM api_key_request_logs WHERE ${countWhere}`).bind(apiKeyId, excludeStatus)
				: raw.prepare(`SELECT COUNT(*) as total FROM api_key_request_logs WHERE ${countWhere}`).bind(apiKeyId);
			const countRow = await countBind.first<{ total: number }>();
			const total = countRow?.total ?? 0;

			const selectWhere = excludeStatus
				? 'api_key_id = ? AND (status IS NULL OR status != ?)'
				: 'api_key_id = ?';
			const selectBind = excludeStatus
				? raw
						.prepare(`SELECT * FROM api_key_request_logs WHERE ${selectWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
						.bind(apiKeyId, excludeStatus, pageSize, offset)
				: raw
						.prepare(`SELECT * FROM api_key_request_logs WHERE ${selectWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
						.bind(apiKeyId, pageSize, offset);
			const rows = await selectBind.all<RequestLogRow>();
			return { logs: rows.results ?? [], total };
		},

		async getRequestLogs(options: {
			page?: number;
			pageSize?: number;
			workspaceId?: string;
			apiKeyId?: string;
			userId?: string;
			userEmail?: string;
			modelId?: string;
			providerId?: string;
			providerName?: string;
			routeGroup?: string;
			protocol?: string;
			status?: string;
			startDate?: string;
			endDate?: string;
		}): Promise<{ logs: RequestLogRow[]; total: number }> {
			const page = options.page || 1;
			const pageSize = Math.min(options.pageSize || 20, 100);
			const offset = (page - 1) * pageSize;
			const conditions: string[] = [];
			const conditionsRl: string[] = [];
			const bindValues: unknown[] = [];

			if (options.workspaceId) {
				conditions.push('workspace_id = ?');
				conditionsRl.push('rl.workspace_id = ?');
				bindValues.push(options.workspaceId);
			}

			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				conditionsRl.push('rl.api_key_id = ?');
				bindValues.push(options.apiKeyId);
			}
			if (options.userId) {
				conditions.push('user_id = ?');
				conditionsRl.push('rl.user_id = ?');
				bindValues.push(options.userId);
			}
			if (options.userEmail) {
				conditions.push('user_email = ?');
				conditionsRl.push('rl.user_email = ?');
				bindValues.push(options.userEmail);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				conditionsRl.push('rl.model_id = ?');
				bindValues.push(options.modelId);
			}
			if (options.providerId) {
				conditions.push('provider_id = ?');
				conditionsRl.push('rl.provider_id = ?');
				bindValues.push(options.providerId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				conditionsRl.push('rl.provider_name = ?');
				bindValues.push(options.providerName);
			}
			if (options.routeGroup) {
				conditions.push('route_group = ?');
				conditionsRl.push('rl.route_group = ?');
				bindValues.push(options.routeGroup);
			}
			if (options.protocol) {
				conditions.push("COALESCE(NULLIF(request_protocol, ''), upstream_protocol) = ?");
				conditionsRl.push("COALESCE(NULLIF(rl.request_protocol, ''), rl.upstream_protocol) = ?");
				bindValues.push(options.protocol);
			}
			if (options.status) {
				conditions.push('status = ?');
				conditionsRl.push('rl.status = ?');
				bindValues.push(options.status);
			}
			if (options.startDate) {
				conditions.push('created_at >= ?');
				conditionsRl.push('rl.created_at >= ?');
				bindValues.push(options.startDate);
			}
			if (options.endDate) {
				conditions.push('created_at <= ?');
				conditionsRl.push('rl.created_at <= ?');
				bindValues.push(options.endDate);
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const whereClauseRl = conditionsRl.length > 0 ? `WHERE ${conditionsRl.join(' AND ')}` : '';

			const countRow = await raw
				.prepare(`SELECT COUNT(*) as total FROM api_key_request_logs ${whereClause}`)
				.bind(...bindValues)
				.first<{ total: number }>();
			const total = Number(countRow?.total ?? 0);

			const rows = await raw
				.prepare(
					`SELECT rl.*, u.external_system AS external_system
					 FROM api_key_request_logs rl
					 LEFT JOIN users u ON u.id = rl.user_id
					 ${whereClauseRl}
					 ORDER BY rl.created_at DESC LIMIT ? OFFSET ?`
				)
				.bind(...bindValues, pageSize, offset)
				.all<RequestLogRow>();
			return { logs: rows.results ?? [], total };
		},

		async getRequestStatsByRange(options: {
			startDate: string;
			endDate: string;
			endExclusive?: boolean;
			userId?: string;
			workspaceId?: string;
			apiKeyId?: string;
			modelId?: string;
			providerName?: string;
			status?: string;
		}) {
			const comparator = options.endExclusive ? '<' : '<=';
			const conditions = [`created_at >= ?`, `created_at ${comparator} ?`];
			const bindValues: unknown[] = [options.startDate, options.endDate];
			if (options.userId) {
				conditions.push('user_id = ?');
				bindValues.push(options.userId);
			}
			if (options.workspaceId) {
				conditions.push('workspace_id = ?');
				bindValues.push(options.workspaceId);
			}
			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				bindValues.push(options.apiKeyId);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				bindValues.push(options.modelId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				bindValues.push(options.providerName);
			}
			if (options.status) {
				conditions.push('status = ?');
				bindValues.push(options.status);
			}
			const row = await raw
				.prepare(
					`SELECT
				${REQUEST_STATS_SELECT_SQL},
				COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost,
				COALESCE(${sqlMoneyRound('SUM(metered_cost)')}, 0) as metered_cost,
				COALESCE(${sqlMoneyRound('SUM(standard_cost)')}, 0) as standard_cost
				 FROM api_key_request_logs WHERE ${conditions.join(' AND ')}`
				)
				.bind(...bindValues)
				.first();

			return mapRequestStatsByRangeRow(row);
		},

		async getRequestActivityGroups(options) {
			const comparator = options.endExclusive ? '<' : '<=';
			const conditions = [
				`created_at >= ?`,
				`created_at ${comparator} ?`,
				'user_id = ?',
				'workspace_id = ?',
			];
			const bindValues: unknown[] = [
				options.startDate,
				options.endDate,
				options.userId,
				options.workspaceId,
			];
			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				bindValues.push(options.apiKeyId);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				bindValues.push(options.modelId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				bindValues.push(options.providerName);
			}
			if (options.status) {
				conditions.push('status = ?');
				bindValues.push(options.status);
			}
			const groupColumn = options.dimension === 'model'
				? 'model_id'
				: options.dimension === 'provider' ? 'provider_name' : 'api_key_id';
			const groupName = options.dimension === 'model'
				? "MAX(NULLIF(model_name, ''))"
				: 'NULL';
			conditions.push(`${groupColumn} IS NOT NULL`, `${groupColumn} != ''`);
			const parsedLimit = Number(options.limit);
			const limit = Number.isFinite(parsedLimit)
				? Math.min(25, Math.max(1, Math.trunc(parsedLimit)))
				: 10;
			const rows = await raw
				.prepare(
					`SELECT
						${groupColumn} as group_id,
						${groupName} as group_name,
						COUNT(*) as request_count,
						SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
						SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
						COALESCE(SUM(total_tokens), 0) as total_tokens,
						COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost
					 FROM api_key_request_logs
					 WHERE ${conditions.join(' AND ')}
					 GROUP BY ${groupColumn}
					 ORDER BY charged_cost DESC, request_count DESC, group_id ASC
					 LIMIT ?`
				)
				.bind(...bindValues, limit)
				.all();
			return mapRequestActivityGroupRows(rows.results ?? []);
		},

		async queryRequestTimeseries(options: {
			startDate: string;
			endDate: string;
			endExclusive?: boolean;
			granularity: 'hour' | 'day';
			userId?: string;
			workspaceId?: string;
			apiKeyId?: string;
			modelId?: string;
			providerName?: string;
			status?: string;
		}) {
			const bucketExpr =
				options.granularity === 'hour'
					? "strftime('%Y-%m-%d %H:00:00', created_at)"
					: "strftime('%Y-%m-%d', created_at)";
			const comparator = options.endExclusive ? '<' : '<=';
			const conditions = [`created_at >= ?`, `created_at ${comparator} ?`];
			const bindValues: unknown[] = [options.startDate, options.endDate];
			if (options.userId) {
				conditions.push('user_id = ?');
				bindValues.push(options.userId);
			}
			if (options.workspaceId) {
				conditions.push('workspace_id = ?');
				bindValues.push(options.workspaceId);
			}
			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				bindValues.push(options.apiKeyId);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				bindValues.push(options.modelId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				bindValues.push(options.providerName);
			}
			if (options.status) {
				conditions.push('status = ?');
				bindValues.push(options.status);
			}
			const rows = await raw
				.prepare(
					`SELECT
				${bucketExpr} as bucket,
				${REQUEST_TIMESERIES_SELECT_SQL},
				COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost
			 FROM api_key_request_logs
				 WHERE ${conditions.join(' AND ')}
			 GROUP BY bucket
			 ORDER BY bucket ASC`
				)
				.bind(...bindValues)
				.all();
			return mapRequestTimeseriesRows(rows.results ?? []);
		},

		async queryUserTokenTimeseries(options: {
			startDate: string;
			endDate: string;
			granularity: 'hour' | 'day';
			userEmails: string[];
		}) {
			if (options.userEmails.length === 0) return [];
			const bucketExpr =
				options.granularity === 'hour'
					? "strftime('%Y-%m-%d %H:00:00', created_at)"
					: "strftime('%Y-%m-%d', created_at)";
			const placeholders = options.userEmails.map(() => '?').join(', ');
			const rows = await raw
				.prepare(
					`SELECT
				${bucketExpr} as bucket,
				user_email,
				COALESCE(SUM(total_tokens), 0) as total_tokens
			 FROM api_key_request_logs
			 WHERE created_at >= ? AND created_at <= ?
			   AND user_email IN (${placeholders})
			 GROUP BY bucket, user_email
			 ORDER BY bucket ASC`
				)
				.bind(options.startDate, options.endDate, ...options.userEmails)
				.all();
			return mapUserTokenTimeseriesRows(rows.results ?? []);
		},

		async getThroughputLastMinute() {
			const end = new Date();
			const start = new Date(end.getTime() - 60 * 1000);
			const startDate = start.toISOString().slice(0, 19).replace('T', ' ');
			const endDate = end.toISOString().slice(0, 19).replace('T', ' ');
			const row = await raw
				.prepare(
					`SELECT
				COUNT(*) as request_count,
				COALESCE(SUM(total_tokens), 0) as total_tokens
			 FROM api_key_request_logs
			 WHERE created_at >= ? AND created_at <= ?`
				)
				.bind(startDate, endDate)
				.first();
			return mapThroughputSnapshot(row);
		},

		async getRecentLogs(limit: number): Promise<RequestLogRow[]> {
			const rows = await raw
				.prepare('SELECT * FROM api_key_request_logs ORDER BY created_at DESC LIMIT ?')
				.bind(limit)
				.all<RequestLogRow>();
			return rows.results ?? [];
		},

		async getRecentErrors(limit: number): Promise<RequestLogRow[]> {
			const rows = await raw
				.prepare(`SELECT * FROM api_key_request_logs WHERE status = 'error' ORDER BY created_at DESC LIMIT ?`)
				.bind(limit)
				.all<RequestLogRow>();
			return rows.results ?? [];
		},

		async getRecentRoutePerformanceSamples(options): Promise<RoutePerformanceSample[]> {
			if (options.routeTargetIds.length === 0) return [];
			const maxSamplesPerRoute = normalizeRoutePerformanceSamplesPerTarget(options.maxSamplesPerRoute);
			if (maxSamplesPerRoute === 0) return [];
			const sql = buildRecentRoutePerformanceSamplesSql('d1', options.routeTargetIds.length);
			const rows = await raw.prepare(sql)
				.bind(...options.routeTargetIds, options.sinceIso, maxSamplesPerRoute)
				.all<RoutePerformanceSample>();
			return rows.results ?? [];
		},

		async getRouteAvailabilityAggregates(options) {
			if (options.routeTargetIds.length === 0) return [];
			const sql = buildRouteAvailabilityAggregateSql('d1', options.routeTargetIds.length);
			const rows = await raw.prepare(sql)
				.bind(...routeAvailabilityAggregateParams(options))
				.all<Record<string, unknown>>();
			return (rows.results ?? []).map(normalizeRouteAvailabilityAggregate);
		},

		async deleteProviderAttemptAvailabilityBefore(options) {
			assertProviderAttemptRetentionDeleteParams(options);
			const result = await raw.prepare(buildProviderAttemptRetentionDeleteSql('d1'))
				.bind(options.cutoffIso, options.cutoffIso, options.limit)
				.run();
			const deleted = Number(result.meta.changes ?? 0);
			if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > options.limit) {
				throw new TypeError('Provider attempt retention delete result is invalid');
			}
			return deleted;
		},

		async getDistinctActiveUsersCount(options: { startDate: string; endDate: string; endExclusive?: boolean }): Promise<number> {
			const comparator = options.endExclusive ? '<' : '<=';
			const row = await raw
				.prepare(
					`SELECT
				COUNT(DISTINCT CASE WHEN user_email IS NOT NULL AND user_email != '' THEN user_email END) as active_users
			 FROM api_key_request_logs WHERE created_at >= ? AND created_at ${comparator} ?`
				)
				.bind(options.startDate, options.endDate)
				.first<{ active_users: number }>();
			return Number(row?.active_users ?? 0);
		},
	};
}

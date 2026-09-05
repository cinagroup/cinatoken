/**
 * Postgres：`api_key_request_logs`（postgres.js + unsafe）。
 */
import { sqlMoneyRound } from '../../lib/money-precision';
import {
	mapRequestActivityGroupRows,
	mapRequestStatsByRangeRow,
	mapRequestTimeseriesRows,
	mapThroughputSnapshot,
	mapUserTokenTimeseriesRows,
} from '../../lib/dashboard-request-stats';
import type { RequestLogRow } from '../../types';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RequestLogsRepository } from '../../storage/gateway-repository-interfaces';
import { sqlitePlaceholdersToPg } from '../shared/sql-placeholders';
import { filterAllowedRequestLogStatuses } from '../request-log-status-filter';
import type { GenerationRequestLogRow, RoutePerformanceSample } from '../request-logs-types';
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

export function createPostgresRequestLogsRepository(db: PostgresDatabaseClient): RequestLogsRepository {
	const pg = db.raw;
	return {
		async queryManagementAnalytics(query) {
			const built = buildManagementAnalyticsQuery('postgres', query);
			const rows = await pg.unsafe<Record<string, unknown>[]>(
				built.sql,
				built.values as Parameters<typeof pg.unsafe>[1],
			);
			return mapManagementAnalyticsResult(rows, query);
		},

		async insertGenerationFeedbackForManagementAccount(params): Promise<boolean> {
			assertGenerationFeedbackInsertParams(params);
			const personal = params.account.accountType === 'personal';
			const ownerId = personal
				? params.account.personalOwnerUserId!
				: params.account.organizationId!;
			const accountPredicate = personal
				? `mk.account_type = 'personal'
				   AND mk.personal_owner_user_id = $7
				   AND mk.organization_id IS NULL
				   AND w.scope_type = 'personal'
				   AND w.personal_owner_user_id = mk.personal_owner_user_id
				   AND w.organization_id IS NULL
				   AND rl.user_id = mk.personal_owner_user_id`
				: `mk.account_type = 'organization'
				   AND mk.organization_id = $7
				   AND mk.personal_owner_user_id IS NULL
				   AND w.scope_type = 'organization'
				   AND w.organization_id = mk.organization_id
				   AND w.personal_owner_user_id IS NULL`;
			const rows = await pg.unsafe<Array<{ id: string }>>(
				`INSERT INTO generation_feedback (
					id, generation_id, workspace_id, management_api_key_id,
					account_type, personal_owner_user_id, organization_id,
					category, comment, created_at
				 )
				 SELECT $1, rl.id, rl.workspace_id, mk.id,
				        mk.account_type, mk.personal_owner_user_id, mk.organization_id,
				        $2, $3, $4
				 FROM api_key_request_logs rl
				 JOIN workspaces w ON w.id = rl.workspace_id
				 JOIN management_api_keys mk ON mk.id = $5 AND mk.status = 'active'
				 WHERE rl.id = $6
				   AND ${accountPredicate}
				 RETURNING id`,
				[
					params.id,
					params.category,
					params.comment,
					params.createdAtIso,
					params.managementApiKeyId,
					params.generationId,
					ownerId,
				],
			);
			return rows.length === 1;
		},

		async getRequestLogByIdForOwner(options): Promise<GenerationRequestLogRow | null> {
			const rows = (await pg.unsafe(
			`SELECT rl.id, rl.request_operation, rl.status, rl.created_at::text AS created_at,
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
				 WHERE rl.id = $1
				   AND rl.user_id = $2
				   AND rl.workspace_id = $3
				 LIMIT 1`,
				[options.id, options.userId, options.workspaceId]
			)) as GenerationRequestLogRow[];
			return rows[0] ?? null;
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
				const countRows = await pg<{ total: string | number }[]>`
			SELECT COUNT(*)::bigint AS total FROM api_key_request_logs
			WHERE api_key_id = ${apiKeyId} AND status IN ${pg(include)}
		`;
				const total = Number(countRows[0]?.total ?? 0);
				const logs = await pg<RequestLogRow[]>`
			SELECT * FROM api_key_request_logs
			WHERE api_key_id = ${apiKeyId} AND status IN ${pg(include)}
			ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}
		`;
				return { logs, total };
			}
			const excludeStatus = filter?.excludeStatus;
			if (excludeStatus) {
				const countRows = await pg<{ total: string | number }[]>`
			SELECT COUNT(*)::bigint AS total FROM api_key_request_logs
			WHERE api_key_id = ${apiKeyId} AND (status IS NULL OR status <> ${excludeStatus})
		`;
				const total = Number(countRows[0]?.total ?? 0);
				const logs = await pg<RequestLogRow[]>`
			SELECT * FROM api_key_request_logs
			WHERE api_key_id = ${apiKeyId} AND (status IS NULL OR status <> ${excludeStatus})
			ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}
		`;
				return { logs, total };
			}
			const countRows = await pg<{ total: string | number }[]>`
		SELECT COUNT(*)::bigint AS total FROM api_key_request_logs WHERE api_key_id = ${apiKeyId}
	`;
			const total = Number(countRows[0]?.total ?? 0);
			const logs = await pg<RequestLogRow[]>`
		SELECT * FROM api_key_request_logs WHERE api_key_id = ${apiKeyId}
		ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}
	`;
			return { logs, total };
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
			const bindValues: unknown[] = [];

			if (options.workspaceId) {
				conditions.push('rl.workspace_id = ?');
				bindValues.push(options.workspaceId);
			}

			if (options.apiKeyId) {
				conditions.push('rl.api_key_id = ?');
				bindValues.push(options.apiKeyId);
			}
			if (options.userId) {
				conditions.push('rl.user_id = ?');
				bindValues.push(options.userId);
			}
			if (options.userEmail) {
				conditions.push('rl.user_email = ?');
				bindValues.push(options.userEmail);
			}
			if (options.modelId) {
				conditions.push('rl.model_id = ?');
				bindValues.push(options.modelId);
			}
			if (options.providerId) {
				conditions.push('rl.provider_id = ?');
				bindValues.push(options.providerId);
			}
			if (options.providerName) {
				conditions.push('rl.provider_name = ?');
				bindValues.push(options.providerName);
			}
			if (options.routeGroup) {
				conditions.push('rl.route_group = ?');
				bindValues.push(options.routeGroup);
			}
			if (options.protocol) {
				conditions.push("COALESCE(NULLIF(rl.request_protocol, ''), rl.upstream_protocol) = ?");
				bindValues.push(options.protocol);
			}
			if (options.status) {
				conditions.push('rl.status = ?');
				bindValues.push(options.status);
			}
			if (options.startDate) {
				conditions.push('rl.created_at >= ?');
				bindValues.push(options.startDate);
			}
			if (options.endDate) {
				conditions.push('rl.created_at <= ?');
				bindValues.push(options.endDate);
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countSql = sqlitePlaceholdersToPg(`SELECT COUNT(*) as total FROM api_key_request_logs rl ${whereClause}`);
			const countRows = (await pg.unsafe(
				countSql,
				bindValues as Parameters<typeof pg.unsafe>[1]
			)) as { total: string | number }[];
			const total = Number(countRows[0]?.total ?? 0);

			const selectSql = sqlitePlaceholdersToPg(
				`SELECT rl.*, u.external_system AS external_system
				 FROM api_key_request_logs rl
				 LEFT JOIN users u ON u.id = rl.user_id
				 ${whereClause}
				 ORDER BY rl.created_at DESC LIMIT ? OFFSET ?`
			);
			const dataRows = (await pg.unsafe(
				selectSql,
				[...bindValues, pageSize, offset] as Parameters<typeof pg.unsafe>[1]
			)) as RequestLogRow[];
			return { logs: dataRows, total };
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
			const conditions = [`created_at >= $1`, `created_at ${comparator} $2`];
			const values: unknown[] = [options.startDate, options.endDate];
			if (options.userId) {
				values.push(options.userId);
				conditions.push(`user_id = $${values.length}`);
			}
			if (options.workspaceId) {
				values.push(options.workspaceId);
				conditions.push(`workspace_id = $${values.length}`);
			}
			if (options.apiKeyId) {
				values.push(options.apiKeyId);
				conditions.push(`api_key_id = $${values.length}`);
			}
			if (options.modelId) {
				values.push(options.modelId);
				conditions.push(`model_id = $${values.length}`);
			}
			if (options.providerName) {
				values.push(options.providerName);
				conditions.push(`provider_name = $${values.length}`);
			}
			if (options.status) {
				values.push(options.status);
				conditions.push(`status = $${values.length}`);
			}
			const q = `SELECT
				COUNT(*)::bigint as total_requests,
				SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::bigint as success_count,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::bigint as error_count,
				COALESCE(SUM(input_tokens), 0)::bigint as input_tokens,
				COALESCE(SUM(output_tokens), 0)::bigint as output_tokens,
				COALESCE(SUM(cache_read_tokens), 0)::bigint as cache_read_tokens,
				COALESCE(SUM(cache_write_tokens), 0)::bigint as cache_write_tokens,
				COALESCE(SUM(total_tokens), 0)::bigint as total_tokens,
				AVG(latency_ms) as avg_latency_ms,
				COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost,
				COALESCE(${sqlMoneyRound('SUM(metered_cost)')}, 0) as metered_cost,
				COALESCE(${sqlMoneyRound('SUM(standard_cost)')}, 0) as standard_cost
			 FROM api_key_request_logs WHERE ${conditions.join(' AND ')}`;
			const rows = (await pg.unsafe(q, values as Parameters<typeof pg.unsafe>[1])) as Record<string, unknown>[];
			return mapRequestStatsByRangeRow(rows[0]);
		},

		async getRequestActivityGroups(options) {
			const comparator = options.endExclusive ? '<' : '<=';
			const values: unknown[] = [
				options.startDate,
				options.endDate,
				options.userId,
				options.workspaceId,
			];
			const conditions = [
				`created_at >= $1`,
				`created_at ${comparator} $2`,
				'user_id = $3',
				'workspace_id = $4',
			];
			if (options.apiKeyId) {
				values.push(options.apiKeyId);
				conditions.push(`api_key_id = $${values.length}`);
			}
			if (options.modelId) {
				values.push(options.modelId);
				conditions.push(`model_id = $${values.length}`);
			}
			if (options.providerName) {
				values.push(options.providerName);
				conditions.push(`provider_name = $${values.length}`);
			}
			if (options.status) {
				values.push(options.status);
				conditions.push(`status = $${values.length}`);
			}
			const groupColumn = options.dimension === 'model'
				? 'model_id'
				: options.dimension === 'provider' ? 'provider_name' : 'api_key_id';
			const groupName = options.dimension === 'model'
				? "MAX(NULLIF(model_name, ''))"
				: 'NULL::text';
			conditions.push(`${groupColumn} IS NOT NULL`, `${groupColumn} != ''`);
			const parsedLimit = Number(options.limit);
			const limit = Number.isFinite(parsedLimit)
				? Math.min(25, Math.max(1, Math.trunc(parsedLimit)))
				: 10;
			values.push(limit);
			const q = `SELECT
				${groupColumn} as group_id,
				${groupName} as group_name,
				COUNT(*)::bigint as request_count,
				SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::bigint as success_count,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::bigint as error_count,
				COALESCE(SUM(total_tokens), 0)::bigint as total_tokens,
				COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost
			 FROM api_key_request_logs
			 WHERE ${conditions.join(' AND ')}
			 GROUP BY ${groupColumn}
			 ORDER BY charged_cost DESC, request_count DESC, group_id ASC
			 LIMIT $${values.length}`;
			const rows = (await pg.unsafe(q, values as Parameters<typeof pg.unsafe>[1])) as Record<string, unknown>[];
			return mapRequestActivityGroupRows(rows);
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
					? "to_char(date_trunc('hour', created_at::timestamp), 'YYYY-MM-DD HH24:MI:SS')"
					: "to_char(date_trunc('day', created_at::timestamp), 'YYYY-MM-DD')";
			const comparator = options.endExclusive ? '<' : '<=';
			const values: unknown[] = [options.startDate, options.endDate];
			const conditions = [`created_at >= $1`, `created_at ${comparator} $2`];
			for (const [column, value] of [
				['user_id', options.userId],
				['workspace_id', options.workspaceId],
				['api_key_id', options.apiKeyId],
				['model_id', options.modelId],
				['provider_name', options.providerName],
				['status', options.status],
			] as const) {
				if (value) {
					values.push(value);
					conditions.push(`${column} = $${values.length}`);
				}
			}
			const q = `SELECT
				${bucketExpr} as bucket,
				COUNT(*)::bigint as request_count,
				COALESCE(SUM(input_tokens), 0)::bigint as input_tokens,
				COALESCE(SUM(output_tokens), 0)::bigint as output_tokens,
				COALESCE(SUM(cache_read_tokens), 0)::bigint as cache_read_tokens,
				COALESCE(SUM(cache_write_tokens), 0)::bigint as cache_write_tokens,
				COALESCE(SUM(total_tokens), 0)::bigint as total_tokens,
				AVG(latency_ms) as avg_latency_ms,
				COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) as charged_cost
			 FROM api_key_request_logs
			 WHERE ${conditions.join(' AND ')}
			 GROUP BY 1
			 ORDER BY 1 ASC`;
			const rows = (await pg.unsafe(q, values as Parameters<typeof pg.unsafe>[1])) as Record<string, unknown>[];
			return mapRequestTimeseriesRows(rows);
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
					? "to_char(date_trunc('hour', created_at::timestamp), 'YYYY-MM-DD HH24:MI:SS')"
					: "to_char(date_trunc('day', created_at::timestamp), 'YYYY-MM-DD')";
			const emailParams = options.userEmails.map((_, i) => `$${i + 3}`).join(', ');
			const q = `SELECT
				${bucketExpr} as bucket,
				user_email,
				COALESCE(SUM(total_tokens), 0)::bigint as total_tokens
			 FROM api_key_request_logs
			 WHERE created_at >= $1 AND created_at <= $2
			   AND user_email IN (${emailParams})
			 GROUP BY 1, user_email
			 ORDER BY 1 ASC`;
			const rows = (await pg.unsafe(q, [options.startDate, options.endDate, ...options.userEmails])) as Record<string, unknown>[];
			return mapUserTokenTimeseriesRows(rows);
		},

		async getThroughputLastMinute() {
			const end = new Date();
			const start = new Date(end.getTime() - 60 * 1000);
			const startDate = start.toISOString().slice(0, 19).replace('T', ' ');
			const endDate = end.toISOString().slice(0, 19).replace('T', ' ');
			const q = `SELECT
				COUNT(*)::bigint as request_count,
				COALESCE(SUM(total_tokens), 0)::bigint as total_tokens
			 FROM api_key_request_logs
			 WHERE created_at >= $1 AND created_at <= $2`;
			const rows = (await pg.unsafe(q, [startDate, endDate])) as Record<string, unknown>[];
			return mapThroughputSnapshot(rows[0]);
		},

		async getRecentLogs(limit: number): Promise<RequestLogRow[]> {
			return (await pg.unsafe('SELECT * FROM api_key_request_logs ORDER BY created_at DESC LIMIT $1', [limit])) as RequestLogRow[];
		},

		async getRecentErrors(limit: number): Promise<RequestLogRow[]> {
			return (await pg.unsafe(
				`SELECT * FROM api_key_request_logs WHERE status = 'error' ORDER BY created_at DESC LIMIT $1`,
				[limit]
			)) as RequestLogRow[];
		},

		async getRecentRoutePerformanceSamples(options): Promise<RoutePerformanceSample[]> {
			if (options.routeTargetIds.length === 0) return [];
			const maxSamplesPerRoute = normalizeRoutePerformanceSamplesPerTarget(options.maxSamplesPerRoute);
			if (maxSamplesPerRoute === 0) return [];
			const sql = sqlitePlaceholdersToPg(
				buildRecentRoutePerformanceSamplesSql('postgres', options.routeTargetIds.length),
			);
			return (await pg.unsafe(
				sql,
				[...options.routeTargetIds, options.sinceIso, maxSamplesPerRoute] as Parameters<typeof pg.unsafe>[1],
			)) as RoutePerformanceSample[];
		},

		async getRouteAvailabilityAggregates(options) {
			if (options.routeTargetIds.length === 0) return [];
			const sql = sqlitePlaceholdersToPg(
				buildRouteAvailabilityAggregateSql('postgres', options.routeTargetIds.length),
			);
			const rows = await pg.unsafe(
				sql,
				routeAvailabilityAggregateParams(options) as Parameters<typeof pg.unsafe>[1],
			) as Record<string, unknown>[];
			return rows.map(normalizeRouteAvailabilityAggregate);
		},

		async deleteProviderAttemptAvailabilityBefore(options) {
			assertProviderAttemptRetentionDeleteParams(options);
			const sql = sqlitePlaceholdersToPg(buildProviderAttemptRetentionDeleteSql('postgres'));
			const rows = await pg.unsafe<Array<{ deleted_count: string | number }>>(
				sql,
				[options.cutoffIso, options.limit],
			);
			const deleted = Number(rows[0]?.deleted_count ?? 0);
			if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > options.limit) {
				throw new TypeError('Provider attempt retention delete result is invalid');
			}
			return deleted;
		},

		async getDistinctActiveUsersCount(options: { startDate: string; endDate: string; endExclusive?: boolean }): Promise<number> {
			const comparator = options.endExclusive ? '<' : '<=';
			const q = `SELECT
				COUNT(DISTINCT CASE WHEN user_email IS NOT NULL AND user_email != '' THEN user_email END)::bigint as active_users
			 FROM api_key_request_logs WHERE created_at >= $1 AND created_at ${comparator} $2`;
			const rows = (await pg.unsafe(q, [options.startDate, options.endDate])) as { active_users?: string | number }[];
			return Number(rows[0]?.active_users ?? 0);
		},
	};
}

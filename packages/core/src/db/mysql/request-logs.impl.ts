/**
 * MySQL：`api_key_request_logs` 读查询。
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { sqlMoneyRound } from '../../lib/money-precision';
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
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { RequestLogsRepository } from '../../storage/gateway-repository-interfaces';
import { asMySqlPool, fromMySqlDateTime, toMySqlDateTime } from './mysql2-compat';
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

type MySqlGenerationRequestLogRow = Omit<GenerationRequestLogRow, 'created_at'> & {
	created_at: string | Date;
};

export function createMySqlRequestLogsRepository(db: MySqlDatabaseClient): RequestLogsRepository {
	const pool = asMySqlPool(db.raw);
	return {
		async queryManagementAnalytics(query) {
			const normalizedQuery = {
				...query,
				startDate: toMySqlDateTime(query.startDate),
				endDate: toMySqlDateTime(query.endDate),
			};
			const built = buildManagementAnalyticsQuery('mysql', normalizedQuery);
			const connection = await pool.getConnection();
			try {
				await connection.query("SET time_zone = '+00:00'");
				const [rows] = await connection.query<
					(RowDataPacket & Record<string, unknown>)[]
				>(built.sql, built.values);
				return mapManagementAnalyticsResult(rows, query);
			} finally {
				connection.release();
			}
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
			const [result] = await pool.execute<ResultSetHeader>(
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
				   AND ${accountPredicate}`,
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
			return result.affectedRows === 1;
		},

		async getRequestLogByIdForOwner(options): Promise<GenerationRequestLogRow | null> {
			const [rows] = await pool.query<MySqlGenerationRequestLogRow[]>(
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
				 LIMIT 1`,
				[options.id, options.userId, options.workspaceId]
			);
			const row = rows[0];
			if (!row) return null;
			row.created_at = fromMySqlDateTime(row.created_at);
			return row as GenerationRequestLogRow;
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
				const [countRows] = await pool.query<(RowDataPacket & { total: string | number })[]>(
					`SELECT COUNT(*) AS total FROM api_key_request_logs
					 WHERE api_key_id = ? AND status IN (${placeholders})`,
					[apiKeyId, ...include]
				);
				const [rows] = await pool.query<RequestLogRow[]>(
					`SELECT * FROM api_key_request_logs
					 WHERE api_key_id = ? AND status IN (${placeholders})
					 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
					[apiKeyId, ...include, pageSize, offset]
				);
				return {
					logs: rows,
					total: Number(countRows[0]?.total ?? 0),
				};
			}

			const excludeStatus = filter?.excludeStatus;
			if (excludeStatus) {
				const [countRows] = await pool.query<(RowDataPacket & { total: string | number })[]>(
					`SELECT COUNT(*) AS total FROM api_key_request_logs
					 WHERE api_key_id = ? AND (status IS NULL OR status <> ?)`,
					[apiKeyId, excludeStatus]
				);
				const [rows] = await pool.query<RequestLogRow[]>(
					`SELECT * FROM api_key_request_logs
					 WHERE api_key_id = ? AND (status IS NULL OR status <> ?)
					 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
					[apiKeyId, excludeStatus, pageSize, offset]
				);
				return {
					logs: rows,
					total: Number(countRows[0]?.total ?? 0),
				};
			}

			const [countRows] = await pool.query<(RowDataPacket & { total: string | number })[]>(
				'SELECT COUNT(*) AS total FROM api_key_request_logs WHERE api_key_id = ?',
				[apiKeyId]
			);
			const [rows] = await pool.query<RequestLogRow[]>(
				'SELECT * FROM api_key_request_logs WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
				[apiKeyId, pageSize, offset]
			);
			return {
				logs: rows,
				total: Number(countRows[0]?.total ?? 0),
			};
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
			const [countRows] = await pool.query<(RowDataPacket & { total: string | number })[]>(
				`SELECT COUNT(*) AS total FROM api_key_request_logs rl ${whereClause}`,
				bindValues
			);
			const [rows] = await pool.query<RequestLogRow[]>(
				`SELECT rl.*, u.external_system AS external_system
				 FROM api_key_request_logs rl
				 LEFT JOIN users u ON u.id = rl.user_id
				 ${whereClause}
				 ORDER BY rl.created_at DESC LIMIT ? OFFSET ?`,
				[...bindValues, pageSize, offset]
			);
			return {
				logs: rows,
				total: Number(countRows[0]?.total ?? 0),
			};
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
			const values: unknown[] = [options.startDate, options.endDate];
			if (options.userId) {
				conditions.push('user_id = ?');
				values.push(options.userId);
			}
			if (options.workspaceId) {
				conditions.push('workspace_id = ?');
				values.push(options.workspaceId);
			}
			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				values.push(options.apiKeyId);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				values.push(options.modelId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				values.push(options.providerName);
			}
			if (options.status) {
				conditions.push('status = ?');
				values.push(options.status);
			}
			const [rows] = await pool.query<(RowDataPacket & Record<string, unknown>)[]>(
				`SELECT
					${REQUEST_STATS_SELECT_SQL},
					COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) AS charged_cost,
					COALESCE(${sqlMoneyRound('SUM(metered_cost)')}, 0) AS metered_cost,
					COALESCE(${sqlMoneyRound('SUM(standard_cost)')}, 0) AS standard_cost
				 FROM api_key_request_logs WHERE ${conditions.join(' AND ')}`,
				values
			);
			return mapRequestStatsByRangeRow(rows[0] as Parameters<typeof mapRequestStatsByRangeRow>[0]);
		},

		async getRequestActivityGroups(options) {
			const comparator = options.endExclusive ? '<' : '<=';
			const conditions = [
				`created_at >= ?`,
				`created_at ${comparator} ?`,
				'user_id = ?',
				'workspace_id = ?',
			];
			const values: unknown[] = [
				options.startDate,
				options.endDate,
				options.userId,
				options.workspaceId,
			];
			if (options.apiKeyId) {
				conditions.push('api_key_id = ?');
				values.push(options.apiKeyId);
			}
			if (options.modelId) {
				conditions.push('model_id = ?');
				values.push(options.modelId);
			}
			if (options.providerName) {
				conditions.push('provider_name = ?');
				values.push(options.providerName);
			}
			if (options.status) {
				conditions.push('status = ?');
				values.push(options.status);
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
			const [rows] = await pool.query<(RowDataPacket & Record<string, unknown>)[]>(
				`SELECT
					${groupColumn} AS group_id,
					${groupName} AS group_name,
					COUNT(*) AS request_count,
					SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
					SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
					COALESCE(SUM(total_tokens), 0) AS total_tokens,
					COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) AS charged_cost
				 FROM api_key_request_logs
				 WHERE ${conditions.join(' AND ')}
				 GROUP BY ${groupColumn}
				 ORDER BY charged_cost DESC, request_count DESC, group_id ASC
				 LIMIT ?`,
				[...values, limit]
			);
			return mapRequestActivityGroupRows(rows as Parameters<typeof mapRequestActivityGroupRows>[0]);
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
					? "DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')"
					: "DATE_FORMAT(created_at, '%Y-%m-%d')";
			const comparator = options.endExclusive ? '<' : '<=';
			const conditions = [`created_at >= ?`, `created_at ${comparator} ?`];
			const values: unknown[] = [options.startDate, options.endDate];
			for (const [column, value] of [
				['user_id', options.userId],
				['workspace_id', options.workspaceId],
				['api_key_id', options.apiKeyId],
				['model_id', options.modelId],
				['provider_name', options.providerName],
				['status', options.status],
			] as const) {
				if (value) {
					conditions.push(`${column} = ?`);
					values.push(value);
				}
			}
			const [rows] = await pool.query<(RowDataPacket & Record<string, unknown>)[]>(
				`SELECT
					${bucketExpr} AS bucket,
					${REQUEST_TIMESERIES_SELECT_SQL},
					COALESCE(${sqlMoneyRound('SUM(charged_cost)')}, 0) AS charged_cost
				 FROM api_key_request_logs
				 WHERE ${conditions.join(' AND ')}
				 GROUP BY bucket
				 ORDER BY bucket ASC`,
				values
			);
			return mapRequestTimeseriesRows(rows as Parameters<typeof mapRequestTimeseriesRows>[0]);
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
					? "DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')"
					: "DATE_FORMAT(created_at, '%Y-%m-%d')";
			const placeholders = options.userEmails.map(() => '?').join(', ');
			const [rows] = await pool.query<(RowDataPacket & Record<string, unknown>)[]>(
				`SELECT
					${bucketExpr} AS bucket,
					user_email,
					COALESCE(SUM(total_tokens), 0) AS total_tokens
				 FROM api_key_request_logs
				 WHERE created_at >= ? AND created_at <= ?
				   AND user_email IN (${placeholders})
				 GROUP BY bucket, user_email
				 ORDER BY bucket ASC`,
				[options.startDate, options.endDate, ...options.userEmails]
			);
			return mapUserTokenTimeseriesRows(rows as Parameters<typeof mapUserTokenTimeseriesRows>[0]);
		},

		async getThroughputLastMinute() {
			const end = new Date();
			const start = new Date(end.getTime() - 60 * 1000);
			const startDate = start.toISOString().slice(0, 19).replace('T', ' ');
			const endDate = end.toISOString().slice(0, 19).replace('T', ' ');
			const [rows] = await pool.query<(RowDataPacket & Record<string, unknown>)[]>(
				`SELECT
					COUNT(*) AS request_count,
					COALESCE(SUM(total_tokens), 0) AS total_tokens
				 FROM api_key_request_logs
				 WHERE created_at >= ? AND created_at <= ?`,
				[startDate, endDate]
			);
			return mapThroughputSnapshot(rows[0] as Parameters<typeof mapThroughputSnapshot>[0]);
		},

		async getRecentLogs(limit: number): Promise<RequestLogRow[]> {
			const [rows] = await pool.query<RequestLogRow[]>('SELECT * FROM api_key_request_logs ORDER BY created_at DESC LIMIT ?', [limit]);
			return rows;
		},

		async getRecentErrors(limit: number): Promise<RequestLogRow[]> {
			const [rows] = await pool.query<RequestLogRow[]>(
				`SELECT * FROM api_key_request_logs WHERE status = 'error' ORDER BY created_at DESC LIMIT ?`,
				[limit]
			);
			return rows;
		},

		async getRecentRoutePerformanceSamples(options): Promise<RoutePerformanceSample[]> {
			if (options.routeTargetIds.length === 0) return [];
			const maxSamplesPerRoute = normalizeRoutePerformanceSamplesPerTarget(options.maxSamplesPerRoute);
			if (maxSamplesPerRoute === 0) return [];
			const sql = buildRecentRoutePerformanceSamplesSql('mysql', options.routeTargetIds.length);
			const [rows] = await pool.query<(RowDataPacket & RoutePerformanceSample)[]>(
				sql,
				[...options.routeTargetIds, toMySqlDateTime(options.sinceIso), maxSamplesPerRoute]
			);
			return rows;
		},

		async getRouteAvailabilityAggregates(options) {
			if (options.routeTargetIds.length === 0) return [];
			const sql = buildRouteAvailabilityAggregateSql('mysql', options.routeTargetIds.length);
			const params = routeAvailabilityAggregateParams({
				...options,
				since5mIso: toMySqlDateTime(options.since5mIso),
				since30mIso: toMySqlDateTime(options.since30mIso),
				since1dIso: toMySqlDateTime(options.since1dIso),
			});
			const [rows] = await pool.query<RowDataPacket[]>(sql, params);
			return rows.map((row) => normalizeRouteAvailabilityAggregate(row));
		},

		async deleteProviderAttemptAvailabilityBefore(options) {
			assertProviderAttemptRetentionDeleteParams(options);
			const cutoff = toMySqlDateTime(options.cutoffIso);
			const [result] = await pool.execute<ResultSetHeader>(
				buildProviderAttemptRetentionDeleteSql('mysql'),
				[cutoff, cutoff, options.limit],
			);
			const deleted = Number(result.affectedRows ?? 0);
			if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > options.limit) {
				throw new TypeError('Provider attempt retention delete result is invalid');
			}
			return deleted;
		},

		async getDistinctActiveUsersCount(options: { startDate: string; endDate: string; endExclusive?: boolean }): Promise<number> {
			const comparator = options.endExclusive ? '<' : '<=';
			const [rows] = await pool.query<(RowDataPacket & { active_users?: string | number })[]>(
				`SELECT
					COUNT(DISTINCT CASE WHEN user_email IS NOT NULL AND user_email != '' THEN user_email END) AS active_users
				 FROM api_key_request_logs WHERE created_at >= ? AND created_at ${comparator} ?`,
				[options.startDate, options.endDate]
			);
			return Number(rows[0]?.active_users ?? 0);
		},
	};
}

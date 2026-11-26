/**
 * 管理路由：`/admin/request-logs` — 全站 `api_key_request_logs` 多维筛选分页（运维排障）。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { getRequestLogSummaryService, listAdminGlobalRequestLogsService } from '@/lib/services/admin/dashboard-service';
import { getAdminRequestLogDetailService } from '@/lib/services/admin/request-log-detail-service';
import { badRequest } from '@/lib/services/admin/errors';
import { handleAdminRouteError } from './error-response';
import { normalizeApiTimeFields } from '@octafuse/core/lib/time-format';
export const adminRequestLogsRoutes = new Hono<AdminEnv>();

adminRequestLogsRoutes.use('*', async (c, next) => {
	await next();
	c.header('Cache-Control', 'private, no-store');
});
adminRequestLogsRoutes.use('*', requireAdminPrincipal);

/**
 * 精确汇总：按维度聚合区间内的请求条数、Token 与各项金额（门户对账、成本监控等核对场景，不必分页拉明细）。
 * 查询参数：start / end（必填，带时区的 ISO 8601，半开区间 [start, end)）、group_by（逗号分隔：provider 默认 | model | user | provider_key | route_group | status，可任意组合）、
 * 筛选 provider_ids（逗号分隔，最多 10 个）、model_id、model_id_prefix、route_group、status；没有任何筛选条件时区间不得超过 31 天。
 * include_labels=1 附带名称快照；limit（≤5000）/ offset 显式分页，响应 has_more。
 */
adminRequestLogsRoutes.get('/summary', async (c) => {
	try {
		const repos = c.get('repositories');
		const result = await getRequestLogSummaryService(repos, {
			group_by: c.req.query('group_by') ?? undefined,
			provider_ids: c.req.query('provider_ids') ?? undefined,
			model_id: c.req.query('model_id') ?? undefined,
			model_id_prefix: c.req.query('model_id_prefix') ?? undefined,
			route_group: c.req.query('route_group') ?? undefined,
			status: c.req.query('status') ?? undefined,
			start: c.req.query('start') ?? undefined,
			end: c.req.query('end') ?? undefined,
			include_labels: c.req.query('include_labels') ?? undefined,
			limit: c.req.query('limit') ?? undefined,
			offset: c.req.query('offset') ?? undefined,
		});
		return c.json({
			success: true,
			data: result.groups,
			group_by: result.group_by,
			start: result.start,
			end: result.end,
			has_more: result.has_more,
		});
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to summarize request logs');
	}
});

/** 查询参数与 `listAdminGlobalRequestLogsService` 一致：page、page_size、id、api_key_id、user_email、ingress_host、model_id、model_ids、model_vendors、provider_id、provider_ids、provider_kinds、kinds、model_id_prefix、route_group、protocol、status、start_date、end_date。 */
adminRequestLogsRoutes.get('/', async (c) => {
	try {
		const repos = c.get('repositories');
		if ((c.req.queries('ingress_host')?.length ?? 0) > 1) {
			throw badRequest('ingress_host accepts one value');
		}
		if ((c.req.queries('model_id_prefix')?.length ?? 0) > 1) {
			throw badRequest('model_id_prefix accepts one value');
		}
		if ((c.req.queries('provider_ids')?.length ?? 0) > 1) {
			throw badRequest('provider_ids accepts one comma-separated value');
		}
		const result = await listAdminGlobalRequestLogsService(repos, {
			page: c.req.query('page') ?? undefined,
			page_size: c.req.query('page_size') ?? undefined,
			id: c.req.query('id') ?? undefined,
			api_key_id: c.req.query('api_key_id') ?? undefined,
			user_id: c.req.query('user_id') ?? undefined,
			user_email: c.req.query('user_email') ?? undefined,
			ingress_host: c.req.query('ingress_host') ?? undefined,
			model_id: c.req.query('model_id') ?? undefined,
			provider_id: c.req.query('provider_id') ?? undefined,
			provider_ids: c.req.query('provider_ids') ?? undefined,
			provider_kinds: c.req.query('provider_kinds') ?? undefined,
			model_ids: c.req.query('model_ids') ?? undefined,
			model_vendors: c.req.query('model_vendors') ?? undefined,
			kinds: c.req.query('kinds') ?? undefined,
			model_id_prefix: c.req.query('model_id_prefix') ?? undefined,
			route_group: c.req.query('route_group') ?? undefined,
			protocol: c.req.query('protocol') ?? undefined,
			status: c.req.query('status') ?? undefined,
			start_date: c.req.query('start_date') ?? undefined,
			end_date: c.req.query('end_date') ?? undefined,
		});
		return c.json(
			normalizeApiTimeFields({
				success: true,
				data: result.logs,
				total: result.total,
				page: result.page,
				page_size: result.page_size,
				...(result.applied_filters === undefined ? {} : { applied_filters: result.applied_filters }),
			}),
		);
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to get request logs');
	}
});

/** Exact ID lookup is independent of the ordinary list's filters and pagination. */
adminRequestLogsRoutes.get('/:id', async (c) => {
	try {
		return c.json({
			success: true,
			data: await getAdminRequestLogDetailService(
				c.get('repositories'),
				c.get('principal'),
				c.req.param('id'),
				c.req.url,
			),
		});
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to read request log');
	}
});

/**
 * 管理路由：`/admin/earnings` — 共享密钥收益补偿。
 *
 * 收益结算与请求日志不在同一事务（见 core/services/shared-key-earnings），
 * 持久失败会少记卖家收益。结算以 `request_log_id` 幂等，因此对历史日志
 * 重跑同一结算即为安全的补偿路径：已结算的行自动跳过。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { settleSharedKeyEarning } from '@octafuse/core';
import { handleAdminRouteError } from './error-response';

export const adminEarningsRoutes = new Hono<AdminEnv>();

adminEarningsRoutes.use('*', requireAdminPrincipal);

/**
 * 重derive共享密钥收益：扫描时间窗内由 `sharedkey:` 服务的请求日志并重跑
 * 幂等结算。默认 dry-run 仅统计候选；`apply=1` 执行结算。
 *
 * 查询：since=<ISO>（默认 24h 前）、limit（默认 200，上限 1000）、apply=1
 */
adminEarningsRoutes.post('/rederive', async (c) => {
	try {
		const repos = c.get('repositories');
		const sinceRaw = c.req.query('since');
		const since = sinceRaw ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? '200') || 200));
		const apply = c.req.query('apply') === '1';

		const { logs, total } = await repos.requestLogs.getRequestLogs({
			page: 1,
			pageSize: limit,
			startDate: since,
		});
		const candidates = logs.filter((row) => (row.provider_key_id ?? '').startsWith('sharedkey:'));

		if (!apply) {
			return c.json({
				success: true,
				dryRun: true,
				data: {
					windowSince: since,
					scanned: logs.length,
					windowTotal: total,
					candidates: candidates.length,
				},
			});
		}

		const counts: Record<string, number> = {};
		for (const row of candidates) {
			const status = await settleSharedKeyEarning(repos, {
				requestLogId: row.id,
				providerKeyId: row.provider_key_id,
				usage: {
					input_tokens: row.input_tokens ?? 0,
					output_tokens: row.output_tokens ?? 0,
					cache_read_tokens: row.cache_read_tokens ?? 0,
					cache_write_tokens: row.cache_write_tokens ?? 0,
				},
			});
			counts[status] = (counts[status] ?? 0) + 1;
		}
		return c.json({
			success: true,
			dryRun: false,
			data: { windowSince: since, scanned: logs.length, windowTotal: total, candidates: candidates.length, results: counts },
		});
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to rederive shared-key earnings');
	}
});

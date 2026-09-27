/**
 * 管理路由：`/admin/earnings` — 共享密钥收益补偿。
 *
 * 收益结算与请求日志不在同一事务（见 core/services/shared-key-earnings）。
 * 旧日志只有 shared key ID 和 token 用量，没有当时的卖家报价、佣金与 owner
 * 快照。对未结算日志按当前配置补算会改变历史金额或将收益付给错误的卖家。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from './error-response';

export const adminEarningsRoutes = new Hono<AdminEnv>();

adminEarningsRoutes.use('*', requireAdminPrincipal);

/**
 * 扫描时间窗内由 `sharedkey:` 服务的旧请求日志。仅用于发现待审核候选；
 * 缺失原始经济证据时 `apply=1` 拒绝入账。后续 C04 消费者应读取不可变报价
 * 与经济事件，而不是重新读取当前 shared_keys / system_config。
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
		// The legacy query reads only page 1. Even an empty page of candidates
		// cannot establish that later pages contain no shared-key earnings.
		const scanComplete = Number.isSafeInteger(total) && total === logs.length;

		if (!apply || (scanComplete && candidates.length === 0)) {
			return c.json({
				success: true,
				dryRun: !apply,
				data: {
					windowSince: since,
					scanned: logs.length,
					windowTotal: total,
					scanComplete,
					candidates: candidates.length,
					reviewRequired: candidates.length,
				},
			});
		}

		return c.json({
			success: false,
			dryRun: false,
			error: scanComplete
				? 'Historical shared-key earnings require original price, commission, and owner evidence'
				: 'Historical shared-key earnings scan is incomplete; later pages require review',
			code: scanComplete ? 'historical_earning_evidence_required' : 'historical_earning_scan_incomplete',
			data: {
				windowSince: since,
				scanned: logs.length,
				windowTotal: total,
				scanComplete,
				candidates: candidates.length,
				reviewRequired: candidates.length,
				requestLogIds: candidates.map((row) => row.id),
			},
		}, 409);
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to rederive shared-key earnings');
	}
});

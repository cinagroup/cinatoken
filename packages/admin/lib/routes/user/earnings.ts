/**
 * 用户路由：`/user/earnings` — 卖家收益流水与账本汇总。
 */
import { Hono } from 'hono';
import type { UserEnv } from '@/lib/user-env';

export const userEarningsRoutes = new Hono<UserEnv>();

userEarningsRoutes.get('/summary', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	return c.json({ success: true, data: earnings });
});

userEarningsRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
	const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? '20') || 20));
	const result = await repositories.portalLedger.listEarningsBySeller(
		principal.userId,
		page,
		pageSize,
	);
	return c.json({ success: true, data: result.rows, total: result.total, page, pageSize });
});

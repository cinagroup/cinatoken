/**
 * 管理路由：`/admin/nft-mints` — CinaBadge 铸造记录与手动处理触发。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from './error-response';

export const adminNftMintsRoutes = new Hono<AdminEnv>();

adminNftMintsRoutes.use('*', requireAdminPrincipal);

adminNftMintsRoutes.get('/', async (c) => {
	try {
		const repos = c.get('repositories');
		const status = c.req.query('status') || undefined;
		const rows = await repos.portalLedger.listAllNftMints(status);
		return c.json({ success: true, data: rows, total: rows.length });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to list nft mints');
	}
});

adminNftMintsRoutes.post('/process', async (c) => {
	try {
		const repos = c.get('repositories');
		if (!c.env.CHAIN_JOBS) {
			return c.json({ success: false, message: 'cinachain env not configured' }, 503);
		}
		const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? '5') || 5));
		const pending = (await repos.portalLedger.listAllNftMints('pending')).slice(0, limit);
		await c.env.CHAIN_JOBS.sendBatch(
			pending.map((row) => ({ body: { kind: 'nft_mint' as const, id: row.id } })),
		);
		return c.json({ success: true, data: { queued: pending.length } });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to process nft mints');
	}
});

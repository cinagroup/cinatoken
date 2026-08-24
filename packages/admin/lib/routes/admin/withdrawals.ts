/**
 * 管理路由：`/admin/withdrawals` — 提现监控、手动处理触发、驳回。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from './error-response';

export const adminWithdrawalsRoutes = new Hono<AdminEnv>();

adminWithdrawalsRoutes.use('*', requireAdminPrincipal);

adminWithdrawalsRoutes.get('/', async (c) => {
	try {
		const repos = c.get('repositories');
		const status = c.req.query('status') || undefined;
		const rows = await repos.portalLedger.listAllWithdrawals(status);
		return c.json({ success: true, data: rows, total: rows.length });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to list withdrawals');
	}
});

/** 手动/兜底触发待处理提现（含已 submitted 等回执）。 */
adminWithdrawalsRoutes.post('/process', async (c) => {
	try {
		const repos = c.get('repositories');
		if (!c.env.CHAIN_JOBS) {
			return c.json({ success: false, message: 'cinachain env not configured' }, 503);
		}
		const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? '5') || 5));
		const pending = (await repos.portalLedger.listAllWithdrawals())
			.filter((row) => row.status === 'requested' || row.status === 'submitted')
			.slice(0, limit);
		await c.env.CHAIN_JOBS.sendBatch(
			pending.map((row) => ({ body: { kind: 'withdrawal' as const, id: row.id } })),
		);
		return c.json({ success: true, data: { queued: pending.length } });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to process withdrawals');
	}
});

/** 驳回：仅 requested/processing 状态（已上链不可驳回），金额退回余额。 */
adminWithdrawalsRoutes.post('/:id/reject', async (c) => {
	const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
	const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : 'rejected by admin';
	try {
		const repos = c.get('repositories');
		const withdrawal = await repos.portalLedger.getWithdrawal(c.req.param('id'));
		if (!withdrawal) return c.json({ success: false, message: 'Not found' }, 404);
		if (withdrawal.status !== 'requested' && withdrawal.status !== 'processing') {
			return c.json({ success: false, message: `Cannot reject withdrawal in status ${withdrawal.status}` }, 409);
		}
		await repos.portalLedger.refundWithdrawal(
			withdrawal.id,
			withdrawal.userId,
			withdrawal.amount,
			reason,
			new Date().toISOString()
		);
		return c.json({ success: true, message: 'Withdrawal rejected and refunded' });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to reject withdrawal');
	}
});

/**
 * 用户路由：`/user/withdrawals` — 链上 CINA-C 自动提现。
 * 请求 → 锁定余额 → 后台处理（mintTo + 回执确认/失败回滚）。
 */
import { Hono } from 'hono';
import { roundGatewayMoney } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { loadPortalMarketplaceConfig } from '@/lib/portal-config';
import { processPendingWithdrawals } from '@/lib/services/withdrawal-processor';
import { isCinachainConfigured } from '@/lib/cinachain';

export const userWithdrawalsRoutes = new Hono<UserEnv>();

userWithdrawalsRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
	const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? '20') || 20));
	const result = await repositories.portalLedger.listWithdrawalsByUser(
		principal.userId,
		page,
		pageSize,
	);
	return c.json({ success: true, data: result.rows, total: result.total, page, pageSize });
});

userWithdrawalsRoutes.post('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as { amount?: unknown } | null;
	const amount = Number(body?.amount);
	if (!Number.isFinite(amount) || amount <= 0) {
		return c.json({ success: false, message: '无效的提现金额' }, 400);
	}

	const config = await loadPortalMarketplaceConfig(repositories);
	if (amount < config.withdrawalMinAmount) {
		return c.json({ success: false, message: `最低提现金额为 ${config.withdrawalMinAmount}` }, 400);
	}
	if (!isCinachainConfigured()) {
		return c.json({ success: false, message: '提现通道未配置（请联系管理员）' }, 503);
	}

	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	if (!earnings || !earnings.walletAddress) {
		return c.json({ success: false, message: '请先绑定收款钱包地址' }, 400);
	}
	const active = await repositories.portalLedger.getActiveWithdrawalByUser(principal.userId);
	if (active) {
		return c.json({ success: false, message: '已有进行中的提现单，请等待完成后再次发起' }, 409);
	}
	// 单日次数限制（含终态）
	const history = await repositories.portalLedger.listWithdrawalsByUser(principal.userId, 1, 100);
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const todayCount = history.rows.filter(
		(row) => new Date(row.createdAt).getTime() >= dayStart.getTime()
	).length;
	if (todayCount >= config.withdrawalDailyLimit) {
		return c.json({ success: false, message: `每日最多提现 ${config.withdrawalDailyLimit} 次` }, 429);
	}

	const fee = roundGatewayMoney(config.withdrawalFee);
	if (amount - fee < 0.000001) {
		return c.json({ success: false, message: '金额不足以覆盖手续费' }, 400);
	}
	const netAmount = roundGatewayMoney(amount - fee);
	const tokenAmount = roundGatewayMoney(netAmount * config.withdrawalTokenRate);
	const nowIso = new Date().toISOString();

	const locked = await repositories.portalLedger.lockBalanceForWithdrawal(
		principal.userId,
		amount,
		nowIso
	);
	if (!locked) {
		return c.json({ success: false, message: '余额不足' }, 400);
	}

	const id = crypto.randomUUID();
	await repositories.portalLedger.insertWithdrawal({
		id,
		userId: principal.userId,
		amount,
		fee,
		netAmount,
		currency: 'USD',
		walletAddress: earnings.walletAddress,
		tokenAmount,
		nowIso,
	});

	// fire-and-forget：Node 直接跑；Workers 由 waitUntil 兜底（catch-all 层传入）
	void processPendingWithdrawals(repositories).catch((error) => {
		console.error(
			JSON.stringify({
				level: 'error',
				message: 'portal.withdrawal_background_failed',
				withdrawalId: id,
				error: error instanceof Error ? error.message : 'unknown',
			})
		);
	});

	const created = await repositories.portalLedger.getWithdrawal(id);
	return c.json({ success: true, data: created });
});

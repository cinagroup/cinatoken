/**
 * 用户路由：`/user/wallet` — cinachain 收款钱包绑定。
 * V1 仅做 EVM 地址格式校验；签名验证（SIWE）列为后续增强。
 */
import { Hono } from 'hono';
import type { UserEnv } from '@/lib/user-env';

export const userWalletRoutes = new Hono<UserEnv>();

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

function maskWallet(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

userWalletRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	return c.json({
		success: true,
		data: {
			walletAddress: earnings?.walletAddress ?? null,
			walletMasked: earnings?.walletAddress ? maskWallet(earnings.walletAddress) : null,
			verifiedAt: earnings?.walletVerifiedAt ?? null,
		},
	});
});

userWalletRoutes.post('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as { walletAddress?: unknown } | null;
	const walletAddress = typeof body?.walletAddress === 'string' ? body.walletAddress.trim() : '';
	if (walletAddress && !EVM_ADDRESS.test(walletAddress)) {
		return c.json({ success: false, message: '无效的 EVM 钱包地址' }, 400);
	}
	const nowIso = new Date().toISOString();
	await repositories.portalLedger.updateWallet(
		principal.userId,
		walletAddress || null,
		walletAddress ? nowIso : null,
	);
	return c.json({ success: true, data: { walletAddress: walletAddress || null } });
});

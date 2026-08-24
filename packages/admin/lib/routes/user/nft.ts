/**
 * 用户路由：`/user/nft` — 按贡献值位阶铸造 cinachain CinaBadge。
 */
import { Hono } from 'hono';
import type { UserEnv } from '@/lib/user-env';
import { loadPortalMarketplaceConfig } from '@/lib/portal-config';
import { computeTierEligibility } from '@/lib/services/nft-mint-service';

export const userNftRoutes = new Hono<UserEnv>();

userNftRoutes.get('/tiers', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const config = await loadPortalMarketplaceConfig(repositories);
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	const contributionValue = earnings?.contributionValue ?? 0;
	const tiers = await computeTierEligibility(repositories, principal.userId, config.nftTiers, contributionValue);
	const mints = await repositories.portalLedger.getNftMintsByUser(principal.userId);
	return c.json({
		success: true,
		data: {
			contributionValue,
			highestBadgeTier: earnings?.highestBadgeTier ?? 0,
			tiers,
			mints,
			chainConfigured: Boolean(c.env.CHAIN_JOBS),
		},
	});
});

userNftRoutes.post('/mint', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as { badgeTokenId?: unknown } | null;
	const badgeTokenId = Number(body?.badgeTokenId);
	if (!Number.isInteger(badgeTokenId)) {
		return c.json({ success: false, message: '无效的位阶' }, 400);
	}
	if (!c.env.CHAIN_JOBS) {
		return c.json({ success: false, message: '铸造通道未配置（请联系管理员）' }, 503);
	}

	const config = await loadPortalMarketplaceConfig(repositories);
	const tier = config.nftTiers.find((item) => item.badgeTokenId === badgeTokenId);
	if (!tier) {
		return c.json({ success: false, message: '位阶不存在' }, 404);
	}

	const earnings = await repositories.portalLedger.getUserEarnings(principal.userId);
	if (!earnings || !earnings.walletAddress) {
		return c.json({ success: false, message: '请先绑定收款钱包地址' }, 400);
	}
	if ((earnings.contributionValue ?? 0) < tier.threshold) {
		return c.json(
			{ success: false, message: `贡献值未达 ${tier.tierName} 位阶（需 ${tier.threshold}）` },
			403
		);
	}

	const id = crypto.randomUUID();
	const inserted = await repositories.portalLedger.insertNftMint({
		id,
		userId: principal.userId,
		badgeTokenId,
		tierName: tier.tierName,
		walletAddress: earnings.walletAddress,
		valueSnapshot: earnings.contributionValue,
		nowIso: new Date().toISOString(),
	});
	if (!inserted) {
		return c.json({ success: false, message: '该位阶已铸造过' }, 409);
	}

	await c.env.CHAIN_JOBS.send({ kind: 'nft_mint', id });

	const mints = await repositories.portalLedger.getNftMintsByUser(principal.userId);
	const created = mints.find((mint) => mint.id === id) ?? null;
	return c.json({ success: true, data: created });
});

userNftRoutes.get('/mints', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const mints = await repositories.portalLedger.getNftMintsByUser(principal.userId);
	return c.json({ success: true, data: mints });
});

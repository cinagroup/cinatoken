/**
 * NFT 铸造服务：按贡献值位阶铸造 cinachain CinaBadge（ERC-1155 灵魂绑定位阶徽章）。
 * tokenId 从 200 起（cinatoken 专属），避开 billing 已占用的 100-104。
 *
 * 状态机由独立 Chain Worker 驱动：pending → processing → submitted → confirmed / failed。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { NFT_TIER_DEFAULTS } from '@/lib/portal-config';

export type NftTierEligibility = {
	badgeTokenId: number;
	tierName: string;
	threshold: number;
	eligible: boolean;
	minted: boolean;
	progress: number;
};

export async function computeTierEligibility(
	repositories: GatewayRepositories,
	userId: string,
	tiers: typeof NFT_TIER_DEFAULTS,
	contributionValue: number
): Promise<NftTierEligibility[]> {
	const mints = await repositories.portalLedger.getNftMintsByUser(userId);
	return tiers.map((tier) => ({
		badgeTokenId: tier.badgeTokenId,
		tierName: tier.tierName,
		threshold: tier.threshold,
		eligible: contributionValue >= tier.threshold,
		minted: mints.some((mint) => mint.badgeTokenId === tier.badgeTokenId && mint.status !== 'failed'),
		progress: Math.min(1, tier.threshold > 0 ? contributionValue / tier.threshold : 1),
	}));
}

/** 铸造确认后回写最高位阶。 */
export async function syncHighestBadgeTier(
	repositories: GatewayRepositories,
	userId: string,
	tiers: typeof NFT_TIER_DEFAULTS
): Promise<number> {
	const mints = await repositories.portalLedger.getNftMintsByUser(userId);
	let highest = 0;
	for (const mint of mints) {
		if (mint.status !== 'confirmed') continue;
		const tierIndex = tiers.findIndex((tier) => tier.badgeTokenId === mint.badgeTokenId);
		if (tierIndex >= 0) highest = Math.max(highest, tierIndex + 1);
	}
	await repositories.portalLedger.setHighestBadgeTier(userId, highest, new Date().toISOString());
	return highest;
}

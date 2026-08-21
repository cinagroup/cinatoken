/**
 * NFT 铸造服务：按贡献值位阶铸造 cinachain CinaBadge（ERC-1155 灵魂绑定位阶徽章）。
 * tokenId 从 200 起（cinatoken 专属），避开 billing 已占用的 100-104。
 *
 * 状态机：pending → submitted(tx) → confirmed / failed。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { mintCinaBadge, waitForCinachainReceipt, isCinachainConfigured } from '@/lib/cinachain';
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

export async function processPendingNftMints(
	repositories: GatewayRepositories,
	limit = 5
): Promise<{ processed: number; confirmed: number; failed: number }> {
	let processed = 0;
	let confirmed = 0;
	let failed = 0;
	if (!isCinachainConfigured()) return { processed, confirmed, failed };

	const pending = (await repositories.portalLedger.listAllNftMints('pending')).slice(0, limit);
	for (const mint of pending) {
		try {
			const txHash = await mintCinaBadge(mint.walletAddress as `0x${string}`, mint.badgeTokenId);
			await repositories.portalLedger.updateNftMintStatus(mint.id, {
				status: 'submitted',
				txHash,
				chainId: Number(process.env.CINACHAIN_CHAIN_ID ?? 84532),
			});
			const receipt = await waitForCinachainReceipt(txHash);
			if (receipt.status === 'success') {
				await repositories.portalLedger.updateNftMintStatus(mint.id, {
					status: 'confirmed',
					confirmedAt: new Date().toISOString(),
				});
				confirmed += 1;
			} else {
				await repositories.portalLedger.updateNftMintStatus(mint.id, {
					status: 'failed',
					failureReason: `chain tx reverted: ${txHash}`,
				});
				failed += 1;
			}
			processed += 1;
		} catch (error) {
			await repositories.portalLedger.updateNftMintStatus(mint.id, {
				status: 'failed',
				failureReason: error instanceof Error ? error.message : 'on-chain mint failed',
			});
			failed += 1;
			processed += 1;
		}
	}
	return { processed, confirmed, failed };
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

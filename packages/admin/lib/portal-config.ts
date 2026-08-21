/**
 * 共享密钥市场运行参数：默认值 + `system_config` 覆盖。
 * 全部为运营开关，改动不需要重新部署。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { getSystemConfigValue } from '@octafuse/core';

export type PortalMarketplaceConfig = {
	/** 允许共享的渠道（逗号分隔；空 = 代码白名单全部）。 */
	enabledChannels: string[];
	/** 平台佣金比例（0-1，对卖家应得金额计提）。 */
	commissionRate: number;
	/** 卖家要价绝对上限（每 1M token），防刷与误填。 */
	maxInputPrice: number;
	maxOutputPrice: number;
	/** 提现最小金额。 */
	withdrawalMinAmount: number;
	/** 提现手续费（固定金额）。 */
	withdrawalFee: number;
	/** CINA-C 兑换比率（1 账户金额 = rate CINA-C）。 */
	withdrawalTokenRate: number;
	/** 单日提现次数上限。 */
	withdrawalDailyLimit: number;
	/** NFT 位阶：贡献值阈值 → CinaBadge tokenId（从 200 起，避开 billing 的 100-104）。 */
	nftTiers: Array<{ badgeTokenId: number; tierName: string; threshold: number }>;
};

export const NFT_TIER_DEFAULTS: PortalMarketplaceConfig['nftTiers'] = [
	{ badgeTokenId: 200, tierName: 'Bronze', threshold: 10 },
	{ badgeTokenId: 201, tierName: 'Silver', threshold: 50 },
	{ badgeTokenId: 202, tierName: 'Gold', threshold: 200 },
	{ badgeTokenId: 203, tierName: 'Platinum', threshold: 1000 },
];

const parseNumber = (raw: string | null, fallback: number): number => {
	if (raw === null) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const parseNftTiers = (raw: string | null): PortalMarketplaceConfig['nftTiers'] => {
	if (!raw) return NFT_TIER_DEFAULTS;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return NFT_TIER_DEFAULTS;
		const tiers = parsed
			.map((item) => {
				const candidate = item as { badgeTokenId?: unknown; tierName?: unknown; threshold?: unknown };
				if (
					typeof candidate.badgeTokenId === 'number' &&
					typeof candidate.tierName === 'string' &&
					typeof candidate.threshold === 'number'
				) {
					return { badgeTokenId: candidate.badgeTokenId, tierName: candidate.tierName, threshold: candidate.threshold };
				}
				return null;
			})
			.filter((item): item is { badgeTokenId: number; tierName: string; threshold: number } => item !== null);
		return tiers.length > 0 ? tiers : NFT_TIER_DEFAULTS;
	} catch {
		return NFT_TIER_DEFAULTS;
	}
};

export async function loadPortalMarketplaceConfig(
	repositories: GatewayRepositories
): Promise<PortalMarketplaceConfig> {
	const [
		channelsRaw,
		commissionRaw,
		maxInputRaw,
		maxOutputRaw,
		withdrawalMinRaw,
		withdrawalFeeRaw,
		withdrawalRateRaw,
		withdrawalDailyRaw,
		nftTiersRaw,
	] = await Promise.all([
		getSystemConfigValue(repositories, 'SHARED_KEY_ENABLED_CHANNELS'),
		getSystemConfigValue(repositories, 'SHARED_KEY_COMMISSION_RATE'),
		getSystemConfigValue(repositories, 'SHARED_KEY_MAX_INPUT_PRICE'),
		getSystemConfigValue(repositories, 'SHARED_KEY_MAX_OUTPUT_PRICE'),
		getSystemConfigValue(repositories, 'WITHDRAWAL_MIN_AMOUNT'),
		getSystemConfigValue(repositories, 'WITHDRAWAL_FEE'),
		getSystemConfigValue(repositories, 'WITHDRAWAL_CINACREDIT_RATE'),
		getSystemConfigValue(repositories, 'WITHDRAWAL_DAILY_LIMIT'),
		getSystemConfigValue(repositories, 'NFT_TIER_THRESHOLDS'),
	]);

	return {
		enabledChannels: (channelsRaw ?? '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean),
		commissionRate: Math.min(0.9, parseNumber(commissionRaw, 0.1)),
		maxInputPrice: parseNumber(maxInputRaw, 200),
		maxOutputPrice: parseNumber(maxOutputRaw, 1200),
		withdrawalMinAmount: parseNumber(withdrawalMinRaw, 10),
		withdrawalFee: parseNumber(withdrawalFeeRaw, 0),
		withdrawalTokenRate: parseNumber(withdrawalRateRaw, 1.0),
		withdrawalDailyLimit: Math.max(1, Math.floor(parseNumber(withdrawalDailyRaw, 3))),
		nftTiers: parseNftTiers(nftTiersRaw),
	};
}

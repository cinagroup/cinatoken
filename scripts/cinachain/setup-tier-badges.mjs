/**
 * 一次性：在 cinachain CinaBadge 上创建 cinatoken 专属贡献位阶（tokenId 200-203）。
 *
 * 前置：CinaBadge owner 私钥（与 CINACHAIN_MINTER_PRIVATE_KEY 同一 EOA）。
 * 用法：
 *   CINACHAIN_MINTER_PRIVATE_KEY=0x... CINABADGE_CONTRACT_ADDRESS=0x72cc... \
 *     node scripts/cinachain/setup-tier-badges.mjs
 *
 * 幂等性：CinaBadge.createBadgeType 对已存在的自定义 id 会 revert；已创建的位阶报错可忽略。
 */
import { createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const CINA_BADGE_ABI = parseAbi([
	'function createBadgeType(string name, string description, bool soulbound, uint256 maxSupply) external',
]);

const TIERS = [
	{ badgeTokenId: 200, name: 'CinaToken Contributor Bronze', description: 'cinatoken shared-key contribution: Bronze', threshold: 10 },
	{ badgeTokenId: 201, name: 'CinaToken Contributor Silver', description: 'cinatoken shared-key contribution: Silver', threshold: 50 },
	{ badgeTokenId: 202, name: 'CinaToken Contributor Gold', description: 'cinatoken shared-key contribution: Gold', threshold: 200 },
	{ badgeTokenId: 203, name: 'CinaToken Contributor Platinum', description: 'cinatoken shared-key contribution: Platinum', threshold: 1000 },
];

const rpcUrl = process.env.CINACHAIN_RPC_URL ?? 'https://sepolia.base.org';
const privateKey = process.env.CINACHAIN_MINTER_PRIVATE_KEY;
const badgeAddress = process.env.CINABADGE_CONTRACT_ADDRESS ?? '0x72cc9adb6c877d233e9843ee2d00424b9766d0cf';

if (!privateKey) {
	console.error('missing CINACHAIN_MINTER_PRIVATE_KEY');
	process.exit(1);
}

// tokenId 由合约端 createBadgeType 递增分配（自定义 id 从 100 起）；本脚本按 200-203 预期执行 4 次，
// 若合约已创建过其他自定义位阶，请以合约事件/浏览器实际 id 为准并同步 NFT_TIER_THRESHOLDS。
const account = privateKeyToAccount(privateKey);
const client = createWalletClient({
	account,
	chain: baseSepolia,
	transport: http(rpcUrl),
});

for (const tier of TIERS) {
	try {
		const hash = await client.writeContract({
			address: badgeAddress,
			abi: CINA_BADGE_ABI,
			functionName: 'createBadgeType',
			args: [tier.name, `${tier.description} (threshold ${tier.threshold})`, true, 0n],
		});
		console.log(`created tier ${tier.name} tx=${hash}`);
	} catch (error) {
		console.error(`tier ${tier.name} failed: ${error instanceof Error ? error.message : error}`);
	}
}

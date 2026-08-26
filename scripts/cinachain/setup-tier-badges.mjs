/**
 * @deprecated 已废弃 — 贡献位阶 105-108 由 cinachain 仓库的
 * scripts/setup-contributor-badges.mjs（contract-admin workflow）在链上创建。
 * CinaBadge.createBadgeType 的 ID 由合约递增分配（无法指定 200-203）；
 * 本脚本重跑会在新合约上创建 109-112 等错误位阶，故改为防护性退出。
 */
console.error(
	"已废弃：贡献位阶 105-108 已由 cinachain 仓库的 setup-contributor-badges 创建。" +
		"tier→tokenId 映射在 packages/admin/lib/portal-config.ts（或 system_config 的 NFT_TIER_THRESHOLDS）。",
)
process.exit(1)

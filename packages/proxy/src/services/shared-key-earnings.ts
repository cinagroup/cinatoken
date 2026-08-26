/**
 * 共享密钥收益结算已下沉至 `@octafuse/core`（admin 的补偿端点需复用同一
 * 实现，而 admin 不得依赖 proxy）。此处保留 re-export 以维持既有导入路径；
 * 经 core 的子路径导出解析（根入口的 node 条件指向构建产物 dist）。
 */
export {
	settleSharedKeyEarning,
	parseSharedKeyId,
	type SettleEarningStatus,
	type SharedKeyEarningUsage,
} from '@octafuse/core/services/shared-key-earnings';

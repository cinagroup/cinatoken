import type { InsertRequestLogParams } from './request-logs-types';

/** 分散热门模型的日聚合写锁；读取端会再次按模型汇总。 */
export const PUBLIC_MODEL_DAILY_STATS_SHARDS = 16;

export type PublicModelDailyStatsDelta = {
	statDate: string;
	modelId: string;
	shard: number;
	requestCount: 1;
	successCount: 0 | 1;
	errorCount: 0 | 1;
	outputTokens: number;
	latencyTotalMs: number;
	latencySampleCount: 0 | 1;
};

function stableShard(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
	}
	return (hash >>> 0) % PUBLIC_MODEL_DAILY_STATS_SHARDS;
}

/** 将一条已经接受落库的请求日志转成同事务写入的公开日聚合增量。 */
export function toPublicModelDailyStatsDelta(
	requestLog: InsertRequestLogParams,
	createdAtIso: string,
): PublicModelDailyStatsDelta {
	const statDate = /^\d{4}-\d{2}-\d{2}/.exec(createdAtIso)?.[0];
	if (!statDate) throw new Error('createdAtIso must begin with YYYY-MM-DD');
	const outputTokens = Number.isFinite(requestLog.outputTokens) && requestLog.outputTokens > 0
		? Math.trunc(requestLog.outputTokens)
		: 0;
	const latency = requestLog.latencyMs;
	const normalizedLatency = latency != null && Number.isFinite(latency) && latency >= 0
		? Math.trunc(latency)
		: 0;
	return {
		statDate,
		modelId: requestLog.modelId,
		shard: stableShard(requestLog.id),
		requestCount: 1,
		successCount: requestLog.status === 'success' ? 1 : 0,
		errorCount: requestLog.status === 'error' ? 1 : 0,
		outputTokens,
		latencyTotalMs: normalizedLatency,
		latencySampleCount: latency != null && Number.isFinite(latency) && latency >= 0 ? 1 : 0,
	};
}

/**
 * 共享密钥收益结算：请求由用户共享 key 服务后，按卖家单价计提收益。
 *
 * 归属 core（而非 proxy）以便 admin 的补偿端点复用同一实现 —— 依赖方向
 * proxy→core / admin→core，admin 不得依赖 proxy。
 *
 * 触发点：`usage-tracker.recordUsage` 落库后（`sharedkey:` 前缀识别）；
 * 补偿端点：admin `/admin/earnings/rederive` 对历史日志重跑（幂等）。
 * 幂等：`shared_key_earnings.request_log_id` UNIQUE；重复结算直接跳过。
 * 金额：gross = 卖家单价 × token 量；platform_fee = gross × SHARED_KEY_COMMISSION_RATE（默认 0.10）；
 * net 入账 `user_earnings.balance / contribution_value / lifetime_earned`。
 */
import type { GatewayRepositories } from '../storage/repositories-types';
import { roundGatewayMoney } from '../lib/money-precision';

const DEFAULT_COMMISSION_RATE = 0.1;
const TOKENS_PER_MILLION = 1_000_000;
const SETTLE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const SHARED_KEY_ID_PREFIX = 'sharedkey:';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SharedKeyEarningUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
};

export type SettleEarningStatus =
	| 'settled'
	| 'duplicate'
	| 'not-shared-key'
	| 'zero-tokens'
	| 'key-not-found'
	| 'zero-gross'
	| 'failed';

/** 从日志/计费侧的 `provider_key_id` 解析共享密钥 id；非共享尝试返回 null。 */
export function parseSharedKeyId(providerKeyId: string | null | undefined): string | null {
	if (!providerKeyId || !providerKeyId.startsWith(SHARED_KEY_ID_PREFIX)) return null;
	const id = providerKeyId.slice(SHARED_KEY_ID_PREFIX.length);
	return id.length > 0 ? id : null;
}

export async function settleSharedKeyEarning(
	repos: GatewayRepositories,
	params: {
		requestLogId: string;
		providerKeyId: string | null | undefined;
		usage: SharedKeyEarningUsage;
	},
): Promise<SettleEarningStatus> {
	const sharedKeyId = parseSharedKeyId(params.providerKeyId);
	if (!sharedKeyId) return 'not-shared-key';
	const tokens =
		(params.usage.input_tokens ?? 0) +
		(params.usage.output_tokens ?? 0) +
		(params.usage.cache_read_tokens ?? 0) +
		(params.usage.cache_write_tokens ?? 0);
	if (tokens <= 0) return 'zero-tokens';

	let key;
	try {
		key = await repos.sharedKeys.getSharedKeyById(sharedKeyId);
	} catch (error) {
		console.error(
			JSON.stringify({
				level: 'error',
				message: 'cinatoken.shared_key_earning_lost',
				stage: 'lookup',
				requestLogId: params.requestLogId,
				sharedKeyId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return 'failed';
	}
	if (!key) return 'key-not-found';

	const gross =
		((params.usage.input_tokens ?? 0) / TOKENS_PER_MILLION) * key.inputPrice +
		((params.usage.output_tokens ?? 0) / TOKENS_PER_MILLION) * key.outputPrice +
		((params.usage.cache_read_tokens ?? 0) / TOKENS_PER_MILLION) * (key.cacheReadPrice ?? 0) +
		((params.usage.cache_write_tokens ?? 0) / TOKENS_PER_MILLION) * (key.cacheWritePrice ?? 0);
	// 审计 M10：非有限数在此拦截（roundGatewayMoney 会把 NaN/∞ 静默映射为 0）
	if (!Number.isFinite(gross) || gross <= 0) return 'zero-gross';

	let commissionRate = DEFAULT_COMMISSION_RATE;
	try {
		const raw = await repos.systemConfig.getConfig('SHARED_KEY_COMMISSION_RATE');
		const parsed = raw === null ? NaN : Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.9) commissionRate = parsed;
	} catch {
		// 配置读取失败按默认佣金
	}

	// 审计 M10：佣金向上取整到 6dp（平台有利方向），净值 = 总额 − 佣金的精确差值
	// （两个 6dp 数相减无需再取整）—— 恒有 fee + net === gross。
	const grossR = roundGatewayMoney(gross);
	const fee = Math.ceil(grossR * commissionRate * 1_000_000) / 1_000_000;
	const net = grossR - fee;
	const nowIso = new Date().toISOString();

	// The earning write is NOT in the same transaction as the request-log
	// insert, so a persistent failure here would silently under-credit the
	// seller (the buyer is already charged). Retry transient errors, then
	// emit a structured, alertable event — the row stays recoverable by
	// re-running settlement (idempotent on request_log_id).
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
		try {
			await repos.portalLedger.ensureUserEarnings(key.sellerUserId);
			const inserted = await repos.portalLedger.recordEarningAndCredit({
				id: crypto.randomUUID(),
				requestLogId: params.requestLogId,
				sharedKeyId: key.id,
				sellerUserId: key.sellerUserId,
				inputTokens: params.usage.input_tokens ?? 0,
				outputTokens: params.usage.output_tokens ?? 0,
				cacheReadTokens: params.usage.cache_read_tokens ?? 0,
				cacheWriteTokens: params.usage.cache_write_tokens ?? 0,
				grossAmount: grossR,
				platformFee: fee,
				netAmount: net,
				currency: 'USD',
				nowIso,
			});
			if (!inserted) return 'duplicate'; // 幂等：同请求日志已结算
			await repos.sharedKeys.addSharedKeyUsage(
				key.id,
				params.usage.input_tokens ?? 0,
				params.usage.output_tokens ?? 0,
				net,
				nowIso,
			);
			return 'settled';
		} catch (error) {
			lastError = error;
			if (attempt < SETTLE_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * attempt);
		}
	}
	console.error(
		JSON.stringify({
			level: 'error',
			message: 'cinatoken.shared_key_earning_lost',
			requestLogId: params.requestLogId,
			sharedKeyId: key.id,
			sellerUserId: key.sellerUserId,
			grossAmount: grossR,
			platformFee: fee,
			netAmount: net,
			attempts: SETTLE_ATTEMPTS,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		}),
	);
	return 'failed';
}

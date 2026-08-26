/**
 * 共享密钥收益结算：请求由用户共享 key 服务后，按卖家单价计提收益。
 *
 * 触发点：`usage-tracker.recordUsage` 落库后（`sharedkey:` 前缀识别）。
 * 幂等：`shared_key_earnings.request_log_id` UNIQUE；重复结算直接跳过。
 * 金额：gross = 卖家单价 × token 量；platform_fee = gross × SHARED_KEY_COMMISSION_RATE（默认 0.10）；
 * net 入账 `user_earnings.balance / contribution_value / lifetime_earned`。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { roundGatewayMoney } from '@octafuse/core';
import { parseSharedKeyId } from './shared-key-pool';

const DEFAULT_COMMISSION_RATE = 0.1;
const TOKENS_PER_MILLION = 1_000_000;
const SETTLE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SharedKeyEarningUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
};

export async function settleSharedKeyEarning(
	repos: GatewayRepositories,
	params: {
		requestLogId: string;
		providerKeyId: string | null | undefined;
		usage: SharedKeyEarningUsage;
	}
): Promise<void> {
	const sharedKeyId = parseSharedKeyId(params.providerKeyId);
	if (!sharedKeyId) return;
	const tokens =
		(params.usage.input_tokens ?? 0) +
		(params.usage.output_tokens ?? 0) +
		(params.usage.cache_read_tokens ?? 0) +
		(params.usage.cache_write_tokens ?? 0);
	if (tokens <= 0) return;

	let key;
	try {
		key = await repos.sharedKeys.getSharedKeyById(sharedKeyId);
	} catch (error) {
		console.warn(
			`[Gateway SharedKeys] earning lookup failed keyId=${sharedKeyId} error=${error instanceof Error ? error.message : String(error)}`
		);
		return;
	}
	if (!key) return;

	const gross =
		((params.usage.input_tokens ?? 0) / TOKENS_PER_MILLION) * key.inputPrice +
		((params.usage.output_tokens ?? 0) / TOKENS_PER_MILLION) * key.outputPrice +
		((params.usage.cache_read_tokens ?? 0) / TOKENS_PER_MILLION) * (key.cacheReadPrice ?? 0) +
		((params.usage.cache_write_tokens ?? 0) / TOKENS_PER_MILLION) * (key.cacheWritePrice ?? 0);
	if (gross <= 0) return;

	let commissionRate = DEFAULT_COMMISSION_RATE;
	try {
		const raw = await repos.systemConfig.getConfig('SHARED_KEY_COMMISSION_RATE');
		const parsed = raw === null ? NaN : Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.9) commissionRate = parsed;
	} catch {
		// 配置读取失败按默认佣金
	}

	const grossR = roundGatewayMoney(gross);
	const fee = roundGatewayMoney(grossR * commissionRate);
	const net = roundGatewayMoney(grossR - fee);
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
			if (!inserted) return; // 幂等：同请求日志已结算
			await repos.sharedKeys.addSharedKeyUsage(key.id, params.usage.input_tokens ?? 0, params.usage.output_tokens ?? 0, net, nowIso);
			return;
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
}

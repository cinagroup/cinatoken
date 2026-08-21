/**
 * 用户共享密钥池（`shared_keys`）调度支持。
 *
 * 排序契约（需求核心）：候选 = 指定渠道全部 `active` key，
 * 按 `seller_priority DESC → weight DESC → id ASC` 固定确定性排序
 * （仓储层 `listActiveSharedKeysByChannel` 已按此排序，与路由 `weight_priority` 策略语义一致）。
 *
 * 失败语义与 provider 熔断隔离：
 * - 401/403：DB 置 `invalid`（永久移出池）+ 复合熔断键 5min；
 * - 429/5xx：仅该 key 复合熔断键短冷却，不影响 provider 自有 key 与其他卖家。
 */
import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import type { RouteResult } from './model-router';

/** `RouteResult.providerKeyId` 前缀，标记该次尝试由用户共享密钥服务。 */
export const SHARED_KEY_ID_PREFIX = 'sharedkey:';

/** 从日志/计费侧的 `provider_key_id` 解析共享密钥 id；非共享尝试返回 null。 */
export function parseSharedKeyId(providerKeyId: string | null | undefined): string | null {
	if (!providerKeyId || !providerKeyId.startsWith(SHARED_KEY_ID_PREFIX)) return null;
	const id = providerKeyId.slice(SHARED_KEY_ID_PREFIX.length);
	return id.length > 0 ? id : null;
}

/**
 * 熔断键：共享 key 尝试用 `providerId#sharedkey:<id>` 复合键，
 * 坏 key 只熔断自己，不波及 provider 自有 key / 其他卖家。
 */
export function circuitKeyForRoute(route: Pick<RouteResult, 'providerId' | 'providerKeyId'>): string {
	const sharedKeyId = parseSharedKeyId(route.providerKeyId);
	return sharedKeyId ? `${route.providerId}#${route.providerKeyId}` : route.providerId;
}

/** 进程级 per-key 冷却（失败后短暂跳过；DB status 变更才是永久移除）。 */
const cooldownByKey = new Map<string, number>();
const COOLDOWN_PURGE_INTERVAL_MS = 60_000;
let lastCooldownPurge = 0;

function purgeCooldowns(now: number): void {
	if (now - lastCooldownPurge < COOLDOWN_PURGE_INTERVAL_MS) return;
	lastCooldownPurge = now;
	for (const [key, until] of cooldownByKey) {
		if (until <= now) cooldownByKey.delete(key);
	}
}

export function getSharedKeyCooldownRemainingMs(sharedKeyId: string, now = Date.now()): number {
	purgeCooldowns(now);
	const until = cooldownByKey.get(sharedKeyId);
	return until ? Math.max(0, until - now) : 0;
}

export function markSharedKeyCooldown(sharedKeyId: string, cooldownMs: number, now = Date.now()): void {
	if (cooldownMs <= 0) return;
	purgeCooldowns(now);
	cooldownByKey.set(sharedKeyId, now + cooldownMs);
}

/** 测试用：清空进程级冷却状态。 */
export function resetSharedKeyPoolStateForTests(): void {
	cooldownByKey.clear();
	lastCooldownPurge = 0;
}

/** 拉取指定渠道的有序候选（固定排序；读取失败不阻塞请求 → 空池）。 */
export async function loadOrderedSharedKeys(
	repos: GatewayRepositories,
	channelType: string
): Promise<SharedKeyRow[]> {
	try {
		return await repos.sharedKeys.listActiveSharedKeysByChannel(channelType);
	} catch (error) {
		console.warn(
			`[Gateway SharedKeys] pool lookup failed channel=${channelType} error=${error instanceof Error ? error.message : String(error)}`
		);
		return [];
	}
}

/** 用共享密钥克隆 route（保留 target/trace 身份，仅替换上游凭据）。 */
export function applySharedKeyToRoute(route: RouteResult, key: SharedKeyRow): RouteResult {
	return {
		...route,
		providerApiKey: key.apiKey,
		providerKeyId: `${SHARED_KEY_ID_PREFIX}${key.id}`,
		providerKeyLabel: key.label ?? `shared:${key.channelType}`,
		providerKeyFingerprint: key.keyFingerprint,
	};
}

/**
 * 把 attempts 中共享渠道 route 展开为「共享 key 依序 + provider 自有 key 兜底」。
 * 展开后的顺序：每条 route 位置不变，其 key 克隆按固定排序内联。
 */
export async function expandAttemptsWithSharedKeys(
	repos: GatewayRepositories,
	attempts: RouteResult[]
): Promise<RouteResult[]> {
	const sharedRoutes = attempts.filter((route) => route.providerSharedChannelType);
	if (sharedRoutes.length === 0) return attempts;

	const poolByChannel = new Map<string, SharedKeyRow[]>();
	const expanded: RouteResult[] = [];
	for (const route of attempts) {
		const channelType = route.providerSharedChannelType;
		if (!channelType) {
			expanded.push(route);
			continue;
		}
		let pool = poolByChannel.get(channelType);
		if (!pool) {
			pool = await loadOrderedSharedKeys(repos, channelType);
			poolByChannel.set(channelType, pool);
		}
		const now = Date.now();
		for (const key of pool) {
			if (getSharedKeyCooldownRemainingMs(key.id, now) > 0) continue;
			expanded.push(applySharedKeyToRoute(route, key));
		}
		// provider 自有 key 兜底（无自有 key 的纯共享 provider 跳过）
		if (route.providerApiKey.trim().length > 0) {
			expanded.push(route);
		}
	}
	if (expanded.length > 0 && expanded.length !== attempts.length) {
		console.log(
			`[Gateway SharedKeys] expanded attempts ${attempts.length} -> ${expanded.length} (shared channels: ${[...poolByChannel.keys()].join(',')})`
		);
	}
	return expanded;
}

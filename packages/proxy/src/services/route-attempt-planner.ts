/**
 * 将协议已过滤的 routes 编排为本次请求的尝试序列：
 * priority 硬序（DESC）→ 层内按 route strategy 排序 → 过滤熔断中的 provider。
 */
import type { RouteStrategyName } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { getProviderCircuitRemainingMs } from './provider-circuit-breaker';
import { ROUTE_STRATEGIES } from './route-strategies';

export type RouteAttemptPlan = {
	attempts: RouteResult[];
	earliestRetryAfterMs: number | null;
	skippedByCircuit: number;
};

function groupRoutesByPriorityDesc(routes: RouteResult[]): Array<{ priority: number; routes: RouteResult[] }> {
	const groups = new Map<number, RouteResult[]>();
	for (const route of routes) {
		const bucket = groups.get(route.routePriority) ?? [];
		bucket.push(route);
		groups.set(route.routePriority, bucket);
	}
	return [...groups.entries()]
		.sort((a, b) => b[0] - a[0])
		.map(([priority, tierRoutes]) => ({ priority, routes: tierRoutes }));
}

/**
 * 构建本次请求的 route 尝试计划。
 * `tierOverrides` 按 priority 覆盖 `strategyName`（未配置的层仍用 base）。
 */
export function buildRouteAttemptPlan(
	routes: RouteResult[],
	ctx: { affinityKey: string; tierKeyPrefix: string },
	strategyName: RouteStrategyName,
	now = Date.now(),
	tierOverrides?: ReadonlyMap<number, RouteStrategyName> | null,
	options?: { filterCircuit?: boolean },
): RouteAttemptPlan {
	const attempts: RouteResult[] = [];
	let earliestRetryAfterMs: number | null = null;
	let skippedByCircuit = 0;

	const trackRetryAfter = (ms: number): void => {
		if (earliestRetryAfterMs == null || ms < earliestRetryAfterMs) {
			earliestRetryAfterMs = ms;
		}
	};

	for (const tier of groupRoutesByPriorityDesc(routes)) {
		const name = tierOverrides?.get(tier.priority) ?? strategyName;
		const strategy = ROUTE_STRATEGIES[name] ?? ROUTE_STRATEGIES.hash_affinity;
		const ordered = strategy(tier.routes, {
			affinityKey: ctx.affinityKey,
			tierKey: `${ctx.tierKeyPrefix}|${tier.priority}`,
		});
		for (const route of ordered) {
			const remaining = options?.filterCircuit === false
				? 0
				: getProviderCircuitRemainingMs(route.providerId, now);
			if (remaining > 0) {
				skippedByCircuit += 1;
				trackRetryAfter(remaining);
				continue;
			}
			attempts.push(route);
		}
	}

	return { attempts, earliestRetryAfterMs, skippedByCircuit };
}

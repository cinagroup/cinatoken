import type { RouteOrderCandidate, RouteOrderContext } from './types';

/** tierKey → 下次起始偏移（进程内存）。 */
const counters = new Map<string, number>();

/**
 * 按 weight 对应的连续区块定位轮转起点；去重后保持首次出现顺序。
 */
export function orderByWeightedRoundRobin<T extends RouteOrderCandidate>(routes: readonly T[], ctx: RouteOrderContext): T[] {
	if (routes.length <= 1) return [...routes];

	// Locate the same slot as the expanded sequence without allocating one
	// element per unit of weight. BigInt also keeps large finite weights exact.
	const weights = routes.map(route => BigInt(Number.isFinite(route.routeWeight)
		? Math.max(1, Math.floor(route.routeWeight)) : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0n);
	const start = counters.get(ctx.tierKey) ?? 0;
	counters.set(ctx.tierKey, start + 1);
	let offset = ((BigInt(start) % total) + total) % total;
	let first = 0;
	while (offset >= weights[first]!) { offset -= weights[first]!; first++; }

	const seen = new Set<string>();
	const ordered: T[] = [];
	for (let index = 0; index < routes.length; index++) {
		const route = routes[(first + index) % routes.length]!;
		if (seen.has(route.providerId)) continue;
		seen.add(route.providerId);
		ordered.push(route);
	}
	return ordered;
}

/** 测试用：清空 weighted round-robin 计数器。 */
export function resetWeightedRoundRobinStateForTests(): void {
	counters.clear();
}

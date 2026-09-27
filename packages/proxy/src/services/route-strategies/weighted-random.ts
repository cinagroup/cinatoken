import type { RouteOrderCandidate, RouteOrderContext } from './types';

/** 按 routeWeight 无放回加权随机打散。 */
export function orderByWeightedRandom<T extends RouteOrderCandidate>(routes: readonly T[], _ctx: RouteOrderContext): T[] {
	if (routes.length <= 1) return [...routes];
	const pool = [...routes];
	const ordered: T[] = [];
	while (pool.length > 0) {
		const totalWeight = pool.reduce((sum, r) => sum + Math.max(1, r.routeWeight), 0);
		let pick = Math.random() * totalWeight;
		let idx = 0;
		for (let i = 0; i < pool.length; i++) {
			pick -= Math.max(1, pool[i]!.routeWeight);
			if (pick <= 0) {
				idx = i;
				break;
			}
		}
		ordered.push(pool[idx]!);
		pool.splice(idx, 1);
	}
	return ordered;
}

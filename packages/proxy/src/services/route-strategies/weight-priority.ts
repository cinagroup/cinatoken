import type { RouteOrderCandidate, RouteOrderContext } from './types';

/** 按 routeWeight DESC，再按 providerId ASC（稳定）。 */
export function orderByWeightPriority<T extends RouteOrderCandidate>(routes: readonly T[], _ctx: RouteOrderContext): T[] {
	return [...routes].sort((a, b) => {
		if (b.routeWeight !== a.routeWeight) return b.routeWeight - a.routeWeight;
		return a.providerId.localeCompare(b.providerId);
	});
}

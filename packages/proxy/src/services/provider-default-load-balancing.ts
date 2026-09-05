import type { RouteResult } from './model-router';
import { isProviderRecentlyDegraded } from './provider-circuit-breaker';

type PricedRoute = {
	route: RouteResult;
	price: number | null;
	recentlyDegraded: boolean;
	originalIndex: number;
};

export type DefaultProviderLoadBalanceResult = {
	applied: boolean;
	routes: RouteResult[];
};

function secureRandomUnit(): number {
	const value = new Uint32Array(1);
	crypto.getRandomValues(value);
	return value[0]! / 0x1_0000_0000;
}

function boundedRandomUnit(randomUnit: () => number): number {
	const value = randomUnit();
	if (!Number.isFinite(value) || value <= 0) return 0;
	if (value >= 1) return 1 - Number.EPSILON;
	return value;
}

function weightedPositivePriceOrder(
	entries: PricedRoute[],
	randomUnit: () => number,
): PricedRoute[] {
	if (entries.length <= 1) return [...entries];
	const pool = [...entries];
	const ordered: PricedRoute[] = [];
	while (pool.length > 0) {
		const minimumPrice = Math.min(...pool.map((entry) => entry.price!));
		const weights = pool.map((entry) => {
			const ratio = minimumPrice / entry.price!;
			return ratio * ratio;
		});
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		let selection = boundedRandomUnit(randomUnit) * totalWeight;
		let selectedIndex = weights.length - 1;
		for (let index = 0; index < weights.length; index += 1) {
			selection -= weights[index]!;
			if (selection < 0) {
				selectedIndex = index;
				break;
			}
		}
		ordered.push(pool[selectedIndex]!);
		pool.splice(selectedIndex, 1);
	}
	return ordered;
}

function uniformOrder(entries: PricedRoute[], randomUnit: () => number): PricedRoute[] {
	const pool = [...entries];
	const ordered: PricedRoute[] = [];
	while (pool.length > 0) {
		const index = Math.min(
			pool.length - 1,
			Math.floor(boundedRandomUnit(randomUnit) * pool.length),
		);
		ordered.push(pool[index]!);
		pool.splice(index, 1);
	}
	return ordered;
}

function orderHealthTier(entries: PricedRoute[], randomUnit: () => number): PricedRoute[] {
	const free = entries.filter((entry) => entry.price === 0);
	const positive = entries.filter((entry) => entry.price != null && entry.price > 0);
	const unpriced = entries.filter((entry) => entry.price == null);
	return [
		...uniformOrder(free, randomUnit),
		...weightedPositivePriceOrder(positive, randomUnit),
		...unpriced.sort((left, right) => left.originalIndex - right.originalIndex),
	];
}

/**
 * Build OpenRouter's default provider attempt order when no explicit sort or
 * provider order disables load balancing. At least one comparable price is
 * required; otherwise the configured route policy remains authoritative.
 */
export function applyDefaultProviderLoadBalancing(params: {
	routes: RouteResult[];
	priceScore: (route: RouteResult) => number | null;
	now?: number;
	randomUnit?: () => number;
}): DefaultProviderLoadBalanceResult {
	if (params.routes.length <= 1) return { applied: false, routes: params.routes };
	const now = params.now ?? Date.now();
	const randomUnit = params.randomUnit ?? secureRandomUnit;
	const priced = params.routes.map((route, originalIndex): PricedRoute => {
		const candidate = params.priceScore(route);
		return {
			route,
			price: candidate != null && Number.isFinite(candidate) && candidate >= 0
				? candidate
				: null,
			recentlyDegraded: isProviderRecentlyDegraded(route.providerId, now),
			originalIndex,
		};
	});
	// Inverse-square weighting has no finite definition when every proven
	// endpoint is free. Preserve the configured route strategy for that edge
	// case; a mixed free/paid pool still routes through the free tier first.
	if (!priced.some((entry) => entry.price != null && entry.price > 0)) {
		return { applied: false, routes: params.routes };
	}

	const healthy = priced.filter((entry) => !entry.recentlyDegraded);
	const degraded = priced.filter((entry) => entry.recentlyDegraded);
	const ordered = [
		...orderHealthTier(healthy, randomUnit),
		...orderHealthTier(degraded, randomUnit),
	];
	return {
		applied: true,
		routes: ordered.map((entry, index) => ({
			...entry.route,
			// A unique priority preserves this exact request-local sequence through
			// every configured route strategy and shared-key expansion.
			routePriority: ordered.length - index,
			gatewayDefaultLoadBalanceRank: index + 1,
			gatewayProviderRecentlyDegraded: entry.recentlyDegraded,
		})),
	};
}

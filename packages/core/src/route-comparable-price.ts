import type { TextEndpointPricing } from './model-endpoint-catalog';
import {
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
} from './db/pricing-schedule';

export type ComparableRoutePrice = {
	prompt: number | null;
	completion: number | null;
	request: number | null;
	image: number | null;
};

export type ComparableRouteMaxPrice = Partial<Record<keyof ComparableRoutePrice, number>>;

/**
 * Resolve the exact charged-side prices used by provider.max_price and the
 * default price load balancer. Prompt/completion are USD per million tokens;
 * request/image retain their endpoint-native per-unit USD contract.
 */
export function resolveComparableRoutePrice(params: {
	pricing: TextEndpointPricing | null | undefined;
	priceOverrideRaw: string | null | undefined;
	pricingAt: Date;
	businessTimezone: string;
}): ComparableRoutePrice {
	const pricing = params.pricing;
	if (!pricing) return { prompt: null, completion: null, request: null, image: null };
	const discountFactor = 1 - (pricing.discount ?? 0);
	const unitPrice = (value: string | undefined, multiplier = 1): number | null => {
		if (value === undefined) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0
			? parsed * multiplier * discountFactor
			: null;
	};
	const base = parseRouteBaseFactors(params.priceOverrideRaw).chargedFactor;
	const schedule = parseRoutePricingSchedule(params.priceOverrideRaw);
	const scheduleFactor = resolveDailyScheduleFactor(
		schedule.charged,
		params.pricingAt,
		params.businessTimezone,
	);
	const factor = resolveEffectiveRouteFactor(base, scheduleFactor, schedule.mode);
	const applyFactor = (value: number | null): number | null => value == null ? null : value * factor;
	return {
		prompt: applyFactor(unitPrice(pricing.prompt, 1_000_000)),
		completion: applyFactor(unitPrice(pricing.completion, 1_000_000)),
		request: applyFactor(unitPrice(pricing.request)),
		image: applyFactor(unitPrice(pricing.image)),
	};
}

export function routeSatisfiesComparableMaxPrice(
	price: ComparableRoutePrice,
	maxPrice: ComparableRouteMaxPrice | null | undefined,
): boolean {
	if (!maxPrice) return true;
	for (const field of ['prompt', 'completion', 'request', 'image'] as const) {
		const maximum = maxPrice[field];
		if (maximum === undefined) continue;
		const actual = price[field];
		if (actual == null || actual > maximum) return false;
	}
	return true;
}

export function comparableRoutePriceSortScore(price: ComparableRoutePrice): number {
	return (price.prompt ?? Number.POSITIVE_INFINITY)
		+ (price.completion ?? Number.POSITIVE_INFINITY);
}

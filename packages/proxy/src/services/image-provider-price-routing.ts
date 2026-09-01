import type { RouteResult } from './model-router';
import {
	multimediaEstimateHasProvablePricing,
	type MultimediaChargedCostEstimate,
} from './multimedia-ordinary-budget';

export type ImageProviderPriceCandidate<T extends MultimediaChargedCostEstimate> = {
	route: RouteResult;
	/** Charged route price for the complete, normalized image request. */
	requestEstimate: T & {
		chargedOutputUnitPrice?: number | null;
		chargedRequestPrice?: number | null;
	};
};

export type ImageProviderPriceRoutingResult<C> =
	| { ok: true; candidates: C[] }
	| { ok: false; message: string };

const SUPPORTED_IMAGE_MAX_PRICE_KEYS = new Set(['image', 'request']);

/**
 * Apply Image provider price controls only after request-specific pricing facts
 * have been resolved from the same verified Endpoint snapshot used for billing.
 * Unknown or unsupported price dimensions fail closed before dispatch.
 */
export function applyImageProviderPriceRouting<
	T extends MultimediaChargedCostEstimate,
	C extends ImageProviderPriceCandidate<T>,
>(candidates: readonly C[]): ImageProviderPriceRoutingResult<C> {
	if (candidates.length === 0) {
		return { ok: false, message: 'No configured image route is available' };
	}
	const trace = candidates.find((candidate) => candidate.route.providerRoutingTrace != null)
		?.route.providerRoutingTrace;
	const maxPrice = trace?.max_price ?? null;
	const hasMaxPrice = maxPrice != null && Object.keys(maxPrice).length > 0;
	const sortByPrice = trace?.sort === 'price';
	if (!hasMaxPrice && !sortByPrice) {
		return { ok: true, candidates: [...candidates] };
	}

	const unsupported = Object.keys(maxPrice ?? {}).filter(
		(key) => !SUPPORTED_IMAGE_MAX_PRICE_KEYS.has(key),
	);
	if (unsupported.length > 0) {
		return {
			ok: false,
			message: `Images provider.max_price supports only image and request; unsupported key: ${unsupported.join(', ')}`,
		};
	}

	const eligible = candidates
		.map((candidate, index) => ({ candidate, index }))
		.filter(({ candidate }) => {
			const requestProvable = multimediaEstimateHasProvablePricing(candidate.requestEstimate);
			if (sortByPrice && !requestProvable) return false;
			if (maxPrice?.request !== undefined && (
				!requestProvable
				|| candidate.requestEstimate.chargedRequestPrice == null
				|| candidate.requestEstimate.chargedRequestPrice > maxPrice.request
			)) return false;
			if (maxPrice?.image !== undefined && (
				!requestProvable
				|| candidate.requestEstimate.chargedOutputUnitPrice == null
				|| candidate.requestEstimate.chargedOutputUnitPrice > maxPrice.image
			)) return false;
			return true;
		});

	if (eligible.length === 0) {
		return {
			ok: false,
			message: hasMaxPrice
				? 'No configured image route satisfies provider.max_price'
				: 'No configured image route has a provable price for provider.sort=price',
		};
	}
	if (sortByPrice) {
		eligible.sort((left, right) =>
			Number(right.candidate.route.gatewayPerformancePreferred === true)
				- Number(left.candidate.route.gatewayPerformancePreferred === true)
			|| left.candidate.requestEstimate.chargedCost
				- right.candidate.requestEstimate.chargedCost
			|| left.index - right.index
		);
	}

	const eligibleTargetIds = eligible.map(({ candidate }) => candidate.route.targetId);
	return {
		ok: true,
		candidates: eligible.map(({ candidate }, index, all) => {
			const existingTrace = candidate.route.providerRoutingTrace;
			const partition = existingTrace?.partition ?? 'model';
			return {
				...candidate,
				route: {
					...candidate.route,
					...(sortByPrice ? { routePriority: all.length - index } : {}),
					...(partition === 'none' ? { gatewayGlobalEndpointRank: index + 1 } : {}),
					...(existingTrace ? {
						providerRoutingTrace: {
							...existingTrace,
							eligible_target_ids: eligibleTargetIds,
							global_endpoint_rank: partition === 'none' ? index + 1 : null,
						},
					} : {}),
				},
			} as C;
		}),
	};
}

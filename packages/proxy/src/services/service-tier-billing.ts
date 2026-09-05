import type { RouteResult } from './model-router';
import type { UsageFromStream } from './proxy';

export type ServiceTierBillingResolution = {
	pricingRoute: RouteResult;
	exact: boolean;
};

/**
 * Bind settlement to the tier actually reported upstream without rewriting the
 * network-attempt identity. A cross-tier pricing route is accepted only when
 * the already validated request plan contains the corresponding endpoint for
 * the same public model, Provider, protocol, operation, and upstream model.
 */
export function resolveServiceTierBillingRoute(
	chosenRoute: RouteResult,
	eligibleRoutes: readonly RouteResult[],
	actualTier: UsageFromStream['service_tier'],
): ServiceTierBillingResolution {
	const expectedTier = chosenRoute.gatewayServiceTier ?? null;
	if (expectedTier === null) {
		// An ordinary route is a standard-tier attempt. Missing/default reports are
		// consistent with that contract; a surprise non-default report must not be
		// silently billed from the standard endpoint snapshot.
		return {
			pricingRoute: chosenRoute,
			exact: actualTier == null || actualTier === 'default',
		};
	}
	if (actualTier == null) return { pricingRoute: chosenRoute, exact: false };
	if (actualTier === expectedTier) return { pricingRoute: chosenRoute, exact: true };

	const pricingRoute = eligibleRoutes.find((route) =>
		route.gatewayServiceTier === actualTier
		&& route.gatewayModelId === chosenRoute.gatewayModelId
		&& route.providerId === chosenRoute.providerId
		&& route.providerModelName === chosenRoute.providerModelName
		&& route.upstreamProtocol === chosenRoute.upstreamProtocol
		&& route.upstreamOperation === chosenRoute.upstreamOperation
	);
	return pricingRoute
		? { pricingRoute, exact: true }
		: { pricingRoute: chosenRoute, exact: false };
}

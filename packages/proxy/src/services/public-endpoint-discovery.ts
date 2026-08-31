/**
 * Public-safe endpoint discovery derived only from current verified endpoint
 * snapshots whose route/provider subject still matches at read time.
 *
 * Legacy route `routing_metadata` is checked before bindings reach this module;
 * it is never used as a source of public endpoint facts.
 */
import type { VerifiedPublicEndpointBinding } from "./public-model-endpoints";

export type PublicModelsRegion = "eu" | "us";

export type PublicEndpointDiscoverySummary = {
	has_matching_route: boolean;
	endpoint_slugs: string[];
	regions: string[];
	route_groups: string[];
};

export type PublicModelsRegionParseResult =
	| { ok: true; value: PublicModelsRegion | null }
	| { ok: false; message: string };

/** Validate the intentionally bounded `/v1/models` provider-location filter. */
export function parsePublicModelsRegion(
	raw: string | undefined
): PublicModelsRegionParseResult {
	if (raw === undefined) return { ok: true, value: null };
	const normalized = raw.trim().toLowerCase();
	if (normalized === "eu" || normalized === "us")
		return { ok: true, value: normalized };
	return { ok: false, message: "region must be one of: eu, us" };
}

export function endpointRouteGroup(routeGroup: string | undefined): string {
	const value = routeGroup?.trim();
	return value || "default";
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Group already-validated endpoint bindings without issuing additional reads. */
export function groupVerifiedEndpointBindingsByModel(
	bindings: readonly VerifiedPublicEndpointBinding[]
): Map<string, VerifiedPublicEndpointBinding[]> {
	const result = new Map<string, VerifiedPublicEndpointBinding[]>();
	for (const binding of bindings) {
		const list = result.get(binding.snapshot.modelId) ?? [];
		list.push(binding);
		result.set(binding.snapshot.modelId, list);
	}
	return result;
}

/**
 * Summarize verified endpoint facts for one model after route-group and region
 * discovery filters. Region is an exact verified snapshot label match only.
 */
export function summarizePublicEndpointDiscovery(
	bindings: readonly VerifiedPublicEndpointBinding[],
	options?: {
		routeGroups?: readonly string[] | null;
		region?: PublicModelsRegion | null;
	}
): PublicEndpointDiscoverySummary {
	const allowedGroups =
		options?.routeGroups == null
			? null
			: new Set(options.routeGroups.map((group) => group.toLowerCase()));
	const endpointSlugs: string[] = [];
	const regions: string[] = [];
	const routeGroups: string[] = [];
	let hasMatchingRoute = false;

	for (const binding of bindings) {
		if (options?.region && binding.snapshot.region !== options.region) continue;
		for (const route of binding.routes) {
			const group = endpointRouteGroup(route.route_group);
			if (allowedGroups && !allowedGroups.has(group.toLowerCase())) continue;
			hasMatchingRoute = true;
			routeGroups.push(group);
			endpointSlugs.push(binding.snapshot.selectorSlug);
			if (binding.snapshot.region) regions.push(binding.snapshot.region);
		}
	}

	return {
		has_matching_route: hasMatchingRoute,
		endpoint_slugs: sortedUnique(endpointSlugs),
		regions: sortedUnique(regions),
		route_groups: sortedUnique(routeGroups),
	};
}

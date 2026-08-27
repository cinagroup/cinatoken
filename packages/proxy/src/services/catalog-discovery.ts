/**
 * Public model catalog discovery: active routes → supported protocols per route group.
 * Used by `GET /catalog/models` (no API key; sanitized, no provider secrets).
 */
import {
	normalizeUpstreamProtocol,
	parseModelModalitiesJson,
	parsePricingProfile,
	UPSTREAM_PROTOCOLS,
	type GatewayRepositories,
	type ModelRouteJoinRow,
	type ParsedPricingProfile,
	type UpstreamProtocol,
} from '@octafuse/core';
import { toPublicModelSlug } from '@octafuse/core/lib/public-model-slug';
import {
	filterRouteGroupsByAllowlist,
	parseTags,
} from '../lib/model-list-parse';

export type CatalogDiscoveryModel = {
	id: string;
	slug: string;
	display_name: string | null;
	vendor: string;
	context_window: number | null;
	max_tokens: number | null;
	pricing_profile: ParsedPricingProfile | null;
	tags: string[];
	route_groups: string[];
	protocols: UpstreamProtocol[];
	protocols_by_group: Record<string, UpstreamProtocol[]>;
	recommended_protocol: UpstreamProtocol;
	description: string | null;
	input_modalities: string[] | null;
	output_modalities: string[] | null;
	released_at: string | null;
};

export type CatalogProviderSummary = {
	id: string;
	display_name: string;
	model_count: number;
	protocols: UpstreamProtocol[];
	route_groups: string[];
	input_modalities: string[];
	output_modalities: string[];
	latest_released_at: string | null;
};

function normalizeRowRouteGroup(routeGroup: string | undefined): string {
	if (typeof routeGroup === 'string' && routeGroup.trim() !== '') {
		return routeGroup.trim();
	}
	return 'default';
}

function sortProtocols(protocols: Iterable<UpstreamProtocol>): UpstreamProtocol[] {
	const set = new Set(protocols);
	return UPSTREAM_PROTOCOLS.filter((p) => set.has(p));
}

export function resolveRecommendedProtocol(protocols: UpstreamProtocol[]): UpstreamProtocol {
	if (protocols.includes('anthropic') && protocols.length > 1) return 'anthropic';
	if (protocols.includes('gemini') && protocols.length > 1) return 'gemini';
	return protocols[0] ?? 'openai';
}

function buildProtocolsByGroup(routes: ModelRouteJoinRow[]): Record<string, UpstreamProtocol[]> {
	const byGroup = new Map<string, Set<UpstreamProtocol>>();
	for (const row of routes) {
		if (row.status !== 'active') continue;
		const group = normalizeRowRouteGroup(row.route_group);
		let protocols = byGroup.get(group);
		if (!protocols) {
			protocols = new Set();
			byGroup.set(group, protocols);
		}
		try {
			protocols.add(normalizeUpstreamProtocol(row.upstream_protocol));
		} catch {
			continue;
		}
	}
	const out: Record<string, UpstreamProtocol[]> = {};
	for (const [group, protocols] of byGroup) {
		out[group] = sortProtocols(protocols);
	}
	return out;
}

function groupActiveRoutesByModel(routes: ModelRouteJoinRow[]): Map<string, ModelRouteJoinRow[]> {
	const map = new Map<string, ModelRouteJoinRow[]>();
	for (const row of routes) {
		if (row.status !== 'active') continue;
		const list = map.get(row.model_id);
		if (list) {
			list.push(row);
		} else {
			map.set(row.model_id, [row]);
		}
	}
	return map;
}

function sortStrings(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Public provider cards derived only from already-sanitized active model discovery. */
export function aggregateCatalogProviders(models: CatalogDiscoveryModel[]): CatalogProviderSummary[] {
	type MutableProvider = {
		id: string;
		displayName: string;
		modelCount: number;
		protocols: Set<UpstreamProtocol>;
		routeGroups: Set<string>;
		inputModalities: Set<string>;
		outputModalities: Set<string>;
		latestReleasedAt: string | null;
	};
	const grouped = new Map<string, MutableProvider>();
	for (const model of models) {
		const displayName = model.vendor.trim() || 'other';
		const id = displayName.toLocaleLowerCase();
		let provider = grouped.get(id);
		if (!provider) {
			provider = {
				id,
				displayName,
				modelCount: 0,
				protocols: new Set(),
				routeGroups: new Set(),
				inputModalities: new Set(),
				outputModalities: new Set(),
				latestReleasedAt: null,
			};
			grouped.set(id, provider);
		}
		provider.modelCount += 1;
		for (const protocol of model.protocols) provider.protocols.add(protocol);
		for (const group of model.route_groups) provider.routeGroups.add(group);
		for (const modality of model.input_modalities ?? []) provider.inputModalities.add(modality);
		for (const modality of model.output_modalities ?? []) provider.outputModalities.add(modality);
		if (model.released_at && (!provider.latestReleasedAt || model.released_at > provider.latestReleasedAt)) {
			provider.latestReleasedAt = model.released_at;
		}
	}

	return [...grouped.values()]
		.map((provider) => ({
			id: provider.id,
			display_name: provider.displayName,
			model_count: provider.modelCount,
			protocols: sortProtocols(provider.protocols),
			route_groups: sortStrings(provider.routeGroups),
			input_modalities: sortStrings(provider.inputModalities),
			output_modalities: sortStrings(provider.outputModalities),
			latest_released_at: provider.latestReleasedAt,
		}))
		.sort((a, b) => b.model_count - a.model_count || a.display_name.localeCompare(b.display_name));
}

export async function listCatalogDiscoveryModels(
	repos: GatewayRepositories,
	options?: { routeGroups?: string[] | null }
): Promise<CatalogDiscoveryModel[]> {
	const models = await repos.modelRouting.listModelsWithActiveRoutes();
	const allRoutes = await repos.routes.listModelRoutesWithJoins({});
	const routesByModel = groupActiveRoutesByModel(allRoutes);
	const allowedGroups = options?.routeGroups ?? null;

	const list: CatalogDiscoveryModel[] = [];
	for (const m of models) {
		const routes = routesByModel.get(m.id) ?? [];
		const fullProtocolsByGroup = buildProtocolsByGroup(routes);
		let routeGroups = Object.keys(fullProtocolsByGroup).sort((a, b) => a.localeCompare(b));

		if (allowedGroups != null) {
			routeGroups = filterRouteGroupsByAllowlist(routeGroups, allowedGroups);
			if (routeGroups.length === 0) {
				continue;
			}
		}

		const protocolsByGroup: Record<string, UpstreamProtocol[]> = {};
		const protocolUnion = new Set<UpstreamProtocol>();
		for (const group of routeGroups) {
			const protocols = fullProtocolsByGroup[group] ?? [];
			protocolsByGroup[group] = protocols;
			for (const p of protocols) {
				protocolUnion.add(p);
			}
		}

		const protocols = sortProtocols(protocolUnion);
		if (protocols.length === 0) {
			continue;
		}

		list.push({
			id: m.id,
			slug: toPublicModelSlug(m.id),
			display_name: m.display_name,
			vendor: m.vendor?.trim() ? m.vendor : 'other',
			context_window: m.context_window,
			max_tokens: m.max_tokens,
			pricing_profile: parsePricingProfile(m.pricing_profile ?? undefined),
			tags: parseTags(m.tags),
			route_groups: routeGroups,
			protocols,
			protocols_by_group: protocolsByGroup,
			recommended_protocol: resolveRecommendedProtocol(protocols),
			description: m.description,
			input_modalities: parseModelModalitiesJson(m.input_modalities),
			output_modalities: parseModelModalitiesJson(m.output_modalities),
			released_at: m.released_at ?? null,
		});
	}

	return list;
}

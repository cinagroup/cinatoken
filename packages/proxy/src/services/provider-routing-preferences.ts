import type { RouteQuantization } from '@octafuse/core';
import { ROUTE_QUANTIZATIONS } from '@octafuse/core';
import type { RouteResult } from './model-router';

export type ProviderSortBy = 'price' | 'throughput' | 'latency';
export type ProviderPercentile = 'p50' | 'p75' | 'p90' | 'p99';
export type ProviderPerformancePreference = number | Partial<Record<ProviderPercentile, number>>;
export type ProviderMaxPrice = { prompt?: number; completion?: number; request?: number; image?: number };
export type ProviderServiceTier = 'default' | 'flex' | 'priority';
export type ServiceTierModelVariant = 'nitro' | 'floor';
export type ServiceTierRoutingMode = ProviderServiceTier | ServiceTierModelVariant | null;
export type ProviderTextSpeed = 'fast' | 'standard';

export type ProviderPreferences = {
	order: string[];
	only: string[] | null;
	ignore: string[];
	allowFallbacks: boolean;
	requireZdr: boolean;
	requireParameters: boolean;
	dataCollection: 'allow' | 'deny';
	enforceDistillableText: boolean;
	quantizations: RouteQuantization[] | null;
	/** Caller-configured sort before a service tier or model variant applies its routing policy. */
	configuredSort: { by: ProviderSortBy; partition: 'model' | 'none' } | null;
	sort: { by: ProviderSortBy; partition: 'model' | 'none' } | null;
	preferredMinThroughput: ProviderPerformancePreference | null;
	preferredMaxLatency: ProviderPerformancePreference | null;
	maxPrice: ProviderMaxPrice | null;
	/** Canonical top-level request value; `fast` is normalized to `priority`. */
	serviceTier: ProviderServiceTier | null;
	/** Explicit top-level tier before `speed="fast"` derives priority routing. */
	explicitServiceTier: ProviderServiceTier | null;
	/** Anthropic/OpenRouter text generation speed control. */
	requestedSpeed: ProviderTextSpeed | null;
	/** Distinguishes an explicit `speed:null` from an omitted field. */
	speedControlled: boolean;
	/** Request-local model variant. Never serialized upstream. */
	modelVariant: ServiceTierModelVariant | null;
};

export type ProviderRoutingResult =
	| {
		ok: true;
		body: Record<string, unknown>;
		routes: RouteResult[];
		hasPreferences: boolean;
		preferences: ProviderPreferences | null;
		routingMode: ServiceTierRoutingMode;
	}
	| { ok: false; message: string };

export type PreparedProviderRouting = {
	body: Record<string, unknown>;
	hasPreferences: boolean;
	requireZdr: boolean;
	preferences: ProviderPreferences | null;
	serviceTier: ProviderServiceTier | null;
	requestedSpeed: ProviderTextSpeed | null;
	apply(routes: RouteResult[], modelVariant?: ServiceTierModelVariant | null): ProviderRoutingResult;
};

export type PrepareProviderRoutingOptions = {
	/** Interpret top-level `speed` as the OpenRouter text-generation control. */
	allowTextSpeed?: boolean;
};

const SUPPORTED_KEYS = new Set([
	'order', 'only', 'ignore', 'allow_fallbacks', 'zdr', 'require_parameters',
	'data_collection', 'enforce_distillable_text', 'quantizations', 'sort',
	'preferred_min_throughput', 'preferred_max_latency', 'max_price',
]);
const SUPPORTED_KEYS_TEXT = [...SUPPORTED_KEYS].join(', ');
const MAX_PROVIDER_SELECTORS = 32;
const MAX_PROVIDER_SELECTOR_LENGTH = 120;
const QUANTIZATIONS = new Set<string>(ROUTE_QUANTIZATIONS);
const SORT_FIELDS = new Set<ProviderSortBy>(['price', 'throughput', 'latency']);
const PERCENTILES = new Set<ProviderPercentile>(['p50', 'p75', 'p90', 'p99']);
const MAX_PRICE_KEYS = new Set(['prompt', 'completion', 'request', 'image']);
const STRUCTURAL_REQUEST_KEYS = new Set([
	'model', 'models', 'messages', 'input', 'contents', 'prompt', 'query', 'documents', 'stream',
	'provider', 'fallbacks', 'preset',
]);
const SOFT_PARAMETER_PREFERENCES = new Set(['tools', 'tool_choice', 'response_format', 'verbosity']);

function defaultProviderPreferences(): ProviderPreferences {
	return {
		order: [],
		only: null,
		ignore: [],
		allowFallbacks: true,
		requireZdr: false,
		requireParameters: false,
		dataCollection: 'allow',
		enforceDistillableText: false,
		quantizations: null,
		configuredSort: null,
		sort: null,
		preferredMinThroughput: null,
		preferredMaxLatency: null,
		maxPrice: null,
		serviceTier: null,
		explicitServiceTier: null,
		requestedSpeed: null,
		speedControlled: false,
		modelVariant: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSelectorList(value: unknown, field: string):
	{ ok: true; value: string[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length > MAX_PROVIDER_SELECTORS) {
		return { ok: false, message: `provider.${field} must be an array of at most ${MAX_PROVIDER_SELECTORS} provider names` };
	}
	const selectors: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') return { ok: false, message: `provider.${field} must contain only provider names` };
		const selector = item.trim();
		if (!selector || selector.length > MAX_PROVIDER_SELECTOR_LENGTH) {
			return { ok: false, message: `provider.${field} contains an invalid provider name` };
		}
		const canonical = selector.toLocaleLowerCase();
		if (!seen.has(canonical)) {
			seen.add(canonical);
			selectors.push(selector);
		}
	}
	return { ok: true, value: selectors };
}

function readBoolean(root: Record<string, unknown>, key: string):
	{ ok: true; value: boolean } | { ok: false; message: string } {
	const value = root[key];
	if (value !== undefined && typeof value !== 'boolean') {
		return { ok: false, message: `provider.${key} must be a boolean` };
	}
	return { ok: true, value: value === true };
}

function readPerformancePreference(value: unknown, field: string):
	{ ok: true; value: ProviderPerformancePreference | null } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: null };
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { ok: true, value };
	if (!isRecord(value)) {
		return { ok: false, message: `provider.${field} must be a non-negative number or percentile map` };
	}
	const keys = Object.keys(value);
	if (keys.length === 0 || keys.some((key) => !PERCENTILES.has(key as ProviderPercentile))) {
		return { ok: false, message: `provider.${field} must contain only: p50, p75, p90, p99` };
	}
	const normalized: Partial<Record<ProviderPercentile, number>> = {};
	for (const key of keys as ProviderPercentile[]) {
		const threshold = value[key];
		if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
			return { ok: false, message: `provider.${field}.${key} must be a non-negative number` };
		}
		normalized[key] = threshold;
	}
	return { ok: true, value: normalized };
}

function readSort(value: unknown):
	{ ok: true; value: ProviderPreferences['sort'] } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: null };
	if (typeof value === 'string' && SORT_FIELDS.has(value as ProviderSortBy)) {
		return { ok: true, value: { by: value as ProviderSortBy, partition: 'model' } };
	}
	if (!isRecord(value)) return { ok: false, message: 'provider.sort must be price, throughput, latency, or a sort object' };
	const unsupported = Object.keys(value).filter((key) => key !== 'by' && key !== 'partition');
	if (unsupported.length > 0 || !SORT_FIELDS.has(value.by as ProviderSortBy)) {
		return { ok: false, message: 'provider.sort.by must be one of: price, throughput, latency' };
	}
	const partition = value.partition ?? 'model';
	if (partition !== 'model' && partition !== 'none') {
		return { ok: false, message: 'provider.sort.partition must be "model" or "none"' };
	}
	return { ok: true, value: { by: value.by as ProviderSortBy, partition } };
}

function readMaxPrice(value: unknown):
	{ ok: true; value: ProviderMaxPrice | null } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: null };
	if (!isRecord(value)) return { ok: false, message: 'provider.max_price must be an object' };
	const unsupported = Object.keys(value).filter((key) => !MAX_PRICE_KEYS.has(key));
	if (unsupported.length > 0) return { ok: false, message: `provider.max_price contains unsupported key: ${unsupported.join(', ')}` };
	const result: ProviderMaxPrice = {};
	for (const key of MAX_PRICE_KEYS) {
		const item = value[key];
		if (item === undefined) continue;
		if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
			return { ok: false, message: `provider.max_price.${key} must be a non-negative number` };
		}
		result[key as keyof ProviderMaxPrice] = item;
	}
	return { ok: true, value: result };
}

function parseProviderPreferences(value: unknown):
	{ ok: true; value: ProviderPreferences } | { ok: false; message: string } {
	if (!isRecord(value)) return { ok: false, message: 'provider must be an object' };
	const unsupported = Object.keys(value).filter((key) => !SUPPORTED_KEYS.has(key));
	if (unsupported.length > 0) {
		return { ok: false, message: `Unsupported provider preference: ${unsupported.join(', ')}. Supported fields: ${SUPPORTED_KEYS_TEXT}` };
	}
	const order = value.order === undefined ? { ok: true as const, value: [] } : readSelectorList(value.order, 'order');
	if (!order.ok) return order;
	const only = value.only === undefined ? { ok: true as const, value: null } : readSelectorList(value.only, 'only');
	if (!only.ok) return only;
	const ignore = value.ignore === undefined ? { ok: true as const, value: [] } : readSelectorList(value.ignore, 'ignore');
	if (!ignore.ok) return ignore;
	const allowFallbacks = readBoolean(value, 'allow_fallbacks');
	if (!allowFallbacks.ok) return allowFallbacks;
	const requireZdr = readBoolean(value, 'zdr');
	if (!requireZdr.ok) return requireZdr;
	const requireParameters = readBoolean(value, 'require_parameters');
	if (!requireParameters.ok) return requireParameters;
	const enforceDistillableText = readBoolean(value, 'enforce_distillable_text');
	if (!enforceDistillableText.ok) return enforceDistillableText;
	if (value.data_collection !== undefined && value.data_collection !== 'allow' && value.data_collection !== 'deny') {
		return { ok: false, message: 'provider.data_collection must be "allow" or "deny"' };
	}

	let quantizations: RouteQuantization[] | null = null;
	if (value.quantizations !== undefined) {
		if (!Array.isArray(value.quantizations) || value.quantizations.length === 0 || value.quantizations.length > ROUTE_QUANTIZATIONS.length) {
			return { ok: false, message: 'provider.quantizations must be a non-empty array of supported quantizations' };
		}
		const normalized: RouteQuantization[] = [];
		for (const item of value.quantizations) {
			const canonical = typeof item === 'string' ? item.toLocaleLowerCase() : '';
			if (!QUANTIZATIONS.has(canonical)) {
				return { ok: false, message: `provider.quantizations must contain only: ${ROUTE_QUANTIZATIONS.join(', ')}` };
			}
			if (!normalized.includes(canonical as RouteQuantization)) normalized.push(canonical as RouteQuantization);
		}
		quantizations = normalized;
	}

	const sort = readSort(value.sort);
	if (!sort.ok) return sort;
	const minThroughput = readPerformancePreference(value.preferred_min_throughput, 'preferred_min_throughput');
	if (!minThroughput.ok) return minThroughput;
	const maxLatency = readPerformancePreference(value.preferred_max_latency, 'preferred_max_latency');
	if (!maxLatency.ok) return maxLatency;
	const maxPrice = readMaxPrice(value.max_price);
	if (!maxPrice.ok) return maxPrice;

	return {
		ok: true,
		value: {
			order: order.value,
			only: only.value,
			ignore: ignore.value,
			allowFallbacks: value.allow_fallbacks !== false,
			requireZdr: requireZdr.value,
			requireParameters: requireParameters.value,
			dataCollection: value.data_collection === 'deny' ? 'deny' : 'allow',
			enforceDistillableText: enforceDistillableText.value,
			quantizations,
			configuredSort: sort.value,
			sort: sort.value,
			preferredMinThroughput: minThroughput.value,
			preferredMaxLatency: maxLatency.value,
			maxPrice: maxPrice.value,
			serviceTier: null,
			explicitServiceTier: null,
			requestedSpeed: null,
			speedControlled: false,
			modelVariant: null,
		},
	};
}

function readServiceTier(body: Record<string, unknown>):
	{ ok: true; value: ProviderServiceTier | null } | { ok: false; message: string } {
	if (!Object.prototype.hasOwnProperty.call(body, 'service_tier') || body.service_tier === null) {
		return { ok: true, value: null };
	}
	if (body.service_tier === 'fast') return { ok: true, value: 'priority' };
	if (body.service_tier === 'auto') return { ok: true, value: 'default' };
	if (
		body.service_tier === 'default'
		|| body.service_tier === 'flex'
		|| body.service_tier === 'priority'
	) {
		return { ok: true, value: body.service_tier };
	}
	return {
		ok: false,
		message: 'service_tier must be one of: auto, default, fast, flex, priority, or null',
	};
}

function readTextSpeed(
	body: Record<string, unknown>,
	allowTextSpeed: boolean,
):
	| { ok: true; value: ProviderTextSpeed | null; controlled: boolean }
	| { ok: false; message: string } {
	if (!allowTextSpeed || !Object.prototype.hasOwnProperty.call(body, 'speed')) {
		return { ok: true, value: null, controlled: false };
	}
	if (body.speed === null) return { ok: true, value: null, controlled: true };
	if (body.speed === 'fast' || body.speed === 'standard') {
		return { ok: true, value: body.speed, controlled: true };
	}
	return {
		ok: false,
		message: 'speed must be one of: fast, standard, or null',
	};
}

function effectivePreferences(
	base: ProviderPreferences | null,
	explicitServiceTier: ProviderServiceTier | null,
	modelVariant: ServiceTierModelVariant | null,
	requestedSpeed: ProviderTextSpeed | null,
	speedControlled: boolean,
): ProviderPreferences | null {
	const serviceTier = explicitServiceTier ?? (requestedSpeed === 'fast' ? 'priority' : null);
	if (!base && !serviceTier && !modelVariant && !speedControlled) return null;
	const value: ProviderPreferences = {
		...(base ?? defaultProviderPreferences()),
		configuredSort: base?.configuredSort ?? base?.sort ?? null,
		serviceTier,
		explicitServiceTier,
		requestedSpeed,
		speedControlled,
		// An explicit service tier always overrides variant admission. In
		// particular, `default` lets callers retain the variant's model spelling
		// while disabling its non-default endpoint pool.
		modelVariant: serviceTier || (base?.order.length ?? 0) > 0 ? null : modelVariant,
	};
	// OpenRouter treats an explicit provider order as the routing order. It
	// therefore replaces both caller-configured and variant-injected sorting.
	if (value.order.length > 0) return { ...value, sort: null };
	const sortBy = value.serviceTier === 'flex' || value.modelVariant === 'floor'
		? 'price'
		: value.serviceTier === 'priority' || value.modelVariant === 'nitro'
			? 'throughput'
			: null;
	return sortBy
		? {
			...value,
			sort: {
				by: sortBy,
				partition: value.sort?.partition ?? 'model',
			},
		}
		: value;
}

export function prepareProviderRoutingPreferences(
	body: Record<string, unknown>,
	options: PrepareProviderRoutingOptions = {},
):
	{ ok: true; value: PreparedProviderRouting } | { ok: false; message: string } {
	const serviceTier = readServiceTier(body);
	if (!serviceTier.ok) return serviceTier;
	const requestedSpeed = readTextSpeed(body, options.allowTextSpeed === true);
	if (!requestedSpeed.ok) return requestedSpeed;
	const hasProvider = Object.prototype.hasOwnProperty.call(body, 'provider');
	const parsed = hasProvider
		? parseProviderPreferences(body.provider)
		: { ok: true as const, value: null };
	if (!parsed.ok) return parsed;
	const upstreamBody = hasProvider
		|| Object.prototype.hasOwnProperty.call(body, 'service_tier')
		|| requestedSpeed.controlled
		? { ...body }
		: body;
	if (upstreamBody !== body) {
		delete upstreamBody.provider;
		delete upstreamBody.service_tier;
		if (requestedSpeed.controlled) delete upstreamBody.speed;
	}
	const hasPreferences = hasProvider || serviceTier.value !== null || requestedSpeed.controlled;
	return { ok: true, value: {
		body: upstreamBody,
		hasPreferences,
		requireZdr: parsed.value?.requireZdr ?? false,
		preferences: effectivePreferences(
			parsed.value,
			serviceTier.value,
			null,
			requestedSpeed.value,
			requestedSpeed.controlled,
		),
		serviceTier: serviceTier.value,
		requestedSpeed: requestedSpeed.value,
		apply: (routes, modelVariant = null) => {
			const preferences = effectivePreferences(
				parsed.value,
				serviceTier.value,
				modelVariant,
				requestedSpeed.value,
				requestedSpeed.controlled,
			);
			if (!preferences) return applyDefaultEndpointEligibility(upstreamBody, routes);
			return applyPreparedProviderRouting(preferences, upstreamBody, routes, hasPreferences || modelVariant !== null);
		},
	} };
}

type ClassifiedRouteTier = ProviderServiceTier | 'unknown';

function classifiedRouteTier(route: RouteResult): ClassifiedRouteTier {
	const endpoint = route.endpoint;
	if (!endpoint) return 'default';
	const slug = endpoint.selectorSlug;
	if (endpoint.endpointClass !== 'service_tier') {
		return slug.includes('/') && endpoint.endpointClass !== 'standard'
			? 'unknown'
			: 'default';
	}
	const suffix = slug.slice(slug.lastIndexOf('/') + 1);
	if (suffix === 'flex') return 'flex';
	if (suffix === 'fast' || suffix === 'priority') return 'priority';
	return 'unknown';
}

function canonicalTierSelector(selector: string): string {
	const normalized = selector.toLowerCase();
	return normalized.endsWith('/fast')
		? `${normalized.slice(0, -'/fast'.length)}/priority`
		: normalized;
}

function routeMatchesSelector(route: RouteResult, selector: string, allowTierBase = false): boolean {
	const normalized = selector.toLowerCase();
	const endpointSlug = route.endpoint?.selectorSlug;
	if (endpointSlug) {
		if (
			endpointSlug === normalized
			|| (
				route.endpoint?.endpointClass === 'service_tier'
				&& canonicalTierSelector(endpointSlug) === canonicalTierSelector(normalized)
			)
		) return true;
		const variantSeparator = endpointSlug.indexOf('/');
		if (variantSeparator > 0) {
			// Service tiers and unclassified historical variants are exact-only.
			// Never infer a tier from an arbitrary suffix or let provider id/name
			// fallback turn a base selector into an implicit service-tier match.
			if (route.endpoint?.endpointClass !== 'standard' && !allowTierBase) return false;
			if (endpointSlug.slice(0, variantSeparator) === normalized) return true;
		}
	}
	const providerId = route.providerId.toLowerCase();
	const providerName = route.providerName.toLowerCase();
	if (providerId === normalized || providerName === normalized) return true;
	return false;
}

function firstMatchingSelectorIndex(route: RouteResult, selectors: string[], allowTierBase = false): number {
	return selectors.findIndex((selector) => routeMatchesSelector(route, selector, allowTierBase));
}

function routeRequiresExplicitEndpointOptIn(route: RouteResult): boolean {
	const slug = route.endpoint?.selectorSlug;
	return Boolean(slug?.includes('/') && route.endpoint?.endpointClass !== 'standard');
}

function hasExactEndpointSelector(route: RouteResult, selectors: readonly string[]): boolean {
	const slug = route.endpoint?.selectorSlug;
	return Boolean(slug && selectors.some((selector) =>
		selector.includes('/')
		&& (
			selector.toLowerCase() === slug
			|| (
				route.endpoint?.endpointClass === 'service_tier'
				&& canonicalTierSelector(selector) === canonicalTierSelector(slug)
			)
		)
	));
}

function applyDefaultEndpointEligibility(
	body: Record<string, unknown>,
	routes: RouteResult[],
): ProviderRoutingResult {
	const eligible = routes.filter((route) => !routeRequiresExplicitEndpointOptIn(route));
	if (routes.length > 0 && eligible.length === 0) {
		return {
			ok: false,
			message: 'No configured standard endpoint is available; service-tier and unclassified variant endpoints require an exact provider.order or provider.only slug',
		};
	}
	return {
		ok: true,
		body,
		routes: eligible.length === routes.length ? routes : eligible,
		hasPreferences: false,
		preferences: null,
		routingMode: null,
	};
}

function requestedCapabilityParameters(body: Record<string, unknown>): string[] {
	return Object.keys(body).filter((key) => !STRUCTURAL_REQUEST_KEYS.has(key) && body[key] !== undefined);
}

function routeSupportsParameter(route: RouteResult, parameter: string): boolean {
	const canonical = parameter.toLocaleLowerCase();
	return (route.endpoint?.supportedParameters ?? []).some((item) => item.toLocaleLowerCase() === canonical);
}

function applyParameterCapabilities(preferences: ProviderPreferences, body: Record<string, unknown>, routes: RouteResult[]): RouteResult[] {
	const requested = requestedCapabilityParameters(body);
	if (requested.length === 0) return routes;
	if (preferences.requireParameters) {
		return routes.filter((route) => requested.every((parameter) => routeSupportsParameter(route, parameter)));
	}
	const softRequested = requested.filter((parameter) => SOFT_PARAMETER_PREFERENCES.has(parameter));
	if (softRequested.length === 0) return routes;
	const preferred = routes.filter((route) => softRequested.every((parameter) => routeSupportsParameter(route, parameter)));
	if (preferred.length === 0) return routes;
	// OpenRouter's "soft preference" is model-soft, endpoint-hard: if this
	// model has any endpoint supporting the parameter, only those endpoints are
	// eligible. If it has none, retain all endpoints so the model itself remains
	// a valid fallback candidate.
	return preferred;
}

function applyPreparedProviderRouting(
	preferences: ProviderPreferences,
	upstreamBody: Record<string, unknown>,
	routes: RouteResult[],
	hasPreferences = true,
): ProviderRoutingResult {
	const routingMode: ServiceTierRoutingMode = preferences.serviceTier ?? preferences.modelVariant;
	let resultPreferences = preferences;
	const allowTierBase = routingMode !== null;
	const explicitEndpointSelectors = [...preferences.order, ...(preferences.only ?? [])];
	let eligible = routes.filter((route) => {
		if (preferences.only && !preferences.only.some((selector) => routeMatchesSelector(route, selector, allowTierBase))) return false;
		if (preferences.ignore.some((selector) => routeMatchesSelector(route, selector, allowTierBase))) return false;
		if (preferences.quantizations && !preferences.quantizations.includes(route.endpoint?.quantization ?? 'unknown')) return false;
		return true;
	});
	eligible = applyParameterCapabilities(preferences, upstreamBody, eligible);

	if (routingMode === 'flex') {
		const flexRoutes = eligible.filter((route) => classifiedRouteTier(route) === 'flex');
		if (flexRoutes.length > 0) {
			eligible = flexRoutes;
		} else {
			eligible = eligible.filter((route) => classifiedRouteTier(route) === 'default');
			// A flex request falls back to normal routing only when the model has no
			// flex endpoint at all. Restore the caller's sort instead of retaining
			// the flex policy's injected price ordering on the standard pool.
			resultPreferences = {
				...preferences,
				sort: preferences.order.length > 0 ? null : preferences.configuredSort,
			};
		}
	} else if (routingMode === 'priority' || routingMode === 'nitro') {
		eligible = eligible.filter((route) => {
			const tier = classifiedRouteTier(route);
			return tier === 'default' || tier === 'priority';
		});
	} else if (routingMode === 'floor') {
		eligible = eligible.filter((route) => {
			const tier = classifiedRouteTier(route);
			return tier === 'default' || tier === 'flex';
		});
	} else if (routingMode === 'default') {
		eligible = eligible.filter((route) => classifiedRouteTier(route) === 'default');
	} else {
		eligible = eligible.filter((route) =>
			!routeRequiresExplicitEndpointOptIn(route)
			|| hasExactEndpointSelector(route, explicitEndpointSelectors)
		);
	}

	eligible = eligible.map((route) => {
		const tier = classifiedRouteTier(route);
		const gatewayServiceTier = tier === 'flex' || tier === 'priority'
			? tier
			: routingMode !== null && tier === 'default'
				? 'default'
				: null;
		const gatewayTextSpeed = preferences.requestedSpeed
			&& routeSupportsParameter(route, 'speed')
			? preferences.requestedSpeed
			: null;
		const gatewayTextSpeedControlled = preferences.speedControlled;
		const gatewayRequestedServiceTier = gatewayServiceTier === 'default'
			&& preferences.explicitServiceTier === null
			&& preferences.requestedSpeed === 'fast'
			&& gatewayTextSpeed === 'fast'
			? 'priority'
			: gatewayServiceTier;
		return gatewayServiceTier || gatewayTextSpeed || gatewayTextSpeedControlled
			? {
				...route,
				...(gatewayServiceTier ? { gatewayServiceTier } : {}),
				...(gatewayRequestedServiceTier ? { gatewayRequestedServiceTier } : {}),
				...(gatewayTextSpeed ? { gatewayTextSpeed } : {}),
				...(gatewayTextSpeedControlled ? { gatewayTextSpeedControlled: true } : {}),
			}
			: route;
	});

	if (preferences.order.length > 0) {
		const explicitlyOrdered = eligible.filter((route) => firstMatchingSelectorIndex(route, preferences.order, allowTierBase) >= 0);
		const remaining = eligible.filter((route) => firstMatchingSelectorIndex(route, preferences.order, allowTierBase) < 0);
		eligible = preferences.allowFallbacks ? [...explicitlyOrdered, ...remaining] : explicitlyOrdered;
		eligible = eligible.map((route) => ({
			...route,
			routePriority: (() => {
				const selectorIndex = firstMatchingSelectorIndex(route, preferences.order, allowTierBase);
				const rank = selectorIndex >= 0 ? selectorIndex : preferences.order.length;
				return (preferences.order.length - rank) * 1_000_000_000
					+ Math.max(-999_999, Math.min(999_999, route.routePriority));
			})(),
		}));
	}

	// With an explicit order, allow_fallbacks=false excludes providers outside
	// that list; every available provider in the list remains a valid fallback.
	// Without an order, retain the historical single-provider behavior.
	if (!preferences.allowFallbacks && preferences.order.length === 0 && eligible.length > 0) {
		const providerId = eligible[0]!.providerId;
		eligible = eligible.filter((route) => route.providerId === providerId);
	}
	if (eligible.length === 0) {
		return { ok: false, message: 'No configured route matches the requested provider preferences or capabilities' };
	}
	return {
		ok: true,
		body: upstreamBody,
		routes: eligible,
		hasPreferences,
		preferences: resultPreferences,
		routingMode,
	};
}

/** Apply validated provider selection controls and strip them before egress. */
export function applyProviderRoutingPreferences(
	body: Record<string, unknown>,
	routes: RouteResult[],
	modelVariant: ServiceTierModelVariant | null = null,
): ProviderRoutingResult {
	const prepared = prepareProviderRoutingPreferences(body, { allowTextSpeed: true });
	if (!prepared.ok) return prepared;
	return prepared.value.apply(routes, modelVariant);
}

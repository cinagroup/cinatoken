/** Resolve and validate every model candidate before the first upstream request. */
import type {
	GatewayRepositories,
	ModelRow,
	ResolvedModelSurfaceRow,
	UpstreamProtocol,
} from '@octafuse/core';
import {
	getBusinessTimezone,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
	routeDataPolicyAllowsZdr,
	routeDataPolicyDeniesCollection,
} from '@octafuse/core';
import { resolveRoutesForSurface, type RouteResult } from './model-router';
import {
	prepareProviderRoutingPreferences,
	type ProviderMaxPrice,
	type ProviderPreferences,
} from './provider-routing-preferences';
import { applyProviderPerformanceRouting } from './provider-performance-routing';
import { resolveModelRouting } from './resolve-model-route-group';
import { resolveRouteStrategyPlan, type RouteStrategyPlan } from './route-strategies';
import { GatewayErrorCode, type GatewayErrorCodeValue } from './gateway-error-codes';

type ComparableRoutePrice = {
	prompt: number | null;
	completion: number | null;
	request: number | null;
	image: number | null;
};

type RequestedOutputCapacityResult =
	| { ok: true; maxCompletionTokens: number | null }
	| { ok: false; message: string };

function readPositiveOutputLimit(
	body: Record<string, unknown>,
	field: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
	if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] == null) {
		return { ok: true, value: null };
	}
	const value = body[field];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		return { ok: false, message: `${field} must be a positive safe integer or null` };
	}
	return { ok: true, value };
}

/**
 * Normalize the public protocol's explicit output limit into the endpoint DTO's
 * `max_completion_tokens` unit. Unknown fields are intentionally ignored here;
 * the protocol/upstream remains responsible for its wider request schema.
 */
function requestedOutputCapacity(params: {
	body: Record<string, unknown>;
	requestProtocol: UpstreamProtocol;
	requestOperation: string;
}): RequestedOutputCapacityResult {
	let fields: string[];
	if (params.requestProtocol === 'openai' && params.requestOperation === 'chat') {
		fields = ['max_tokens', 'max_completion_tokens'];
	} else if (params.requestProtocol === 'openai' && params.requestOperation === 'responses') {
		fields = ['max_output_tokens'];
	} else if (params.requestProtocol === 'anthropic' && params.requestOperation === 'messages') {
		fields = ['max_tokens'];
	} else {
		return { ok: true, maxCompletionTokens: null };
	}

	let required: number | null = null;
	for (const field of fields) {
		const parsed = readPositiveOutputLimit(params.body, field);
		if (!parsed.ok) return parsed;
		if (parsed.value != null) required = Math.max(required ?? 0, parsed.value);
	}
	return { ok: true, maxCompletionTokens: required };
}

function routeProvesOutputCapacity(route: RouteResult, requiredTokens: number): boolean {
	const capacity = route.endpoint?.maxCompletionTokens;
	return typeof capacity === 'number'
		&& Number.isSafeInteger(capacity)
		&& capacity >= requiredTokens;
}

function modelAllowsTextDistillation(model: ModelRow): boolean {
	if (!model.metadata) return false;
	try {
		const metadata = JSON.parse(model.metadata) as unknown;
		return Boolean(
			metadata && typeof metadata === 'object' && !Array.isArray(metadata)
			&& (metadata as Record<string, unknown>).distillable_text === true
		);
	} catch {
		return false;
	}
}

function comparableRoutePrice(
	route: RouteResult,
	pricingAt: Date,
	businessTimezone: string,
): ComparableRoutePrice {
	const pricing = route.endpoint?.pricing;
	if (!pricing) return { prompt: null, completion: null, request: null, image: null };
	const discountFactor = 1 - (pricing.discount ?? 0);
	const unitPrice = (value: string | undefined, multiplier = 1): number | null => {
		if (value === undefined) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0
			? parsed * multiplier * discountFactor
			: null;
	};
	// Public provider.max_price prompt/completion values are USD per million
	// tokens, while endpoint catalog prices are normalized USD per token.
	const prompt = unitPrice(pricing.prompt, 1_000_000);
	const completion = unitPrice(pricing.completion, 1_000_000);
	const request = unitPrice(pricing.request);
	const image = unitPrice(pricing.image);
	const base = parseRouteBaseFactors(route.priceOverrideRaw).chargedFactor;
	const schedule = parseRoutePricingSchedule(route.priceOverrideRaw);
	const scheduleFactor = resolveDailyScheduleFactor(schedule.charged, pricingAt, businessTimezone);
	const factor = resolveEffectiveRouteFactor(base, scheduleFactor, schedule.mode);
	return {
		prompt: prompt == null ? null : prompt * factor,
		completion: completion == null ? null : completion * factor,
		request: request == null ? null : request * factor,
		image: image == null ? null : image * factor,
	};
}

function routeSatisfiesMaxPrice(
	price: ComparableRoutePrice,
	maxPrice: ProviderMaxPrice | null,
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

function priceSortScore(price: ComparableRoutePrice): number {
	const prompt = price.prompt ?? Number.POSITIVE_INFINITY;
	const completion = price.completion ?? Number.POSITIVE_INFINITY;
	return prompt + completion;
}

export type ModelFallbackCandidatePlan = {
	requestedModelId: string;
	model: ModelRow;
	baseModelId: string;
	effectiveRouteGroup: string;
	routes: RouteResult[];
	surface: ResolvedModelSurfaceRow | null;
	strategy: RouteStrategyPlan;
	upstreamBody: Record<string, unknown>;
	hasProviderPreferences: boolean;
};

export type ModelFallbackPlanResult =
	| {
		ok: true;
		/** Complete per-model candidates used for conservative budget and state checks. */
		candidates: ModelFallbackCandidatePlan[];
		/** Endpoint grouping selected by provider.sort.partition. */
		endpointPartition: 'model' | 'none';
		/**
		 * Exact request-level endpoint sequence for partition=none. It must be
		 * dispatched by one failover loop so replay and unknown-outcome state are
		 * shared across every fallback model.
		 */
		globalRoutes: RouteResult[];
	}
	| {
		ok: false;
		status: 400 | 404 | 502;
		code: GatewayErrorCodeValue;
		message: string;
	};

function attachProviderRoutingTrace(
	route: RouteResult,
	preferences: ProviderPreferences | null,
	configuredTargetIds: string[],
	eligibleTargetIds: string[],
	partition: 'model' | 'none',
	globalEndpointRank: number | null,
): RouteResult {
	if (!preferences) return route;
	return {
		...route,
		providerRoutingTrace: {
			configured_target_ids: configuredTargetIds,
			eligible_target_ids: eligibleTargetIds,
			sort: preferences.sort?.by ?? null,
			partition,
			global_endpoint_rank: globalEndpointRank,
			require_parameters: preferences.requireParameters,
			data_collection: preferences.dataCollection,
			zdr: preferences.requireZdr,
			quantizations: preferences.quantizations,
			max_price: preferences.maxPrice,
		},
	};
}

async function buildExecutionCandidates(params: {
	repos: GatewayRepositories;
	candidates: ModelFallbackCandidatePlan[];
	configuredTargetIdsByCandidate: string[][];
	preferences: ProviderPreferences | null;
	pricingAt: Date;
	businessTimezone: string;
}): Promise<{
	candidates: ModelFallbackCandidatePlan[];
	endpointPartition: 'model' | 'none';
	globalRoutes: RouteResult[];
}> {
	const partition = params.preferences?.sort?.partition ?? 'model';
	if (partition === 'model') {
		const candidates = params.candidates.map((candidate, index) => {
			const eligibleTargetIds = candidate.routes.map((route) => route.targetId);
			return {
				...candidate,
				routes: candidate.routes.map((route) => attachProviderRoutingTrace(
					route,
					params.preferences,
					params.configuredTargetIdsByCandidate[index] ?? [],
					eligibleTargetIds,
					'model',
					null,
				)),
			};
		});
		return {
			candidates,
			endpointPartition: 'model',
			globalRoutes: [],
		};
	}

	const entries = params.candidates.flatMap((candidate, candidateIndex) =>
		candidate.routes.map((route, routeIndex) => ({
			candidateIndex,
			routeIndex,
			route: { ...route, gatewayCandidateIndex: candidateIndex },
			price: comparableRoutePrice(
				route,
				params.pricingAt,
				params.businessTimezone,
			),
		})),
	);
	let orderedEntries = [...entries];
	if (params.preferences?.sort?.by === 'price') {
		orderedEntries.sort((left, right) =>
			priceSortScore(left.price) - priceSortScore(right.price)
			|| left.candidateIndex - right.candidateIndex
			|| left.routeIndex - right.routeIndex
		);
		orderedEntries = orderedEntries.map((entry, index, all) => ({
			...entry,
			route: { ...entry.route, routePriority: all.length - index },
		}));
	}

	let globallyOrderedRoutes = await applyProviderPerformanceRouting(
		params.repos,
		orderedEntries.map((entry) => entry.route),
		params.preferences!,
		params.pricingAt,
	);
	if (
		params.preferences?.sort?.by === 'price'
		&& (params.preferences.preferredMinThroughput != null
			|| params.preferences.preferredMaxLatency != null)
	) {
		globallyOrderedRoutes = [...globallyOrderedRoutes].sort(
			(left, right) => right.routePriority - left.routePriority,
		);
	}

	const configuredTargetIds = params.configuredTargetIdsByCandidate.flat();
	const eligibleTargetIds = globallyOrderedRoutes.map((route) => route.targetId);
	const rankedRoutes = globallyOrderedRoutes.map((route, index) => attachProviderRoutingTrace(
		{
			...route,
			// Unique priorities make buildRouteAttemptPlan preserve this exact
			// request-level sequence; shared-key clones remain adjacent.
			routePriority: globallyOrderedRoutes.length - index,
			gatewayGlobalEndpointRank: index + 1,
		},
		params.preferences,
		configuredTargetIds,
		eligibleTargetIds,
		'none',
		index + 1,
	));
	const candidates = params.candidates.map((candidate, candidateIndex) => ({
		...candidate,
		routes: rankedRoutes.filter(
			(route) => route.gatewayCandidateIndex === candidateIndex,
		),
	}));
	return { candidates, endpointPartition: 'none', globalRoutes: rankedRoutes };
}

/**
 * Resolve model rows, surfaces, routes, provider filters, and route strategies as
 * one preflight. A malformed fallback can therefore never cause a paid primary
 * attempt before the gateway discovers the request is invalid.
 */
export async function buildModelFallbackPlan(
	repos: GatewayRepositories,
	params: {
		modelIds: string[];
		body: Record<string, unknown>;
		requestProtocol: UpstreamProtocol;
		requestOperation: string;
		/** Request-start instant shared with admission and final settlement. */
		pricingAt?: Date;
	},
): Promise<ModelFallbackPlanResult> {
	const preparedProvider = prepareProviderRoutingPreferences(params.body);
	if (!preparedProvider.ok) {
		return {
			ok: false,
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: preparedProvider.message,
		};
	}
	const outputCapacity = requestedOutputCapacity(params);
	if (!outputCapacity.ok) {
		return {
			ok: false,
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: outputCapacity.message,
		};
	}
	if (preparedProvider.value.requireZdr && Array.isArray(params.body.tools) && params.body.tools.length > 0) {
		return {
			ok: false,
			status: 400,
			code: GatewayErrorCode.zdrToolsUnsupported,
			message: 'ZDR requests cannot use tools until each tool has an independently verified data policy',
		};
	}

	const resolvedModels = await Promise.all(
		params.modelIds.map((modelId) => resolveModelRouting(repos, modelId)),
	);
	for (let index = 0; index < resolvedModels.length; index += 1) {
		if (!resolvedModels[index]) {
			return {
				ok: false,
				status: 404,
				code: GatewayErrorCode.modelNotFound,
				message: `Model not found: ${params.modelIds[index]}`,
			};
		}
	}

	const resolved = resolvedModels as Array<NonNullable<(typeof resolvedModels)[number]>>;
	const preferences = preparedProvider.value.preferences;
	const requiredCompletionTokens = outputCapacity.maxCompletionTokens;
	if (preferences?.enforceDistillableText) {
		const deniedIndex = resolved.findIndex((candidate) => !modelAllowsTextDistillation(candidate.model));
		if (deniedIndex >= 0) {
			return {
				ok: false,
				status: 400,
				code: GatewayErrorCode.invalidRequest,
				message: `Model "${params.modelIds[deniedIndex]}" is not marked as text-distillable`,
			};
		}
	}
	const usesPriceRouting = Boolean(preferences?.maxPrice || preferences?.sort?.by === 'price');
	const usesGlobalEndpointPartition = preferences?.sort?.partition === 'none';
	const pricingAt = params.pricingAt instanceof Date && Number.isFinite(params.pricingAt.getTime())
		? params.pricingAt
		: new Date();
	const businessTimezone = usesPriceRouting ? await getBusinessTimezone(repos) : 'UTC';
	let surfaces: Awaited<ReturnType<typeof resolveRoutesForSurface>>[];
	try {
		surfaces = await Promise.all(
			resolved.map((candidate) =>
				resolveRoutesForSurface(repos, {
					modelId: candidate.baseModelId,
					routeGroup: candidate.explicitGroup?.trim() || 'default',
					requestProtocol: params.requestProtocol,
					requestOperation: params.requestOperation,
				}),
			),
		);
	} catch (error) {
		return {
			ok: false,
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: error instanceof Error ? error.message : 'Model route resolution failed',
		};
	}

	const eligibleRoutes: RouteResult[][] = [];
	const configuredTargetIdsByCandidate: string[][] = [];
	let firstSkippedCandidateFailure: Extract<ModelFallbackPlanResult, { ok: false }> | null = null;
	for (let index = 0; index < resolved.length; index += 1) {
		const candidate = resolved[index]!;
		const requestedModelId = params.modelIds[index]!;
		let routes = surfaces[index]!.routes.map((route) => ({
			...route,
			gatewayModelId: candidate.baseModelId,
			gatewayCandidateIndex: index,
		}));
		const configuredTargetIds = routes.map((route) => route.targetId);
		configuredTargetIdsByCandidate.push(configuredTargetIds);
		if (routes.length === 0) {
			const failure: Extract<ModelFallbackPlanResult, { ok: false }> = {
				ok: false,
				status: 502,
				code: GatewayErrorCode.noRoute,
				message: `No ${params.requestProtocol} ${params.requestOperation} route is configured for model "${requestedModelId}"`,
			};
			if (!usesGlobalEndpointPartition) return failure;
			firstSkippedCandidateFailure ??= failure;
			eligibleRoutes.push([]);
			continue;
		}
		if (requiredCompletionTokens != null) {
			routes = routes.filter((route) => routeProvesOutputCapacity(
				route,
				requiredCompletionTokens,
			));
			if (routes.length === 0) {
				const failure: Extract<ModelFallbackPlanResult, { ok: false }> = {
					ok: false,
					status: 400,
					code: GatewayErrorCode.invalidRequest,
					message: `No configured endpoint has verified max_completion_tokens capacity of at least ${requiredCompletionTokens} for model "${requestedModelId}"`,
				};
				if (!usesGlobalEndpointPartition) return failure;
				firstSkippedCandidateFailure ??= failure;
				eligibleRoutes.push([]);
				continue;
			}
		}
		if (preparedProvider.value.requireZdr || preferences?.dataCollection === 'deny') {
			// Shared credentials are injected only after route-policy evaluation and
			// may represent a different upstream account. Until shared keys carry
			// independent verified evidence, they cannot inherit the Provider's ZDR
			// or no-collection assertion.
			routes = routes.filter((route) => route.providerSharedChannelType == null);
			const policies = await repos.routeDataPolicies.getByRouteTargetIds(routes.map((route) => route.targetId));
			const byTarget = new Map(policies.map((policy) => [policy.route_target_id, policy]));
			if (preparedProvider.value.requireZdr) {
				routes = routes.filter((route) => routeDataPolicyAllowsZdr(
					byTarget.get(route.targetId),
					route.dataPolicySubjectFingerprint,
				));
			}
			if (preferences?.dataCollection === 'deny') {
				routes = routes.filter((route) => routeDataPolicyDeniesCollection(
					byTarget.get(route.targetId),
					route.dataPolicySubjectFingerprint,
				));
			}
			if (routes.length === 0) {
				const failure: Extract<ModelFallbackPlanResult, { ok: false }> = {
					ok: false,
					status: 400,
					code: preparedProvider.value.requireZdr
						? GatewayErrorCode.zdrNoRoute
						: GatewayErrorCode.dataCollectionNoRoute,
					message: preparedProvider.value.requireZdr
						? `No verified zero-data-retention route is available for model "${requestedModelId}"`
						: `No verified no-collection route is available for model "${requestedModelId}"`,
				};
				if (!usesGlobalEndpointPartition) return failure;
				firstSkippedCandidateFailure ??= failure;
				eligibleRoutes.push([]);
				continue;
			}
		}
		const providerResult = preparedProvider.value.apply(routes);
		if (!providerResult.ok) {
			const failure: Extract<ModelFallbackPlanResult, { ok: false }> = {
				ok: false,
				status: 400,
				code: GatewayErrorCode.invalidRequest,
				message: `${providerResult.message} for model "${requestedModelId}"`,
			};
			if (!usesGlobalEndpointPartition) return failure;
			firstSkippedCandidateFailure ??= failure;
			eligibleRoutes.push([]);
			continue;
		}
		let selectedRoutes = providerResult.routes;
		if (usesPriceRouting) {
			const priced = selectedRoutes.map((route) => ({
				route,
				price: comparableRoutePrice(route, pricingAt, businessTimezone),
			}));
			selectedRoutes = priced
				.filter((item) => routeSatisfiesMaxPrice(item.price, preferences?.maxPrice ?? null))
				.sort((a, b) => preferences?.sort?.by === 'price'
					? priceSortScore(a.price) - priceSortScore(b.price)
					: 0)
				.map((item, priceIndex, all) => ({
					...item.route,
					routePriority: preferences?.sort?.by === 'price'
						? all.length - priceIndex
						: item.route.routePriority,
				}));
			if (selectedRoutes.length === 0) {
				const failure: Extract<ModelFallbackPlanResult, { ok: false }> = {
					ok: false,
					status: 400,
					code: GatewayErrorCode.invalidRequest,
					message: `No configured route satisfies provider.max_price for model "${requestedModelId}"`,
				};
				if (!usesGlobalEndpointPartition) return failure;
				firstSkippedCandidateFailure ??= failure;
				eligibleRoutes.push([]);
				continue;
			}
		}
		if (preferences && (preferences.sort?.partition ?? 'model') === 'model') {
			selectedRoutes = await applyProviderPerformanceRouting(
				repos,
				selectedRoutes,
				preferences,
				pricingAt,
			);
		}
		eligibleRoutes.push(selectedRoutes);
	}
	if (eligibleRoutes.every((routes) => routes.length === 0)) {
		return firstSkippedCandidateFailure ?? {
			ok: false,
			status: 502,
			code: GatewayErrorCode.noRoute,
			message: 'No configured route satisfies the requested provider preferences',
		};
	}

	const strategies = await Promise.all(
		resolved.map((candidate, index) => {
			const surface = surfaces[index]!.surface;
			return resolveRouteStrategyPlan({
				routePolicyRaw: candidate.model.route_policy ?? null,
				poolStrategy: surface?.pool_strategy ?? null,
				poolTierStrategies: surface?.pool_tier_strategies ?? null,
				protocol: params.requestProtocol,
				capability: params.requestOperation,
				routeGroup: candidate.explicitGroup?.trim() || 'default',
				repos,
			});
		}),
	);

	const candidates = resolved.map((candidate, index) => ({
			requestedModelId: params.modelIds[index]!,
			model: candidate.model,
			baseModelId: candidate.baseModelId,
			effectiveRouteGroup: candidate.explicitGroup?.trim() || 'default',
			routes: eligibleRoutes[index]!,
			surface: surfaces[index]!.surface,
			strategy: strategies[index]!,
			upstreamBody: preparedProvider.value.body,
			hasProviderPreferences: preparedProvider.value.hasPreferences,
		}));
	const finalized = await buildExecutionCandidates({
		repos,
		candidates,
		configuredTargetIdsByCandidate,
		preferences,
		pricingAt,
		businessTimezone,
	});
	return {
		ok: true,
		candidates: finalized.candidates,
		endpointPartition: finalized.endpointPartition,
		globalRoutes: finalized.globalRoutes,
	};
}

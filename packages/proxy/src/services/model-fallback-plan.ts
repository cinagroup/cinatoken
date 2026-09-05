/** Resolve and validate every model candidate before the first upstream request. */
import type {
	GatewayRepositories,
	ModelRow,
	ResolvedModelSurfaceRow,
	UpstreamProtocol,
} from '@octafuse/core';
import {
	comparableRoutePriceSortScore,
	getBusinessTimezone,
	resolveComparableRoutePrice,
	routeDataPolicyAllowsZdr,
	routeDataPolicyDeniesCollection,
	routeSatisfiesComparableMaxPrice,
	type ComparableRoutePrice,
} from '@octafuse/core';
import { resolveRoutesForSurface, type RouteResult } from './model-router';
import {
	prepareProviderRoutingPreferences,
	type ProviderPreferences,
} from './provider-routing-preferences';
import { applyProviderPerformanceRouting } from './provider-performance-routing';
import { applyDefaultProviderLoadBalancing } from './provider-default-load-balancing';
import { resolveModelRouting } from './resolve-model-route-group';
import { resolveRouteStrategyPlan, type RouteStrategyPlan } from './route-strategies';
import { GatewayErrorCode, type GatewayErrorCodeValue } from './gateway-error-codes';

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
	return resolveComparableRoutePrice({
		pricing: route.endpoint?.pricing,
		priceOverrideRaw: route.priceOverrideRaw,
		pricingAt,
		businessTimezone,
	});
}

function supportsDefaultProviderLoadBalancing(params: {
	requestProtocol: UpstreamProtocol;
	requestOperation: string;
}): boolean {
	return (
		params.requestProtocol === 'openai'
		&& (
			params.requestOperation === 'chat'
			|| params.requestOperation === 'responses'
			|| params.requestOperation === 'embeddings'
			|| params.requestOperation === 'rerank'
		)
	) || (
		params.requestProtocol === 'anthropic'
		&& params.requestOperation === 'messages'
	);
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
	routingPreferences: ProviderPreferences | null;
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
	const defaultLoadBalanced = route.gatewayDefaultLoadBalanceRank != null;
	if (!preferences && !defaultLoadBalanced) return route;
	return {
		...route,
		providerRoutingTrace: {
			configured_target_ids: configuredTargetIds,
			eligible_target_ids: eligibleTargetIds,
			sort: preferences?.sort?.by ?? null,
			partition,
			global_endpoint_rank: globalEndpointRank,
			require_parameters: preferences?.requireParameters ?? false,
			data_collection: preferences?.dataCollection ?? 'allow',
			zdr: preferences?.requireZdr ?? false,
			quantizations: preferences?.quantizations ?? null,
			max_price: preferences?.maxPrice ?? null,
			...(preferences?.preferredMinThroughput == null
				? {}
				: { preferred_min_throughput: preferences.preferredMinThroughput }),
			...(preferences?.preferredMaxLatency == null
				? {}
				: { preferred_max_latency: preferences.preferredMaxLatency }),
			service_tier: preferences?.serviceTier ?? null,
			speed: preferences?.requestedSpeed ?? null,
			model_variant: preferences?.modelVariant ?? null,
			...(defaultLoadBalanced ? {
				default_load_balance: true,
				provider_recently_degraded: route.gatewayProviderRecentlyDegraded === true,
			} : {}),
		},
	};
}

async function buildExecutionCandidates(params: {
	repos: GatewayRepositories;
	candidates: ModelFallbackCandidatePlan[];
	configuredTargetIdsByCandidate: string[][];
	pricingAt: Date;
	businessTimezone: string;
	deferPriceRoutingToSurface: boolean;
}): Promise<{
	candidates: ModelFallbackCandidatePlan[];
	endpointPartition: 'model' | 'none';
	globalRoutes: RouteResult[];
}> {
	const globalPreference = params.candidates
		.map((candidate) => candidate.routingPreferences)
		.find((preferences) => preferences?.sort?.partition === 'none') ?? null;
	const partition = globalPreference ? 'none' : 'model';
	if (partition === 'model') {
		const candidates = params.candidates.map((candidate, index) => {
			const eligibleTargetIds = candidate.routes.map((route) => route.targetId);
			return {
				...candidate,
				routes: candidate.routes.map((route) => attachProviderRoutingTrace(
					route,
					candidate.routingPreferences,
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
	if (globalPreference?.sort?.by === 'price' && !params.deferPriceRoutingToSurface) {
		orderedEntries.sort((left, right) =>
			comparableRoutePriceSortScore(left.price) - comparableRoutePriceSortScore(right.price)
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
		globalPreference!,
		params.pricingAt,
	);
	globallyOrderedRoutes = orderPriorityServiceTierFirst(
		globallyOrderedRoutes,
		globalPreference,
	);
	if (
		globalPreference?.sort?.by === 'price'
		&& !params.deferPriceRoutingToSurface
		&& (globalPreference.preferredMinThroughput != null
			|| globalPreference.preferredMaxLatency != null)
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
		globalPreference,
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

function orderPriorityServiceTierFirst(
	routes: RouteResult[],
	preferences: ProviderPreferences | null,
): RouteResult[] {
	if (preferences?.serviceTier !== 'priority' || preferences.order.length > 0) return routes;
	const ordered = [
		...routes.filter((route) => route.gatewayServiceTier === 'priority'),
		...routes.filter((route) => route.gatewayServiceTier !== 'priority'),
	];
	return ordered.map((route, index) => ({
		...route,
		routePriority: ordered.length - index,
	}));
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
	const serviceTierOperationSupported = (
		params.requestProtocol === 'openai'
		&& (params.requestOperation === 'chat' || params.requestOperation === 'responses')
	) || (
		params.requestProtocol === 'anthropic'
		&& params.requestOperation === 'messages'
	);
	const preparedProvider = prepareProviderRoutingPreferences(params.body, {
		allowTextSpeed: serviceTierOperationSupported,
	});
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
	if (
		(preparedProvider.value.serviceTier !== null
			|| preparedProvider.value.requestedSpeed !== null
			|| resolved.some((candidate) => candidate.modelVariant !== null))
		&& !serviceTierOperationSupported
	) {
		return {
			ok: false,
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'service_tier, text speed, and :nitro/:floor are supported only for Chat Completions, Responses, and Messages',
		};
	}
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
	const usesPriceRouting = Boolean(
		preferences?.maxPrice
		|| preferences?.sort?.by === 'price'
		|| resolved.some((candidate) => candidate.modelVariant === 'floor'),
	);
	const canUseDefaultLoadBalancing = supportsDefaultProviderLoadBalancing(params);
	const deferPriceRoutingToSurface = params.requestProtocol === 'openai'
		&& (params.requestOperation === 'images.generations'
			|| params.requestOperation === 'images.edits');
	const usesGenericPriceRouting = usesPriceRouting && !deferPriceRoutingToSurface;
	const usesGlobalEndpointPartition = preferences?.sort?.partition === 'none';
	const pricingAt = params.pricingAt instanceof Date && Number.isFinite(params.pricingAt.getTime())
		? params.pricingAt
		: new Date();
	const businessTimezone = usesGenericPriceRouting || canUseDefaultLoadBalancing
		? await getBusinessTimezone(repos)
		: 'UTC';
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
	const routingPreferencesByCandidate: Array<ProviderPreferences | null> = Array.from(
		{ length: resolved.length },
		() => null,
	);
	const configuredTargetIdsByCandidate: string[][] = [];
	let firstSkippedCandidateFailure: Extract<ModelFallbackPlanResult, { ok: false }> | null = null;
	for (let index = 0; index < resolved.length; index += 1) {
		const candidate = resolved[index]!;
		const requestedModelId = params.modelIds[index]!;
		let routes = surfaces[index]!.routes.map((route) => ({
			...route,
			gatewayModelId: candidate.baseModelId,
			gatewayCandidateIndex: index,
			gatewaySessionIdControlled: serviceTierOperationSupported || undefined,
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
			// The verified policy fingerprint includes the configured Provider
			// account. A private credential changes that trust subject, so do not
			// inject BYOK until policy evidence can be verified per private key.
			routes = routes.map((route) => ({
				...route,
				gatewayPrivateByokDataPolicyAllowed: false,
			}));
		}
		const providerResult = preparedProvider.value.apply(routes, candidate.modelVariant);
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
		const candidatePreferences = providerResult.preferences;
		routingPreferencesByCandidate[index] = candidatePreferences;
		let selectedRoutes = providerResult.routes;
		const candidateUsesPriceRouting = Boolean(
			candidatePreferences?.maxPrice
			|| candidatePreferences?.sort?.by === 'price',
		);
		if (usesGenericPriceRouting && candidateUsesPriceRouting) {
			const priced = selectedRoutes.map((route) => ({
				route,
				price: comparableRoutePrice(route, pricingAt, businessTimezone),
			}));
			selectedRoutes = priced
				.filter((item) => routeSatisfiesComparableMaxPrice(item.price, candidatePreferences?.maxPrice ?? null))
				.sort((a, b) => candidatePreferences?.sort?.by === 'price'
					? comparableRoutePriceSortScore(a.price) - comparableRoutePriceSortScore(b.price)
					: 0)
				.map((item, priceIndex, all) => ({
					...item.route,
					routePriority: candidatePreferences?.sort?.by === 'price'
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
		if (candidatePreferences && (candidatePreferences.sort?.partition ?? 'model') === 'model') {
			selectedRoutes = await applyProviderPerformanceRouting(
				repos,
				selectedRoutes,
				candidatePreferences,
				pricingAt,
			);
		}
		const shouldUseDefaultLoadBalancing = canUseDefaultLoadBalancing
			&& candidatePreferences?.sort == null
			&& (candidatePreferences?.order.length ?? 0) === 0;
		if (shouldUseDefaultLoadBalancing) {
			const balanced = applyDefaultProviderLoadBalancing({
				routes: selectedRoutes,
				priceScore: (route) => comparableRoutePriceSortScore(
					comparableRoutePrice(route, pricingAt, businessTimezone),
				),
				now: pricingAt.getTime(),
			});
			selectedRoutes = balanced.routes;
		}
		eligibleRoutes.push(orderPriorityServiceTierFirst(selectedRoutes, candidatePreferences));
	}
	if (eligibleRoutes.every((routes) => routes.length === 0)) {
		return firstSkippedCandidateFailure ?? {
			ok: false,
			status: 502,
			code: GatewayErrorCode.noRoute,
			message: 'No configured route satisfies the requested provider preferences',
		};
	}
	if (usesGlobalEndpointPartition) {
		const globalSorts = new Set(
			routingPreferencesByCandidate
				.filter((candidatePreferences, index) => eligibleRoutes[index]?.length)
				.map((candidatePreferences) => candidatePreferences?.sort?.by ?? null),
		);
		if (globalSorts.size > 1) {
			return {
				ok: false,
				status: 400,
				code: GatewayErrorCode.invalidRequest,
				message: 'provider.sort.partition="none" cannot combine fallback models with different service-tier variant sorts',
			};
		}
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
			hasProviderPreferences: preparedProvider.value.hasPreferences || candidate.modelVariant !== null,
			routingPreferences: routingPreferencesByCandidate[index] ?? null,
	}));
	const finalized = await buildExecutionCandidates({
		repos,
		candidates,
		configuredTargetIdsByCandidate,
		pricingAt,
		businessTimezone,
		deferPriceRoutingToSurface,
	});
	return {
		ok: true,
		candidates: finalized.candidates,
		endpointPartition: finalized.endpointPartition,
		globalRoutes: finalized.globalRoutes,
	};
}

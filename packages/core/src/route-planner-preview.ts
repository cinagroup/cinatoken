import type { ModelEndpointRuntimeBindingRow } from './db/model-endpoints-types';
import type { RoutePerformanceSample } from './db/request-logs-types';
import type { ModelRouteJoinRow } from './storage/repository-dtos';
import type { ProviderRow } from './types';
import {
	modelEndpointSubjectFingerprintIsValid,
	modelEndpointSupportsOperation,
	parseVerifiedModelEndpointSnapshot,
	verifiedEndpointMatchesLegacyRoutingMetadata,
} from './model-endpoint-runtime';
import { computeRouteDataPolicySubjectFingerprintFromRows } from './route-data-policy';
import { isPendingProviderImportApiKey } from './db/provider-key-utils';
import { normalizeUpstreamProtocol } from './upstream-protocol';
import { providerSupportsUpstreamProtocol } from './provider-endpoints';
import {
	collectRoutePerformanceSeries,
	routePerformancePercentile,
} from './route-performance';
import {
	resolveComparableRoutePrice,
	type ComparableRoutePrice,
} from './route-comparable-price';

const PLANNER_PREVIEW_MAX_EXAMPLES = 100;
const OUTPUT_CAPACITY_OPERATIONS = new Set(['chat', 'responses', 'messages']);

export type GuardrailRoutePlannerExclusionReason =
	| 'provider_missing'
	| 'provider_inactive'
	| 'provider_credential_missing'
	| 'provider_shared_channel'
	| 'provider_protocol_unsupported'
	| 'endpoint_binding_missing'
	| 'endpoint_binding_ambiguous'
	| 'endpoint_invalid'
	| 'endpoint_identity_mismatch'
	| 'endpoint_subject_unverifiable'
	| 'endpoint_subject_mismatch'
	| 'endpoint_metadata_drift'
	| 'operation_unsupported';

export type GuardrailRoutePlannerPreview = {
	checkedCount: number;
	staticallyEligibleCount: number;
	excludedCount: number;
	excludedByReason: Partial<Record<GuardrailRoutePlannerExclusionReason, number>>;
	operationCapabilities: {
		verifiedCount: number;
		requestDependentCount: number;
	};
	outputCapacity: {
		applicableCount: number;
		knownCount: number;
		unknownCount: number;
		minimumTokens: number | null;
		maximumTokens: number | null;
	};
	pricing: {
		evidenceReadyCount: number;
		comparableCount: number;
		requestDependentCount: number;
		promptPerMillion: { minimum: number | null; maximum: number | null };
		completionPerMillion: { minimum: number | null; maximum: number | null };
		request: { minimum: number | null; maximum: number | null };
		image: { minimum: number | null; maximum: number | null };
		evaluatedAt: string;
		businessTimezone: string;
	};
	performance: {
		windowSeconds: number;
		checkedRoutes: number;
		truncated: boolean;
		sampledRoutes: number;
		unsampledRoutes: number;
		sampleCount: number;
		p50LatencyMs: number | null;
		p50ThroughputTokensPerSecond: number | null;
	};
	requestDependent: {
		wildcardOperationCount: number;
		explicitEndpointOptInCount: number;
	};
	circuit: {
		evaluated: false;
		scope: 'dispatch_isolate';
	};
	eligibleExamples: Array<{
		modelId: string;
		provider: string;
		protocol: string;
		operation: string;
		routeGroup: string;
	}>;
};

export type GuardrailRoutePlannerPreviewResult = {
	value: GuardrailRoutePlannerPreview;
	eligibleRoutes: ModelRouteJoinRow[];
};

function publicRoute(route: ModelRouteJoinRow) {
	return {
		modelId: route.model_id,
		provider: route.provider_name ?? route.provider_id,
		protocol: route.upstream_protocol,
		operation: route.upstream_operation,
		routeGroup: route.route_group,
	};
}

function finiteRange(values: readonly (number | null)[]): { minimum: number | null; maximum: number | null } {
	const finite = values.filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
	if (finite.length === 0) return { minimum: null, maximum: null };
	return { minimum: Math.min(...finite), maximum: Math.max(...finite) };
}

function comparablePriceHasValue(price: ComparableRoutePrice): boolean {
	return price.prompt != null || price.completion != null || price.request != null || price.image != null;
}

/**
 * Evaluate the request-independent portion of the same route gates used by
 * dispatch. Live provider preferences and the in-memory circuit are explicitly
 * request/isolate scoped and therefore reported, never guessed.
 */
export async function evaluateGuardrailRoutePlannerPreview(params: {
	candidateRoutes: readonly ModelRouteJoinRow[];
	providers: readonly ProviderRow[];
	bindings: readonly ModelEndpointRuntimeBindingRow[];
	performanceSamples: readonly RoutePerformanceSample[];
	performanceRouteTargetIds: readonly string[];
	performanceTruncated?: boolean;
	performanceWindowMs: number;
	pricingAt?: Date;
	businessTimezone: string;
	now?: Date;
}): Promise<GuardrailRoutePlannerPreviewResult> {
	const providerById = new Map(params.providers.map((provider) => [provider.id, provider]));
	const bindingByTargetId = new Map<string, ModelEndpointRuntimeBindingRow | null>();
	for (const binding of params.bindings) {
		bindingByTargetId.set(
			binding.route_target_id,
			bindingByTargetId.has(binding.route_target_id) ? null : binding,
		);
	}
	const excludedByReason: Partial<Record<GuardrailRoutePlannerExclusionReason, number>> = {};
	const exclude = (reason: GuardrailRoutePlannerExclusionReason) => {
		excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
	};
	const now = params.now ?? new Date();
	const pricingAt = params.pricingAt ?? now;
	const eligibleRoutes: ModelRouteJoinRow[] = [];
	const comparablePrices: ComparableRoutePrice[] = [];
	const capacities: number[] = [];
	let operationVerifiedCount = 0;
	let wildcardOperationCount = 0;
	let explicitEndpointOptInCount = 0;
	let capacityApplicableCount = 0;
	let capacityKnownCount = 0;
	let priceEvidenceReadyCount = 0;
	let priceRequestDependentCount = 0;

	for (const route of params.candidateRoutes) {
		const provider = providerById.get(route.provider_id);
		if (!provider) {
			exclude('provider_missing');
			continue;
		}
		if (provider.status !== 'active') {
			exclude('provider_inactive');
			continue;
		}
		if (!provider.api_key?.trim() || isPendingProviderImportApiKey(provider.api_key)) {
			exclude('provider_credential_missing');
			continue;
		}
		if (provider.shared_channel_type?.trim()) {
			exclude('provider_shared_channel');
			continue;
		}
		try {
			if (!providerSupportsUpstreamProtocol(normalizeUpstreamProtocol(route.upstream_protocol), provider)) {
				exclude('provider_protocol_unsupported');
				continue;
			}
		} catch {
			exclude('provider_protocol_unsupported');
			continue;
		}

		if (!bindingByTargetId.has(route.id)) {
			exclude('endpoint_binding_missing');
			continue;
		}
		const binding = bindingByTargetId.get(route.id);
		if (!binding) {
			exclude('endpoint_binding_ambiguous');
			continue;
		}
		const endpoint = parseVerifiedModelEndpointSnapshot(binding, now);
		if (!endpoint) {
			exclude('endpoint_invalid');
			continue;
		}
		if (
			binding.model_id !== route.model_id
			|| binding.provider_id !== route.provider_id
			|| endpoint.modelId !== route.model_id
			|| endpoint.providerId !== route.provider_id
		) {
			exclude('endpoint_identity_mismatch');
			continue;
		}
		let currentSubjectFingerprint: string;
		try {
			currentSubjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		} catch {
			exclude('endpoint_subject_unverifiable');
			continue;
		}
		if (
			!modelEndpointSubjectFingerprintIsValid(binding.subject_fingerprint)
			|| binding.subject_fingerprint !== currentSubjectFingerprint
		) {
			exclude('endpoint_subject_mismatch');
			continue;
		}
		if (!verifiedEndpointMatchesLegacyRoutingMetadata(endpoint, route.routing_metadata)) {
			exclude('endpoint_metadata_drift');
			continue;
		}

		const operation = route.upstream_operation?.trim() || '*';
		if (operation === '*') {
			wildcardOperationCount += 1;
			priceRequestDependentCount += 1;
		} else if (!modelEndpointSupportsOperation(endpoint, operation)) {
			exclude('operation_unsupported');
			continue;
		} else {
			operationVerifiedCount += 1;
		}
		if (operation !== '*' && OUTPUT_CAPACITY_OPERATIONS.has(operation)) {
			capacityApplicableCount += 1;
			if (endpoint.maxCompletionTokens != null) {
				capacityKnownCount += 1;
				capacities.push(endpoint.maxCompletionTokens);
			}
		}
		if (endpoint.selectorSlug.includes('/') && endpoint.endpointClass !== 'standard') {
			explicitEndpointOptInCount += 1;
		}
		const price = resolveComparableRoutePrice({
			pricing: endpoint.pricing,
			priceOverrideRaw: route.price_override,
			pricingAt,
			businessTimezone: params.businessTimezone,
		});
		if (comparablePriceHasValue(price)) {
			priceEvidenceReadyCount += 1;
			comparablePrices.push(price);
		} else if (operation !== '*') {
			// Image/audio prices depend on request dimensions and their dedicated
			// comparators; missing text prices must never be reported as comparable.
			priceRequestDependentCount += 1;
		}
		eligibleRoutes.push(route);
	}

	const performanceRouteTargetIds = new Set(params.performanceRouteTargetIds);
	const eligiblePerformanceIds = new Set(
		eligibleRoutes.map((route) => route.id).filter((id) => performanceRouteTargetIds.has(id)),
	);
	const performance = collectRoutePerformanceSeries({
		samples: params.performanceSamples,
		allowedRouteTargetIds: eligiblePerformanceIds,
	});
	const latencySeconds = [...performance.values()].flatMap((metric) => metric.latencySeconds);
	const throughput = [...performance.values()].flatMap((metric) => metric.throughputTokensPerSecond);
	const sampleCount = [...performance.values()].reduce((sum, metric) => sum + metric.sampleCount, 0);
	const checkedPerformanceRoutes = eligiblePerformanceIds.size;
	const capacityRange = finiteRange(capacities);

	return {
		eligibleRoutes,
		value: {
			checkedCount: params.candidateRoutes.length,
			staticallyEligibleCount: eligibleRoutes.length,
			excludedCount: params.candidateRoutes.length - eligibleRoutes.length,
			excludedByReason,
			operationCapabilities: {
				verifiedCount: operationVerifiedCount,
				requestDependentCount: wildcardOperationCount,
			},
			outputCapacity: {
				applicableCount: capacityApplicableCount,
				knownCount: capacityKnownCount,
				unknownCount: capacityApplicableCount - capacityKnownCount,
				minimumTokens: capacityRange.minimum,
				maximumTokens: capacityRange.maximum,
			},
			pricing: {
				evidenceReadyCount: priceEvidenceReadyCount,
				comparableCount: comparablePrices.length,
				requestDependentCount: priceRequestDependentCount,
				promptPerMillion: finiteRange(comparablePrices.map((price) => price.prompt)),
				completionPerMillion: finiteRange(comparablePrices.map((price) => price.completion)),
				request: finiteRange(comparablePrices.map((price) => price.request)),
				image: finiteRange(comparablePrices.map((price) => price.image)),
				evaluatedAt: pricingAt.toISOString(),
				businessTimezone: params.businessTimezone,
			},
			performance: {
				windowSeconds: Math.trunc(params.performanceWindowMs / 1_000),
				checkedRoutes: checkedPerformanceRoutes,
				truncated: params.performanceTruncated === true,
				sampledRoutes: performance.size,
				unsampledRoutes: Math.max(0, checkedPerformanceRoutes - performance.size),
				sampleCount,
				p50LatencyMs: (() => {
					const seconds = routePerformancePercentile(latencySeconds, 'p50');
					return seconds == null ? null : seconds * 1_000;
				})(),
				p50ThroughputTokensPerSecond: routePerformancePercentile(throughput, 'p50', true),
			},
			requestDependent: {
				wildcardOperationCount,
				explicitEndpointOptInCount,
			},
			circuit: {
				evaluated: false,
				scope: 'dispatch_isolate',
			},
			eligibleExamples: eligibleRoutes.slice(0, PLANNER_PREVIEW_MAX_EXAMPLES).map(publicRoute),
		},
	};
}

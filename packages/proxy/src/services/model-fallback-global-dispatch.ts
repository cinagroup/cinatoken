import type { GatewayRepositories } from '@octafuse/core';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import type { FailoverDispatchOptions, ProxyDispatchAttemptTrace } from './failover-dispatch';
import { GatewayErrorCode } from './gateway-error-codes';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import type { ModelFallbackTraceAttempt } from './model-fallbacks';
import type { RouteResult } from './model-router';
import type { ProxyResult, RouteRequestBody } from './proxy';
import { formatHttpErrorTextForRequestLog } from './request-log-record-status';
import { getUserModelCircuitOpen } from './user-model-circuit-breaker';
import { maybeTriggerUserModelCircuitFromUpstream } from './user-model-circuit-route';

export type GlobalTextProxy = (
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: RouteRequestBody,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
) => Promise<ProxyResult>;

export type GlobalModelFallbackDispatchResult =
	| {
		ok: false;
		blockedCandidateIndex: number;
		fallbackAttempts: ModelFallbackTraceAttempt[];
	}
	| {
		ok: true;
		result: ProxyResult;
		selectedPlan: ModelFallbackCandidatePlan;
		fallbackAttempts: ModelFallbackTraceAttempt[];
		userModelCircuitEvents: GatewayCircuitAlertEvent[];
	};

function circuitAttempt(
	candidate: ModelFallbackCandidatePlan,
	reason: 'client_error' | 'sensitive_content',
): ModelFallbackTraceAttempt {
	return {
		model: candidate.requestedModelId,
		base_model: candidate.baseModelId,
		route_group: candidate.effectiveRouteGroup,
		status: reason === 'client_error' ? 400 : 429,
		outcome: 'circuit_open',
		error_code: reason === 'client_error'
			? GatewayErrorCode.circuitClientError
			: GatewayErrorCode.circuitSensitiveContent,
	};
}

function attemptSummary(
	candidate: ModelFallbackCandidatePlan,
	attempt: ProxyDispatchAttemptTrace,
): ModelFallbackTraceAttempt {
	return {
		model: candidate.requestedModelId,
		base_model: candidate.baseModelId,
		route_group: candidate.effectiveRouteGroup,
		status: attempt.status ?? 502,
		outcome: attempt.outcome === 'success' ? 'success' : 'error',
		provider_id: attempt.providerId,
		route_target_id: attempt.routeTargetId,
	};
}

function firstGlobalRankByCandidate(routes: RouteResult[]): Map<number, number> {
	const ranks = new Map<number, number>();
	for (const route of routes) {
		const index = route.gatewayCandidateIndex;
		if (typeof index !== 'number' || ranks.has(index)) continue;
		ranks.set(index, route.gatewayGlobalEndpointRank ?? Number.MAX_SAFE_INTEGER);
	}
	return ranks;
}

/**
 * Execute partition=none as one dispatcher invocation. This is intentionally
 * separate from the ordinary per-model loop: restarting failover per endpoint
 * would lose replay prohibitions, unknown-outcome state, and shared-key order.
 */
export async function dispatchGlobalModelFallback(params: {
	repos: GatewayRepositories;
	candidates: ModelFallbackCandidatePlan[];
	globalRoutes: RouteResult[];
	userId: string;
	requestSignal?: AbortSignal;
	publicCorrelationId?: string;
	timing: NonNullable<FailoverDispatchOptions['timing']>;
	beforeUpstreamDispatch: () => Promise<void>;
	proxy: GlobalTextProxy;
	affinityKey: string;
	tierKeyPrefix: string;
}): Promise<GlobalModelFallbackDispatchResult> {
	const openByCandidate = new Map<number, NonNullable<ReturnType<typeof getUserModelCircuitOpen>>>();
	for (let index = 0; index < params.candidates.length; index += 1) {
		const candidate = params.candidates[index]!;
		const open = getUserModelCircuitOpen(params.userId, candidate.baseModelId);
		if (open) openByCandidate.set(index, open);
	}

	const eligibleRoutes = params.globalRoutes.filter((route) => {
		const index = route.gatewayCandidateIndex;
		return typeof index === 'number' && !openByCandidate.has(index);
	});
	if (eligibleRoutes.length === 0) {
		const blockedCandidateIndex = [...openByCandidate.keys()].at(-1) ?? 0;
		return {
			ok: false,
			blockedCandidateIndex,
			fallbackAttempts: [...openByCandidate.entries()].map(([index, open]) =>
				circuitAttempt(params.candidates[index]!, open.reason),
			),
		};
	}

	const bodyForRoute: RouteRequestBody = (route) => {
		const index = route.gatewayCandidateIndex;
		if (typeof index !== 'number' || !params.candidates[index]) {
			throw new Error('Global endpoint lost its model candidate context');
		}
		return params.candidates[index]!.upstreamBody;
	};
	const result = await params.proxy(
		params.repos,
		eligibleRoutes,
		bodyForRoute,
		params.requestSignal,
		{
			affinityKey: params.affinityKey,
			tierKeyPrefix: params.tierKeyPrefix,
			strategy: 'weight_priority',
			tierStrategies: null,
			timing: params.timing,
			routePoolId: null,
			sticky: null,
			beforeUpstreamDispatch: params.beforeUpstreamDispatch,
			crossModelCandidateFailover: true,
		},
		params.publicCorrelationId,
	);

	const selectedIndex = result.chosenRoute.gatewayCandidateIndex;
	if (typeof selectedIndex !== 'number' || !params.candidates[selectedIndex]) {
		throw new Error('Global dispatcher returned a route without model candidate context');
	}
	const selectedPlan = params.candidates[selectedIndex]!;
	const traces = result.dispatchAttempts ?? [];
	const lastAttemptByCandidate = new Map<number, ProxyDispatchAttemptTrace>();
	const firstSeenCandidateIndexes: number[] = [];
	for (const attempt of traces) {
		const index = attempt.candidateIndex;
		if (index == null || !params.candidates[index]) continue;
		if (!lastAttemptByCandidate.has(index)) firstSeenCandidateIndexes.push(index);
		lastAttemptByCandidate.set(index, attempt);
	}

	const selectedRank = result.response.ok
		? result.chosenRoute.gatewayGlobalEndpointRank ?? Number.MAX_SAFE_INTEGER
		: Number.MAX_SAFE_INTEGER;
	const firstRanks = firstGlobalRankByCandidate(params.globalRoutes);
	const blockedAttempts = [...openByCandidate.entries()]
		.filter(([index]) => (firstRanks.get(index) ?? Number.MAX_SAFE_INTEGER) <= selectedRank)
		.map(([index, open]) => circuitAttempt(params.candidates[index]!, open.reason));
	const orderedIndexes = [
		...firstSeenCandidateIndexes.filter((index) => index !== selectedIndex),
		...(lastAttemptByCandidate.has(selectedIndex) ? [selectedIndex] : []),
	];
	const fallbackAttempts = [
		...blockedAttempts,
		...orderedIndexes.map((index) =>
			attemptSummary(params.candidates[index]!, lastAttemptByCandidate.get(index)!),
		),
	];

	const userModelCircuitEvents: GatewayCircuitAlertEvent[] = [];
	for (const [index, attempt] of lastAttemptByCandidate) {
		if (attempt.outcome === 'success' || attempt.errorBodyText == null || attempt.status == null) continue;
		const event = maybeTriggerUserModelCircuitFromUpstream(
			params.userId,
			params.candidates[index]!.baseModelId,
			attempt.status,
			attempt.contentType ?? null,
			attempt.errorBodyText,
			formatHttpErrorTextForRequestLog(
				attempt.status,
				attempt.contentType ?? null,
				attempt.errorBodyText,
			),
		);
		if (event) userModelCircuitEvents.push(event);
	}

	return {
		ok: true,
		result,
		selectedPlan,
		fallbackAttempts,
		userModelCircuitEvents,
	};
}

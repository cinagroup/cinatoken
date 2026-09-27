import { isRouteStrategyName } from '@octafuse/core';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import type { CredentialFreeRoutingProjectionV396, CredentialFreeRoutingCandidateV396,
	CredentialFreeRoutingRouteV396 } from './postgres-complete-text-routing-projection-v396';
import { applyDefaultProviderLoadBalancing } from './provider-default-load-balancing';
import { buildRouteAttemptPlan } from './route-attempt-planner';
import { buildAffinityKey, buildTierKeyPrefix } from './route-strategies';
import { buildOpenRouterSessionAffinityKey, resolveOpenRouterStickyRouting,
	type OpenRouterSessionRouting, type OpenRouterStickySuccessPolicy } from './openrouter-session-routing';
import { hashAffinityKey, mergeStickyIntoAttempts, resolveStickySession,
	type StickyRoutingPorts, type StickySession } from './provider-sticky-routing';

const SHA = /^[0-9a-f]{64}$/u;
const EMPTY_SESSION: OpenRouterSessionRouting = Object.freeze({ sessionId: null, source: null,
	stickyKeyDigest: null, stickySource: null, stickySuccessPolicy: null });
function invalid(): never { throw new TypeError('Credential-free route preparation invalid'); }

export type CredentialFreeStickyContextV398 = Readonly<{
	quoteId: string; requestId: string; finalBodySha256: string; routingEpoch: string;
	candidateIndex: number; routePoolId: string; affinityHash: string;
	sessionControlled: boolean; successPolicy: OpenRouterStickySuccessPolicy | null;
}>;
export type CredentialFreePreparedCandidateV398 = Readonly<{
	candidateIndex: number; modelId: string; attempts: readonly CredentialFreeRoutingRouteV396[];
	earliestRetryAfterMs: number | null; skippedByCircuit: number;
	stickySession: StickySession | null; stickyContext: CredentialFreeStickyContextV398 | null;
}>;
export type CredentialFreeRouteAttemptsV398 = Readonly<{
	requestId: string; quoteId: string; finalBodySha256: string; routingEpoch: string;
	candidates: readonly CredentialFreePreparedCandidateV398[];
}>;

/**
 * Prepares the default platform Chat attempt order from an acknowledged v396
 * projection. It is not the public ingress parser or a dispatch/fallback loop.
 * Explicit provider controls must be resolved by the ingress adapter before
 * that adapter can use this default-policy path.
 */
export async function prepareCredentialFreeRouteAttemptsV398(params: {
	projection: CredentialFreeRoutingProjectionV396;
	finalQuoteInput: FinalChatQuoteSnapshot;
	identity: Readonly<{ userId: string; workspaceId: string }>;
	sessionRouting?: OpenRouterSessionRouting;
	createStickyPorts?: (context: CredentialFreeStickyContextV398) => StickyRoutingPorts;
	now?: number; randomUnit?: () => number; signal?: AbortSignal;
}): Promise<CredentialFreeRouteAttemptsV398> {
	const signal = params.signal;
	let expiresAt = Number.POSITIVE_INFINITY;
	const ensureLive = () => {
		if (signal?.aborted) throw new Error('Credential-free route preparation stopped');
		// `now` controls routing health/order; projection freshness uses the live
		// clock and the deadline captured before any caller-owned async work.
		if (Date.now() >= expiresAt) invalid();
	};
	ensureLive();
	const now = params.now ?? Date.now();
	const original = params.projection, input = params.finalQuoteInput;
	const userId = params.identity?.userId, workspaceId = params.identity?.workspaceId;
	if (!original || !input || typeof userId !== 'string' || !userId || typeof workspaceId !== 'string' || !workspaceId
		|| !Number.isSafeInteger(now) || original.requestId !== input.requestId
		|| original.finalBodySha256 !== input.finalBodySha256 || !SHA.test(input.finalBodySha256)
		|| !/^[1-9][0-9]*$/u.test(original.routingEpoch) || !original.quoteId
		|| Date.parse(original.expiresAt) <= now || !Number.isFinite(Date.parse(original.expiresAt))
		|| original.modelIds.length < 1 || original.modelIds.length > 8
		|| original.modelIds.length !== input.modelIds.length
		|| original.modelIds.some((model, index) => model !== input.modelIds[index])
		|| original.candidates.length !== original.modelIds.length) invalid();
	expiresAt = Date.parse(original.expiresAt);
	ensureLive();
	const requestId = original.requestId, quoteId = original.quoteId, routingEpoch = original.routingEpoch;
	const finalBodySha256 = input.finalBodySha256, finalBodyUtf8 = input.finalBodyUtf8;
	const createStickyPorts = params.createStickyPorts, randomUnit = params.randomUnit;
	const capturedSession = Object.freeze({ ...(params.sessionRouting ?? EMPTY_SESSION) });
	let body: Record<string, unknown>;
	try { body = JSON.parse(finalBodyUtf8) as Record<string, unknown>; } catch { return invalid(); }
	if (!body || typeof body !== 'object' || Array.isArray(body)
		|| !Array.isArray(body.models) || body.models.length !== original.modelIds.length
		|| body.models.some((model, index) => model !== original.modelIds[index])) invalid();
	let requiredTokens = 0;
	for (const field of ['max_tokens', 'max_completion_tokens']) {
		const value = body[field];
		if (value == null) continue;
		if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid();
		requiredTokens = Math.max(requiredTokens, value as number);
	}
	if (requiredTokens === 0) invalid();
	// Copy every caller-owned field before the first asynchronous hash/read.
	const candidates = original.candidates.map((candidate, index): CredentialFreeRoutingCandidateV396 => {
		if (candidate.candidateIndex !== index || candidate.modelId !== original.modelIds[index]
			|| candidate.routeGroup !== 'default' || candidate.requestProtocol !== 'openai'
			|| candidate.requestOperation !== 'chat' || !isRouteStrategyName(candidate.strategy.base)) invalid();
		const seen = new Set<string>();
		const routes = candidate.routes.map(route => {
			if (!route.targetId || !route.providerId || seen.has(route.targetId)
				|| !Number.isSafeInteger(route.routePriority) || !Number.isFinite(route.routeWeight) || route.routeWeight <= 0
				|| !/^[1-9][0-9]*$/u.test(route.sourceGeneration) || !SHA.test(route.attestedSourceSha256)
				|| !route.endpointId || !['standard', 'service_tier', null].includes(route.endpointClass)
				|| typeof route.defaultEndpointEligible !== 'boolean'
				|| (route.routePoolId !== null && (typeof route.routePoolId !== 'string' || !route.routePoolId))
				|| (route.maxCompletionTokens !== null && (!Number.isSafeInteger(route.maxCompletionTokens) || route.maxCompletionTokens < 1))
				|| (route.priceScore !== null && (!Number.isFinite(route.priceScore) || route.priceScore < 0))
				|| typeof route.beneficialCacheReadPricing !== 'boolean') invalid();
			seen.add(route.targetId);
			return Object.freeze({ targetId: route.targetId, providerId: route.providerId,
				routePoolId: route.routePoolId, routePriority: route.routePriority, routeWeight: route.routeWeight,
				sourceGeneration: route.sourceGeneration, attestedSourceSha256: route.attestedSourceSha256,
				endpointId: route.endpointId, endpointClass: route.endpointClass, defaultEndpointEligible: route.defaultEndpointEligible,
				maxCompletionTokens: route.maxCompletionTokens, priceScore: route.priceScore,
				beneficialCacheReadPricing: route.beneficialCacheReadPricing });
		});
		const tierOverrides = candidate.strategy.tierOverrides.map(tier => {
			if (!Number.isSafeInteger(tier.priority) || !isRouteStrategyName(tier.strategy)) invalid();
			return Object.freeze({ priority: tier.priority, strategy: tier.strategy });
		});
		const surface = candidate.surface === null ? null : Object.freeze({ id: candidate.surface.id,
			poolId: candidate.surface.poolId, match: candidate.surface.match,
			sticky: Object.freeze({ ...candidate.surface.sticky }) });
		return Object.freeze({ candidateIndex: index, modelId: candidate.modelId, routeGroup: 'default',
			requestProtocol: 'openai', requestOperation: 'chat', surface,
			strategy: Object.freeze({ base: candidate.strategy.base, tierOverrides: Object.freeze(tierOverrides) }),
			routes: Object.freeze(routes) });
	});
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(finalBodyUtf8));
	ensureLive();
	if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== finalBodySha256) invalid();
	const session = resolveOpenRouterStickyRouting(capturedSession, body, 'chat');
	const prepared: CredentialFreePreparedCandidateV398[] = [];
	for (const candidate of candidates) {
		ensureLive();
		if (candidate.routes.length === 0) throw new Error('No eligible route for a model candidate');
		const capacityRoutes = candidate.routes.filter(route => route.maxCompletionTokens !== null && route.maxCompletionTokens >= requiredTokens);
		if (capacityRoutes.length === 0) throw new Error('No verified output capacity for a model candidate');
		const standardRoutes = capacityRoutes.filter(route => route.defaultEndpointEligible);
		if (standardRoutes.length === 0) throw new Error('No standard endpoint for a model candidate');
		const balanced = applyDefaultProviderLoadBalancing({ routes: standardRoutes, priceScore: route => route.priceScore,
			now, randomUnit });
		const controlled = session.stickyKeyDigest !== null && session.stickySource !== null && session.stickySuccessPolicy !== null;
		const affinityKey = controlled ? buildOpenRouterSessionAffinityKey({ userId, workspaceId,
			stickyKeyDigest: session.stickyKeyDigest!, stickySource: session.stickySource!, baseModelId: candidate.modelId })
			: buildAffinityKey(userId, candidate.modelId, 'default', 'openai');
		const plan = buildRouteAttemptPlan(balanced.routes, { affinityKey,
			tierKeyPrefix: buildTierKeyPrefix(candidate.modelId, 'default', 'openai') }, candidate.strategy.base,
			now, new Map(candidate.strategy.tierOverrides.map(tier => [tier.priority, tier.strategy])));
		const pool = candidate.surface?.poolId ?? balanced.routes.find(route => route.routePoolId)?.routePoolId ?? null;
		const config = controlled ? { enabled: true, idleTtlSeconds: 600, epoch: candidate.surface?.sticky.epoch ?? 0 }
			: candidate.surface?.sticky ?? { enabled: false, idleTtlSeconds: 3600, epoch: 0 };
		const availableTargets = new Set(plan.attempts.map(route => route.targetId));
		const stickyCandidates = session.stickySuccessPolicy === 'cache_hit'
			? standardRoutes.filter(route => route.beneficialCacheReadPricing) : standardRoutes;
		let stickySession: StickySession | null = null, stickyContext: CredentialFreeStickyContextV398 | null = null;
		let stickyRoute: CredentialFreeRoutingRouteV396 | null = null;
		if (pool && config.enabled && stickyCandidates.length > 0) {
			if (!createStickyPorts) throw new Error('Quote-bound sticky routing port required');
			const affinityHash = await hashAffinityKey(affinityKey); ensureLive();
			stickyContext = Object.freeze({ quoteId, requestId, finalBodySha256, routingEpoch,
				candidateIndex: candidate.candidateIndex, routePoolId: pool, affinityHash,
				sessionControlled: controlled, successPolicy: session.stickySuccessPolicy });
			const lookup = await resolveStickySession(createStickyPorts(stickyContext), { routePoolId: pool, affinityKey,
				config, candidates: stickyCandidates, targetAvailable: route => availableTargets.has(route.targetId), nowMs: now });
			ensureLive(); stickySession = lookup.session; stickyRoute = lookup.stickyRoute;
		}
		prepared.push(Object.freeze({ candidateIndex: candidate.candidateIndex, modelId: candidate.modelId,
			attempts: Object.freeze(mergeStickyIntoAttempts(plan.attempts, stickyRoute)),
			earliestRetryAfterMs: plan.earliestRetryAfterMs, skippedByCircuit: plan.skippedByCircuit,
			stickySession, stickyContext }));
	}
	ensureLive();
	return Object.freeze({ requestId, quoteId, finalBodySha256, routingEpoch, candidates: Object.freeze(prepared) });
}

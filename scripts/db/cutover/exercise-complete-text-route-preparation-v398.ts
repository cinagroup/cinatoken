import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { comparableRoutePriceSortScore, resolveComparableRoutePrice } from '../../../packages/core/src/index';
import { resetRouteStrategyCacheForTests } from '../../../packages/core/src/lib/route-strategy-system-config';
import { createPostgresStorageContext } from '../../../packages/core/src/storage/context';
import type { PostgresDatabaseClient } from '../../../packages/core/src/storage/database-client';
import type { FinalChatQuoteSnapshot } from '../../../packages/proxy/src/services/chat-final-quote-input';
import { prepareCredentialFreeRouteAttemptsV398 } from '../../../packages/proxy/src/services/credential-free-route-attempts-v398';
import type { CredentialFreeRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396';
import { createPostgresCompleteTextStickyRoutingV398 } from '../../../packages/proxy/src/services/postgres-complete-text-sticky-routing-v398';
import { buildModelFallbackPlan } from '../../../packages/proxy/src/services/model-fallback-plan';
import { resolveRoutesForSurface } from '../../../packages/proxy/src/services/model-router';
import { buildRouteAttemptPlan } from '../../../packages/proxy/src/services/route-attempt-planner';
import { buildTierKeyPrefix, resetWeightedRoundRobinStateForTests } from '../../../packages/proxy/src/services/route-strategies';
import { getProviderCircuitRemainingMs, markProviderFailure, resetProviderCircuitStateForTests } from '../../../packages/proxy/src/services/provider-circuit-breaker';
import { mergeStickyIntoAttempts, resolveStickySession } from '../../../packages/proxy/src/services/provider-sticky-routing';
import { isDefaultEndpointRouteEligible } from '../../../packages/proxy/src/services/provider-routing-preferences';
import { openRouterSessionDispatchOptions, resolveOpenRouterStickyRouting, routeHasBeneficialCacheReadPricing,
	type OpenRouterSessionRouting } from '../../../packages/proxy/src/services/openrouter-session-routing';

type Sql = PostgresDatabaseClient['raw'];
type Params = {
	projection: CredentialFreeRoutingProjectionV396; finalQuoteInput: FinalChatQuoteSnapshot;
	runtimeConnectionString: string; stickyConnectionString: string; auditor: Sql;
	stage: (name: string, detail?: Record<string, unknown>) => void;
	label?: string; observedTargetId?: string;
};

// Both paths execute the actual implementations. Only their stochastic input
// and process-local test state are controlled, so random ordering is comparable.
// The caller must invoke this owned native fixture serially after Worker drain.
async function withEntropy<T>(unit: number, work: () => Promise<T>): Promise<T> {
	const previousMath = Math.random, previousCrypto = globalThis.crypto.getRandomValues;
	Math.random = () => unit;
	globalThis.crypto.getRandomValues = ((array: Uint32Array) => {
		assert.ok(array instanceof Uint32Array, 'unexpected entropy consumer in preparation oracle');
		array.fill(Math.floor(unit * 0x1_0000_0000)); return array;
	}) as Crypto['getRandomValues'];
	resetWeightedRoundRobinStateForTests(); resetRouteStrategyCacheForTests();
	try { return await work(); }
	finally { Math.random = previousMath; globalThis.crypto.getRandomValues = previousCrypto; }
}

/**
 * Acknowledged, same-database projection -> new preparer versus the existing
 * complete model preflight and exported dispatch preparation primitives.
 * This verifies the default platform Chat subset; it does not wire public ingress.
 */
export async function exerciseCompleteTextRoutePreparationV398(p: Params) {
	const label = p.label ?? (p.observedTargetId ? 'observed' : 'projection');
	const [quote] = await p.auditor.unsafe(`SELECT user_id,workspace_id,request_id,final_body_sha256
	 FROM cinatoken_gateway.complete_text_quotes_v360 WHERE quote_id=$1::uuid`, [p.projection.quoteId]);
	assert.equal(quote?.request_id, p.finalQuoteInput.requestId);
	assert.equal(quote?.final_body_sha256, p.finalQuoteInput.finalBodySha256);
	const identity = { userId: String(quote!.user_id), workspaceId: String(quote!.workspace_id) };
	const body = JSON.parse(p.finalQuoteInput.finalBodyUtf8) as Record<string, unknown>;
	const routing: OpenRouterSessionRouting = { sessionId: `owned-v398:${p.projection.quoteId}`, source: 'header',
		stickyKeyDigest: null, stickySource: null, stickySuccessPolicy: null };
	const resolvedSession = resolveOpenRouterStickyRouting(routing, body, 'chat');
	const storage = await createPostgresStorageContext(p.runtimeConnectionString, {
		max: 1, prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
		max_lifetime: 0, backoff: false, onnotice() {},
	});
	assert.equal(storage.client.driver, 'postgres');
	const runtime = storage.client as PostgresDatabaseClient;
	const repos = storage.repositories;
	const now = Date.now();
	const financial = async () => (await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM cinatoken_gateway.complete_text_attempt_grants_v362) AS grants,
	 (SELECT count(*) FROM cinatoken_gateway.complete_text_send_starts_v365) AS starts,
	 (SELECT count(*) FROM cinatoken_gateway.complete_text_result_facts_v366) AS facts,
	 (SELECT count(*) FROM cinatoken_response_observation.observations_v392) AS observations,
	 (SELECT count(*) FROM cinatoken_gateway.user_budget_reservations WHERE state='dispatched') AS ordinary_holds,
	 (SELECT count(*) FROM cinatoken_gateway.guardrail_budget_reservations WHERE state='dispatched') AS guardrail_holds,
	 (SELECT count(*) FROM cinatoken_gateway.api_key_request_logs) AS buyer_logs`))[0];
	const before = await financial();
	let cleanup: (() => Promise<void>) | undefined;
	try {
		resetProviderCircuitStateForTests();
		// Compare attested safe fields with real repository parsing before either
		// path rewrites priorities for price load balancing or circuit filtering.
		for (const candidate of p.projection.candidates) {
			const raw = await resolveRoutesForSurface(repos, { modelId: candidate.modelId,
				routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat' });
			assert.deepEqual(candidate.routes.map(r => r.targetId), raw.routes.map(r => r.targetId));
			for (const route of candidate.routes) {
				const actual = raw.routes.find(r => r.targetId === route.targetId)!;
				assert.deepEqual({ provider: route.providerId, pool: route.routePoolId, priority: route.routePriority,
					weight: route.routeWeight, endpoint: route.endpointId, endpointClass: route.endpointClass,
					capacity: route.maxCompletionTokens, defaultEligible: route.defaultEndpointEligible,
					cacheBeneficial: route.beneficialCacheReadPricing },
				{ provider: actual.providerId, pool: actual.routePoolId, priority: actual.routePriority,
					weight: actual.routeWeight, endpoint: actual.endpoint!.id, endpointClass: actual.endpoint!.endpointClass,
					capacity: actual.endpoint!.maxCompletionTokens, defaultEligible: isDefaultEndpointRouteEligible(actual),
					cacheBeneficial: routeHasBeneficialCacheReadPricing(actual) });
				const price = comparableRoutePriceSortScore(resolveComparableRoutePrice({ pricing: actual.endpoint!.pricing,
					priceOverrideRaw: actual.priceOverrideRaw, pricingAt: new Date(now), businessTimezone: 'UTC' }));
				assert.equal(route.priceScore, Number.isFinite(price) && price >= 0 ? price : null);
			}
		}
		const prepare = (unit: number) => withEntropy(unit, () => prepareCredentialFreeRouteAttemptsV398({
			projection: p.projection, finalQuoteInput: p.finalQuoteInput, identity, sessionRouting: routing,
			now, randomUnit: () => unit, createStickyPorts: context => createPostgresCompleteTextStickyRoutingV398({
				stickyConnectionString: p.stickyConnectionString, context }),
		}));
		const oracle = (unit: number) => withEntropy(unit, async () => {
			const legacy = await buildModelFallbackPlan(repos, { modelIds: [...p.projection.modelIds], body,
				requestProtocol: 'openai', requestOperation: 'chat', pricingAt: new Date(now) });
			assert.equal(legacy.ok, true, JSON.stringify(legacy));
			if (!legacy.ok) throw new Error('Existing complete preparation rejected the actual fixture');
			return Promise.all(legacy.candidates.map(async (candidate, candidateIndex) => {
				assert.equal(candidate.strategy.base, p.projection.candidates[candidateIndex]!.strategy.base);
				assert.deepEqual([...candidate.strategy.tierOverrides].map(([priority, strategy]) => ({ priority, strategy })),
					p.projection.candidates[candidateIndex]!.strategy.tierOverrides);
				const session = openRouterSessionDispatchOptions({ routing: resolvedSession, ...identity,
					baseModelId: candidate.baseModelId, routeGroup: candidate.effectiveRouteGroup, protocol: 'openai',
					surface: candidate.surface, hasProviderPreferences: candidate.hasProviderPreferences,
					routingPreferences: candidate.routingPreferences });
				const plan = buildRouteAttemptPlan(candidate.routes, { affinityKey: session.affinityKey,
					tierKeyPrefix: buildTierKeyPrefix(candidate.baseModelId, candidate.effectiveRouteGroup, 'openai') },
					candidate.strategy.base, now, candidate.strategy.tierOverrides, { filterCircuit: false });
				// v360 excludes shared and BYOK credentials; platform circuit keys
				// are provider IDs, exactly as the existing dispatch preparation.
				let skippedByCircuit = 0, earliestRetryAfterMs: number | null = null;
				const available = plan.attempts.filter(route => {
					const remaining = getProviderCircuitRemainingMs(route.providerId, now);
					if (remaining <= 0) return true;
					skippedByCircuit++;
					earliestRetryAfterMs = earliestRetryAfterMs === null ? remaining : Math.min(earliestRetryAfterMs, remaining);
					return false;
				});
				const availableTargets = new Set(available.map(r => r.targetId));
				const candidates = session.stickyRouteEligible ? candidate.routes.filter(session.stickyRouteEligible) : candidate.routes;
				const pool = candidate.surface?.route_pool_id ?? candidate.routes.find(r => r.routePoolId)?.routePoolId ?? null;
				const sticky = session.sticky?.enabled && candidates.length > 0
					? await resolveStickySession(repos, { routePoolId: pool, affinityKey: session.affinityKey,
						config: session.sticky, candidates, targetAvailable: route => availableTargets.has(route.targetId), nowMs: now })
					: { session: null, stickyRoute: null };
				return { candidateIndex, modelId: candidate.baseModelId,
					attempts: mergeStickyIntoAttempts(available, sticky.stickyRoute).map(r => r.targetId),
					skippedByCircuit, earliestRetryAfterMs, sticky: sticky.session ? {
						pool: sticky.session.routePoolId, affinityHash: sticky.session.affinityHash,
						lookup: sticky.session.lookup, result: sticky.session.result, target: sticky.session.boundTargetId,
						token: sticky.session.bindingToken, staleToken: sticky.session.staleToken, config: sticky.session.config,
					} : null };
			}));
		});
		const compare = async (unit: number) => {
			const expected = await oracle(unit), actual = await prepare(unit);
			const safe = actual.candidates.map(candidate => ({ candidateIndex: candidate.candidateIndex, modelId: candidate.modelId,
				attempts: candidate.attempts.map(r => r.targetId), skippedByCircuit: candidate.skippedByCircuit,
				earliestRetryAfterMs: candidate.earliestRetryAfterMs, sticky: candidate.stickySession ? {
					pool: candidate.stickySession.routePoolId, affinityHash: candidate.stickySession.affinityHash,
					lookup: candidate.stickySession.lookup, result: candidate.stickySession.result, target: candidate.stickySession.boundTargetId,
					token: candidate.stickySession.bindingToken, staleToken: candidate.stickySession.staleToken,
					config: candidate.stickySession.config,
				} : null }));
			assert.deepEqual(safe, expected);
			for (const [index, candidate] of actual.candidates.entries()) {
				assert.equal(candidate.stickyContext?.routePoolId ?? null, expected[index]!.sticky?.pool ?? null);
				assert.equal(candidate.stickyContext?.affinityHash ?? null, expected[index]!.sticky?.affinityHash ?? null);
			}
			return actual;
		};
		const baseline = await compare(0.125); await compare(0.875);
		p.stage(`v398-real-projection-full-preparation-oracle-${label}`, { candidates: baseline.candidates.map(candidate => ({
			model: candidate.modelId, attempts: candidate.attempts.map(r => r.targetId) })), entropy: [0.125, 0.875] });
		if (p.observedTargetId) {
			const candidate = baseline.candidates.find(c => c.attempts.some(r => r.targetId === p.observedTargetId))!;
			assert.ok(candidate?.stickyContext, 'observed fixture must have a real quote-bound sticky namespace');
			const context = candidate.stickyContext!;
			const port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: p.stickyConnectionString, context });
			const token = randomUUID();
			assert.equal(await port.routePoolSticky.tryBind({ routePoolId: context.routePoolId, affinityHash: context.affinityHash,
				routeTargetId: p.observedTargetId, bindingToken: token, poolEpoch: -123,
				expiresAt: '2099-01-01T00:00:00Z', nowIso: '2000-01-01T00:00:00Z' }), true);
			cleanup = async () => { assert.equal(await port.routePoolSticky.clearBinding({ routePoolId: context.routePoolId,
				affinityHash: context.affinityHash, expectedToken: token }), true); };
			const hit = await compare(0.875), prepared = hit.candidates[candidate.candidateIndex]!;
			assert.equal(prepared.stickySession?.lookup, 'hit');
			assert.equal(prepared.stickySession?.bindingToken, token);
			assert.equal(prepared.attempts[0]!.targetId, p.observedTargetId);
			p.stage('v398-real-response-proof-binding-new-and-old-preparation-read-same-sticky-hit', {
				candidate: candidate.candidateIndex, target: p.observedTargetId, bindingToken: token });
		}
		const provider = p.projection.candidates.flatMap(c => c.routes)[0]!.providerId;
		markProviderFailure(provider, 'rate_limit', 5_000, now);
		const circuit = await compare(0.125);
		assert.ok(circuit.candidates.some(candidate => candidate.skippedByCircuit > 0));
		assert.ok(circuit.candidates.some(candidate => candidate.earliestRetryAfterMs === 5_000));
		p.stage(`v398-real-projection-provider-circuit-retry-after-oracle-${label}`, { provider,
			skipped: circuit.candidates.map(c => c.skippedByCircuit), retryAfterMs: 5_000 });
		assert.deepEqual(await financial(), before);
		p.stage(`v398-preparation-oracle-no-financial-write-${label}`);
	} finally {
		try { if (cleanup) await cleanup(); }
		finally {
			resetProviderCircuitStateForTests(); resetWeightedRoundRobinStateForTests(); resetRouteStrategyCacheForTests();
			await runtime.raw.end({ timeout: 1 });
		}
	}
}

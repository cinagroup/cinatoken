import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	GuardrailBudgetIntent,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import type { ApiKeyContext } from '../middleware/auth';
import {
	AuthenticatedChatBudgetProofError,
	createAuthenticatedChatBudgetProof,
} from './authenticated-chat-budget-proof';
import { failoverDispatch } from './failover-dispatch';
import { estimateOrdinaryBudgetChargedCost } from './guardrail-budget-estimate';
import type { ModelFallbackCandidatePlan, ModelFallbackPlanResult } from './model-fallback-plan';
import type { RouteResult } from './model-router';
import { ordinaryBudgetReservationMicros } from './ordinary-budget-lifecycle';
import type { OrdinaryBudgetRepositories } from './ordinary-budget-lifecycle';
import type { GuardrailBudgetRequestPort } from './request-budget-admission';
import { EMPTY_USAGE } from './proxy';
import { MAX_REQUEST_DISPATCHES } from './request-dispatch-budget';

const NOW = new Date('2026-09-25T04:00:00.000Z');

function authenticatedKey(): ApiKeyContext {
	return {
		keyId: 'key-1', apiKeyHash: 'a'.repeat(64), userId: 'user-1',
		workspaceId: 'workspace-1', userEmail: null, budgetMax: 100,
		budgetSpent: 0, budgetEpoch: 7, budgetPeriod: 'none',
		budgetResetAt: null, includeByokInLimit: false, metadata: null,
		chargedCostFactors: null,
	};
}

function pricedRoute(targetId: string, candidateIndex: number, prompt: string): RouteResult {
	const endpoint = {
		id: `endpoint-${targetId}`, modelId: `model-${candidateIndex}`,
		providerId: `provider-${targetId}`, providerSlug: 'provider',
		selectorSlug: 'provider', endpointClass: 'standard', region: null,
		contextLength: 8192, maxPromptTokens: 8192,
		maxCompletionTokens: 1024, quantization: null,
		supportedParameters: [],
		pricing: { currency: 'USD', prompt, completion: '0.000002' },
		capabilities: {
			implicit_caching: false, voice_cloning: false,
			tool_choice: { auto: false, function: false, none: false, required: false },
		},
		imageCapabilities: null, evidenceUrl: 'https://evidence.example/pricing',
		verifiedBy: 'test', verifiedAt: NOW.toISOString(),
		expiresAt: '2027-09-25T00:00:00.000Z',
	} as VerifiedModelEndpointSnapshot;
	return {
		targetId, modelSurfaceId: null, routePoolId: null,
		providerId: `provider-${targetId}`, providerName: 'provider',
		providerModelName: `private-${targetId}`, gatewayModelId: `model-${candidateIndex}`,
		gatewayCandidateIndex: candidateIndex,
		upstreamProtocol: 'openai', upstreamOperation: 'chat.completions',
		adapter: 'passthrough', providerEndpoints: {}, providerApiKey: 'secret',
		providerSharedChannelType: null, priceOverrideRaw: null,
		routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 0,
		routeWeight: 1, endpoint,
	};
}

function plan(routes: RouteResult[]): Extract<ModelFallbackPlanResult, { ok: true }> {
	const candidates = routes.map((route, index) => ({
		baseModelId: `model-${index}`,
		model: { pricing_profile: null },
		upstreamBody: { model: `model-${index}`, messages: [{ role: 'user', content: 'hi' }] },
		routes: [route],
	} as ModelFallbackCandidatePlan));
	return { ok: true, candidates, endpointPartition: 'none', globalRoutes: routes };
}

function intent(): GuardrailBudgetIntent {
	return {
		workspaceId: 'workspace-1', assignmentId: 'assignment-1',
		guardrailId: 'guardrail-1', guardrailVersion: 1,
		scopeType: 'user', scopeId: 'user-1', period: 'daily',
		periodStart: '2026-09-25T00:00:00.000Z',
		periodEnd: '2026-09-26T00:00:00.000Z', limitMicros: 100_000_000,
	};
}

function repositories() {
	const calls: { ordinaryMicros: number[]; guardrailMicros: number[]; sends: number } = {
		ordinaryMicros: [], guardrailMicros: [], sends: 0,
	};
	const repos = {
		userBudgets: {
			reserve: async (params: { requestId: string; userId: string; apiKeyId: string;
				expectedBudgetEpoch: number; reservedMicros: number }) => {
				calls.ordinaryMicros.push(params.reservedMicros);
				return { status: 'reserved' as const, reservation: {
					requestId: params.requestId, userId: params.userId,
					apiKeyId: params.apiKeyId, budgetEpoch: params.expectedBudgetEpoch,
					limitMicros: 100_000_000, reservedMicros: params.reservedMicros,
				} };
			},
			expireBefore: async () => 0,
			markDispatched: async () => true,
			release: async () => 1,
			forfeitDispatched: async () => 1,
		},
		guardrailBudgets: {
			reserveMany: async (params: { reservedMicros: number }) => {
				calls.guardrailMicros.push(params.reservedMicros);
				return { status: 'reserved' as const, reservationCount: 1 };
			},
			expireBefore: async () => 0,
			markDispatched: async () => true,
			releaseMany: async () => 1,
			forfeitMany: async () => 1,
		},
	} as unknown as GatewayRepositories;
	return { repos, calls };
}

describe('authenticated Chat budget proof candidate', () => {
	it('opening a request owner creates only a local free lease before any privileged reservation', async () => {
		const { repos } = repositories();
		const writes: string[] = [];
		const ordinary: OrdinaryBudgetRepositories = { userBudgets: {
			reserve: async () => { writes.push('ordinary-reserve'); throw new Error('unexpected reserve'); },
			expireBefore: async () => { writes.push('ordinary-recover'); throw new Error('unexpected recovery'); },
			markDispatched: async () => { writes.push('ordinary-mark'); throw new Error('unexpected mark'); },
			release: async () => { writes.push('ordinary-release'); throw new Error('unexpected release'); },
			forfeitDispatched: async () => { writes.push('ordinary-forfeit'); throw new Error('unexpected forfeit'); },
		} };
		const guardrail: GuardrailBudgetRequestPort = {
			identity: { requestId: 'request-open', userId: 'user-1', apiKeyId: 'key-1' },
			reserve: async () => { writes.push('guardrail-reserve'); throw new Error('unexpected reserve'); },
			extend: async () => { writes.push('guardrail-extend'); throw new Error('unexpected extend'); },
			markDispatched: async () => { writes.push('guardrail-mark'); throw new Error('unexpected mark'); },
			releasePreDispatch: async () => { writes.push('guardrail-release'); throw new Error('unexpected release'); },
			forfeitPostDispatch: async () => { writes.push('guardrail-forfeit'); throw new Error('unexpected forfeit'); },
		};
		const proof = createAuthenticatedChatBudgetProof({
			requestId: 'request-open', authenticatedKey: authenticatedKey(),
			plan: plan([pricedRoute('route-open', 0, '0.000002')]),
			budgetIntents: [intent()], now: NOW,
		});
		const opened = await proof.open(repos, { ordinaryBudgetRepositories: ordinary,
			ordinaryRecoveryFailureMode: 'fail_closed', guardrailBudgetRequestPort: guardrail });
		assert.equal(opened.ordinaryLease.kind, 'free');
		assert.deepEqual(writes, []);
	});
	it('holds the maximum paid route for every possible dispatch permit', async () => {
		const routes = [pricedRoute('cheap', 0, '0.000001'), pricedRoute('expensive', 1, '0.000003')];
		const fallbackPlan = plan(routes);
		const key = authenticatedKey();
		const perDispatch = estimateOrdinaryBudgetChargedCost(fallbackPlan.candidates, key.chargedCostFactors);
		assert.equal(perDispatch.ok, true);
		if (!perDispatch.ok) return;
		const perDispatchMicros = ordinaryBudgetReservationMicros(perDispatch.estimatedChargedCost);
		assert.equal(perDispatchMicros.ok, true);
		if (!perDispatchMicros.ok) return;
		const proof = createAuthenticatedChatBudgetProof({
			requestId: 'request-1', authenticatedKey: key, plan: fallbackPlan,
			budgetIntents: [intent()], now: NOW,
		});
		const { repos, calls } = repositories();
		const admission = await proof.open(repos);
		const result = await failoverDispatch(repos, routes, 'openai',
			async (_route, _signal, _timing, _attempt, beforeFetch) => {
				await beforeFetch?.();
				calls.sends++;
				return {
					response: new Response(calls.sends === 1 ? 'busy' : 'ok', {
						status: calls.sends === 1 ? 429 : 200,
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null,
				};
			}, undefined, {
				affinityKey: 'request-1', tierKeyPrefix: 'tier-1',
				strategy: 'weight_priority', delegateBeforeUpstreamDispatchToDriver: true,
				beforeUpstreamDispatch: admission.beforeUpstreamDispatch,
			});
		assert.equal(result.response.status, 200);
		assert.equal(calls.sends, 2);
		assert.ok(calls.ordinaryMicros[0]! >= perDispatchMicros.reservedMicros * MAX_REQUEST_DISPATCHES);
		assert.ok(calls.guardrailMicros[0]! >= calls.ordinaryMicros[0]! - 1);
		assert.equal(admission.ordinaryLease.userId, key.userId);
		assert.equal(admission.ordinaryLease.apiKeyId, key.keyId);
		assert.equal(admission.ordinaryLease.requestId, 'request-1');
		await assert.rejects(proof.open(repos), /already opened/);
	});

	it('rejects an altered authenticated key before the held amount can be opened or dispatched', async () => {
		const key = authenticatedKey();
		const route = pricedRoute('one', 0, '0.000001');
		const fallbackPlan = plan([route]);
		const proof = createAuthenticatedChatBudgetProof({
			requestId: 'request-1', authenticatedKey: key,
			plan: fallbackPlan, budgetIntents: [intent()], now: NOW,
		});
		key.chargedCostFactors = '{"model-0":0}';
		const { repos, calls } = repositories();
		await assert.rejects(proof.open(repos), AuthenticatedChatBudgetProofError);
		assert.deepEqual(calls.ordinaryMicros, []);
		key.chargedCostFactors = null;
		const opened = await proof.open(repos);
		key.userId = 'other-user';
		await assert.rejects(async () => opened.beforeUpstreamDispatch(route),
			AuthenticatedChatBudgetProofError);
		assert.deepEqual(calls.ordinaryMicros, []);
		assert.deepEqual(calls.guardrailMicros, []);
	});

	it('keeps final charged factors pinned and rejects post-dispatch mutation before settlement', async () => {
		const key = authenticatedKey();
		const route = pricedRoute('one', 0, '0.000001');
		const proof = createAuthenticatedChatBudgetProof({
			requestId: 'request-1', authenticatedKey: key,
			plan: plan([route]), budgetIntents: [intent()], now: NOW,
		});
		const { repos } = repositories();
		const admission = await proof.open(repos);
		await admission.beforeUpstreamDispatch(route);
		assert.equal(proof.authenticatedKeySnapshot.chargedCostFactors, null);
		key.chargedCostFactors = '{"model-0":0}';
		assert.throws(() => proof.assertSettlementSnapshot(route, route),
			AuthenticatedChatBudgetProofError);
		key.chargedCostFactors = null;
		route.routeMeteredProfileJson = '{"input_price":0}';
		assert.throws(() => proof.assertSettlementSnapshot(route, route),
			AuthenticatedChatBudgetProofError);
	});

	it('rejects post-proof pricing, route/model relabeling, and body mutation before any send', async () => {
		for (const mutate of [
			(route: RouteResult, _fallbackPlan: ReturnType<typeof plan>) => { route.routeChargedProfileJson = '{"input_price":0}'; },
			(route: RouteResult, _fallbackPlan: ReturnType<typeof plan>) => { route.gatewayCandidateIndex = 2; },
			(route: RouteResult, _fallbackPlan: ReturnType<typeof plan>) => { route.gatewayModelId = 'other-model'; },
			(_route: RouteResult, fallbackPlan: ReturnType<typeof plan>) => {
				fallbackPlan.candidates[0]!.upstreamBody.messages = [{ role: 'user', content: 'longer' }];
			},
			(_route: RouteResult, fallbackPlan: ReturnType<typeof plan>) => {
				fallbackPlan.candidates[0]!.model.pricing_profile = '{"input_price":0}';
			},
		]) {
			const route = pricedRoute('one', 0, '0.000001');
			const fallbackPlan = plan([route]);
			const proof = createAuthenticatedChatBudgetProof({
				requestId: 'request-1', authenticatedKey: authenticatedKey(),
				plan: fallbackPlan, budgetIntents: [intent()], now: NOW,
			});
			const { repos, calls } = repositories();
			const admission = await proof.open(repos);
			mutate(route, fallbackPlan);
			await assert.rejects(async () => admission.beforeUpstreamDispatch(route),
				AuthenticatedChatBudgetProofError);
			assert.deepEqual(calls.ordinaryMicros, []);
			assert.deepEqual(calls.guardrailMicros, []);
			assert.equal(calls.sends, 0);
		}
	});

	it('rejects a wrong authenticated scope and an unpriced route before opening admission', () => {
		const route = pricedRoute('one', 0, '0.000001');
		assert.throws(() => createAuthenticatedChatBudgetProof({
			requestId: 'request-1', authenticatedKey: authenticatedKey(), plan: plan([route]),
			budgetIntents: [{ ...intent(), scopeId: 'other-user' }], now: NOW,
		}), /differs from authenticated Gateway Key/);
		const unpriced = pricedRoute('unpriced', 0, '0.000001');
		delete unpriced.endpoint;
		assert.throws(() => createAuthenticatedChatBudgetProof({
			requestId: 'request-1', authenticatedKey: authenticatedKey(), plan: plan([unpriced]),
			budgetIntents: [], now: NOW,
		}), AuthenticatedChatBudgetProofError);
	});
});

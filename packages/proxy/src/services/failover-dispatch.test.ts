import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ByokRuntimeKeyRow, GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { EMPTY_USAGE, proxyDashScopeMultimodalPassthrough } from './proxy';
import {
	failoverDispatch,
	isSuccessfulDispatchResponse,
	markUpstreamOutcomeUnknown,
} from './failover-dispatch';
import { RequestTimingCollector } from './request-timing';
import {
	isProviderCircuitOpen,
	markProviderFailure,
	resetProviderCircuitStateForTests,
} from './provider-circuit-breaker';
import { resetSharedKeyPoolStateForTests } from './shared-key-pool';
import {
	createRouteAwareBudgetAdmission,
	RequestBudgetAdmissionError,
} from './request-budget-admission';

function makeRoute(providerId: string, overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: `target-${providerId}`,
		modelSurfaceId: null,
		routePoolId: 'pool-1',
		providerId,
		providerName: providerId,
		providerModelName: 'model-x',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://example.com/v1' } },
		providerApiKey: `sk-${providerId}`,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: providerId,
		providerKeyLabel: providerId,
		providerKeyFingerprint: `…${providerId.slice(-4)}`,
		...overrides,
	};
}

const emptyRepos = {} as GatewayRepositories;

const defaultOptions = {
	affinityKey: 'u|m|default|openai',
	tierKeyPrefix: 'm|default|openai',
	strategy: 'weight_priority' as const,
};

const byokContext = {
	workspaceId: 'workspace-1',
	userId: 'user-1',
	apiKeyHash: 'a'.repeat(64),
};

function makeByokKey(id: string, isFallback = false): ByokRuntimeKeyRow {
	return {
		id,
		workspace_id: byokContext.workspaceId,
		provider: 'deepseek',
		name: null,
		label: `...${id.slice(-4)}`,
		disabled: false,
		is_fallback: isFallback,
		sort_order: 0,
		allowed_models: null,
		allowed_user_ids: null,
		allowed_api_key_hashes: null,
		created_by_management_key_id: null,
		created_at: '2026-09-03T00:00:00.000Z',
		updated_at: '2026-09-03T00:00:00.000Z',
		api_key: `secret-${id}`,
	};
}

function makeByokRoute(overrides: Partial<RouteResult> = {}): RouteResult {
	return makeRoute('provider-1', {
		targetId: 'target-byok',
		gatewayModelId: 'deepseek/deepseek-chat',
		endpoint: {
			id: 'endpoint-deepseek',
			modelId: 'deepseek/deepseek-chat',
			providerId: 'provider-1',
			providerSlug: 'deepseek',
		} as NonNullable<RouteResult['endpoint']>,
		...overrides,
	});
}

beforeEach(() => {
	resetProviderCircuitStateForTests();
	resetSharedKeyPoolStateForTests();
});

describe('dispatch success response', () => {
	it('accepts Cloudflare WebSocket 101 responses in addition to HTTP 2xx', () => {
		assert.equal(
			isSuccessfulDispatchResponse({
				ok: false,
				status: 101,
				webSocket: {},
			} as Response),
			true
		);
	});
});

describe('failoverDispatch — private BYOK credentials', () => {
	it('attempts primary BYOK, shared, platform, then fallback BYOK for one route target', async () => {
		const sharedKey: SharedKeyRow = {
			id: 'shared-1',
			sellerUserId: 'seller-1',
			channelType: 'openai',
			apiKey: 'secret-shared-1',
			keyFingerprint: '...ared',
			label: 'shared-1',
			status: 'active',
			sellerPriority: 0,
			weight: 1,
			inputPrice: 1,
			outputPrice: 2,
			cacheReadPrice: null,
			cacheWritePrice: null,
			validatedAt: null,
			lastUsedAt: null,
			lastFailureAt: null,
			failureReason: null,
			servedInputTokens: 0,
			servedOutputTokens: 0,
			earnedTotal: 0,
			createdAt: '2026-09-03T00:00:00.000Z',
			updatedAt: '2026-09-03T00:00:00.000Z',
		};
		const repos = {
			sharedKeys: {
				listActiveSharedKeysByChannel: async () => [sharedKey],
				markSharedKeyFailure: mock.fn(),
			},
			byokKeys: {
				listActiveForRequest: async () => [
					makeByokKey('primary-1'),
					makeByokKey('fallback-1', true),
				],
			},
		} as unknown as GatewayRepositories;
		const seen: string[] = [];
		const result = await failoverDispatch(
			repos,
			[makeByokRoute({ providerSharedChannelType: 'openai' })],
			'openai',
			async (route) => {
				seen.push(route.providerKeyId ?? 'none');
				const success = route.providerKeyId === 'byok:fallback-1';
				return {
					response: new Response(success ? 'ok' : 'unavailable', {
						status: success ? 200 : 503,
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{ ...defaultOptions, byok: byokContext },
		);

		assert.deepEqual(seen, [
			'byok:primary-1',
			'sharedkey:shared-1',
			'provider-1',
			'byok:fallback-1',
		]);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.providerKeyId, 'byok:fallback-1');
	});

	it('dispatches a BYOK-only route without allowing a blank platform credential to egress', async () => {
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('only-1')],
			},
		} as unknown as GatewayRepositories;
		const seen: Array<[string | null | undefined, string]> = [];
		const result = await failoverDispatch(
			repos,
			[makeByokRoute({ providerApiKey: '' })],
			'openai',
			async (route) => {
				seen.push([route.providerKeyId, route.providerApiKey]);
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{ ...defaultOptions, byok: byokContext },
		);

		assert.deepEqual(seen, [['byok:only-1', 'secret-only-1']]);
		assert.equal(result.response.status, 200);
	});

	it('delegates route-aware admission for BYOK and platform fallback at each dispatch boundary', async () => {
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('primary-1')],
			},
		} as unknown as GatewayRepositories;
		const events: string[] = [];
		const result = await failoverDispatch(
			repos,
			[makeByokRoute()],
			'openai',
			async (route) => {
				events.push(`dispatch:${route.providerKeyId}`);
				const isByok = route.providerKeyId?.startsWith('byok:') === true;
				return {
					response: new Response(isByok ? 'unavailable' : 'ok', {
						status: isByok ? 503 : 200,
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				byok: byokContext,
				beforeUpstreamDispatch: async (route) => {
					events.push(`admission:${route.providerKeyId}`);
				},
			},
		);

		assert.deepEqual(events, [
			'admission:byok:primary-1',
			'dispatch:byok:primary-1',
			'admission:provider-1',
			'dispatch:provider-1',
		]);
		assert.equal(result.response.status, 200);
	});

	it('lets an exhausted finite-budget user complete a successful zero-fee BYOK request', async () => {
		const ordinaryReserve = mock.fn<GatewayRepositories['userBudgets']['reserve']>(async () => ({
			status: 'blocked',
			remainingMicros: 0,
		}));
		const guardrailReserve = mock.fn<GatewayRepositories['guardrailBudgets']['reserveMany']>(
			async () => ({ status: 'blocked', assignmentId: 'assignment-1' }),
		);
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('zero-fee-1')],
			},
			userBudgets: {
				reserve: ordinaryReserve,
				expireBefore: mock.fn(async () => 0),
				markDispatched: mock.fn(async () => true),
				release: mock.fn(async () => 1),
				forfeitDispatched: mock.fn(async () => 1),
			},
			guardrailBudgets: {
				reserveMany: guardrailReserve,
				expireBefore: mock.fn(async () => 0),
				markDispatched: mock.fn(async () => true),
				releaseMany: mock.fn(async () => 1),
				forfeitMany: mock.fn(async () => 1),
			},
		} as unknown as GatewayRepositories;
		const admission = await createRouteAwareBudgetAdmission(repos, {
			ordinary: {
				requestId: 'request-byok-success',
				userId: byokContext.userId,
				apiKeyId: 'gateway-key-1',
				budgetMax: 1,
				expectedBudgetEpoch: 4,
				estimatedChargedCost: 0.25,
			},
			guardrail: { intents: [], reservedMicros: 250_000 },
			privateByokGatewayKey: { includeInLimit: false, reservedMicros: 250_000 },
		});
		const dispatched: string[] = [];

		const result = await failoverDispatch(
			repos,
			[makeByokRoute({ providerApiKey: '' })],
			'openai',
			async (route) => {
				dispatched.push(route.providerKeyId ?? 'none');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				byok: byokContext,
				beforeUpstreamDispatch: (route) => admission.beforeUpstreamDispatch(route),
			},
		);

		assert.equal(result.response.status, 200);
		assert.deepEqual(dispatched, ['byok:zero-fee-1']);
		assert.equal(ordinaryReserve.mock.callCount(), 0);
		assert.equal(guardrailReserve.mock.callCount(), 0);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.guardrailReserved, false);
	});

	it('denies platform fallback before egress when BYOK fails and the ordinary budget is exhausted', async () => {
		const ordinaryReserve = mock.fn<GatewayRepositories['userBudgets']['reserve']>(async () => ({
			status: 'blocked',
			remainingMicros: 0,
		}));
		const guardrailReserve = mock.fn<GatewayRepositories['guardrailBudgets']['reserveMany']>(
			async () => ({ status: 'reserved', reservationCount: 0 }),
		);
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('fallback-denied-1')],
			},
			userBudgets: {
				reserve: ordinaryReserve,
				expireBefore: mock.fn(async () => 0),
				markDispatched: mock.fn(async () => true),
				release: mock.fn(async () => 1),
				forfeitDispatched: mock.fn(async () => 1),
			},
			guardrailBudgets: {
				reserveMany: guardrailReserve,
				expireBefore: mock.fn(async () => 0),
				markDispatched: mock.fn(async () => true),
				releaseMany: mock.fn(async () => 1),
				forfeitMany: mock.fn(async () => 1),
			},
		} as unknown as GatewayRepositories;
		const admission = await createRouteAwareBudgetAdmission(repos, {
			ordinary: {
				requestId: 'request-platform-denied',
				userId: byokContext.userId,
				apiKeyId: 'gateway-key-1',
				budgetMax: 1,
				expectedBudgetEpoch: 4,
				estimatedChargedCost: 0.25,
			},
			guardrail: { intents: [], reservedMicros: 250_000 },
			privateByokGatewayKey: { includeInLimit: false, reservedMicros: 250_000 },
		});
		const dispatched: string[] = [];

		const result = await failoverDispatch(
			repos,
			[makeByokRoute()],
			'openai',
			async (route) => {
				dispatched.push(route.providerKeyId ?? 'none');
				return {
					response: new Response('unavailable', { status: 503 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				byok: byokContext,
				beforeUpstreamDispatch: (route) => admission.beforeUpstreamDispatch(route),
			},
		);

		assert.equal(result.response.status, 402);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), 'gateway.budget_exceeded');
		assert.deepEqual(dispatched, ['byok:fallback-denied-1']);
		assert.equal(ordinaryReserve.mock.callCount(), 1);
		assert.equal(guardrailReserve.mock.callCount(), 0);
		assert.equal(result.meta?.gatewayGeneratedError, true);
		assert.equal(result.dispatchAttempts?.length, 1);
		assert.equal(result.dispatchAttempts?.[0]?.routeTargetId, 'target-byok');
	});

	it('can explicitly include private BYOK in an authenticated future budget policy', async () => {
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('included-1')],
			},
		} as unknown as GatewayRepositories;
		const admitted: string[] = [];
		await failoverDispatch(
			repos,
			[makeByokRoute({ providerApiKey: '' })],
			'openai',
			async () => ({
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			}),
			undefined,
			{
				...defaultOptions,
				byok: byokContext,
				includePrivateByokInBudget: true,
				beforeUpstreamDispatch: async (route) => {
					admitted.push(route.providerKeyId ?? 'none');
				},
			},
		);

		assert.deepEqual(admitted, ['byok:included-1']);
	});

	it('does not disable a shared key when a private BYOK credential receives 401 or 403', async () => {
		for (const status of [401, 403]) {
			resetProviderCircuitStateForTests();
			const markSharedKeyFailure = mock.fn();
			const repos = {
				sharedKeys: { markSharedKeyFailure },
				byokKeys: {
					listActiveForRequest: async () => [makeByokKey(`auth-${status}`)],
				},
			} as unknown as GatewayRepositories;
			const seen: string[] = [];
			const result = await failoverDispatch(
				repos,
				[makeByokRoute()],
				'openai',
				async (route) => {
					seen.push(route.providerKeyId ?? 'none');
					const isByok = route.providerKeyId?.startsWith('byok:') === true;
					return {
						response: new Response(isByok ? 'auth rejected' : 'ok', {
							status: isByok ? status : 200,
						}),
						usagePromise: Promise.resolve(EMPTY_USAGE),
						upstreamRequestId: null,
					};
				},
				undefined,
				{ ...defaultOptions, byok: byokContext },
			);

			assert.deepEqual(seen, [`byok:auth-${status}`, 'provider-1']);
			assert.equal(result.response.status, 200);
			assert.equal(markSharedKeyFailure.mock.callCount(), 0);
		}
	});

	it('isolates a circuit-open BYOK key and still attempts another private credential', async () => {
		markProviderFailure('provider-1#byok:key-1', 'rate_limit', 60_000);
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [
					makeByokKey('key-1'),
					makeByokKey('key-2'),
				],
			},
		} as unknown as GatewayRepositories;
		const seen: string[] = [];
		const result = await failoverDispatch(
			repos,
			[makeByokRoute()],
			'openai',
			async (route) => {
				seen.push(route.providerKeyId ?? 'none');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{ ...defaultOptions, byok: byokContext },
		);

		assert.deepEqual(seen, ['byok:key-2']);
		assert.equal(result.chosenRoute.providerKeyId, 'byok:key-2');
	});

	it('does not let an open platform circuit suppress a healthy BYOK credential', async () => {
		markProviderFailure('provider-1', 'rate_limit', 60_000);
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [makeByokKey('healthy-1')],
			},
		} as unknown as GatewayRepositories;
		const seen: string[] = [];
		const result = await failoverDispatch(
			repos,
			[makeByokRoute()],
			'openai',
			async (route) => {
				seen.push(route.providerKeyId ?? 'none');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{ ...defaultOptions, byok: byokContext },
		);

		assert.deepEqual(seen, ['byok:healthy-1']);
		assert.equal(result.response.status, 200);
	});

	it('returns 429 without dispatch when every expanded credential circuit is open', async () => {
		markProviderFailure('provider-1', 'rate_limit', 60_000);
		markProviderFailure('provider-1#byok:primary-1', 'rate_limit', 60_000);
		markProviderFailure('provider-1#byok:fallback-1', 'rate_limit', 60_000);
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => [
					makeByokKey('primary-1'),
					makeByokKey('fallback-1', true),
				],
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn();
		const result = await failoverDispatch(
			repos,
			[makeByokRoute()],
			'openai',
			dispatch,
			undefined,
			{ ...defaultOptions, byok: byokContext },
		);

		assert.equal(dispatch.mock.callCount(), 0);
		assert.equal(result.response.status, 429);
		assert.equal(result.suppressErrorAlert, true);
		assert.match(result.response.headers.get('retry-after') ?? '', /^\d+$/u);
	});
});

describe('final-attempt Guardrail outcome metadata', () => {
	it('does not replay a paid response when the driver forbids failover', async () => {
		let calls = 0;
		const result = await failoverDispatch(
			emptyRepos,
			[
				makeRoute('accepted-first', { routePriority: 2 }),
				makeRoute('must-not-run', { routePriority: 1 }),
			],
			'openai',
			async () => {
				calls += 1;
				return {
					response: new Response('gateway could not buffer the accepted response', { status: 502 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: 'accepted-request',
					meta: { responseBodyTooLarge: true, failoverForbidden: true },
				};
			},
			undefined,
			defaultOptions,
		);

		assert.equal(calls, 1);
		assert.equal(result.chosenRoute.providerId, 'accepted-first');
		assert.equal(result.meta?.failoverForbidden, true);
	});

	it('does not replay a driver-reported unknown outcome', async () => {
		const routes = [
			makeRoute('unknown-first', {
				routePriority: 2,
				upstreamProtocol: 'dashscope',
				upstreamOperation: 'audio.transcriptions.multimodal',
				adapter: 'passthrough',
				providerEndpoints: { dashscope: { base: 'https://unknown-first.example/api/v1' } },
			}),
			makeRoute('success-second', {
				routePriority: 1,
				upstreamProtocol: 'dashscope',
				upstreamOperation: 'audio.transcriptions.multimodal',
				adapter: 'passthrough',
				providerEndpoints: { dashscope: { base: 'https://success-second.example/api/v1' } },
			}),
		];
		const attempted: string[] = [];
		const result = await proxyDashScopeMultimodalPassthrough(
			emptyRepos,
			routes,
			{ model: 'public-asr', input: { messages: [] } },
			undefined,
			{
				...defaultOptions,
				dashScope: {
					beforeUpstreamDispatch: async () => undefined,
					fetchImpl: async (input) => {
						const url = String(input);
						attempted.push(url.includes('unknown-first.example') ? 'unknown-first' : 'success-second');
						if (url.includes('unknown-first.example')) throw new TypeError('connection reset');
						return new Response(JSON.stringify({
							request_id: 'req-success', output: { text: 'ok' }, usage: { seconds: 4 },
						}), { status: 200 });
					},
				},
			},
		);

		assert.deepEqual(attempted, ['unknown-first']);
		assert.equal(result.response.status, 502);
		assert.equal(result.chosenRoute.providerId, 'unknown-first');
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
	});

	it('retains unknown metadata when the final result itself is unknown', async () => {
		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('final-unknown')],
			'openai',
			async () => ({
				response: new Response('unknown', { status: 502 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
				meta: { upstreamOutcomeUnknown: true },
			}),
			undefined,
			defaultOptions,
		);

		assert.equal(result.response.status, 502);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
	});

	it('returns a fixed 502 and never replays a thrown unknown outcome', async () => {
		const allUnknown = await failoverDispatch(
			emptyRepos,
			[makeRoute('throws')],
			'openai',
			async () => {
				throw markUpstreamOutcomeUnknown(new TypeError('connection reset'));
			},
			undefined,
			defaultOptions,
		);
		assert.equal(allUnknown.response.status, 502);
		assert.equal(allUnknown.meta?.upstreamOutcomeUnknown, true);
		assert.equal(allUnknown.meta?.failoverForbidden, true);
		assert.deepEqual(await allUnknown.response.json(), {
			error: {
				code: 502,
				message: 'Upstream provider is unavailable',
				metadata: { error_type: 'provider_unavailable' },
			},
			code: 'gateway.upstream_request_failed',
		});

		let calls = 0;
		const recovered = await failoverDispatch(
			emptyRepos,
			[
				makeRoute('throws-first', { routePriority: 2 }),
				makeRoute('succeeds-second', { routePriority: 1 }),
			],
			'openai',
			async () => {
				calls += 1;
				if (calls === 1) {
					throw markUpstreamOutcomeUnknown(new TypeError('connection reset'));
				}
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{ ...defaultOptions, delegateBeforeUpstreamDispatchToDriver: true },
		);
		assert.equal(calls, 1);
		assert.equal(recovered.response.status, 502);
		assert.equal(recovered.meta?.upstreamOutcomeUnknown, true);
		assert.equal(recovered.meta?.failoverForbidden, true);
	});
});

describe('failoverDispatch — partition none request-level chain', () => {
	function globalRoute(
		targetId: string,
		candidateIndex: number,
		modelId: string,
		priority: number,
		globalRank: number,
		overrides: Partial<RouteResult> = {},
	): RouteResult {
		return makeRoute(targetId, {
			targetId,
			gatewayCandidateIndex: candidateIndex,
			gatewayModelId: modelId,
			gatewayGlobalEndpointRank: globalRank,
			routePriority: priority,
			...overrides,
		});
	}

	const crossModelOptions = {
		...defaultOptions,
		crossModelCandidateFailover: true,
	};

	it('preserves the exact globally interleaved M2/M1/M2/M1 attempt order', async () => {
		const routes = [
			globalRoute('m2-a', 1, 'm2', 4, 1),
			globalRoute('m1-a', 0, 'm1', 3, 2),
			globalRoute('m2-b', 1, 'm2', 2, 3),
			globalRoute('m1-b', 0, 'm1', 1, 4),
		];
		const seen: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			routes,
			'openai',
			async (route) => {
				seen.push(route.targetId);
				return {
					response: new Response(
						route.targetId === 'm1-b' ? 'ok' : 'unavailable',
						{ status: route.targetId === 'm1-b' ? 200 : 503 },
					),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			crossModelOptions,
		);

		assert.deepEqual(seen, ['m2-a', 'm1-a', 'm2-b', 'm1-b']);
		assert.equal(result.chosenRoute.targetId, 'm1-b');
		assert.deepEqual(
			result.dispatchAttempts?.map((attempt) => [
				attempt.routeTargetId,
				attempt.candidateIndex,
				attempt.globalEndpointRank,
			]),
			[
				['m2-b', 1, 3],
				['m1-b', 0, 4],
			],
		);
	});

	it('stops only the rejected model candidate on 400 and continues another candidate', async () => {
		const routes = [
			globalRoute('m2-a', 1, 'm2', 4, 1),
			globalRoute('m1-a', 0, 'm1', 3, 2),
			globalRoute('m2-b', 1, 'm2', 2, 3),
			globalRoute('m1-b', 0, 'm1', 1, 4),
		];
		const seen: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			routes,
			'openai',
			async (route) => {
				seen.push(route.targetId);
				const status = route.targetId === 'm2-a'
					? 400
					: route.targetId === 'm1-b' ? 200 : 503;
				return {
					response: Response.json(
						status === 200 ? { ok: true } : { error: { message: `failed ${route.targetId}` } },
						{ status },
					),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			crossModelOptions,
		);

		assert.deepEqual(seen, ['m2-a', 'm1-a', 'm1-b']);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.targetId, 'm1-b');
		assert.deepEqual(
			result.dispatchAttempts?.map((attempt) => attempt.routeTargetId),
			['m2-a', 'm1-b'],
		);
	});

	it('stops the entire chain when an accepted outcome forbids replay', async () => {
		const calls: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			[
				globalRoute('m2-accepted', 1, 'm2', 2, 1),
				globalRoute('m1-must-not-run', 0, 'm1', 1, 2),
			],
			'openai',
			async (route) => {
				calls.push(route.targetId);
				return {
					response: new Response('accepted response could not be buffered', { status: 502 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: 'accepted-request',
					meta: { upstreamOutcomeUnknown: true, failoverForbidden: true },
				};
			},
			undefined,
			crossModelOptions,
		);

		assert.deepEqual(calls, ['m2-accepted']);
		assert.equal(result.meta?.failoverForbidden, true);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.dispatchAttempts?.length, 1);
	});

	it('stops the global chain on the first thrown unknown model outcome', async () => {
		const result = await failoverDispatch(
			emptyRepos,
			[
				globalRoute('m2-unknown', 1, 'm2', 2, 1),
				globalRoute('m1-success', 0, 'm1', 1, 2),
			],
			'openai',
			async (route) => {
				if (route.targetId === 'm2-unknown') {
					throw markUpstreamOutcomeUnknown(new TypeError('connection reset after write'));
				}
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			crossModelOptions,
		);

		assert.equal(result.response.status, 502);
		assert.equal(result.chosenRoute.targetId, 'm2-unknown');
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
		assert.deepEqual(
			result.dispatchAttempts?.map((attempt) => attempt.outcome),
			['fetch_error'],
		);
	});

	it('keeps shared-key clones adjacent and preserves their model candidate context', async () => {
		const sharedKeys: SharedKeyRow[] = ['key-a', 'key-b'].map((id) => ({
			id,
			sellerUserId: 'seller-1',
			channelType: 'openai',
			apiKey: `sk-${id}`,
			keyFingerprint: `fingerprint-${id}`,
			label: id,
			status: 'active',
			sellerPriority: 0,
			weight: 1,
			inputPrice: 1,
			outputPrice: 2,
			cacheReadPrice: null,
			cacheWritePrice: null,
			validatedAt: null,
			lastUsedAt: null,
			lastFailureAt: null,
			failureReason: null,
			servedInputTokens: 0,
			servedOutputTokens: 0,
			earnedTotal: 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		}));
		const repos = {
			sharedKeys: {
				listActiveSharedKeysByChannel: async () => sharedKeys,
			},
		} as unknown as GatewayRepositories;
		const seen: Array<[string, string | null | undefined, number | undefined, string | undefined]> = [];
		const result = await failoverDispatch(
			repos,
			[
				globalRoute('m2-shared', 1, 'm2', 2, 1, {
					providerId: 'shared-provider',
					providerApiKey: 'sk-provider-own',
					providerKeyId: 'shared-provider',
					providerSharedChannelType: 'openai',
				}),
				globalRoute('m1-direct', 0, 'm1', 1, 2),
			],
			'openai',
			async (route) => {
				seen.push([
					route.targetId,
					route.providerKeyId,
					route.gatewayCandidateIndex,
					route.gatewayModelId,
				]);
				const success = route.targetId === 'm1-direct';
				return {
					response: new Response(success ? 'ok' : 'unavailable', { status: success ? 200 : 503 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			crossModelOptions,
		);

		assert.deepEqual(seen, [
			['m2-shared', 'sharedkey:key-a', 1, 'm2'],
			['m2-shared', 'sharedkey:key-b', 1, 'm2'],
			['m2-shared', 'shared-provider', 1, 'm2'],
			['m1-direct', 'm1-direct', 0, 'm1'],
		]);
		assert.deepEqual(
			result.dispatchAttempts?.map((attempt) => [
				attempt.routeTargetId,
				attempt.candidateIndex,
				attempt.globalEndpointRank,
			]),
			[
				['m2-shared', 1, 1],
				['m1-direct', 0, 2],
			],
		);
	});

});

describe('failoverDispatch — all providers unavailable', () => {
	it('returns 429 + Retry-After when every provider is circuit-open (no upstream dispatch)', async () => {
		markProviderFailure('p1', 'rate_limit', 5_000);
		const dispatch = mock.fn();
		const routes = [makeRoute('p1')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 0);
		assert.equal(result.response.status, 429);
		assert.ok(result.response.headers.get('Retry-After'));
		const retryAfter = Number(result.response.headers.get('Retry-After'));
		assert.ok(retryAfter > 0);
		assert.ok(retryAfter <= 5);
		const body = (await result.response.json()) as {
			error: { code: number; metadata: { retry_after_seconds: number; error_type: string }; message: string };
			code: string;
		};
		assert.equal(body.error.code, 429);
		assert.equal(body.error.metadata.error_type, 'rate_limit_exceeded');
		assert.equal(body.error.metadata.retry_after_seconds, retryAfter);
		assert.match(body.error.message, /providers are cooling down/i);
		assert.equal(body.code, 'circuit.upstream_capacity_exhausted');
		assert.equal(result.suppressErrorAlert, true);
		assert.deepEqual(result.circuitEvents, []);
	});

	it('dispatches when at least one provider is eligible', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const routes = [makeRoute('p1')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 1);
		assert.equal(result.response.status, 200);
	});

	it('accepts mixed protocol targets for an adapter-backed surface', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const routes = [
			makeRoute('dashscope', {
				upstreamProtocol: 'dashscope',
				providerEndpoints: {
					dashscope: { base: 'https://workspace.example/api/v1' },
				},
			}),
		];

		const result = await failoverDispatch(
			emptyRepos,
			routes,
			['openai', 'dashscope'],
			dispatch,
			undefined,
			defaultOptions
		);

		assert.equal(dispatch.mock.callCount(), 1);
		assert.equal(result.chosenRoute.upstreamProtocol, 'dashscope');
	});
});

describe('failoverDispatch — pre-dispatch admission boundary', () => {
	it('returns the canonical gateway budget response without dispatch or provider failover', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('must not run', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('p1'), makeRoute('p2')],
			'openai',
			dispatch,
			undefined,
			{
				...defaultOptions,
				beforeUpstreamDispatch: async () => {
					throw new RequestBudgetAdmissionError({
						code: 'gateway.budget_exceeded',
						message: 'Gateway key spend limit exceeded',
					});
				},
			},
		);

		assert.equal(dispatch.mock.callCount(), 0);
		assert.equal(result.response.status, 402);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), 'gateway.budget_exceeded');
		assert.equal(result.meta?.gatewayGeneratedError, true);
		assert.equal(result.meta?.failoverForbidden, true);
		assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	});

	it('awaits the admission callback immediately before the first dispatch only', async () => {
		const events: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('p1')],
			'openai',
			async () => {
				events.push('dispatch');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				beforeUpstreamDispatch: async () => {
					events.push('admission');
				},
			},
		);

		assert.equal(result.response.status, 200);
		assert.deepEqual(events, ['admission', 'dispatch']);
	});

	it('propagates admission failure without invoking or classifying an upstream attempt', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('must not run', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const admissionError = new Error('ordinary budget dispatch persistence failed');

		await assert.rejects(
			failoverDispatch(
				emptyRepos,
				[makeRoute('p1')],
				'openai',
				dispatch,
				undefined,
				{
					...defaultOptions,
					beforeUpstreamDispatch: async () => {
						throw admissionError;
					},
				},
			),
			(error: unknown) => error === admissionError,
		);
		assert.equal(dispatch.mock.callCount(), 0);
	});

	it('lets a text driver prepare locally before crossing the dispatch boundary beside fetch', async () => {
		const events: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('p1')],
			'openai',
			async (_route, _signal, _timing, _attempt, beforeFetch) => {
				events.push('prepare');
				await beforeFetch?.();
				events.push('fetch');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				delegateBeforeUpstreamDispatchToDriver: true,
				beforeUpstreamDispatch: async () => {
					events.push('admission');
				},
			},
		);

		assert.equal(result.response.status, 200);
		assert.deepEqual(events, ['prepare', 'admission', 'fetch']);
	});

	it('does not cross the delegated boundary for local preparation errors', async () => {
		const events: string[] = [];
		let calls = 0;
		const result = await failoverDispatch(
			emptyRepos,
			[
				makeRoute('bad-local', { routePriority: 2 }),
				makeRoute('good', { routePriority: 1 }),
			],
			'openai',
			async (_route, _signal, _timing, _attempt, beforeFetch) => {
				calls += 1;
				events.push(`prepare-${calls}`);
				if (calls === 1) throw new Error('body serialization failed');
				await beforeFetch?.();
				events.push('fetch');
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				delegateBeforeUpstreamDispatchToDriver: true,
				beforeUpstreamDispatch: async () => {
					events.push('admission');
				},
			},
		);

		assert.equal(result.response.status, 200);
		assert.deepEqual(events, ['prepare-1', 'prepare-2', 'admission', 'fetch']);
	});

	it('propagates a delegated admission failure without network failover', async () => {
		const events: string[] = [];
		const admissionError = new Error('budget dispatch persistence failed');
		await assert.rejects(
			failoverDispatch(
				emptyRepos,
				[
					makeRoute('p1', { routePriority: 2 }),
					makeRoute('p2', { routePriority: 1 }),
				],
				'openai',
				async (_route, _signal, _timing, _attempt, beforeFetch) => {
					events.push('prepare');
					await beforeFetch?.();
					events.push('fetch');
					return {
						response: new Response('must not run', { status: 200 }),
						usagePromise: Promise.resolve(EMPTY_USAGE),
						upstreamRequestId: null,
					};
				},
				undefined,
				{
					...defaultOptions,
					delegateBeforeUpstreamDispatchToDriver: true,
					beforeUpstreamDispatch: async () => {
						throw admissionError;
					},
				},
			),
			(error: unknown) => error === admissionError,
		);
		assert.deepEqual(events, ['prepare']);
	});

	it('returns a gateway Guardrail response when a delegated driver reaches a denied admission boundary', async () => {
		const events: string[] = [];
		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('p1'), makeRoute('p2')],
			'openai',
			async (_route, _signal, _timing, _attempt, beforeFetch) => {
				events.push('prepare');
				await beforeFetch?.();
				events.push('fetch');
				return {
					response: new Response('must not run', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				delegateBeforeUpstreamDispatchToDriver: true,
				beforeUpstreamDispatch: async () => {
					throw new RequestBudgetAdmissionError({
						code: 'gateway.guardrail_blocked',
						message: 'Request blocked by guardrail budget',
					});
				},
			},
		);

		assert.deepEqual(events, ['prepare']);
		assert.equal(result.response.status, 403);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), 'gateway.guardrail_blocked');
		assert.equal(result.meta?.failoverForbidden, true);
		assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	});
});

describe('failoverDispatch — cross-model timing handoff', () => {
	it('does not select a failed model final provider when outer model fallback continues', async () => {
		const timing = new RequestTimingCollector();
		const dispatch = mock.fn(async (
			_route: RouteResult,
			_signal?: AbortSignal,
			collector?: RequestTimingCollector | null,
			attempt?: Parameters<RequestTimingCollector['markAttemptHeaders']>[0]
		) => {
			collector?.markAttemptHeaders(attempt, 503);
			return {
				response: new Response('unavailable', { status: 503 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});

		const result = await failoverDispatch(
			emptyRepos,
			[makeRoute('p1')],
			'openai',
			dispatch,
			undefined,
			{ ...defaultOptions, timing, deferFinalAttempt: true }
		);

		assert.equal(result.response.status, 503);
		const snapshot = timing.snapshot();
		assert.equal(snapshot.upstreamResponseMs, null);
		assert.equal(snapshot.finalUpstreamHeadersMs, null);
		const metadata = JSON.parse(snapshot.timingMetadata ?? '{}') as {
			attempts?: Array<{ selected: boolean }>;
		};
		assert.equal(metadata.attempts?.[0]?.selected, false);
	});
});

describe('failoverDispatch — image abort (no failover)', () => {
	it('does not try next provider when meta.imageAbortReason is client_abort', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response(
				JSON.stringify({
					error: { message: 'cancelled', abort_reason: 'client_abort' },
				}),
				{ status: 504 }
			),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			meta: { imageAbortReason: 'client_abort' as const, parsedBody: { error: {} }, imageUsage: null },
		}));
		const routes = [makeRoute('p1'), makeRoute('p2')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 1);
		assert.equal(result.response.status, 504);
		assert.equal(result.meta?.imageAbortReason, 'client_abort');
	});

	it('does not try next provider when meta.imageAbortReason is gateway_timeout', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response(
				JSON.stringify({
					error: { message: 'timeout', abort_reason: 'gateway_timeout' },
				}),
				{ status: 504 }
			),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			meta: {
				imageAbortReason: 'gateway_timeout' as const,
				parsedBody: { error: {} },
				imageUsage: null,
			},
		}));
		const routes = [makeRoute('p1'), makeRoute('p2')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 1);
		assert.equal(result.response.status, 504);
	});

	it('still retries ordinary 504 without imageAbortReason', async () => {
		let calls = 0;
		const dispatch = mock.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					response: new Response('gateway timeout', { status: 504 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [makeRoute('p1'), makeRoute('p2')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 2);
		assert.equal(result.response.status, 200);
	});
});

describe('failoverDispatch — soft server failures', () => {
	it('does not open circuit after upstream 524 so the next request still dispatches', async () => {
		let calls = 0;
		const dispatch = mock.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					response: new Response('timeout', { status: 524 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [makeRoute('p1')];

		const first = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(first.response.status, 524);
		assert.equal(isProviderCircuitOpen('p1'), false);

		const second = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(dispatch.mock.callCount(), 2);
		assert.equal(second.response.status, 200);
	});

	it('does not open circuit after fetch failure so the next request still dispatches', async () => {
		let calls = 0;
		const dispatch = mock.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error('network reset');
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [makeRoute('p1')];

		const first = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(first.response.status, 502);
		assert.equal(isProviderCircuitOpen('p1'), false);

		const second = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(dispatch.mock.callCount(), 2);
		assert.equal(second.response.status, 200);
	});

	it('does not block the next request after a single ordinary 5xx', async () => {
		let calls = 0;
		const dispatch = mock.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					response: new Response('error', { status: 503 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [makeRoute('p1')];

		const first = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(first.response.status, 503);
		assert.equal(isProviderCircuitOpen('p1'), false);

		const second = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(dispatch.mock.callCount(), 2);
		assert.equal(second.response.status, 200);
	});

	it('returns 429 after three consecutive ordinary 5xx failures exhaust the only provider', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('error', { status: 500 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const routes = [makeRoute('p1')];

		await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		const blocked = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);
		assert.equal(dispatch.mock.callCount(), 3);
		assert.equal(blocked.response.status, 429);
		assert.equal(isProviderCircuitOpen('p1'), true);
		assert.equal(blocked.suppressErrorAlert, true);
	});

	it('records provider circuit event when upstream 429 opens circuit', async () => {
		const dispatch = mock.fn(async () => ({
			response: new Response('rate limited', { status: 429 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const routes = [makeRoute('p1')];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(result.response.status, 429);
		assert.equal(result.circuitEvents.length, 1);
		assert.equal(result.circuitEvents[0]?.kind, 'provider');
		assert.equal((result.circuitEvents[0] as { providerId: string }).providerId, 'p1');
		assert.equal(result.circuitEvents[0]?.failureKind, 'rate_limit');
		assert.equal(result.circuitEvents[0]?.openedOrExtended, true);
		assert.equal(result.suppressErrorAlert, false);
	});

	it('skips same providerId mid-request after first target opens circuit', async () => {
		let calls = 0;
		const dispatch = mock.fn(async (route: RouteResult) => {
			calls += 1;
			if (calls === 1) {
				return {
					response: new Response('rate limited', {
						status: 429,
						headers: { 'Retry-After': '30' },
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		// Two targets on same provider, then a different provider
		const routes = [
			makeRoute('p1', { targetId: 't1', routePriority: 10 }),
			makeRoute('p1', { targetId: 't2', routePriority: 10 }),
			makeRoute('p2', { targetId: 't3', routePriority: 1 }),
		];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.equal(dispatch.mock.callCount(), 2);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.providerId, 'p2');
		assert.equal(isProviderCircuitOpen('p1'), true);
	});

	it('failovers across providers in priority order', async () => {
		const seen: string[] = [];
		const dispatch = mock.fn(async (route: RouteResult) => {
			seen.push(route.providerId);
			if (route.providerId === 'high') {
				return {
					response: new Response('error', { status: 503 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [makeRoute('low', { routePriority: 1 }), makeRoute('high', { routePriority: 10 })];

		const result = await failoverDispatch(emptyRepos, routes, 'openai', dispatch, undefined, defaultOptions);

		assert.deepEqual(seen, ['high', 'low']);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.providerId, 'low');
	});
});

describe('failoverDispatch — provider sticky', () => {
	const stickyRepoExtras = {
		deleteStaleBefore: mock.fn(async () => 0),
	};

	it('tries sticky low-priority target before higher priority tiers', async () => {
		const now = Date.now();
		const seen: string[] = [];
		// expires far enough that last-touch approximation is outside 60s throttle window
		const getBinding = mock.fn(async () => ({
			route_pool_id: 'pool-1',
			affinity_hash: 'x',
			route_target_id: 'low-target',
			binding_token: 'tok-1',
			pool_epoch: 0,
			expires_at: new Date(now + (3_600 - 120) * 1000).toISOString(),
		}));
		const touchBinding = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding,
				touchBinding,
				tryBind: mock.fn(),
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async (route: RouteResult) => {
			seen.push(route.targetId);
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [
			makeRoute('high', { targetId: 'high-target', routePriority: 10 }),
			makeRoute('low', { targetId: 'low-target', routePriority: 1 }),
		];

		const result = await failoverDispatch(repos, routes, 'openai', dispatch, undefined, {
			...defaultOptions,
			routePoolId: 'pool-1',
			sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
		});

		assert.deepEqual(seen, ['low-target']);
		assert.equal(result.response.status, 200);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'hit');
		assert.equal(trace.result, 'kept');
		assert.ok(result.stickyMutationPromise);
		await result.stickyMutationPromise;
		assert.equal(touchBinding.mock.callCount(), 1);
	});

	it('keeps an existing binding untouched when another target primary BYOK succeeds first', async () => {
		const now = Date.now();
		const touchBinding = mock.fn(async () => true);
		const tryBind = mock.fn(async () => true);
		const clearBinding = mock.fn(async () => true);
		const repos = {
			byokKeys: {
				listActiveForRequest: async ({ provider }: { provider: string }) =>
					provider === 'deepseek' ? [makeByokKey('preempt-sticky-1')] : [],
			},
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 'sticky-target',
					binding_token: 'tok-existing',
					pool_epoch: 0,
					expires_at: new Date(now + 3_600_000).toISOString(),
				}),
				touchBinding,
				tryBind,
				clearBinding,
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const stickyRoute = makeRoute('sticky-provider', {
			targetId: 'sticky-target',
			gatewayModelId: 'deepseek/deepseek-chat',
			endpoint: {
				id: 'endpoint-sticky',
				modelId: 'deepseek/deepseek-chat',
				providerId: 'sticky-provider',
				providerSlug: 'openai',
			} as NonNullable<RouteResult['endpoint']>,
			routePriority: 10,
		});
		const byokRoute = makeByokRoute({
			targetId: 'byok-target',
			routePriority: 1,
		});
		const seen: Array<{ targetId: string; keyId: string | null | undefined }> = [];

		const result = await failoverDispatch(
			repos,
			[stickyRoute, byokRoute],
			'openai',
			async (route) => {
				seen.push({ targetId: route.targetId, keyId: route.providerKeyId });
				return {
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			},
			undefined,
			{
				...defaultOptions,
				byok: byokContext,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			},
		);

		assert.deepEqual(seen, [
			{ targetId: 'byok-target', keyId: 'byok:preempt-sticky-1' },
		]);
		assert.equal(result.chosenRoute.targetId, 'byok-target');
		assert.deepEqual(await result.stickyTrace!(), {
			lookup: 'hit',
			attempted_target: null,
			result: 'unchanged',
		});
		assert.equal(touchBinding.mock.callCount(), 0);
		assert.equal(tryBind.mock.callCount(), 0);
		assert.equal(clearBinding.mock.callCount(), 0);
	});

	it('clears sticky on provider failure and continues normal plan without retrying same target', async () => {
		const now = Date.now();
		const seen: string[] = [];
		const clearBinding = mock.fn(async () => true);
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 'low-target',
					binding_token: 'tok-1',
					pool_epoch: 0,
					expires_at: new Date(now + 3_600_000).toISOString(),
				}),
				clearBinding,
				tryBind,
				touchBinding: mock.fn(async () => true),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async (route: RouteResult) => {
			seen.push(route.targetId);
			if (route.targetId === 'low-target') {
				return {
					response: new Response('busy', { status: 429 }),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
				};
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			};
		});
		const routes = [
			makeRoute('high', { targetId: 'high-target', routePriority: 10 }),
			makeRoute('low', { targetId: 'low-target', routePriority: 1 }),
		];

		const result = await failoverDispatch(repos, routes, 'openai', dispatch, undefined, {
			...defaultOptions,
			routePoolId: 'pool-1',
			sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
		});

		assert.deepEqual(seen, ['low-target', 'high-target']);
		assert.equal(result.response.status, 200);
		assert.equal(clearBinding.mock.callCount(), 1);
		const trace = await result.stickyTrace!();
		assert.equal(trace.result, 'rebound');
		assert.ok(result.stickyMutationPromise);
		await result.stickyMutationPromise;
		assert.equal(tryBind.mock.callCount(), 1);
	});

	it('does not clear sticky on 400 client errors', async () => {
		const now = Date.now();
		const clearBinding = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 't1',
					binding_token: 'tok-1',
					pool_epoch: 0,
					expires_at: new Date(now + 3_600_000).toISOString(),
				}),
				clearBinding,
				tryBind: mock.fn(),
				touchBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async () => ({
			response: new Response('bad request', { status: 400 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const routes = [makeRoute('p1', { targetId: 't1' }), makeRoute('p2', { targetId: 't2' })];

		const result = await failoverDispatch(repos, routes, 'openai', dispatch, undefined, {
			...defaultOptions,
			routePoolId: 'pool-1',
			sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
		});

		assert.equal(dispatch.mock.callCount(), 1);
		assert.equal(result.response.status, 400);
		assert.equal(clearBinding.mock.callCount(), 0);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'hit');
	});

	it('binds on first success when sticky enabled and storage miss', async () => {
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => null,
				tryBind,
				touchBinding: mock.fn(),
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const result = await failoverDispatch(
			repos,
			[makeRoute('p1', { targetId: 't1' })],
			'openai',
			dispatch,
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 3 },
			}
		);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'miss');
		assert.equal(trace.result, 'bound');
		assert.equal(trace.attempted_target, 't1');
		await result.stickyMutationPromise;
		assert.equal(tryBind.mock.callCount(), 1);
		const bindArgs = tryBind.mock.calls[0]?.arguments[0] as { poolEpoch: number };
		assert.equal(bindArgs.poolEpoch, 3);
	});

	it('waits for a completed successful stream before binding an explicit session', async () => {
		let resolveUsage!: (usage: typeof EMPTY_USAGE) => void;
		const usagePromise = new Promise<typeof EMPTY_USAGE>((resolve) => {
			resolveUsage = resolve;
		});
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => null,
				tryBind,
				touchBinding: mock.fn(),
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const result = await failoverDispatch(
			repos,
			[makeRoute('p1', { targetId: 't1' })],
			'openai',
			async () => ({
				response: new Response('ok', { status: 200 }),
				usagePromise,
				upstreamRequestId: null,
			}),
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
				stickySuccessPolicy: 'stream_success',
			},
		);

		assert.equal(tryBind.mock.callCount(), 0);
		resolveUsage(EMPTY_USAGE);
		await result.stickyMutationPromise;
		assert.equal(tryBind.mock.callCount(), 1);
		assert.equal((await result.stickyTrace!()).result, 'bound');
	});

	it('does not bind or touch a sticky session after cancellation or a stream error', async () => {
		for (const usage of [
			{ ...EMPTY_USAGE, cancelled: true },
			{ ...EMPTY_USAGE, stream_error: 'upstream ended early' },
		]) {
			const tryBind = mock.fn(async () => true);
			const touchBinding = mock.fn(async () => true);
			const missRepos = {
				routePoolSticky: {
					getBinding: async () => null,
					tryBind,
					touchBinding,
					clearBinding: mock.fn(),
					...stickyRepoExtras,
				},
			} as unknown as GatewayRepositories;
			const miss = await failoverDispatch(
				missRepos,
				[makeRoute('p1', { targetId: 't1' })],
				'openai',
				async () => ({
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(usage),
					upstreamRequestId: null,
				}),
				undefined,
				{
					...defaultOptions,
					routePoolId: 'pool-1',
					sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
					stickySuccessPolicy: 'stream_success',
				},
			);
			await miss.stickyMutationPromise;
			assert.equal(tryBind.mock.callCount(), 0);

			const now = Date.now();
			const hitRepos = {
				routePoolSticky: {
					getBinding: async () => ({
						route_pool_id: 'pool-1', affinity_hash: 'x', route_target_id: 't1',
						binding_token: 'token', pool_epoch: 0,
						expires_at: new Date(now + 300_000).toISOString(),
					}),
					tryBind,
					touchBinding,
					clearBinding: mock.fn(),
					...stickyRepoExtras,
				},
			} as unknown as GatewayRepositories;
			const hit = await failoverDispatch(
				hitRepos,
				[makeRoute('p1', { targetId: 't1' })],
				'openai',
				async () => ({
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve(usage),
					upstreamRequestId: null,
				}),
				undefined,
				{
					...defaultOptions,
					routePoolId: 'pool-1',
					sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
					stickySuccessPolicy: 'stream_success',
				},
			);
			await hit.stickyMutationPromise;
			assert.equal(touchBinding.mock.callCount(), 0);
		}
	});

	it('binds implicit affinity only after a cache hit on an eligible route', async () => {
		for (const [cacheReadTokens, expectedBinds] of [[0, 0], [24, 1]] as const) {
			const tryBind = mock.fn(async () => true);
			const repos = {
				routePoolSticky: {
					getBinding: async () => null,
					tryBind,
					touchBinding: mock.fn(),
					clearBinding: mock.fn(),
					...stickyRepoExtras,
				},
			} as unknown as GatewayRepositories;
			const result = await failoverDispatch(
				repos,
				[makeRoute('eligible', { targetId: 'eligible-target' })],
				'openai',
				async () => ({
					response: new Response('ok', { status: 200 }),
					usagePromise: Promise.resolve({ ...EMPTY_USAGE, cache_read_tokens: cacheReadTokens }),
					upstreamRequestId: null,
				}),
				undefined,
				{
					...defaultOptions,
					routePoolId: 'pool-1',
					sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
					stickySuccessPolicy: 'cache_hit',
					stickyRouteEligible: (route) => route.providerId === 'eligible',
				},
			);
			await result.stickyMutationPromise;
			assert.equal(tryBind.mock.callCount(), expectedBinds);
		}
	});

	it('touches an already activated implicit session after any completed success', async () => {
		const now = Date.now();
		const touchBinding = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1', affinity_hash: 'x', route_target_id: 'eligible-target',
					binding_token: 'token', pool_epoch: 0,
					expires_at: new Date(now + 300_000).toISOString(),
				}),
				tryBind: mock.fn(),
				touchBinding,
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const result = await failoverDispatch(
			repos,
			[makeRoute('eligible', { targetId: 'eligible-target' })],
			'openai',
			async () => ({
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
			}),
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
				stickySuccessPolicy: 'cache_hit',
				stickyRouteEligible: () => true,
			},
		);
		await result.stickyMutationPromise;
		assert.equal(touchBinding.mock.callCount(), 1);
	});

	it('disables implicit sticky storage when no route has beneficial cache pricing', async () => {
		const getBinding = mock.fn(async () => null);
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding,
				tryBind,
				touchBinding: mock.fn(),
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const result = await failoverDispatch(
			repos,
			[makeRoute('ineligible', { targetId: 't1' })],
			'openai',
			async () => ({
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve({ ...EMPTY_USAGE, cache_read_tokens: 10 }),
				upstreamRequestId: null,
			}),
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 600, epoch: 0 },
				stickySuccessPolicy: 'cache_hit',
				stickyRouteEligible: () => false,
			},
		);
		assert.equal(result.response.status, 200);
		assert.equal(getBinding.mock.callCount(), 0);
		assert.equal(tryBind.mock.callCount(), 0);
		assert.deepEqual(await result.stickyTrace!(), {
			lookup: 'disabled', attempted_target: null, result: 'unchanged',
		});
	});

	it('records unchanged when tryBind loses CAS', async () => {
		const tryBind = mock.fn(async () => false);
		const repos = {
			routePoolSticky: {
				getBinding: async () => null,
				tryBind,
				touchBinding: mock.fn(),
				clearBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const result = await failoverDispatch(
			repos,
			[makeRoute('p1', { targetId: 't1' })],
			'openai',
			dispatch,
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			}
		);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'miss');
		assert.equal(trace.result, 'unchanged');
	});

	it('skips rebind when sticky target is circuit-open but another provider succeeds', async () => {
		resetProviderCircuitStateForTests();
		const now = Date.now();
		markProviderFailure('p-sticky', 'rate_limit', 60_000);
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 'sticky-target',
					binding_token: 'tok-1',
					pool_epoch: 0,
					expires_at: new Date(now + 3_600_000).toISOString(),
				}),
				clearBinding: mock.fn(),
				tryBind,
				touchBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));
		const result = await failoverDispatch(
			repos,
			[
				makeRoute('p-sticky', { targetId: 'sticky-target', routePriority: 1 }),
				makeRoute('p-other', { targetId: 'other-target', routePriority: 10 }),
			],
			'openai',
			dispatch,
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			}
		);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.targetId, 'other-target');
		assert.equal(tryBind.mock.callCount(), 0);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'invalid_circuit');
		assert.equal(trace.result, 'unchanged');
		resetProviderCircuitStateForTests();
	});

	it('skips sticky attempt when all candidates are circuit-open and leaves binding untouched', async () => {
		resetProviderCircuitStateForTests();
		const now = Date.now();
		markProviderFailure('p1', 'rate_limit', 60_000);
		const clearBinding = mock.fn(async () => true);
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 't1',
					binding_token: 'tok-1',
					pool_epoch: 0,
					expires_at: new Date(now + 3_600_000).toISOString(),
				}),
				clearBinding,
				tryBind,
				touchBinding: mock.fn(),
				...stickyRepoExtras,
			},
		} as unknown as GatewayRepositories;
		const dispatch = mock.fn(async () => ({
			response: new Response('ok', { status: 200 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		}));

		const result = await failoverDispatch(
			repos,
			[makeRoute('p1', { targetId: 't1' })],
			'openai',
			dispatch,
			undefined,
			{
				...defaultOptions,
				routePoolId: 'pool-1',
				sticky: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			}
		);

		assert.equal(dispatch.mock.callCount(), 0);
		assert.equal(clearBinding.mock.callCount(), 0);
		assert.equal(tryBind.mock.callCount(), 0);
		const trace = await result.stickyTrace!();
		assert.equal(trace.lookup, 'invalid_circuit');
		resetProviderCircuitStateForTests();
	});
});

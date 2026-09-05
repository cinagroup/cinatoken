import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GatewayRepositories, ModelRow } from '@octafuse/core';
import {
	dispatchGlobalModelFallback,
	type GlobalTextProxy,
} from './model-fallback-global-dispatch';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import { buildModelFallbackTrace } from './model-fallbacks';
import type { RouteResult } from './model-router';
import { resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { EMPTY_USAGE, proxyChatCompletions } from './proxy';
import { RequestTimingCollector } from './request-timing';
import { resetSharedKeyPoolStateForTests } from './shared-key-pool';
import { resetUserModelCircuitStateForTests } from './user-model-circuit-breaker';

const originalFetch = globalThis.fetch;
const emptyRepos = {} as GatewayRepositories;

function model(id: string): ModelRow {
	return {
		id,
		display_name: id.toUpperCase(),
		vendor: 'test',
		context_window: 8_192,
		max_tokens: 1_024,
		pricing_profile: null,
		tags: '[]',
		description: null,
		metadata: null,
		input_modalities: '["text"]',
		output_modalities: '["text"]',
		released_at: null,
		route_policy: '{"strategy":"weight_priority"}',
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

function route(
	targetId: string,
	candidateIndex: number,
	modelId: string,
	priority: number,
	globalRank: number,
): RouteResult {
	return {
		targetId,
		modelSurfaceId: null,
		routePoolId: `pool-${modelId}`,
		providerId: targetId,
		providerName: targetId,
		providerModelName: `private-${targetId}`,
		gatewayModelId: modelId,
		gatewayCandidateIndex: candidateIndex,
		gatewayGlobalEndpointRank: globalRank,
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: `https://${targetId}.example/v1` } },
		providerApiKey: `sk-${targetId}`,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		providerRoutingTrace: {
			configured_target_ids: ['m2-a', 'm1-a', 'm2-b', 'm1-b'],
			eligible_target_ids: ['m2-a', 'm1-a', 'm2-b', 'm1-b'],
			sort: 'latency',
			partition: 'none',
			global_endpoint_rank: globalRank,
			require_parameters: false,
			data_collection: 'allow',
			zdr: false,
			quantizations: null,
			max_price: null,
		},
		routeGroup: 'default',
		routePriority: priority,
		routeWeight: 1,
		providerKeyId: targetId,
		providerKeyLabel: targetId,
		providerKeyFingerprint: `fingerprint-${targetId}`,
	};
}

function candidate(
	modelId: string,
	routes: RouteResult[],
	marker: string,
): ModelFallbackCandidatePlan {
	return {
		requestedModelId: modelId,
		model: model(modelId),
		baseModelId: modelId,
		effectiveRouteGroup: 'default',
		routes,
		surface: null,
		strategy: { base: 'weight_priority', tierOverrides: new Map() },
		upstreamBody: { model: modelId, marker, messages: [] },
		hasProviderPreferences: true,
	};
}

function globalFixture(): {
	routes: RouteResult[];
	candidates: ModelFallbackCandidatePlan[];
} {
	const routes = [
		route('m2-a', 1, 'm2', 4, 1),
		route('m1-a', 0, 'm1', 3, 2),
		route('m2-b', 1, 'm2', 2, 3),
		route('m1-b', 0, 'm1', 1, 4),
	];
	return {
		routes,
		candidates: [
			candidate('m1', routes.filter((item) => item.gatewayCandidateIndex === 0), 'body-m1'),
			candidate('m2', routes.filter((item) => item.gatewayCandidateIndex === 1), 'body-m2'),
		],
	};
}

beforeEach(() => {
	resetProviderCircuitStateForTests();
	resetSharedKeyPoolStateForTests();
	resetUserModelCircuitStateForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetProviderCircuitStateForTests();
	resetSharedKeyPoolStateForTests();
	resetUserModelCircuitStateForTests();
});

describe('partition none global model fallback dispatch', () => {
	it('records a gateway-local admission denial without inventing an upstream provider attempt', async () => {
		const fixture = globalFixture();
		const chosenRoute = fixture.routes[0]!;
		const proxy: GlobalTextProxy = async () => ({
			response: new Response(
				JSON.stringify({ error: { message: 'Gateway key spend limit exceeded' } }),
				{
					status: 402,
					headers: {
						'Content-Type': 'application/json',
						'X-OctaFuse-Error-Code': 'gateway.budget_exceeded',
					},
				},
			),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			chosenRoute,
			circuitEvents: [],
			suppressErrorAlert: true,
			meta: {
				gatewayGeneratedError: true,
				failoverForbidden: true,
				admissionDeniedPreDispatch: true,
			},
			dispatchAttempts: [],
		});

		const dispatched = await dispatchGlobalModelFallback({
			repos: emptyRepos,
			candidates: fixture.candidates,
			globalRoutes: fixture.routes,
			userId: 'user-budget-denied',
			timing: new RequestTimingCollector(),
			beforeUpstreamDispatch: async () => undefined,
			proxy,
			affinityKey: 'user-budget-denied|global|partition-none|openai',
			tierKeyPrefix: 'global|partition-none|openai',
		});

		assert.equal(dispatched.ok, true);
		if (!dispatched.ok) return;
		assert.equal(dispatched.fallbackAttempts.length, 1);
		assert.deepEqual(dispatched.fallbackAttempts[0], {
			model: 'm2',
			base_model: 'm2',
			route_group: 'default',
			status: 402,
			outcome: 'error',
			error_code: 'gateway.budget_exceeded',
		});
		assert.equal(dispatched.fallbackAttempts[0]?.provider_id, undefined);
		assert.equal(dispatched.fallbackAttempts[0]?.route_target_id, undefined);
	});

	it('stops after one fetch when the first dispatched outcome is unknown', async () => {
		const fixture = globalFixture();
		let fetches = 0;
		globalThis.fetch = async () => {
			fetches += 1;
			throw new TypeError('connection reset after request dispatch');
		};

		const dispatched = await dispatchGlobalModelFallback({
			repos: emptyRepos,
			candidates: fixture.candidates,
			globalRoutes: fixture.routes,
			userId: 'user-unknown',
			timing: new RequestTimingCollector(),
			beforeUpstreamDispatch: async () => undefined,
			proxy: proxyChatCompletions,
			affinityKey: 'user-unknown|global|partition-none|openai',
			tierKeyPrefix: 'global|partition-none|openai',
		});

		assert.equal(fetches, 1);
		assert.equal(dispatched.ok, true);
		if (!dispatched.ok) return;
		assert.equal(dispatched.result.response.status, 502);
		assert.equal(dispatched.result.chosenRoute.targetId, 'm2-a');
		assert.equal(dispatched.result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(dispatched.result.meta?.failoverForbidden, true);
		assert.equal(dispatched.result.dispatchAttempts?.length, 1);
		assert.equal(dispatched.fallbackAttempts.length, 1);
		assert.deepEqual(await dispatched.result.response.json(), {
			error: {
				code: 502,
				message: 'Upstream provider is unavailable',
				metadata: { error_type: 'provider_unavailable' },
			},
			code: 'gateway.upstream_request_failed',
		});
	});

	it('performs real fetches in M2/M1/M2/M1 order with each candidate body and route model', async () => {
		const fixture = globalFixture();
		const fetches: Array<{ target: string; marker: string; model: string }> = [];
		globalThis.fetch = async (input, init) => {
			const target = new URL(String(input)).hostname.split('.')[0]!;
			const body = JSON.parse(String(init?.body)) as { marker: string; model: string };
			fetches.push({ target, marker: body.marker, model: body.model });
			if (target !== 'm1-b') {
				return Response.json(
					{ error: { message: `unavailable ${target}` } },
					{ status: 503 },
				);
			}
			return Response.json({
				id: 'chatcmpl-success',
				object: 'chat.completion',
				created: 1_700_000_000,
				model: 'private-m1-b',
				choices: [{
					index: 0,
					message: { role: 'assistant', content: 'ok' },
					finish_reason: 'stop',
				}],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			});
		};

		const dispatched = await dispatchGlobalModelFallback({
			repos: emptyRepos,
			candidates: fixture.candidates,
			globalRoutes: fixture.routes,
			userId: 'user-1',
			timing: new RequestTimingCollector(),
			beforeUpstreamDispatch: async () => undefined,
			proxy: proxyChatCompletions,
			affinityKey: 'user-1|global|partition-none|openai',
			tierKeyPrefix: 'global|partition-none|openai',
		});

		assert.equal(dispatched.ok, true);
		if (!dispatched.ok) return;
		assert.deepEqual(fetches, [
			{ target: 'm2-a', marker: 'body-m2', model: 'private-m2-a' },
			{ target: 'm1-a', marker: 'body-m1', model: 'private-m1-a' },
			{ target: 'm2-b', marker: 'body-m2', model: 'private-m2-b' },
			{ target: 'm1-b', marker: 'body-m1', model: 'private-m1-b' },
		]);
		assert.equal(dispatched.selectedPlan.baseModelId, 'm1');
		assert.equal(dispatched.result.chosenRoute.targetId, 'm1-b');
		assert.equal(
			dispatched.result.chosenRoute.providerRoutingTrace?.global_endpoint_rank,
			4,
		);
		assert.deepEqual(
			dispatched.fallbackAttempts.map((attempt) => [
				attempt.base_model,
				attempt.route_target_id,
				attempt.outcome,
			]),
			[
				['m2', 'm2-b', 'error'],
				['m1', 'm1-b', 'success'],
			],
		);
		assert.deepEqual(
			buildModelFallbackTrace(['m1', 'm2'], dispatched.fallbackAttempts),
			{
				original_model: 'm1',
				requested_models: ['m1', 'm2'],
				final_model: 'm1',
				fallback_count: 1,
				attempts: dispatched.fallbackAttempts,
			},
		);
	});

	it('uses the chosen route candidate for body resolution and the final fallback summary', async () => {
		const fixture = globalFixture();
		const chosenRoute = fixture.routes[2]!;
		const resolvedBodies: string[] = [];
		const proxy: GlobalTextProxy = async (_repos, routes, body) => {
			assert.equal(typeof body, 'function');
			if (typeof body === 'function') {
				for (const item of routes) {
					resolvedBodies.push(String(body(item).marker));
				}
			}
			return {
				response: new Response('ok', { status: 200 }),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
				chosenRoute,
				circuitEvents: [],
				suppressErrorAlert: false,
				dispatchAttempts: [
					{
						candidateIndex: 1,
						modelId: 'm2',
						globalEndpointRank: 1,
						routeTargetId: 'm2-a',
						providerId: 'm2-a',
						status: 503,
						outcome: 'error',
					},
					{
						candidateIndex: 0,
						modelId: 'm1',
						globalEndpointRank: 2,
						routeTargetId: 'm1-a',
						providerId: 'm1-a',
						status: 503,
						outcome: 'error',
					},
					{
						candidateIndex: 1,
						modelId: 'm2',
						globalEndpointRank: 3,
						routeTargetId: 'm2-b',
						providerId: 'm2-b',
						status: 200,
						outcome: 'success',
					},
				],
			};
		};

		const dispatched = await dispatchGlobalModelFallback({
			repos: emptyRepos,
			candidates: fixture.candidates,
			globalRoutes: fixture.routes,
			userId: 'user-2',
			timing: new RequestTimingCollector(),
			beforeUpstreamDispatch: async () => undefined,
			proxy,
			affinityKey: 'user-2|global|partition-none|openai',
			tierKeyPrefix: 'global|partition-none|openai',
		});

		assert.equal(dispatched.ok, true);
		if (!dispatched.ok) return;
		assert.deepEqual(resolvedBodies, ['body-m2', 'body-m1', 'body-m2', 'body-m1']);
		assert.equal(dispatched.selectedPlan.baseModelId, 'm2');
		assert.deepEqual(
			dispatched.fallbackAttempts.map((attempt) => [attempt.base_model, attempt.outcome]),
			[['m1', 'error'], ['m2', 'success']],
		);
		const trace = buildModelFallbackTrace(['m1', 'm2'], dispatched.fallbackAttempts);
		assert.equal(trace?.final_model, 'm2');
		assert.equal(trace?.attempts.at(-1)?.route_target_id, 'm2-b');
	});

	it('keeps fallback and circuit summaries bounded across 120 globally ranked endpoints', async () => {
		const endpointCount = 120;
		const candidateCount = 8;
		const routes = Array.from({ length: endpointCount }, (_, index) => {
			const candidateIndex = index % candidateCount;
			return route(
				`c${candidateIndex}-e${index}`,
				candidateIndex,
				`m${candidateIndex}`,
				endpointCount - index,
				index + 1,
			);
		});
		const candidates = Array.from({ length: candidateCount }, (_, candidateIndex) =>
			candidate(
				`m${candidateIndex}`,
				routes.filter((item) => item.gatewayCandidateIndex === candidateIndex),
				`body-m${candidateIndex}`,
			),
		);
		let fetches = 0;
		globalThis.fetch = async (input) => {
			fetches += 1;
			const target = new URL(String(input)).hostname.split('.')[0]!;
			if (target === 'c0-e112') {
				return Response.json(
					{ error: { message: 'invalid request shape' } },
					{ status: 400 },
				);
			}
			if (target === 'c7-e119') {
				return Response.json({
					id: 'chatcmpl-success',
					object: 'chat.completion',
					created: 1_700_000_000,
					model: 'private-c7-e119',
					choices: [{
						index: 0,
						message: { role: 'assistant', content: 'ok' },
						finish_reason: 'stop',
					}],
					usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
				});
			}
			return new Response('x'.repeat(4 * 1024), {
				status: 503,
				headers: { 'Content-Type': 'text/plain' },
			});
		};

		const dispatched = await dispatchGlobalModelFallback({
			repos: emptyRepos,
			candidates,
			globalRoutes: routes,
			userId: 'user-bounded',
			timing: new RequestTimingCollector(),
			beforeUpstreamDispatch: async () => undefined,
			proxy: proxyChatCompletions,
			affinityKey: 'user-bounded|global|partition-none|openai',
			tierKeyPrefix: 'global|partition-none|openai',
		});

		assert.equal(fetches, endpointCount);
		assert.equal(dispatched.ok, true);
		if (!dispatched.ok) return;
		assert.equal(dispatched.result.dispatchAttempts?.length, candidateCount);
		assert.deepEqual(
			dispatched.result.dispatchAttempts?.map((attempt) => attempt.routeTargetId),
			Array.from({ length: candidateCount }, (_, candidateIndex) =>
				`c${candidateIndex}-e${112 + candidateIndex}`,
			),
		);
		const retainedErrorBytes = (dispatched.result.dispatchAttempts ?? []).reduce(
			(total, attempt) => total + new TextEncoder().encode(attempt.errorBodyText ?? '').byteLength,
			0,
		);
		assert.ok(retainedErrorBytes <= candidateCount * 8 * 1024);
		assert.equal(dispatched.fallbackAttempts.length, candidateCount);
		assert.equal(dispatched.fallbackAttempts.at(-1)?.base_model, 'm7');
		assert.equal(dispatched.fallbackAttempts.at(-1)?.outcome, 'success');
		assert.equal(dispatched.userModelCircuitEvents.length, 1);
		const circuitEvent = dispatched.userModelCircuitEvents[0]!;
		assert.equal(circuitEvent.kind, 'user_model');
		if (circuitEvent.kind !== 'user_model') return;
		assert.equal(circuitEvent.modelId, 'm0');
		assert.equal(circuitEvent.reason, 'client_error');
		assert.deepEqual(dispatched.result.circuitEvents, []);
	});
});

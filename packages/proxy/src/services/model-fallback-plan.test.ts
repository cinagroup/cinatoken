import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	ModelEndpointRow,
	ModelRow,
	ModelRouteRow,
	ProviderRow,
	RouteDataPolicyRow,
	RoutePerformanceSample,
} from '@octafuse/core';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	parseRouteRoutingMetadata,
} from '@octafuse/core';
import { buildModelFallbackPlan } from './model-fallback-plan';

function model(id: string): ModelRow {
	return {
		id,
		display_name: id.toUpperCase(),
		vendor: 'test',
		context_window: 8192,
		max_tokens: 1024,
		pricing_profile: null,
		tags: '[]',
		description: null,
		metadata: null,
		input_modalities: '["text"]',
		output_modalities: '["text"]',
		released_at: null,
		route_policy: '{"strategy":"weight_priority"}',
		created_at: '2026-01-01T00:00:00Z',
	};
}

function modelRoute(modelId: string): ModelRouteRow {
	return {
		id: `target-${modelId}`,
		model_id: modelId,
		provider_id: 'provider-a',
		provider_model_name: `private-${modelId}`,
		priority: 10,
		status: 'active',
		route_group: 'default',
		weight: 1,
		price_override: null,
		custom_params: null,
		upstream_protocol: 'openai',
		upstream_operation: 'chat',
		adapter: 'passthrough',
		routing_metadata: null,
	};
}

function routeWithOutputCapacity(
	modelId: string,
	targetId: string,
	maxCompletionTokens: number | null,
	protocol: 'openai' | 'anthropic' = 'openai',
	operation = protocol === 'anthropic' ? 'messages' : 'chat',
): ModelRouteRow {
	return {
		...modelRoute(modelId),
		id: targetId,
		upstream_protocol: protocol,
		upstream_operation: operation,
		routing_metadata: maxCompletionTokens == null
			? null
			: JSON.stringify({ max_completion_tokens: maxCompletionTokens }),
	};
}

const provider: ProviderRow = {
	id: 'provider-a',
	name: 'Provider A',
	endpoints: '{"openai":{"base":"https://provider.test/v1"},"anthropic":{"base":"https://provider.test"}}',
	api_key: 'secret',
	status: 'active',
	description: null,
	created_at: '2026-01-01T00:00:00Z',
};

function verifiedPolicy(routeTargetId: string, subjectFingerprint = ''): RouteDataPolicyRow {
	return {
		route_target_id: routeTargetId,
		retention_days: 0,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: 'https://provider.test/privacy',
		verified_by: 'admin',
		verified_at: '2026-08-01T00:00:00.000Z',
		expires_at: '2099-08-01T00:00:00.000Z',
		status: 'verified',
		subject_fingerprint: subjectFingerprint,
		invalidated_at: null,
		invalidation_reason: null,
		updated_at: '2026-08-01T00:00:00.000Z',
	};
}

function repositories(
	models: Map<string, ModelRow>,
	policies: RouteDataPolicyRow[] = [],
	options: {
		routesByModel?: Map<string, ModelRouteRow[]>;
		performanceSamples?: RoutePerformanceSample[];
		provider?: ProviderRow;
		providers?: ProviderRow[];
		endpointPricingByRoute?: Map<string, {
			prompt: string;
			completion: string;
			request?: string;
			image?: string;
			discount?: number;
		}>;
		endpointOverridesByRoute?: Map<string, Partial<ModelEndpointRow>>;
	} = {},
): GatewayRepositories {
	const selectedProviders = options.providers ?? [options.provider ?? provider];
	const providersById = new Map(selectedProviders.map((item) => [item.id, item]));
	const routesForModel = (id: string) => options.routesByModel?.get(id) ?? [modelRoute(id)];
	const routesById = new Map(
		[...models.keys()].flatMap((modelId) => routesForModel(modelId)).map((route) => [route.id, route]),
	);
	return {
		modelRouting: {
			getModelById: async (id: string) => models.get(id) ?? null,
			resolveModelSurface: async () => null,
			getModelRoutesByModelId: async (id: string) => routesForModel(id),
		},
		providers: {
			getProvidersByIds: async (ids: string[]) => selectedProviders.filter((item) => ids.includes(item.id)),
		},
		modelEndpoints: {
			listRuntimeBindingsByRouteTargetIds: async (ids: string[]) => Promise.all(
				ids.flatMap((id) => {
					const route = routesById.get(id);
					if (!route) return [];
					return [Promise.resolve().then(async () => {
						const selectedProvider = providersById.get(route.provider_id);
						if (!selectedProvider) throw new Error(`missing provider ${route.provider_id}`);
						const metadata = parseRouteRoutingMetadata(route.routing_metadata);
						const pricing = options.endpointPricingByRoute?.get(id) ?? {
							prompt: '0', completion: '0',
						};
						const endpoint: ModelEndpointRow = {
							id: `endpoint-${id}`,
							model_id: route.model_id,
							provider_id: route.provider_id,
							provider_slug: selectedProvider.id,
							tag: metadata?.endpoint_slug ?? selectedProvider.id,
							endpoint_class: metadata?.endpoint_class ?? null,
							region: metadata?.region ?? null,
							context_length: metadata?.context_length ?? 8_192,
							max_prompt_tokens: metadata?.max_prompt_tokens ?? null,
							max_completion_tokens: metadata?.max_completion_tokens ?? null,
							quantization: metadata?.quantization ?? null,
							supported_parameters: JSON.stringify(metadata?.supported_parameters ?? []),
							pricing: JSON.stringify({ currency: 'USD', ...pricing }),
							supports_implicit_caching: false,
							supports_voice_cloning: false,
							supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
							image_capabilities: '{}',
							evidence_url: 'https://provider.test/evidence',
							verified_by: 'test',
							verified_at: '2026-01-01T00:00:00.000Z',
							expires_at: '2099-01-01T00:00:00.000Z',
							status: 'verified',
							created_at: '2026-01-01T00:00:00.000Z',
							updated_at: '2026-01-01T00:00:00.000Z',
							...(options.endpointOverridesByRoute?.get(id) ?? {}),
						};
						return {
							...endpoint,
							route_target_id: id,
							subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
								route,
								selectedProvider,
							),
						};
					})];
				}),
			),
		},
		routeDataPolicies: {
			getByRouteTargetIds: async (ids: string[]) => policies.filter((policy) => ids.includes(policy.route_target_id)),
		},
		systemConfig: { getConfig: async () => null },
		requestLogs: {
			getRecentRoutePerformanceSamples: async () => (options.performanceSamples ?? [])
				.flatMap((sample) => Array.from({ length: 5 }, () => ({ ...sample }))),
			getRouteAvailabilityAggregates: async () => [],
		},
	} as unknown as GatewayRepositories;
}

describe('model fallback preflight', () => {
	it('resolves every candidate and applies one provider policy before dispatch', async () => {
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')], ['m2', model('m2')]])),
			{
				modelIds: ['m1', 'm2'],
				body: { model: 'm1', provider: { only: ['Provider A'] }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.candidates.map((candidate) => candidate.baseModelId), ['m1', 'm2']);
		assert.deepEqual(result.candidates.map((candidate) => candidate.routes[0]?.gatewayModelId), ['m1', 'm2']);
		assert.equal('provider' in result.candidates[0]!.upstreamBody, false);
		assert.deepEqual(result.candidates[0]?.routes[0]?.providerRoutingTrace, {
			configured_target_ids: ['target-m1'],
			eligible_target_ids: ['target-m1'],
			sort: null,
			partition: 'model',
			global_endpoint_rank: null,
			require_parameters: false,
			data_collection: 'allow',
			zdr: false,
			quantizations: null,
			max_price: null,
			service_tier: null,
			speed: null,
			model_variant: null,
		});
		assert.equal(
			JSON.stringify(result.candidates[0]?.routes[0]?.providerRoutingTrace).includes('secret'),
			false,
		);
	});

	it('retains only public performance thresholds in the request-local routing trace', async () => {
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]])),
			{
				modelIds: ['m1'],
				body: {
					model: 'm1',
					messages: [],
					provider: {
						preferred_min_throughput: { p50: 40, p90: 20 },
						preferred_max_latency: 0.8,
					},
				},
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.candidates[0]?.routes[0]?.providerRoutingTrace?.preferred_min_throughput,
			{ p50: 40, p90: 20 },
		);
		assert.equal(
			result.candidates[0]?.routes[0]?.providerRoutingTrace?.preferred_max_latency,
			0.8,
		);
	});

	it('implements service-tier pools, aliases, and model variants from verified endpoints', async () => {
		const tierRoute = (
			targetId: string,
			endpointSlug: string,
			endpointClass: 'standard' | 'service_tier',
			priority: number,
		): ModelRouteRow => ({
			...modelRoute('m1'),
			id: targetId,
			priority,
			routing_metadata: JSON.stringify({
				endpoint_slug: endpointSlug,
				endpoint_class: endpointClass,
				supported_parameters: ['speed'],
			}),
		});
		const standard = tierRoute('standard', 'provider-a/standard', 'standard', 100);
		const priority = tierRoute('priority', 'provider-a/fast', 'service_tier', 10);
		const flex = tierRoute('flex', 'provider-a/flex', 'service_tier', 1);
		const routesByModel = new Map([['m1', [standard, priority, flex]]]);
		const endpointPricingByRoute = new Map([
			['standard', { prompt: '0.000002', completion: '0.000002' }],
			['priority', { prompt: '0.000004', completion: '0.000004' }],
			['flex', { prompt: '0.000001', completion: '0.000001' }],
		]);
		const performanceSamples: RoutePerformanceSample[] = [
			{ route_target_id: 'standard', first_reasoning_token_ms: null, first_token_ms: 500, output_tokens: 100, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'priority', first_reasoning_token_ms: null, first_token_ms: 100, output_tokens: 300, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
		];
		const repos = repositories(new Map([['m1', model('m1')]]), [], {
			routesByModel,
			endpointPricingByRoute,
			performanceSamples,
		});

		const priorityResult = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [], service_tier: 'fast' },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(priorityResult.ok, true);
		if (priorityResult.ok) {
			assert.deepEqual(priorityResult.candidates[0]?.routes.map((route) => route.targetId), ['priority', 'standard']);
			assert.deepEqual(priorityResult.candidates[0]?.routes.map((route) => route.gatewayServiceTier), ['priority', 'default']);
			assert.equal('service_tier' in priorityResult.candidates[0]!.upstreamBody, false);
			assert.equal(priorityResult.candidates[0]?.routingPreferences?.serviceTier, 'priority');
		}

		const fastResult = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [], speed: 'fast' },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(fastResult.ok, true);
		if (fastResult.ok) {
			assert.deepEqual(fastResult.candidates[0]?.routes.map((route) => route.targetId), ['priority', 'standard']);
			assert.equal('speed' in fastResult.candidates[0]!.upstreamBody, false);
			assert.equal(fastResult.candidates[0]?.routingPreferences?.requestedSpeed, 'fast');
			assert.deepEqual(fastResult.candidates[0]?.routes.map((route) => route.gatewayTextSpeed), ['fast', 'fast']);
			assert.deepEqual(fastResult.candidates[0]?.routes.map((route) => route.gatewayRequestedServiceTier), ['priority', 'priority']);
			assert.equal(fastResult.candidates[0]?.routes[0]?.providerRoutingTrace?.speed, 'fast');
		}

		const flexResult = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [], service_tier: 'flex' },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(flexResult.ok, true);
		if (flexResult.ok) {
			assert.deepEqual(flexResult.candidates[0]?.routes.map((route) => route.targetId), ['flex']);
		}

		const nitro = await buildModelFallbackPlan(repos, {
			modelIds: ['m1:nitro'],
			body: { model: 'm1:nitro', messages: [] },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(nitro.ok, true);
		if (nitro.ok) {
			assert.deepEqual(nitro.candidates[0]?.routes.map((route) => route.targetId), ['priority', 'standard']);
			assert.equal(nitro.candidates[0]?.effectiveRouteGroup, 'default');
			assert.equal(nitro.candidates[0]?.routingPreferences?.modelVariant, 'nitro');
		}

		const floor = await buildModelFallbackPlan(repos, {
			modelIds: ['m1:floor'],
			body: { model: 'm1:floor', messages: [] },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(floor.ok, true);
		if (floor.ok) {
			assert.deepEqual(floor.candidates[0]?.routes.map((route) => route.targetId), ['flex', 'standard']);
			assert.equal(floor.candidates[0]?.routingPreferences?.modelVariant, 'floor');
		}

		const orderedNitro = await buildModelFallbackPlan(repos, {
			modelIds: ['m1:nitro'],
			body: { model: 'm1:nitro', messages: [], provider: { order: ['provider-a'] } },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(orderedNitro.ok, true);
		if (orderedNitro.ok) {
			assert.deepEqual(orderedNitro.candidates[0]?.routes.map((route) => route.targetId), ['standard']);
		}

		const defaultNitro = await buildModelFallbackPlan(repos, {
			modelIds: ['m1:nitro'],
			body: { model: 'm1:nitro', messages: [], service_tier: 'default' },
			requestProtocol: 'openai',
			requestOperation: 'chat',
		});
		assert.equal(defaultNitro.ok, true);
		if (defaultNitro.ok) {
			assert.deepEqual(defaultNitro.candidates[0]?.routes.map((route) => route.targetId), ['standard']);
		}
	});

	it('falls back to standard routing only when a flex endpoint does not exist', async () => {
		const standardRoute = {
			...modelRoute('m1'),
			routing_metadata: JSON.stringify({
				endpoint_slug: 'provider-a/standard',
				endpoint_class: 'standard',
			}),
		};
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [], {
				routesByModel: new Map([['m1', [standardRoute]]]),
			}),
			{
				modelIds: ['m1'],
				body: { model: 'm1', messages: [], service_tier: 'flex' },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidates[0]?.routes.map((route) => route.targetId), ['target-m1']);
			assert.equal(result.candidates[0]?.routes[0]?.gatewayServiceTier, 'default');
		}
	});

	it('globally interleaves endpoints across fallback models for partition none', async () => {
		const makeRoute = (modelId: string, targetId: string, priority: number): ModelRouteRow => ({
			...modelRoute(modelId),
			id: targetId,
			priority,
		});
		const routesByModel = new Map<string, ModelRouteRow[]>([
			['m1', [makeRoute('m1', 'm1-slow', 20), makeRoute('m1', 'm1-fast', 10)]],
			['m2', [makeRoute('m2', 'm2-fast', 20), makeRoute('m2', 'm2-slow', 10)]],
		]);
		const performanceSamples: RoutePerformanceSample[] = [
			{ route_target_id: 'm1-slow', first_reasoning_token_ms: null, first_token_ms: 1_000, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm1-fast', first_reasoning_token_ms: null, first_token_ms: 200, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm2-fast', first_reasoning_token_ms: null, first_token_ms: 100, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm2-slow', first_reasoning_token_ms: null, first_token_ms: 300, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: 0, created_at: '2026-08-30T00:00:00Z' },
		];
		const result = await buildModelFallbackPlan(
			repositories(
				new Map([['m1', model('m1')], ['m2', model('m2')]]),
				[],
				{ routesByModel, performanceSamples },
			),
			{
				modelIds: ['m1', 'm2'],
				body: {
					models: ['m1', 'm2'],
					messages: [],
					provider: { sort: { by: 'latency', partition: 'none' } },
				},
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.candidates.map((candidate) => candidate.baseModelId), ['m1', 'm2']);
		assert.equal(result.endpointPartition, 'none');
		assert.deepEqual(
			result.globalRoutes.map((route) => route.targetId),
			['m2-fast', 'm1-fast', 'm2-slow', 'm1-slow'],
		);
		assert.deepEqual(
			result.globalRoutes.map((route) => result.candidates[route.gatewayCandidateIndex!]?.baseModelId),
			['m2', 'm1', 'm2', 'm1'],
		);
		assert.deepEqual(
			result.globalRoutes[0]?.providerRoutingTrace?.eligible_target_ids,
			['m2-fast', 'm1-fast', 'm2-slow', 'm1-slow'],
		);
		assert.equal(
			result.globalRoutes[0]?.providerRoutingTrace?.global_endpoint_rank,
			1,
		);
	});

	it('filters every model candidate by authoritative endpoint output capacity', async () => {
		const routesByModel = new Map<string, ModelRouteRow[]>([
			['m1', [
				routeWithOutputCapacity('m1', 'm1-small', 1_024),
				routeWithOutputCapacity('m1', 'm1-capable', 4_096),
				{ ...routeWithOutputCapacity('m1', 'm1-unknown', null), custom_params: '{"max_tokens":8192}' },
			]],
			['m2', [
				routeWithOutputCapacity('m2', 'm2-unknown', null),
				routeWithOutputCapacity('m2', 'm2-capable', 8_192),
			]],
		]);
		const m1 = model('m1');
		m1.max_tokens = 128_000;
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', m1], ['m2', model('m2')]]), [], { routesByModel }),
			{
				modelIds: ['m1', 'm2'],
				body: {
					models: ['m1', 'm2'],
					messages: [],
					max_tokens: 2_048,
					max_completion_tokens: 3_000,
				},
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.endpointPartition, 'model');
		assert.deepEqual(result.candidates[0]?.routes.map((route) => route.targetId), ['m1-capable']);
		assert.deepEqual(result.candidates[1]?.routes.map((route) => route.targetId), ['m2-capable']);
		assert.equal(result.candidates[0]?.upstreamBody.max_tokens, 2_048);
		assert.equal(result.candidates[0]?.upstreamBody.max_completion_tokens, 3_000);
	});

	it('uses protocol-specific output fields for Responses and Messages', async () => {
		const responsesRoutes = new Map<string, ModelRouteRow[]>([[
			'm1',
			[
				routeWithOutputCapacity('m1', 'responses-small', 1_024, 'openai', 'responses'),
				routeWithOutputCapacity('m1', 'responses-capable', 4_096, 'openai', 'responses'),
			],
		]]);
		const responses = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [], { routesByModel: responsesRoutes }),
			{
				modelIds: ['m1'],
				body: { model: 'm1', input: 'hello', max_output_tokens: 2_048 },
				requestProtocol: 'openai',
				requestOperation: 'responses',
			},
		);
		assert.equal(responses.ok, true);
		if (responses.ok) {
			assert.deepEqual(responses.candidates[0]?.routes.map((route) => route.targetId), ['responses-capable']);
		}

		const messageRoutes = new Map<string, ModelRouteRow[]>([[
			'm1',
			[
				routeWithOutputCapacity('m1', 'messages-small', 1_024, 'anthropic'),
				routeWithOutputCapacity('m1', 'messages-capable', 4_096, 'anthropic'),
			],
		]]);
		const messages = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [], { routesByModel: messageRoutes }),
			{
				modelIds: ['m1'],
				body: { model: 'm1', messages: [], max_tokens: 2_048 },
				requestProtocol: 'anthropic',
				requestOperation: 'messages',
			},
		);
		assert.equal(messages.ok, true);
		if (messages.ok) {
			assert.deepEqual(messages.candidates[0]?.routes.map((route) => route.targetId), ['messages-capable']);
		}
	});

	it('preserves routes without an explicit protocol output limit', async () => {
		const routesByModel = new Map<string, ModelRouteRow[]>([[
			'm1',
			[
				routeWithOutputCapacity('m1', 'unknown-capacity', null),
				routeWithOutputCapacity('m1', 'known-capacity', 64),
			],
		]]);
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [], { routesByModel }),
			{
				modelIds: ['m1'],
				// max_output_tokens is not a Chat Completions field and therefore is
				// not misinterpreted as a request-level endpoint capacity promise.
				body: { model: 'm1', messages: [], max_output_tokens: 100_000 },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.candidates[0]?.routes.map((route) => route.targetId),
				['unknown-capacity', 'known-capacity'],
			);
		}
	});

	it('fails closed when explicit output capacity is unknown and rejects invalid limits', async () => {
		const missingCapacity = await buildModelFallbackPlan(
			repositories(new Map([['m1', { ...model('m1'), max_tokens: 128_000 }]])),
			{
				modelIds: ['m1'],
				body: { model: 'm1', messages: [], max_tokens: 1_024 },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(missingCapacity.ok, false);
		if (!missingCapacity.ok) {
			assert.equal(missingCapacity.status, 400);
			assert.match(missingCapacity.message, /verified max_completion_tokens capacity of at least 1024/);
		}

		for (const testCase of [
			{ requestProtocol: 'openai' as const, requestOperation: 'chat', body: { max_tokens: 1.5 } },
			{ requestProtocol: 'openai' as const, requestOperation: 'responses', body: { max_output_tokens: 0 } },
			{ requestProtocol: 'anthropic' as const, requestOperation: 'messages', body: { max_tokens: '1024' } },
		]) {
			const invalid = await buildModelFallbackPlan(
				repositories(new Map([['m1', model('m1')]])),
				{
					modelIds: ['m1'],
					body: { model: 'm1', messages: [], ...testCase.body },
					requestProtocol: testCase.requestProtocol,
					requestOperation: testCase.requestOperation,
				},
			);
			assert.equal(invalid.ok, false);
			if (!invalid.ok) assert.match(invalid.message, /positive safe integer or null/);
		}
	});

	it('removes incapable models from the global endpoint partition', async () => {
		const routesByModel = new Map<string, ModelRouteRow[]>([
			['m1', [routeWithOutputCapacity('m1', 'm1-small', 1_024)]],
			['m2', [routeWithOutputCapacity('m2', 'm2-capable', 4_096)]],
		]);
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')], ['m2', model('m2')]]), [], { routesByModel }),
			{
				modelIds: ['m1', 'm2'],
				body: {
					models: ['m1', 'm2'],
					messages: [],
					max_tokens: 2_048,
					provider: { sort: { by: 'price', partition: 'none' } },
				},
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.candidates.map((candidate) => candidate.routes.length), [0, 1]);
		assert.deepEqual(result.globalRoutes.map((route) => route.targetId), ['m2-capable']);
		assert.equal(result.globalRoutes[0]?.gatewayModelId, 'm2');
	});

	it('keeps globally eligible fallback models when another model has no endpoint', async () => {
		const routesByModel = new Map<string, ModelRouteRow[]>([
			['m1', []],
			['m2', [modelRoute('m2')]],
		]);
		const result = await buildModelFallbackPlan(
			repositories(
				new Map([['m1', model('m1')], ['m2', model('m2')]]),
				[],
				{ routesByModel },
			),
			{
				modelIds: ['m1', 'm2'],
				body: {
					models: ['m1', 'm2'],
					messages: [],
					provider: { sort: { by: 'price', partition: 'none' } },
				},
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.candidates.map((candidate) => candidate.routes.length), [0, 1]);
		assert.deepEqual(result.globalRoutes.map((route) => route.gatewayModelId), ['m2']);
	});

	it('enforces verified no-collection evidence independently of explicit ZDR support', async () => {
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(modelRoute('m1'), provider);
		const policy = { ...verifiedPolicy('target-m1', fingerprint), zdr_supported: false };
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [policy]),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { data_collection: 'deny' }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
	});

	it('fails closed for text distillation and max-price requirements', async () => {
		const priced = model('m1');
		priced.pricing_profile = JSON.stringify({
			tiers: [{ upto: null, input_price: 0.01, output_price: 0.01 }],
		});
		const distillationDenied = await buildModelFallbackPlan(
			repositories(new Map([['m1', priced]])),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { enforce_distillable_text: true }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(distillationDenied.ok, false);
		if (!distillationDenied.ok) assert.match(distillationDenied.message, /not marked as text-distillable/);

		priced.metadata = JSON.stringify({ distillable_text: true });
		const endpointPricingByRoute = new Map([[
			'target-m1',
			{ prompt: '0.000002', completion: '0.000004', request: '0.01' },
		]]);
		const tooExpensive = await buildModelFallbackPlan(
			repositories(new Map([['m1', priced]]), [], { endpointPricingByRoute }),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { max_price: { prompt: 1 } }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(tooExpensive.ok, false);
		if (!tooExpensive.ok) assert.match(tooExpensive.message, /max_price/);

		const requestCap = await buildModelFallbackPlan(
			repositories(new Map([['m1', priced]]), [], { endpointPricingByRoute }),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { max_price: { request: 0.005 } }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(requestCap.ok, false);
		if (!requestCap.ok) assert.match(requestCap.message, /max_price/);
	});

	it('defers image price controls to the request-specific image comparator', async () => {
		const imageRoute = {
			...modelRoute('m1'),
			upstream_operation: 'images.generations',
		};
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [], {
				routesByModel: new Map([['m1', [imageRoute]]]),
				endpointPricingByRoute: new Map([[
					'target-m1',
					{ prompt: '0', completion: '0', image: '9.99' },
				]]),
				endpointOverridesByRoute: new Map([[
					'target-m1',
					{
						context_length: null,
						max_prompt_tokens: null,
						max_completion_tokens: null,
						pricing: JSON.stringify({
							currency: 'USD', prompt: '0', completion: '0', image: '9.99',
						}),
						image_capabilities: JSON.stringify({
							provider_slug: 'provider-a',
							provider_tag: null,
							supports_streaming: false,
							supported_parameters: {},
							allowed_passthrough_parameters: [],
							pricing: [
								{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
							],
						}),
					},
				]]),
			}),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { max_price: { image: 0.05 } } },
				requestProtocol: 'openai',
				requestOperation: 'images.generations',
			},
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.candidates[0]?.routes[0]?.providerRoutingTrace?.max_price,
				{ image: 0.05 },
			);
		}
	});

	it('fails preflight when any requested model is unknown', async () => {
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]])),
			{
				modelIds: ['m1', 'missing'],
				body: { model: 'm1', messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.deepEqual(result, {
			ok: false,
			status: 404,
			code: 'gateway.model_not_found',
			message: 'Model not found: missing',
		});
	});

	it('allows ZDR only through currently verified zero-retention routes', async () => {
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(modelRoute('m1'), provider);
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [verifiedPolicy('target-m1', fingerprint)]),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { zdr: true }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidates[0]?.routes.map((route) => route.targetId), ['target-m1']);
			assert.equal(
				result.candidates[0]?.routes[0]?.gatewayPrivateByokDataPolicyAllowed,
				false,
			);
		}
	});

	it('fails closed when verified ZDR evidence is bound to a different route subject', async () => {
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
			{ ...modelRoute('m1'), provider_model_name: 'different-upstream-model' },
			provider,
		);
		const result = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [verifiedPolicy('target-m1', fingerprint)]),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { zdr: true }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.deepEqual(result, {
			ok: false,
			status: 400,
			code: 'gateway.zdr_no_route',
			message: 'No verified zero-data-retention route is available for model "m1"',
		});
	});

	it('fails closed for strict data policy when a shared credential can replace the verified provider account', async () => {
		const sharedProvider: ProviderRow = {
			...provider,
			shared_channel_type: 'openai',
		};
		const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
			modelRoute('m1'),
			sharedProvider,
		);
		const result = await buildModelFallbackPlan(
			repositories(
				new Map([['m1', model('m1')]]),
				[verifiedPolicy('target-m1', fingerprint)],
				{ provider: sharedProvider },
			),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { data_collection: 'deny' }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 400);
			assert.equal(result.code, 'gateway.data_collection_no_route');
			assert.equal(
				result.message,
				'No verified no-collection route is available for model "m1"',
			);
		}
	});

	it('fails closed when ZDR evidence is absent or tools are requested', async () => {
		const noRoute = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]])),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { zdr: true }, messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.deepEqual(noRoute, {
			ok: false,
			status: 400,
			code: 'gateway.zdr_no_route',
			message: 'No verified zero-data-retention route is available for model "m1"',
		});

		const tools = await buildModelFallbackPlan(
			repositories(new Map([['m1', model('m1')]]), [verifiedPolicy('target-m1')]),
			{
				modelIds: ['m1'],
				body: { model: 'm1', provider: { zdr: true }, tools: [{ type: 'function' }], messages: [] },
				requestProtocol: 'openai',
				requestOperation: 'chat',
			},
		);
		assert.equal(tools.ok, false);
		if (!tools.ok) assert.equal(tools.code, 'gateway.zdr_tools_unsupported');
	});

	it('applies default inverse-square provider balancing only when sort and order are absent', async () => {
		const providerB: ProviderRow = {
			...provider,
			id: 'provider-b',
			name: 'Provider B',
		};
		const cheap = { ...modelRoute('m1'), id: 'target-cheap', priority: 10 };
		const expensive = {
			...modelRoute('m1'),
			id: 'target-expensive',
			provider_id: providerB.id,
			priority: 100,
		};
		const repos = repositories(new Map([['m1', model('m1')]]), [], {
			routesByModel: new Map([['m1', [cheap, expensive]]]),
			providers: [provider, providerB],
			endpointPricingByRoute: new Map([
				['target-cheap', { prompt: '0.000001', completion: '0.000001' }],
				['target-expensive', { prompt: '0.000010', completion: '0.000010' }],
			]),
		});

		const defaults = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [] },
			requestProtocol: 'openai',
			requestOperation: 'chat',
			pricingAt: new Date('2026-09-01T00:00:00.000Z'),
		});
		assert.equal(defaults.ok, true);
		if (!defaults.ok) return;
		assert.deepEqual(
			[...defaults.candidates[0]!.routes]
				.sort((left, right) => left.gatewayDefaultLoadBalanceRank! - right.gatewayDefaultLoadBalanceRank!)
				.map((item) => item.gatewayDefaultLoadBalanceRank),
			[1, 2],
		);
		assert.equal(
			defaults.candidates[0]!.routes.every(
				(item) => item.providerRoutingTrace?.default_load_balance === true,
			),
			true,
		);

		const explicitPrice = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [], provider: { sort: 'price' } },
			requestProtocol: 'openai',
			requestOperation: 'chat',
			pricingAt: new Date('2026-09-01T00:00:00.000Z'),
		});
		assert.equal(explicitPrice.ok, true);
		if (!explicitPrice.ok) return;
		assert.deepEqual(explicitPrice.candidates[0]!.routes.map((item) => item.targetId), [
			'target-cheap',
			'target-expensive',
		]);
		assert.equal(
			explicitPrice.candidates[0]!.routes.every(
				(item) => item.gatewayDefaultLoadBalanceRank === undefined,
			),
			true,
		);

		const explicitOrder = await buildModelFallbackPlan(repos, {
			modelIds: ['m1'],
			body: { model: 'm1', messages: [], provider: { order: ['Provider B'] } },
			requestProtocol: 'openai',
			requestOperation: 'chat',
			pricingAt: new Date('2026-09-01T00:00:00.000Z'),
		});
		assert.equal(explicitOrder.ok, true);
		if (!explicitOrder.ok) return;
		const attempted = [...explicitOrder.candidates[0]!.routes]
			.sort((left, right) => right.routePriority - left.routePriority);
		assert.equal(attempted[0]?.providerId, 'provider-b');
		assert.equal(attempted.every((item) => item.gatewayDefaultLoadBalanceRank === undefined), true);
	});
});

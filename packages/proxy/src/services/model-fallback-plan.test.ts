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
	const selectedProvider = options.provider ?? provider;
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
			getProvidersByIds: async (ids: string[]) => ids.includes(selectedProvider.id) ? [selectedProvider] : [],
		},
		modelEndpoints: {
			listRuntimeBindingsByRouteTargetIds: async (ids: string[]) => Promise.all(
				ids.flatMap((id) => {
					const route = routesById.get(id);
					if (!route) return [];
					return [Promise.resolve().then(async () => {
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
		requestLogs: { getRecentRoutePerformanceSamples: async () => options.performanceSamples ?? [] },
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
		});
		assert.equal(
			JSON.stringify(result.candidates[0]?.routes[0]?.providerRoutingTrace).includes('secret'),
			false,
		);
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
			{ route_target_id: 'm1-slow', first_token_ms: 1_000, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: null, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm1-fast', first_token_ms: 200, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: null, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm2-fast', first_token_ms: 100, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: null, created_at: '2026-08-30T00:00:00Z' },
			{ route_target_id: 'm2-slow', first_token_ms: 300, output_tokens: 10, stream_duration_ms: 1_000, latency_ms: null, upstream_response_ms: null, final_upstream_headers_ms: null, created_at: '2026-08-30T00:00:00Z' },
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
		if (result.ok) assert.deepEqual(result.candidates[0]?.routes.map((route) => route.targetId), ['target-m1']);
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
			assert.equal(result.status, 502);
			assert.equal(result.code, 'gateway.no_route');
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
});

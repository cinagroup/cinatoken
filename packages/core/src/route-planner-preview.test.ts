import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelEndpointRuntimeBindingRow } from './db/model-endpoints-types';
import type { RoutePerformanceSample } from './db/request-logs-types';
import type { ModelRouteJoinRow } from './storage/repository-dtos';
import type { ProviderRow } from './types';
import { computeRouteDataPolicySubjectFingerprintFromRows } from './route-data-policy';
import { evaluateGuardrailRoutePlannerPreview } from './route-planner-preview';
import { ROUTE_PERFORMANCE_WINDOW_MS } from './route-performance';

const NOW = new Date('2026-09-02T00:00:00.000Z');
const route: ModelRouteJoinRow = {
	id: 'internal-route-id', model_id: 'openai/gpt-4o', provider_id: 'internal-provider-id',
	provider_model_name: 'private-upstream-model', priority: 1, status: 'active', route_group: 'default',
	price_override: JSON.stringify({ charged_factor: 2 }), custom_params: null, routing_metadata: null,
	upstream_protocol: 'openai', route_pool_id: 'pool-1', upstream_operation: 'chat', adapter: 'passthrough',
	surfaces: null, pool_name: 'Default', pool_strategy: null, pool_tier_strategies: null,
	pool_status: 'active', model_name: 'GPT-4o', provider_name: 'Provider A', provider_status: 'active',
};
const provider: ProviderRow = {
	id: route.provider_id,
	name: 'Provider A',
	endpoints: JSON.stringify({ openai: { base: 'https://api.example.com/v1' } }),
	api_key: 'provider-secret',
	status: 'active',
	description: null,
	shared_channel_type: null,
	created_at: NOW.toISOString(),
};

async function binding(): Promise<ModelEndpointRuntimeBindingRow> {
	return {
		route_target_id: route.id,
		subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(route, provider),
		id: 'internal-endpoint-id', model_id: route.model_id, provider_id: route.provider_id,
		provider_slug: 'provider-a', tag: 'provider-a', endpoint_class: 'standard', region: 'us',
		context_length: 128_000, max_prompt_tokens: 120_000, max_completion_tokens: 4_096,
		quantization: null, supported_parameters: JSON.stringify(['max_tokens']),
		pricing: JSON.stringify({ currency: 'USD', prompt: '0.000001', completion: '0.000002' }),
		supports_implicit_caching: 1, supports_voice_cloning: 0,
		supports_tool_choice: JSON.stringify({ auto: true, function: true, none: true, required: true }),
		image_capabilities: '{}', audio_capabilities: '{}', evidence_url: 'https://evidence.example/endpoint',
		verified_by: 'admin-1', verified_at: '2026-09-01T00:00:00.000Z',
		expires_at: '2027-09-01T00:00:00.000Z', status: 'verified',
		created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
	};
}

const performanceSample: RoutePerformanceSample = {
	route_target_id: route.id, output_tokens: 20, latency_ms: 1_000,
	upstream_response_ms: 800, final_upstream_headers_ms: 500,
	first_reasoning_token_ms: null, first_token_ms: 200,
	stream_duration_ms: 1_000, created_at: NOW.toISOString(),
};

describe('Guardrail route planner preview', () => {
	it('reports static callable, capacity, charged price, and bounded performance evidence safely', async () => {
		const result = await evaluateGuardrailRoutePlannerPreview({
			candidateRoutes: [route], providers: [provider], bindings: [await binding()],
			performanceSamples: [performanceSample], performanceRouteTargetIds: [route.id],
			performanceWindowMs: ROUTE_PERFORMANCE_WINDOW_MS, pricingAt: NOW,
			businessTimezone: 'UTC', now: NOW,
		});

		assert.equal(result.eligibleRoutes.length, 1);
		assert.equal(result.value.staticallyEligibleCount, 1);
		assert.equal(result.value.operationCapabilities.verifiedCount, 1);
		assert.deepEqual(result.value.outputCapacity, {
			applicableCount: 1, knownCount: 1, unknownCount: 0,
			minimumTokens: 4_096, maximumTokens: 4_096,
		});
		assert.deepEqual(result.value.pricing.promptPerMillion, { minimum: 2, maximum: 2 });
		assert.deepEqual(result.value.pricing.completionPerMillion, { minimum: 4, maximum: 4 });
		assert.equal(result.value.pricing.evidenceReadyCount, 1);
		assert.equal(result.value.pricing.requestDependentCount, 0);
		assert.equal(result.value.performance.p50LatencyMs, 200);
		assert.equal(result.value.performance.p50ThroughputTokensPerSecond, 20_000 / 1_500);
		assert.deepEqual(result.value.circuit, { evaluated: false, scope: 'dispatch_isolate' });
		assert.doesNotMatch(
			JSON.stringify(result.value),
			/internal-route-id|internal-provider-id|internal-endpoint-id|private-upstream-model|provider-secret|[0-9a-f]{64}/u,
		);
	});

	it('fails closed when the verified endpoint binding is missing', async () => {
		const result = await evaluateGuardrailRoutePlannerPreview({
			candidateRoutes: [route], providers: [provider], bindings: [], performanceSamples: [],
			performanceRouteTargetIds: [], performanceWindowMs: ROUTE_PERFORMANCE_WINDOW_MS,
			businessTimezone: 'UTC', now: NOW,
		});
		assert.equal(result.value.staticallyEligibleCount, 0);
		assert.deepEqual(result.value.excludedByReason, { endpoint_binding_missing: 1 });
	});
});

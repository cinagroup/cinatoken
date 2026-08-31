import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type GatewayRepositories,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
	type ModelRow,
	type ProviderRow,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { modelsRoutes } from './models';

function model(id: string, routeGroups = ['default']): ModelRow {
	return {
		id, display_name: id, vendor: 'Vendor', context_window: 8_192, max_tokens: 1_024,
		pricing_profile: JSON.stringify({ tiers: [{ upto: null, input_price: 1, output_price: 2 }] }),
		tags: '[]', route_groups: JSON.stringify(routeGroups), description: null, metadata: null,
		input_modalities: '["text"]', output_modalities: '["text"]', released_at: null,
		created_at: '2026-08-30T00:00:00.000Z',
	};
}

function route(
	id: string,
	modelId: string,
	routeGroup: string,
	endpointSlug: string,
	region: 'eu' | 'us',
	state?: { provider?: string; pool?: string },
	upstreamOperation = 'chat',
): ModelRouteJoinRow {
	return {
		id, model_id: modelId, provider_id: `${id}-provider`, provider_model_name: 'upstream-model',
		priority: 0, status: 'active', route_group: routeGroup, weight: 1, price_override: null,
		custom_params: null, routing_metadata: JSON.stringify({
			supported_parameters: [], quantization: null, endpoint_slug: endpointSlug, endpoint_class: 'standard', region,
		}),
		upstream_protocol: 'openai', route_pool_id: `${id}-pool`, upstream_operation: upstreamOperation, adapter: 'passthrough',
		surfaces: null, pool_name: null, pool_strategy: null, pool_tier_strategies: null,
		pool_status: state?.pool ?? 'active', model_name: modelId, provider_name: 'Provider',
		provider_status: state?.provider ?? 'active',
	};
}

async function createTestApp() {
	let endpointReads = 0;
	const models = [
		model('model-eu'), model('model-us'), model('model-mixed', ['default', 'free']),
		model('model-disabled-pool'), model('model-disabled-provider'),
	];
	const ttsModel = model('model-tts', ['audio']);
	ttsModel.pricing_profile = JSON.stringify({
		audio_billing_mode: 'per_character',
		audio: { price_per_character: 0.0001 },
	});
	ttsModel.output_modalities = '["audio"]';
	models.push(ttsModel);
	const routes = [
		route('eu', 'model-eu', 'default', 'alpha/turbo', 'eu'),
		route('us', 'model-us', 'default', 'beta/default', 'us'),
		route('mixed-us', 'model-mixed', 'default', 'gamma/us', 'us'),
		route('mixed-eu', 'model-mixed', 'free', 'gamma/eu', 'eu'),
		route('disabled-pool', 'model-disabled-pool', 'default', 'hidden/pool', 'eu', { pool: 'inactive' }),
		route('disabled-provider', 'model-disabled-provider', 'default', 'hidden/provider', 'eu', { provider: 'disabled' }),
		route('tts', 'model-tts', 'audio', 'voice/default', 'us', undefined, 'audio.speech'),
	];
	const providers: ProviderRow[] = routes.map((candidate) => ({
		id: candidate.provider_id,
		name: 'Provider',
		endpoints: '{"openai":{"base":"https://api.example/v1"}}',
		api_key: `secret-${candidate.id}`,
		status: candidate.provider_status ?? 'active',
		description: null,
		shared_channel_type: null,
		created_at: '2026-08-01T00:00:00.000Z',
	}));
	const providerById = new Map(providers.map((provider) => [provider.id, provider]));
	const endpoints: ModelEndpointRow[] = routes.map((candidate) => {
		const metadata = JSON.parse(candidate.routing_metadata!) as {
			endpoint_slug: string;
			endpoint_class: string;
			region: string;
		};
		return {
			id: `endpoint-${candidate.id}`,
			model_id: candidate.model_id,
			provider_id: candidate.provider_id,
			provider_slug: metadata.endpoint_slug.split('/')[0]!,
			tag: metadata.endpoint_slug,
			endpoint_class: metadata.endpoint_class,
			region: metadata.region,
			context_length: 8_192,
			max_prompt_tokens: 7_168,
			max_completion_tokens: 1_024,
			quantization: null,
			supported_parameters: '[]',
			pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
			supports_implicit_caching: false,
			supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":false,"none":true,"required":false}',
			image_capabilities: '{}',
			audio_capabilities: candidate.upstream_operation === 'audio.speech'
				? JSON.stringify({
						v: 1,
						pricing_by_operation: {
							'audio.speech': {
								currency: 'USD',
								meter: {
									kind: 'characters',
									unit: 'unicode_code_point',
									price: '0.0001',
									minimum_units: 0,
									increment_units: 1,
								},
							},
						},
					})
				: '{}',
			evidence_url: 'https://provider.example/evidence',
			verified_by: 'console:admin',
			verified_at: '2026-08-01T00:00:00.000Z',
			expires_at: '2099-08-01T00:00:00.000Z',
			status: 'verified',
			created_at: '2026-08-01T00:00:00.000Z',
			updated_at: '2026-08-01T00:00:00.000Z',
		};
	});
	const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
	const bindings: ModelEndpointDiscoveryRouteBindingRow[] = await Promise.all(
		routes.map(async (candidate) => ({
			endpoint_id: `endpoint-${candidate.id}`,
			subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
				candidate,
				providerById.get(candidate.provider_id)!
			),
			id: candidate.id,
			model_id: candidate.model_id,
			provider_id: candidate.provider_id,
			provider_model_name: candidate.provider_model_name,
			status: candidate.status,
			route_group: candidate.route_group,
			custom_params: candidate.custom_params,
			routing_metadata: candidate.routing_metadata,
			upstream_protocol: candidate.upstream_protocol,
			upstream_operation: candidate.upstream_operation,
			adapter: candidate.adapter,
			route_pool_id: candidate.route_pool_id,
			pool_status: candidate.pool_status,
		}))
	);
	const repositories = {
		apiKeys: { getApiKeyWithUserByKey: async (key: string) => key === 'sk-test' ? {
			id: 'key-1', key: 'sk-test', user_id: 'user-1', workspace_id: 'workspace-1', name: 'Test', status: 'active',
			metadata: null, last_used_at: null, created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
			user_email: 'user@example.com', user_metadata: null, user_charged_cost_factors: null,
			budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
			budget_epoch: 0, budget_reserved_micros: 0,
		} : null },
		modelRouting: { listModelsWithActiveRoutes: async () => models },
		routes: { listModelRoutesWithJoins: async () => { throw new Error('public model discovery must not scan all routes'); } },
		providers: {
			getProvidersByIds: async (ids: string[]) => providers.filter((provider) => ids.includes(provider.id)),
		},
		modelEndpoints: {
			list: async (filters: { limit?: number; offset?: number }) => {
				endpointReads += 1;
				return endpoints.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 100));
			},
			listDiscoveryRouteBindings: async (ids: string[]) => bindings.filter((binding) => {
				const endpoint = endpointById.get(binding.endpoint_id);
				return endpoint != null && ids.includes(endpoint.id);
			}),
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<Env>();
	app.use('*', async (c, next) => { c.set('repositories', repositories); await next(); });
	app.route('/v1/models', modelsRoutes);
	return { app, endpointReads: () => endpointReads };
}

describe('GET /v1/models provider-location discovery', () => {
	it('includes TTS models in the audio kind without leaking them into the default LLM list', async () => {
		const { app } = await createTestApp();
		const audioResponse = await app.request('/v1/models?kind=audio&route_groups=audio', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(audioResponse.status, 200);
		const audioBody = await audioResponse.json() as { data: Array<{ id: string }> };
		assert.deepEqual(audioBody.data.map((entry) => entry.id), ['model-tts']);

		const defaultResponse = await app.request('/v1/models?route_groups=default,free', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		const defaultBody = await defaultResponse.json() as { data: Array<{ id: string }> };
		assert.equal(defaultBody.data.some((entry) => entry.id === 'model-tts'), false);
	});

	it('filters by eu and returns only safe endpoint aggregates in matching route groups', async () => {
		const { app } = await createTestApp();
		const response = await app.request('/v1/models?region=EU&route_groups=default,free', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(response.status, 200);
		const body = await response.json() as {
			data: Array<{ id: string; owned_by: string; model_info: Record<string, unknown> & { route_groups: string[]; endpoint_slugs: string[] } }>;
			region_filter: Record<string, unknown>;
		};
		assert.deepEqual(body.data.map((entry) => entry.id), ['model-eu', 'model-mixed']);
		assert.equal(body.data[0]?.owned_by, 'cinatoken');
		assert.deepEqual(body.data[0]?.model_info.endpoint_slugs, ['alpha/turbo']);
		assert.deepEqual(body.data[0]?.model_info.regions, ['eu']);
		assert.deepEqual(body.data[0]?.model_info.route_groups, ['default']);
		assert.deepEqual(body.data[1]?.model_info.route_groups, ['free']);
		assert.deepEqual(body.data[1]?.model_info.endpoint_slugs, ['gamma/eu']);
		assert.deepEqual(body.region_filter, {
			region: 'eu', scope: 'provider_endpoint_location_discovery', inference_data_residency_guaranteed: false,
		});
		assert.equal(JSON.stringify(body).includes('upstream-model'), false);

		const usResponse = await app.request('/v1/models?region=us&route_groups=default,free', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(usResponse.status, 200);
		const usBody = await usResponse.json() as {
			data: Array<{ id: string; model_info: { route_groups: string[]; endpoint_slugs: string[] } }>;
		};
		assert.deepEqual(usBody.data.map((entry) => entry.id), ['model-us', 'model-mixed']);
		assert.deepEqual(usBody.data[1]?.model_info.route_groups, ['default']);
		assert.deepEqual(usBody.data[1]?.model_info.endpoint_slugs, ['gamma/us']);

		const unfilteredResponse = await app.request('/v1/models?route_groups=default,free', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		const unfilteredBody = await unfilteredResponse.json() as { data: Array<{ id: string }> };
		assert.deepEqual(unfilteredBody.data.map((entry) => entry.id), ['model-eu', 'model-us', 'model-mixed']);
	});

	it('rejects unsupported or empty regions before reading route discovery data', async () => {
		for (const value of ['apac', '']) {
			const { app, endpointReads } = await createTestApp();
			const response = await app.request(`/v1/models?region=${encodeURIComponent(value)}`, {
				headers: { Authorization: 'Bearer sk-test' },
			});
			assert.equal(response.status, 400);
			assert.equal(endpointReads(), 0);
			const body = await response.json() as { error: Record<string, unknown> };
			assert.deepEqual(body.error, {
				message: 'region must be one of: eu, us', type: 'invalid_request_error', param: 'region', code: 'invalid_region',
			});
		}
	});
});

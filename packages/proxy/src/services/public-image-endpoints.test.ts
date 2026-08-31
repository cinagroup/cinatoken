import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
	type ModelRow,
	type ProviderRow,
} from "@octafuse/core";
import {
	getPublicImageModelEndpoints,
	listPublicImageModels,
	parseModelEndpointPath,
	type PublicEndpointDiscoveryRepositories,
} from "./public-model-endpoints";
const NOW = new Date("2026-08-30T00:00:00Z");
const model: ModelRow = {
	id: "image/acme",
	display_name: "Acme",
	vendor: "image",
	context_window: null,
	max_tokens: null,
	pricing_profile: null,
	tags: "[]",
	description: "Image",
	metadata: null,
	input_modalities: '["text"]',
	output_modalities: '["image"]',
	released_at: "2026-08-01",
	created_at: "2026-08-01Z",
};
const provider: ProviderRow = {
	id: "p",
	name: "Provider",
	endpoints: '{"openai":{"base":"https://private"}}',
	api_key: "secret",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: "2026-01-01Z",
};
const route: ModelRouteJoinRow = {
	id: "r",
	model_id: model.id,
	provider_id: "p",
	provider_model_name: "private",
	priority: 0,
	status: "active",
	route_group: "default",
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: "openai",
	route_pool_id: null,
	upstream_operation: "image",
	adapter: "passthrough",
	surfaces: null,
	pool_name: null,
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: null,
	model_name: "Acme",
	provider_name: "Provider",
	provider_status: "active",
};
function routeBinding(
	endpointId: string,
	overrides: Partial<ModelEndpointDiscoveryRouteBindingRow> = {}
): ModelEndpointDiscoveryRouteBindingRow {
	return {
		endpoint_id: endpointId,
		subject_fingerprint: null,
		id: `route-${endpointId}`,
		model_id: route.model_id,
		provider_id: route.provider_id,
		provider_model_name: route.provider_model_name,
		status: route.status,
		route_group: route.route_group,
		custom_params: route.custom_params,
		routing_metadata: route.routing_metadata,
		upstream_protocol: route.upstream_protocol,
		upstream_operation: route.upstream_operation,
		adapter: route.adapter,
		route_pool_id: route.route_pool_id,
		pool_status: route.pool_status,
		...overrides,
	};
}
function ep(
	id: string,
	descriptor: unknown,
	stream: boolean | null = true
): ModelEndpointRow {
	return {
		id,
		model_id: model.id,
		provider_id: "p",
		provider_slug: "provider",
		tag: id,
		endpoint_class: null,
		region: null,
		context_length: null,
		max_prompt_tokens: null,
		max_completion_tokens: null,
		quantization: null,
		supported_parameters: "[]",
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: JSON.stringify({
			provider_slug: "provider",
			provider_tag: "image-public",
			supports_streaming: stream,
			allowed_passthrough_parameters: ["seed"],
			supported_parameters: { size: descriptor },
			pricing: [{ billable: "output_image", unit: "image", cost_usd: "0.04" }],
		}),
		evidence_url: "https://evidence.example/image",
		verified_by: "x",
		verified_at: "2026-08-01Z",
		expires_at: "2027-01-01Z",
		status: "verified",
		created_at: "x",
		updated_at: "x",
	};
}
function repos(
	endpoints: ModelEndpointRow[]
): PublicEndpointDiscoveryRepositories {
	return {
		modelRouting: {
			getModelById: async (id) => (id === model.id ? model : null),
			listModelsWithActiveRoutes: async () => [model],
		},
		providers: { getProvidersByIds: async () => [provider] },
		modelEndpoints: {
			list: async (filters) =>
				endpoints.slice(
					filters?.offset ?? 0,
					(filters?.offset ?? 0) + (filters?.limit ?? 100)
				),
			listByModelId: async (_modelId, options) =>
				endpoints.slice(
					options?.offset ?? 0,
					(options?.offset ?? 0) + (options?.limit ?? 100)
				),
			listDiscoveryRouteBindings: async (ids) =>
				Promise.all(
					ids.map(async (id) => {
						const binding = routeBinding(id);
						binding.subject_fingerprint =
							await computeRouteDataPolicySubjectFingerprintFromRows(
								binding,
								provider
							);
						return binding;
					})
				),
		},
		routeDataPolicies: { getByRouteTargetIds: async () => [] },
	};
}
describe("image endpoint discovery", () => {
	it("publishes SDK image shapes and converts cost_usd only at serialization", async () => {
		const r = repos([ep("fast", { type: "enum", values: ["1024"] })]);
		const endpoints = await getPublicImageModelEndpoints(
			r,
			parseModelEndpointPath("image", "acme")!,
			NOW
		);
		assert.equal(endpoints?.id, "image/acme");
		assert.equal(endpoints?.endpoints[0]?.pricing[0]?.cost_usd, 0.04);
		assert.equal(endpoints?.endpoints[0]?.supports_streaming, true);
		assert.equal(endpoints?.endpoints[0]?.provider_tag, "image-public");
		assert.notEqual(endpoints?.endpoints[0]?.provider_tag, "fast");
		const models = await listPublicImageModels(r, NOW);
		assert.equal(
			models[0]?.endpoints,
			"/api/v1/images/models/image/acme/endpoints"
		);
		assert.deepEqual(models[0]?.supported_parameters, {
			size: { type: "enum", values: ["1024"] },
		});
	});
	it("omits conflicting summary descriptors and rejects unknown streaming evidence", async () => {
		const r = repos([
			ep("a", { type: "enum", values: ["a"] }),
			ep("b", { type: "range", min: 1, max: 2 }),
		]);
		assert.deepEqual(
			(await listPublicImageModels(r, NOW))[0]?.supported_parameters,
			{}
		);
		assert.equal(
			await getPublicImageModelEndpoints(
				repos([ep("unknown", { type: "boolean" }, null)]),
				parseModelEndpointPath("image", "acme")!,
				NOW
			),
			null
		);
		const mismatched = ep("mismatch", { type: "boolean" });
		mismatched.image_capabilities = JSON.stringify({
			provider_slug: "wrong-provider",
			provider_tag: "independent",
			supports_streaming: true,
			allowed_passthrough_parameters: [],
			supported_parameters: {},
			pricing: [],
		});
		assert.equal(
			await getPublicImageModelEndpoints(
				repos([mismatched]),
				parseModelEndpointPath("image", "acme")!,
				NOW
			),
			null
		);
	});
	it("uses one bounded catalog read and emits a reachable canonical path for legacy simple ids", async () => {
		const simpleModel = { ...model, id: "acme", vendor: "Image" };
		const simpleEndpoint = {
			...ep("simple", { type: "boolean" }),
			model_id: simpleModel.id,
		};
		const r = repos([simpleEndpoint]);
		r.modelRouting.getModelById = async (id) =>
			id === simpleModel.id ? simpleModel : null;
		r.modelRouting.listModelsWithActiveRoutes = async () => [simpleModel];
	r.modelEndpoints.listDiscoveryRouteBindings = async (ids) =>
		Promise.all(
			ids.map(async (id) => {
				const binding = routeBinding(id, { model_id: simpleModel.id });
				binding.subject_fingerprint =
					await computeRouteDataPolicySubjectFingerprintFromRows(
						binding,
						provider
					);
				return binding;
			})
		);
		let listCalls = 0;
		let listByModelCalls = 0;
		const list = r.modelEndpoints.list;
		r.modelEndpoints.list = async (filters) => {
			listCalls += 1;
			assert.deepEqual(filters, { status: "verified", limit: 100, offset: 0 });
			return list(filters);
		};
		r.modelEndpoints.listByModelId = async () => {
			listByModelCalls += 1;
			return [simpleEndpoint];
		};
		const models = await listPublicImageModels(r, NOW);
		assert.equal(listCalls, 1);
		assert.equal(listByModelCalls, 0);
		assert.equal(models[0]?.id, "image/acme");
		assert.equal(
			models[0]?.endpoints,
			"/api/v1/images/models/image/acme/endpoints"
		);
		assert.ok(parseModelEndpointPath("image", "acme"));
	});
	it("paginates beyond 100 endpoints and fails closed above the catalog safety limit", async () => {
		const many = Array.from({ length: 101 }, (_, index) =>
			ep(`endpoint-${index}`, { type: "boolean" }, index === 100)
		);
		const listed = await listPublicImageModels(repos(many), NOW);
		assert.equal(listed.length, 1);
		const detailed = await getPublicImageModelEndpoints(
			repos(many),
			parseModelEndpointPath("image", "acme")!,
			NOW
		);
		assert.equal(detailed?.endpoints.length, 101);
		const overflow = Array.from({ length: 1_001 }, (_, index) =>
			ep(`overflow-${index}`, { type: "boolean" })
		);
		const overflowRepos = repos(overflow);
		let bindingReads = 0;
		let providerReads = 0;
		overflowRepos.modelEndpoints.listDiscoveryRouteBindings = async () => {
			bindingReads += 1;
			return [];
		};
		overflowRepos.providers.getProvidersByIds = async () => {
			providerReads += 1;
			return [provider];
		};
		await assert.rejects(
			listPublicImageModels(overflowRepos, NOW),
			/catalog exceeds safety limit 1000/
		);
		assert.equal(bindingReads, 0);
		assert.equal(providerReads, 0);
	});
});

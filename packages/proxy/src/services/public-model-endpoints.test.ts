import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	routeDataPolicyAllowsZdr,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
	type ModelRow,
	type ProviderRow,
	type RouteDataPolicyRow,
} from "@octafuse/core";
import {
	getPublicModelEndpoints,
	listVerifiedPublicEndpointBindings,
	listVerifiedZdrPublicEndpoints,
	parseModelEndpointPath,
	resolvePublishedPublicProviders,
	type PublicEndpointDiscoveryRepositories,
} from "./public-model-endpoints";

const NOW = new Date("2026-08-30T12:00:00Z");
const MODEL: ModelRow = {
	id: "openai/model",
	display_name: "Model",
	vendor: "openai",
	context_window: 999,
	max_tokens: 999,
	pricing_profile: '{"must":"not leak"}',
	tags: "[]",
	description: null,
	metadata: null,
	input_modalities: '["text"]',
	output_modalities: '["text"]',
	released_at: null,
	created_at: "2026-08-01T00:00:00Z",
};
const ROUTE: ModelRouteJoinRow = {
	id: "route",
	model_id: MODEL.id,
	provider_id: "provider",
	provider_model_name: "secret",
	priority: 0,
	status: "active",
	route_group: "default",
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: "openai",
	route_pool_id: null,
	upstream_operation: "chat",
	adapter: "passthrough",
	surfaces: null,
	pool_name: null,
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: null,
	model_name: "Model",
	provider_name: "Provider",
	provider_status: "active",
};
const PROVIDER: ProviderRow = {
	id: "provider",
	name: "Provider",
	endpoints: '{"openai":{"base":"https://secret.example"}}',
	api_key: "secret-key",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: "2026-01-01Z",
};
function routeBinding(
	endpointId: string,
	route: ModelRouteJoinRow = ROUTE,
	subjectFingerprint: string | null = null
): ModelEndpointDiscoveryRouteBindingRow {
	return {
		endpoint_id: endpointId,
		subject_fingerprint: subjectFingerprint,
		id: route.id,
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
	};
}
function endpoint(overrides: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return {
		id: "endpoint",
		model_id: MODEL.id,
		provider_id: PROVIDER.id,
		provider_slug: "provider",
		tag: "standard",
		endpoint_class: "standard",
		region: null,
		context_length: 128000,
		max_prompt_tokens: 120000,
		max_completion_tokens: 8000,
		quantization: "fp16",
		supported_parameters: '["temperature"]',
		pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
		supports_implicit_caching: false,
		supports_voice_cloning: false,
		supports_tool_choice:
			'{"auto":true,"function":false,"none":true,"required":false}',
		image_capabilities: "{}",
		evidence_url: "https://private.evidence",
		verified_by: "admin-secret",
		verified_at: "2026-08-01T00:00:00Z",
		expires_at: "2027-01-01T00:00:00Z",
		status: "verified",
		created_at: "2026-08-01Z",
		updated_at: "2026-08-01Z",
		...overrides,
	};
}
function repo(
	options: {
		endpoint?: ModelEndpointRow;
		route?: ModelRouteJoinRow;
		provider?: ProviderRow;
		policy?: RouteDataPolicyRow;
	} = {}
): PublicEndpointDiscoveryRepositories {
	const e = options.endpoint ?? endpoint(),
		route = options.route ?? ROUTE,
		p = options.provider ?? PROVIDER;
	return {
		modelRouting: {
			getModelById: async (id) => (id === MODEL.id ? MODEL : null),
			listModelsWithActiveRoutes: async () => [MODEL],
		},
		providers: {
			getProvidersByIds: async (ids) => (ids.includes(p.id) ? [p] : []),
		},
		modelEndpoints: {
			list: async () => [e],
			listByModelId: async () => [e],
			listDiscoveryRouteBindings: async (ids) =>
				ids.includes(e.id)
					? [
						routeBinding(
							e.id,
							route,
							await computeRouteDataPolicySubjectFingerprintFromRows(route, p)
						),
					  ]
					: [],
		},
		routeDataPolicies: {
			getByRouteTargetIds: async () => (options.policy ? [options.policy] : []),
		},
	};
}

describe("endpoint entity publication", () => {
	it("publishes an SDK-shaped endpoint solely from verified endpoint facts", async () => {
		const path = parseModelEndpointPath("openai", "model")!;
		const data = await getPublicModelEndpoints(repo(), path, NOW);
		assert.ok(data);
		assert.equal(data.description, "");
		assert.equal(data.created, 1785542400);
		assert.deepEqual(data.endpoints[0]?.pricing, {
			prompt: "0.000001",
			completion: "0.000002",
		});
		assert.equal(data.endpoints[0]?.context_length, 128000);
		assert.equal(data.endpoints[0]?.supports_implicit_caching, false);
		assert.deepEqual(data.endpoints[0]?.supports_tool_choice, {
			auto: true,
			function: false,
			none: true,
			required: false,
		});
		assert.equal(data.endpoints[0]?.latency_last_30m, null);
		assert.equal(data.endpoints[0]?.status, 0);
		assert.doesNotMatch(
			JSON.stringify(data),
			/must not leak|secret\.example|secret-key|private\.evidence|admin-secret/
		);
	});

	it("omits an ambiguous provider slug from both provider and endpoint publication", async () => {
		const bindings = await listVerifiedPublicEndpointBindings(repo(), [MODEL], NOW);
		assert.equal(bindings.length, 1);
		const conflicting = {
			...bindings[0]!,
			provider: { ...bindings[0]!.provider, name: "Different Provider" },
		};
		const catalog = resolvePublishedPublicProviders([
			bindings[0]!,
			conflicting,
		]);
		assert.deepEqual(catalog.providers, []);
		assert.equal(catalog.bySlug.has("provider"), false);
		assert.equal(
			await getPublicModelEndpoints(
				repo(),
				parseModelEndpointPath("openai", "model")!,
				NOW,
				{
					bindings: [bindings[0]!, conflicting],
					publishedProvidersBySlug: catalog.bySlug,
				}
			),
			null
		);
	});
	it("fails closed for draft, expired, unbound, model/provider mismatch and incomplete facts", async () => {
		const path = parseModelEndpointPath("openai", "model")!;
		for (const e of [
			endpoint({ status: "draft" }),
			endpoint({ expires_at: "2026-08-29Z" }),
			endpoint({ provider_id: "other" }),
			endpoint({ model_id: "other" }),
			endpoint({ context_length: null }),
			endpoint({ pricing: "{}" }),
			endpoint({ supports_voice_cloning: null }),
			endpoint({ evidence_url: "http://insecure.example/evidence" }),
			endpoint({ tag: "bad tag" }),
			endpoint({ max_prompt_tokens: 0 }),
			endpoint({ max_completion_tokens: 1.5 }),
			endpoint({ supported_parameters: '["tools","TOOLS"]' }),
			endpoint({ supported_parameters: '["bad parameter"]' }),
		])
			assert.equal(
				await getPublicModelEndpoints(repo({ endpoint: e }), path, NOW),
				null
			);
		const r = repo();
		r.modelEndpoints.listDiscoveryRouteBindings = async () => [];
		assert.equal(await getPublicModelEndpoints(r, path, NOW), null);
		const previousSubject =
			await computeRouteDataPolicySubjectFingerprintFromRows(ROUTE, PROVIDER);
		const rotatedProvider = { ...PROVIDER, api_key: "rotated-secret" };
		const drifted = repo({ provider: rotatedProvider });
		drifted.modelEndpoints.listDiscoveryRouteBindings = async () => [
			routeBinding("endpoint", ROUTE, previousSubject),
		];
		assert.equal(
			await getPublicModelEndpoints(drifted, path, NOW),
			null,
			"provider credential rotation must invalidate the linked endpoint subject"
		);
		const legacyRegionDrift = {
			...ROUTE,
			routing_metadata: JSON.stringify({ region: "eu" }),
		};
		assert.equal(
			await getPublicModelEndpoints(
				repo({
					endpoint: endpoint({ region: "us" }),
					route: legacyRegionDrift,
				}),
				path,
				NOW
			),
			null,
			"legacy region drift must fail closed instead of becoming a public fact"
		);
	});
	it("keeps exact author/slug resolution", async () => {
		assert.equal(parseModelEndpointPath("openai", "../model"), null);
		assert.equal(
			await getPublicModelEndpoints(
				repo(),
				parseModelEndpointPath("other", "model")!,
				NOW
			),
			null
		);
	});
	it("requires an endpoint-linked current matching ZDR policy", async () => {
		const fp = await computeRouteDataPolicySubjectFingerprintFromRows(
			ROUTE,
			PROVIDER
		);
		const policy: RouteDataPolicyRow = {
			route_target_id: ROUTE.id,
			subject_fingerprint: fp,
			retention_days: 0,
			training_allowed: false,
			zdr_supported: true,
			evidence_url: "https://policy.example/evidence",
			verified_by: "operator",
			verified_at: "2026-08-01T00:00:00.000Z",
			expires_at: "2027-01-01T00:00:00.000Z",
			status: "verified",
			invalidated_at: null,
			invalidation_reason: null,
			updated_at: "2026-08-01T00:00:00.000Z",
		};
		assert.equal(routeDataPolicyAllowsZdr(policy, fp, NOW), true);
		const bulkRepo = repo({ policy });
		let bulkListCalls = 0;
		const bulkList = bulkRepo.modelEndpoints.list;
		bulkRepo.modelEndpoints.list = async (filters) => {
			bulkListCalls += 1;
			assert.deepEqual(filters, { status: "verified", limit: 100, offset: 0 });
			return bulkList(filters);
		};
		bulkRepo.modelEndpoints.listByModelId = async () => {
			throw new Error("ZDR catalog must not issue per-model endpoint queries");
		};
		assert.equal(
			(await listVerifiedZdrPublicEndpoints(bulkRepo, NOW)).length,
			1
		);
		assert.equal(bulkListCalls, 1);
		const manyRows = Array.from({ length: 101 }, (_, index) =>
			endpoint({ id: `endpoint-${index}`, tag: `tag-${index}` })
		);
		const paged = repo({ policy });
		let bindingBatchCalls = 0;
		let providerBatchCalls = 0;
		paged.modelEndpoints.list = async (filters) =>
			manyRows.slice(
				filters?.offset ?? 0,
				(filters?.offset ?? 0) + (filters?.limit ?? 100)
			);
		paged.modelEndpoints.listDiscoveryRouteBindings = async (ids) => {
			bindingBatchCalls += 1;
			assert.ok(ids.length <= 100);
			const subject = await computeRouteDataPolicySubjectFingerprintFromRows(
				ROUTE,
				PROVIDER
			);
			return ids.map((id) =>
				routeBinding(id, { ...ROUTE, id: `route-${id}` }, subject)
			);
		};
		paged.providers.getProvidersByIds = async (ids) => {
			providerBatchCalls += 1;
			assert.deepEqual(ids, [PROVIDER.id]);
			return [PROVIDER];
		};
		paged.routeDataPolicies.getByRouteTargetIds = async (ids) =>
			ids.map((id) => ({ ...policy, route_target_id: id }));
		assert.equal(
			(await listVerifiedZdrPublicEndpoints(paged, NOW)).length,
			101
		);
		assert.equal(bindingBatchCalls, 2);
		assert.equal(providerBatchCalls, 1);
		assert.equal(
			(
				await listVerifiedZdrPublicEndpoints(
					repo({ policy: { ...policy, training_allowed: true } }),
					NOW
				)
			).length,
			0
		);
		const unbound = repo({ policy });
		unbound.modelEndpoints.listDiscoveryRouteBindings = async () => [];
		assert.equal(
			(await listVerifiedZdrPublicEndpoints(unbound, NOW)).length,
			0
		);

		const mixedRoute: ModelRouteJoinRow = {
			...ROUTE,
			id: "route-without-zdr-evidence",
			provider_model_name: "secret-backup",
		};
		const mixed = repo({ policy });
		mixed.modelEndpoints.listDiscoveryRouteBindings = async () => [
			routeBinding(
				"endpoint",
				ROUTE,
				await computeRouteDataPolicySubjectFingerprintFromRows(ROUTE, PROVIDER)
			),
			routeBinding(
				"endpoint",
				mixedRoute,
				await computeRouteDataPolicySubjectFingerprintFromRows(
					mixedRoute,
					PROVIDER
				)
			),
		];
		assert.equal(
			(await listVerifiedZdrPublicEndpoints(mixed, NOW)).length,
			0,
			"an aggregate endpoint must not be advertised as ZDR when any callable route lacks matching evidence"
		);
	});

	it("fails closed before provider reads when linked-route fanout exceeds 1000", async () => {
		const r = repo();
		let providerReads = 0;
		r.providers.getProvidersByIds = async () => {
			providerReads += 1;
			return [PROVIDER];
		};
		r.modelEndpoints.listDiscoveryRouteBindings = async () =>
			Array.from({ length: 1_001 }, (_, index) =>
				routeBinding("endpoint", { ...ROUTE, id: `route-${index}` })
			);

		await assert.rejects(
			getPublicModelEndpoints(
				r,
				parseModelEndpointPath("openai", "model")!,
				NOW
			),
			/route bindings exceed safety limit 1000/
		);
		assert.equal(providerReads, 0);
	});

	it("bulk discovery rejects missing, expired, subject-mismatched, and region-drifted endpoint facts", async () => {
		const missing = repo();
		missing.modelEndpoints.list = async () => [];
		assert.deepEqual(
			await listVerifiedPublicEndpointBindings(missing, [MODEL], NOW),
			[]
		);

		const expired = repo({ endpoint: endpoint({ expires_at: "2026-08-29Z" }) });
		assert.deepEqual(
			await listVerifiedPublicEndpointBindings(expired, [MODEL], NOW),
			[]
		);

		const subjectMismatch = repo();
		subjectMismatch.modelEndpoints.listDiscoveryRouteBindings = async () => [
			routeBinding("endpoint", ROUTE, "f".repeat(64)),
		];
		assert.deepEqual(
			await listVerifiedPublicEndpointBindings(subjectMismatch, [MODEL], NOW),
			[]
		);

		const regionDriftRoute = {
			...ROUTE,
			routing_metadata: JSON.stringify({ region: "eu" }),
		};
		const regionDrift = repo({
			endpoint: endpoint({ region: "us" }),
			route: regionDriftRoute,
		});
		assert.deepEqual(
			await listVerifiedPublicEndpointBindings(regionDrift, [MODEL], NOW),
			[]
		);
	});
});

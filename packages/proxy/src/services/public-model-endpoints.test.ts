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
	type RouteAvailabilityAggregate,
	type RoutePerformanceSample,
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
		model?: ModelRow;
		endpoint?: ModelEndpointRow;
		route?: ModelRouteJoinRow;
		provider?: ProviderRow;
		policy?: RouteDataPolicyRow;
		performanceSamples?: RoutePerformanceSample[];
		availabilityAggregates?: RouteAvailabilityAggregate[];
		availabilityError?: Error;
		performanceError?: Error;
	} = {}
): PublicEndpointDiscoveryRepositories {
	const m = options.model ?? MODEL,
		e = options.endpoint ?? endpoint({ model_id: m.id }),
		route = options.route ?? { ...ROUTE, model_id: m.id },
		p = options.provider ?? PROVIDER;
	return {
		modelRouting: {
			getModelById: async (id) => (id === m.id ? m : null),
			listModelsWithActiveRoutes: async () => [m],
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
		requestLogs: {
			getRecentRoutePerformanceSamples: async (query) => {
				assert.ok(query.routeTargetIds.length > 0 && query.routeTargetIds.length <= 64);
				assert.equal(new Set(query.routeTargetIds).size, query.routeTargetIds.length);
				assert.equal(query.sinceIso, '2026-08-30T11:30:00.000Z');
				assert.equal(query.maxSamplesPerRoute, 100);
				if (options.performanceError) throw options.performanceError;
				return options.performanceSamples ?? [];
			},
			getRouteAvailabilityAggregates: async (query) => {
				assert.ok(query.routeTargetIds.length > 0 && query.routeTargetIds.length <= 64);
				assert.equal(new Set(query.routeTargetIds).size, query.routeTargetIds.length);
				assert.equal(query.since5mIso, '2026-08-30T11:55:00.000Z');
				assert.equal(query.since30mIso, '2026-08-30T11:30:00.000Z');
				assert.equal(query.since1dIso, '2026-08-29T12:00:00.000Z');
				if (options.availabilityError) throw options.availabilityError;
				return options.availabilityAggregates ?? [];
			},
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
		assert.equal(data.endpoints[0]?.supports_default_voice, null);
		assert.deepEqual(data.endpoints[0]?.reference_audio_media_types, []);
		assert.equal(data.endpoints[0]?.reference_audio_default_media_type, null);
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

	it("publishes privacy-thresholded 30-minute latency and throughput percentiles", async () => {
		const performanceSamples = Array.from({ length: 20 }, (_, index): RoutePerformanceSample => ({
			route_target_id: ROUTE.id,
			output_tokens: index + 1,
			latency_ms: null,
			upstream_response_ms: null,
			final_upstream_headers_ms: 0,
			first_reasoning_token_ms: null,
			first_token_ms: (index + 1) * 100,
			stream_duration_ms: 1_000,
			created_at: '2026-08-30T11:59:00.000Z',
		}));
		const availabilityAggregates: RouteAvailabilityAggregate[] = [{
			route_target_id: ROUTE.id,
			available_5m: 90,
			total_5m: 100,
			available_30m: 190,
			total_30m: 200,
			available_1d: 990,
			total_1d: 1_000,
		}];
		const data = await getPublicModelEndpoints(
			repo({ performanceSamples, availabilityAggregates }),
			parseModelEndpointPath("openai", "model")!,
			NOW,
		);
		assert.deepEqual(data?.endpoints[0]?.latency_last_30m, {
			p50: 1, p75: 1.5, p90: 1.8, p99: 2,
		});
		assert.deepEqual(data?.endpoints[0]?.throughput_last_30m, {
			p50: 10, p75: 5, p90: 2, p99: 1,
		});
		assert.equal(data?.endpoints[0]?.uptime_last_5m, 90);
		assert.equal(data?.endpoints[0]?.uptime_last_30m, 95);
		assert.equal(data?.endpoints[0]?.uptime_last_1d, 99);

		const belowThreshold = await getPublicModelEndpoints(
			repo({ performanceSamples: performanceSamples.slice(0, 19) }),
			parseModelEndpointPath("openai", "model")!,
			NOW,
		);
		assert.equal(belowThreshold?.endpoints[0]?.latency_last_30m, null);
		assert.equal(belowThreshold?.endpoints[0]?.throughput_last_30m, null);
		assert.equal(belowThreshold?.endpoints[0]?.uptime_last_30m, null);
	});

	it("keeps each uptime window private until it independently reaches the threshold", async () => {
		const data = await getPublicModelEndpoints(
			repo({
				availabilityAggregates: [{
					route_target_id: ROUTE.id,
					available_5m: 99,
					total_5m: 99,
					available_30m: 90,
					total_30m: 100,
					available_1d: 195,
					total_1d: 200,
				}],
			}),
			parseModelEndpointPath("openai", "model")!,
			NOW,
		);
		assert.equal(data?.endpoints[0]?.uptime_last_5m, null);
		assert.equal(data?.endpoints[0]?.uptime_last_30m, 90);
		assert.equal(data?.endpoints[0]?.uptime_last_1d, 97.5);
	});

	it("keeps endpoint discovery available when optional performance telemetry fails", async () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (value?: unknown) => warnings.push(String(value));
		try {
			const data = await getPublicModelEndpoints(
				repo({ performanceError: new Error("private database details") }),
				parseModelEndpointPath("openai", "model")!,
				NOW,
			);
			assert.equal(data?.endpoints.length, 1);
			assert.equal(data?.endpoints[0]?.latency_last_30m, null);
			assert.equal(data?.endpoints[0]?.throughput_last_30m, null);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /endpoint performance samples unavailable/u);
			assert.doesNotMatch(warnings[0]!, /private database details/u);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("keeps latency data available when optional uptime aggregation fails", async () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (value?: unknown) => warnings.push(String(value));
		try {
			const performanceSamples = Array.from({ length: 20 }, (_, index): RoutePerformanceSample => ({
				route_target_id: ROUTE.id,
				output_tokens: index + 1,
				latency_ms: (index + 1) * 100,
				upstream_response_ms: null,
				final_upstream_headers_ms: 0,
				first_reasoning_token_ms: (index + 1) * 100,
				first_token_ms: null,
				stream_duration_ms: 1_000,
				created_at: '2026-08-30T11:59:00.000Z',
			}));
			const data = await getPublicModelEndpoints(
				repo({
					performanceSamples,
					availabilityError: new Error("private uptime database details"),
				}),
				parseModelEndpointPath("openai", "model")!,
				NOW,
			);
			assert.notEqual(data?.endpoints[0]?.latency_last_30m, null);
			assert.equal(data?.endpoints[0]?.uptime_last_30m, null);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /endpoint availability aggregates unavailable/u);
			assert.doesNotMatch(warnings[0]!, /private uptime database details/u);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("publishes normalized endpoint speech request evidence", async () => {
		const speechModel: ModelRow = {
			...MODEL,
			id: "openai/speech-model",
			display_name: "Speech Model",
			context_window: null,
			max_tokens: null,
			pricing_profile: JSON.stringify({
				audio_billing_mode: "per_character",
				audio: { price_per_character: 0.00002 },
			}),
			input_modalities: '["text"]',
			output_modalities: '["speech"]',
		};
		const speechRoute: ModelRouteJoinRow = {
			...ROUTE,
			id: "speech-route",
			model_id: speechModel.id,
			upstream_operation: "audio.speech",
		};
		const repository = repo({
			model: speechModel,
			route: speechRoute,
			endpoint: endpoint({
				model_id: speechModel.id,
				context_length: null,
				max_prompt_tokens: null,
				max_completion_tokens: null,
				pricing: "{}",
				supports_voice_cloning: true,
				audio_capabilities: JSON.stringify({
					v: 1,
					pricing_by_operation: {
						"audio.speech": {
							currency: "USD",
							meter: {
								kind: "characters",
								unit: "unicode_code_point",
								price: "0.00002",
								minimum_units: 0,
								increment_units: 1,
							},
						},
					},
					speech_by_operation: {
						"audio.speech": {
							supports_default_voice: true,
							reference_audio_media_types: ["audio/WAV"],
							reference_audio_default_media_type: "audio/WAV",
						},
					},
				}),
			}),
		});
		assert.equal(
			(await listVerifiedPublicEndpointBindings(repository, [speechModel], NOW)).length,
			1
		);
		const data = await getPublicModelEndpoints(
			repository,
			parseModelEndpointPath("openai", "speech-model")!,
			NOW
		);
		assert.ok(data);
		assert.equal(data.endpoints[0]?.context_length, 0);
		assert.deepEqual(data.endpoints[0]?.pricing, {
			prompt: "0.00002",
			completion: "0",
		});
		assert.equal(data.endpoints[0]?.supports_default_voice, true);
		assert.deepEqual(data.endpoints[0]?.reference_audio_media_types, [
			"audio/wav",
		]);
		assert.equal(
			data.endpoints[0]?.reference_audio_default_media_type,
			"audio/wav"
		);
		assert.deepEqual(data.endpoints[0]?.audio_capabilities, {
			v: 1,
			pricing_by_operation: {
				"audio.speech": {
					currency: "USD",
					meter: {
						kind: "characters",
						unit: "unicode_code_point",
						price: "0.00002",
						minimum_units: 0,
						increment_units: 1,
					},
				},
			},
			speech_by_operation: {
				"audio.speech": {
					supports_default_voice: true,
					reference_audio_media_types: ["audio/wav"],
					reference_audio_default_media_type: "audio/wav",
				},
			},
		});
	});

	it("does not bind an audio route without evidence for its exact operation", async () => {
		const audioRoute: ModelRouteJoinRow = {
			...ROUTE,
			upstream_operation: "audio.speech",
		};
		assert.deepEqual(
			await listVerifiedPublicEndpointBindings(
				repo({ route: audioRoute }),
				[MODEL],
				NOW
			),
			[]
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

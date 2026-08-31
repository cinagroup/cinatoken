import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT,
	parseVerifiedModelEndpointSnapshot,
	type GatewayRepositories,
	type InsertModelEndpointParams,
	type ModelRouteRow,
	type ModelEndpointRouteLinkRow,
	type ModelEndpointRow,
	type ProviderRow,
} from "@octafuse/core";
import {
	createModelEndpointService,
	getModelEndpointService,
	linkModelEndpointRouteService,
	listModelEndpointsService,
	unlinkModelEndpointRouteService,
	updateModelEndpointService,
} from "./model-endpoints-service";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const ACTIVE_PROVIDER: ProviderRow = {
	id: "provider-1",
	name: "Provider One",
	endpoints: '{"openai":{"base":"https://provider.test/v1"}}',
	api_key: "provider-secret",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: NOW.toISOString(),
};

function route(
	id: string,
	overrides: Partial<ModelRouteRow> = {}
): ModelRouteRow {
	return {
		id,
		model_id: "openai/model-one",
		provider_id: "provider-1",
		provider_model_name: `upstream-${id}`,
		priority: 0,
		status: "active",
		route_group: "default",
		weight: 1,
		price_override: null,
		custom_params: null,
		routing_metadata: null,
		upstream_protocol: "openai",
		upstream_operation: "chat",
		adapter: "passthrough",
		route_pool_id: "pool-1",
		...overrides,
	};
}

function row(overrides: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return {
		id: "endpoint-1",
		model_id: "openai/model-one",
		provider_id: "provider-1",
		provider_slug: "provider-one",
		tag: "provider-one",
		endpoint_class: "standard",
		region: "us",
		context_length: 128_000,
		max_prompt_tokens: 120_000,
		max_completion_tokens: 8_000,
		quantization: "fp16",
		supported_parameters: '["temperature","tool_choice"]',
		pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
		supports_implicit_caching: 0,
		supports_voice_cloning: 0,
		supports_tool_choice:
			'{"auto":true,"function":true,"none":true,"required":false}',
		image_capabilities: "{}",
		audio_capabilities: "{}",
		evidence_url: "https://provider.test/pricing",
		verified_by: "admin-1",
		verified_at: NOW.toISOString(),
		expires_at: "2026-12-01T00:00:00.000Z",
		status: "verified",
		created_at: NOW.toISOString(),
		updated_at: NOW.toISOString(),
		...overrides,
	};
}

function speechAudioCapabilities(price = "0.00002000") {
	return {
		v: 1,
		pricing_by_operation: {
			"audio.speech": {
				currency: "USD",
				meter: {
					kind: "characters",
					unit: "unicode_code_point",
					price,
					minimum_units: 0,
					increment_units: 1,
				},
				request: "0.0100",
				discount: 0.25,
			},
		},
	};
}

function audioOnlyEndpointRow(
	overrides: Partial<ModelEndpointRow> = {}
): ModelEndpointRow {
	return row({
		status: "draft",
		context_length: null,
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: "{}",
		audio_capabilities: JSON.stringify(speechAudioCapabilities()),
		verified_by: null,
		verified_at: null,
		...overrides,
	});
}

function imageOnlyEndpointRow(
	overrides: Partial<ModelEndpointRow> = {}
): ModelEndpointRow {
	return row({
		status: "draft",
		context_length: null,
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: JSON.stringify({
			provider_slug: "provider-one",
			provider_tag: "fast",
			supports_streaming: false,
			supported_parameters: { seed: { type: "range", min: 0, max: 10 } },
			allowed_passthrough_parameters: ["seed"],
			pricing: [
				{ billable: "output_image", unit: "image", cost_usd: "0.0400" },
			],
		}),
		verified_by: null,
		verified_at: null,
		...overrides,
	});
}

function validMutation() {
	return {
		model_id: "openai/model-one",
		provider_id: "provider-1",
		provider_slug: "provider-one",
		tag: "provider-one",
		endpoint_class: "standard",
		region: "US",
		context_length: 128_000,
		max_prompt_tokens: 120_000,
		max_completion_tokens: 8_000,
		quantization: "FP16",
		supported_parameters: ["temperature", "tool_choice"],
		pricing: {
			currency: "USD",
			prompt: "0.00000100",
			completion: "0.00000200",
		},
		supports_implicit_caching: false,
		supports_voice_cloning: false,
		supports_tool_choice: {
			auto: true,
			function: true,
			none: true,
			required: false,
		},
		evidence_url: "https://provider.test/pricing",
		expires_at: "2026-12-01T00:00:00Z",
		status: "draft",
	};
}

function repositories(
	options: {
		rows?: ModelEndpointRow[];
		routes?: Record<string, ModelRouteRow>;
		links?: ModelEndpointRouteLinkRow[];
		provider?: ProviderRow | null;
		publicationResult?: boolean;
		linkResult?: boolean;
	} = {}
) {
	const rows = [...(options.rows ?? [])];
	const links = [...(options.links ?? [])];
	const provider =
		options.provider === undefined ? ACTIVE_PROVIDER : options.provider;
	let inserted: InsertModelEndpointParams | null = null;
	let lastPatch: Record<string, unknown> | null = null;
	const patches: Record<string, unknown>[] = [];
	const subjectUpdates: Array<{
		endpointId: string;
		routeTargetId: string;
		subjectFingerprint: string;
	}> = [];
	const events: string[] = [];
	const repos = {
		modelRouting: {
			getModelById: async (id: string) =>
				id === "openai/model-one" ? { id: "openai/model-one" } : null,
		},
		providers: {
			getProviderById: async (id: string) =>
				id === "provider-1" ? provider : null,
		},
		routes: {
			getModelRouteRowById: async (id: string) => options.routes?.[id] ?? null,
		},
		modelEndpoints: {
			list: async (filters?: { limit?: number; offset?: number }) =>
				rows.slice(
					filters?.offset ?? 0,
					(filters?.offset ?? 0) + (filters?.limit ?? 100)
				),
			listByModelId: async (modelId: string) =>
				rows.filter((item) => item.model_id === modelId),
			getById: async (id: string) =>
				rows.find((item) => item.id === id) ?? null,
			insert: async (params: InsertModelEndpointParams) => {
				inserted = params;
				events.push("insert:endpoint");
			},
			updateUnpublished: async (
				_id: string,
				params: {
					status: string;
					updatedAt: string;
					endpointPatch: Record<string, unknown>;
				}
			) => {
				const patch = {
					...params.endpointPatch,
					status: params.status,
					verified_by: null,
					verified_at: null,
					updated_at: params.updatedAt,
				};
				lastPatch = patch;
				patches.push(patch);
				events.push(`update:endpoint:${String(patch.status ?? "unchanged")}`);
				return 1;
			},
			delete: async () => 1,
			listRouteLinks: async (ids: string[]) =>
				links.filter((link) => ids.includes(link.endpoint_id)),
			linkRoute: async (params: {
				endpointId: string;
				routeTargetId: string;
				createdAt: string;
				subjectFingerprint: string | null;
				expectedEndpointStatus: string;
			}) => {
				if (options.linkResult === false) return false;
				events.push(`link:${params.routeTargetId}`);
				links.push({
					endpoint_id: params.endpointId,
					route_target_id: params.routeTargetId,
					created_at: params.createdAt,
					subject_fingerprint: params.subjectFingerprint,
				});
				if (params.expectedEndpointStatus === "verified") {
					const patch = {
						status: "draft",
						verified_by: null,
						verified_at: null,
					};
					lastPatch = patch;
					patches.push(patch);
					events.push("update:endpoint:draft");
				}
				return true;
			},
			publishVerified: async (params: {
				endpointPatch: Record<string, unknown>;
				verifiedBy: string;
				verifiedAt: string;
				routeSubjects: Array<{
					routeTargetId: string;
					subjectFingerprint: string;
				}>;
			}) => {
				if (options.publicationResult === false) return false;
				const patch = {
					...params.endpointPatch,
					status: "verified",
					verified_by: params.verifiedBy,
					verified_at: params.verifiedAt,
				};
				lastPatch = patch;
				patches.push(patch);
				events.push("publish:endpoint:verified");
				for (const subject of params.routeSubjects) {
					subjectUpdates.push({
						endpointId: "endpoint-1",
						routeTargetId: subject.routeTargetId,
						subjectFingerprint: subject.subjectFingerprint,
					});
					events.push(`subject:${subject.routeTargetId}`);
					const link = links.find(
						(candidate) => candidate.route_target_id === subject.routeTargetId
					);
					if (link) link.subject_fingerprint = subject.subjectFingerprint;
				}
				return true;
			},
			unlinkRoute: async (params: {
				endpointId: string;
				routeTargetId: string;
			}) => {
				events.push(`unlink:${params.routeTargetId}`);
				const index = links.findIndex(
					(link) =>
						link.endpoint_id === params.endpointId &&
						link.route_target_id === params.routeTargetId
				);
				if (index < 0) return 0;
				links.splice(index, 1);
				return 1;
			},
		},
	} as unknown as GatewayRepositories;
	return {
		repos,
		getInserted: () => inserted,
		getLastPatch: () => lastPatch,
		patches,
		subjectUpdates,
		events,
		links,
	};
}

describe("model endpoint admin service", () => {
	it("creates canonical drafts and rejects direct publication", async () => {
		const state = repositories();
		const created = await createModelEndpointService(
			state.repos,
			{
				...validMutation(),
				audio_capabilities: speechAudioCapabilities(),
			},
			"admin-1",
			NOW
		);
		const inserted = state.getInserted();
		assert.ok(inserted);
		assert.equal(inserted.region, "us");
		assert.equal(inserted.quantization, "fp16");
		assert.equal(
			inserted.pricing,
			JSON.stringify({
				currency: "USD",
				prompt: "0.000001",
				completion: "0.000002",
			})
		);
		assert.deepEqual(JSON.parse(inserted.supportsToolChoice), {
			auto: true,
			function: true,
			none: true,
			required: false,
		});
		assert.deepEqual(JSON.parse(inserted.audioCapabilities ?? "{}"), {
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
					request: "0.01",
					discount: 0.25,
				},
			},
		});
		assert.equal(created.status, "draft");
		assert.equal(
			created.audio_capabilities?.pricing_by_operation["audio.speech"]?.meter
				.kind,
			"characters"
		);
		assert.equal(inserted.status, "draft");
		assert.equal(inserted.verifiedBy, null);
		assert.equal(inserted.verifiedAt, null);

		await assert.rejects(
			createModelEndpointService(
				state.repos,
				{ ...validMutation(), status: "verified" },
				"admin-1",
				NOW
			),
			/create a draft, link routes, then explicitly verify/
		);
		assert.equal(
			state.events.filter((event) => event === "insert:endpoint").length,
			1
		);
	});

	it("strictly rejects unknown audio operations and operation/meter mismatches", async () => {
		await assert.rejects(
			createModelEndpointService(
				repositories().repos,
				{
					...validMutation(),
					audio_capabilities: {
						v: 1,
						pricing_by_operation: {
							"audio.unknown":
								speechAudioCapabilities().pricing_by_operation["audio.speech"],
						},
					},
				},
				"admin-1",
				NOW
			),
			/unsupported key: audio\.unknown/
		);

		await assert.rejects(
			createModelEndpointService(
				repositories().repos,
				{
					...validMutation(),
					audio_capabilities: {
						v: 1,
						pricing_by_operation: {
							"audio.speech": {
								currency: "USD",
								meter: {
									kind: "duration",
									unit: "second",
									price: "0.1",
									minimum_units: 0,
									increment_units: 1,
								},
							},
						},
					},
				},
				"admin-1",
				NOW
			),
			/meter\.kind is unsupported for audio\.speech/
		);
	});

	it("uses the runtime parameter limit and provider-qualified tag rule", async () => {
		const parameters = Array.from(
			{ length: MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT },
			(_, index) => `p${index}`
		);
		const accepted = repositories();
		await createModelEndpointService(
			accepted.repos,
			{ ...validMutation(), supported_parameters: parameters },
			"admin-1",
			NOW
		);
		assert.equal(
			JSON.parse(accepted.getInserted()?.supportedParameters ?? "[]").length,
			MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT
		);

		await assert.rejects(
			createModelEndpointService(
				repositories().repos,
				{
					...validMutation(),
					supported_parameters: [...parameters, "overflow"],
				},
				"admin-1",
				NOW
			),
			new RegExp(
				`at most ${MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT} names`,
				"u"
			)
		);
		await assert.rejects(
			createModelEndpointService(
				repositories().repos,
				{ ...validMutation(), tag: "another-provider/turbo" },
				"admin-1",
				NOW
			),
			/does not belong to provider_slug/
		);
	});

	it("allows an image-only draft to be explicitly verified when route evidence is complete", async () => {
		const imageDraft = imageOnlyEndpointRow();
		const state = repositories({
			rows: [imageDraft],
			routes: {
				"route-image": route("route-image", {
					upstream_operation: "images.generations",
				}),
			},
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-image",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
		});
		await updateModelEndpointService(
			state.repos,
			"endpoint-1",
			{ status: "verified" },
			"admin-1",
			NOW
		);
		assert.equal(state.getLastPatch()?.status, "verified");
		assert.match(
			String(state.getLastPatch()?.image_capabilities ?? ""),
			/"cost_usd":"0.04"/
		);
		assert.equal(state.subjectUpdates.length, 1);
		assert.ok(
			parseVerifiedModelEndpointSnapshot(
				{ ...imageDraft, ...state.patches[0] } as ModelEndpointRow,
				NOW
			)
		);
	});

	it("verifies an audio-only endpoint only for an exactly priced linked operation", async () => {
		const audioDraft = audioOnlyEndpointRow();
		const state = repositories({
			rows: [audioDraft],
			routes: {
				"route-audio": route("route-audio", {
					upstream_operation: "audio.speech",
				}),
			},
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-audio",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
		});

		const verified = await updateModelEndpointService(
			state.repos,
			"endpoint-1",
			{ status: "verified" },
			"admin-1",
			NOW
		);
		assert.equal(state.getLastPatch()?.status, "verified");
		assert.equal(verified.status, "verified");
		assert.equal(
			verified.audio_capabilities?.pricing_by_operation["audio.speech"]?.meter
				.kind,
			"characters"
		);
		assert.match(
			String(state.getLastPatch()?.audio_capabilities ?? ""),
			/"audio\.speech"/
		);
		assert.equal(state.subjectUpdates.length, 1);
		assert.ok(
			parseVerifiedModelEndpointSnapshot(
				{ ...audioDraft, ...state.patches[0] } as ModelEndpointRow,
				NOW
			)
		);

		const mismatched = repositories({
			rows: [audioOnlyEndpointRow()],
			routes: {
				"route-audio": route("route-audio", {
					upstream_operation: "audio.transcriptions",
				}),
			},
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-audio",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
		});
		await assert.rejects(
			updateModelEndpointService(
				mismatched.repos,
				"endpoint-1",
				{ status: "verified" },
				"admin-1",
				NOW
			),
			/Endpoint facts do not support linked route operation "audio\.transcriptions"/
		);
		assert.equal(mismatched.patches.length, 0);
	});

	it("rejects image-only chat links and text-only image links before publication", async () => {
		const cases = [
			{
				name: "image-only chat",
				endpoint: imageOnlyEndpointRow(),
				route: route("route-1", { upstream_operation: "chat" }),
			},
			{
				name: "text-only images",
				endpoint: row({
					status: "draft",
					verified_by: null,
					verified_at: null,
				}),
				route: route("route-1", {
					upstream_operation: "images.generations",
				}),
			},
		];
		for (const scenario of cases) {
			const state = repositories({
				rows: [scenario.endpoint],
				routes: { "route-1": scenario.route },
				links: [
					{
						endpoint_id: "endpoint-1",
						route_target_id: "route-1",
						subject_fingerprint: null,
						created_at: NOW.toISOString(),
					},
				],
			});
			await assert.rejects(
				updateModelEndpointService(
					state.repos,
					"endpoint-1",
					{ status: "verified" },
					"admin-1",
					NOW
				),
				/Endpoint facts do not support linked route operation/,
				scenario.name
			);
			assert.equal(state.patches.length, 0, scenario.name);
			assert.equal(state.subjectUpdates.length, 0, scenario.name);
		}
	});

	it("validates every link before atomically publishing deterministic route subjects", async () => {
		const routeA = route("route-a", { custom_params: '{"temperature":0.1}' });
		const routeB = route("route-b", { provider_model_name: "upstream-b" });
		const draftRow = row({
			status: "draft",
			verified_by: null,
			verified_at: null,
		});
		const state = repositories({
			rows: [draftRow],
			routes: { "route-a": routeA, "route-b": routeB },
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-b",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-a",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
		});

		await updateModelEndpointService(
			state.repos,
			"endpoint-1",
			{ status: "verified" },
			"admin-2",
			NOW
		);

		assert.equal(state.patches[0]?.status, "verified");
		assert.equal(state.patches[0]?.verified_by, "admin-2");
		assert.equal(state.patches[0]?.verified_at, NOW.toISOString());
		assert.deepEqual(state.events, [
			"publish:endpoint:verified",
			"subject:route-a",
			"subject:route-b",
		]);
		assert.deepEqual(
			state.subjectUpdates.map((subject) => subject.subjectFingerprint),
			[
				await computeRouteDataPolicySubjectFingerprintFromRows(
					routeA,
					ACTIVE_PROVIDER
				),
				await computeRouteDataPolicySubjectFingerprintFromRows(
					routeB,
					ACTIVE_PROVIDER
				),
			]
		);
		assert.ok(
			state.links.every((link) =>
				/^[0-9a-f]{64}$/u.test(link.subject_fingerprint ?? "")
			)
		);
		assert.ok(
			parseVerifiedModelEndpointSnapshot(
				{ ...draftRow, ...state.patches[0] } as ModelEndpointRow,
				NOW
			),
			"every Admin-publishable endpoint must parse under the runtime contract"
		);
	});

	it("requires every non-empty legacy routing_metadata claim to match the candidate endpoint before any write", async () => {
		const draft = row({
			status: "draft",
			verified_by: null,
			verified_at: null,
		});
		const matching = repositories({
			rows: [draft],
			routes: {
				"route-full": route("route-full", {
					routing_metadata: JSON.stringify({
						supported_parameters: ["tool_choice", "TEMPERATURE"],
						quantization: "fp16",
						endpoint_slug: "provider-one",
						endpoint_class: "standard",
						region: "US",
						context_length: 128_000,
						max_prompt_tokens: 120_000,
						max_completion_tokens: 8_000,
					}),
				}),
				"route-empty": route("route-empty", { routing_metadata: "{}" }),
			},
			links: ["route-full", "route-empty"].map((routeTargetId) => ({
				endpoint_id: "endpoint-1",
				route_target_id: routeTargetId,
				subject_fingerprint: null,
				created_at: NOW.toISOString(),
			})),
		});
		await updateModelEndpointService(
			matching.repos,
			"endpoint-1",
			{ status: "verified" },
			"admin-2",
			NOW
		);
		assert.equal(matching.patches[0]?.status, "verified");
		assert.equal(matching.subjectUpdates.length, 2);

		const driftCases: Array<{
			id: string;
			metadata: Record<string, unknown> | string;
		}> = [
			{
				id: "route-selector",
				metadata: {
					endpoint_slug: "provider-one/turbo",
					endpoint_class: "standard",
				},
			},
			{ id: "route-class", metadata: { endpoint_class: "service_tier" } },
			{ id: "route-region", metadata: { region: "eu" } },
			{ id: "route-quantization", metadata: { quantization: "fp8" } },
			{
				id: "route-parameters",
				metadata: { supported_parameters: ["temperature"] },
			},
			{ id: "route-context", metadata: { context_length: 64_000 } },
			{ id: "route-prompt", metadata: { max_prompt_tokens: 64_000 } },
			{ id: "route-completion", metadata: { max_completion_tokens: 4_000 } },
			{ id: "route-invalid-json", metadata: "{" },
		];

		for (const scenario of driftCases) {
			const state = repositories({
				rows: [draft],
				routes: {
					[scenario.id]: route(scenario.id, {
						routing_metadata:
							typeof scenario.metadata === "string"
								? scenario.metadata
								: JSON.stringify(scenario.metadata),
					}),
				},
				links: [
					{
						endpoint_id: "endpoint-1",
						route_target_id: scenario.id,
						subject_fingerprint: null,
						created_at: NOW.toISOString(),
					},
				],
			});
			await assert.rejects(
				updateModelEndpointService(
					state.repos,
					"endpoint-1",
					{ status: "verified" },
					"admin-2",
					NOW
				),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes("routing_metadata drifts") &&
					error.message.includes(scenario.id),
				scenario.id
			);
			assert.equal(state.patches.length, 0, scenario.id);
			assert.equal(state.subjectUpdates.length, 0, scenario.id);
			assert.deepEqual(state.events, [], scenario.id);
		}
	});

	it("demotes a verified record to draft when a public claim changes without explicit re-verification", async () => {
		const state = repositories({ rows: [row()] });
		await updateModelEndpointService(
			state.repos,
			"endpoint-1",
			{ context_length: 256_000 },
			"admin-2",
			NOW
		);
		assert.equal(state.getLastPatch()?.status, "draft");
		assert.equal(state.getLastPatch()?.verified_by, null);
		assert.equal(state.getLastPatch()?.verified_at, null);
	});

	it("normalizes an audio pricing update and demotes verified evidence", async () => {
		const state = repositories({ rows: [row()] });
		const demoted = await updateModelEndpointService(
			state.repos,
			"endpoint-1",
			{ audio_capabilities: speechAudioCapabilities("0.00003000") },
			"admin-2",
			NOW
		);
		assert.equal(state.getLastPatch()?.status, "draft");
		assert.equal(demoted.status, "draft");
		assert.equal(
			demoted.audio_capabilities?.pricing_by_operation["audio.speech"]?.meter
				.kind,
			"characters"
		);
		assert.equal(state.getLastPatch()?.verified_by, null);
		assert.equal(state.getLastPatch()?.verified_at, null);
		assert.equal(
			JSON.parse(String(state.getLastPatch()?.audio_capabilities))
				.pricing_by_operation["audio.speech"].meter.price,
			"0.00003"
		);
	});

	it("fails closed before publication when a linked route or provider is not eligible", async () => {
		const cases: Array<{
			name: string;
			route: ModelRouteRow;
			provider: ProviderRow;
			error: RegExp;
		}> = [
			{
				name: "inactive route",
				route: route("route-1", { status: "disabled" }),
				provider: ACTIVE_PROVIDER,
				error: /route must be active/,
			},
			{
				name: "route identity mismatch",
				route: route("route-1", { model_id: "other/model" }),
				provider: ACTIVE_PROVIDER,
				error: /model\/provider must match/,
			},
			{
				name: "inactive provider",
				route: route("route-1"),
				provider: { ...ACTIVE_PROVIDER, status: "disabled" },
				error: /active provider/,
			},
			{
				name: "shared-channel provider",
				route: route("route-1"),
				provider: { ...ACTIVE_PROVIDER, shared_channel_type: "openai" },
				error: /shared-channel providers/,
			},
			{
				name: "missing provider credential",
				route: route("route-1"),
				provider: { ...ACTIVE_PROVIDER, api_key: "" },
				error: /provider credential/,
			},
			{
				name: "pending provider credential",
				route: route("route-1"),
				provider: { ...ACTIVE_PROVIDER, api_key: "__OCTAFUSE_PENDING_PROVIDER_API_KEY__" },
				error: /provider credential/,
			},
			{
				name: "missing protocol endpoint",
				route: route("route-1"),
				provider: { ...ACTIVE_PROVIDER, endpoints: null },
				error: /no callable endpoint/,
			},
			{
				name: "missing operation endpoint",
				route: route("route-1", { upstream_operation: "chat" }),
				provider: {
					...ACTIVE_PROVIDER,
					endpoints:
						'{"openai":{"endpoints":{"embeddings":"https://provider.test/embeddings"}}}',
				},
				error: /operation "chat" on protocol "openai"/,
			},
			{
				name: "incomplete composite operation endpoints",
				route: route("route-1", {
					upstream_protocol: "dashscope",
					upstream_operation: "audio.transcriptions.async",
				}),
				provider: {
					...ACTIVE_PROVIDER,
					endpoints:
						'{"dashscope":{"endpoints":{"audio.transcriptions":"https://provider.test/asr/submit"}}}',
				},
				error:
					/operation "audio\.transcriptions\.async" on protocol "dashscope"/,
			},
		];

		for (const scenario of cases) {
			const state = repositories({
				rows: [row({ status: "draft", verified_by: null, verified_at: null })],
				routes: { "route-1": scenario.route },
				links: [
					{
						endpoint_id: "endpoint-1",
						route_target_id: "route-1",
						subject_fingerprint: null,
						created_at: NOW.toISOString(),
					},
				],
				provider: scenario.provider,
			});
			await assert.rejects(
				updateModelEndpointService(
					state.repos,
					"endpoint-1",
					{ status: "verified" },
					"admin-2",
					NOW
				),
				scenario.error,
				scenario.name
			);
			assert.equal(state.patches.length, 0, scenario.name);
			assert.equal(state.subjectUpdates.length, 0, scenario.name);
		}
	});

	it("requires between one and one hundred links and complete public evidence", async () => {
		const noLinks = repositories({
			rows: [row({ status: "draft", verified_by: null, verified_at: null })],
		});
		await assert.rejects(
			updateModelEndpointService(
				noLinks.repos,
				"endpoint-1",
				{ status: "verified" },
				"admin-2",
				NOW
			),
			/between 1 and 100 route links/
		);
		assert.equal(noLinks.patches.length, 0);

		const tooManyLinks = repositories({
			rows: [row({ status: "draft", verified_by: null, verified_at: null })],
			links: Array.from({ length: 101 }, (_, index) => ({
				endpoint_id: "endpoint-1",
				route_target_id: `route-${index}`,
				subject_fingerprint: null,
				created_at: NOW.toISOString(),
			})),
		});
		await assert.rejects(
			updateModelEndpointService(
				tooManyLinks.repos,
				"endpoint-1",
				{ status: "verified" },
				"admin-2",
				NOW
			),
			/between 1 and 100 route links/
		);
		assert.equal(tooManyLinks.patches.length, 0);

		const incomplete = repositories({
			rows: [
				row({
					status: "draft",
					pricing: "{}",
					verified_by: null,
					verified_at: null,
				}),
			],
		});
		await assert.rejects(
			updateModelEndpointService(
				incomplete.repos,
				"endpoint-1",
				{ status: "verified" },
				"admin-2",
				NOW
			),
			/complete text pricing\/capabilities, definitive image capabilities, or exact audio operation pricing/
		);
		assert.equal(incomplete.patches.length, 0);
	});

	it("publishes no endpoint or subjects when the atomic snapshot changed", async () => {
		const state = repositories({
			rows: [row({ status: "draft", verified_by: null, verified_at: null })],
			routes: { "route-a": route("route-a"), "route-b": route("route-b") },
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-a",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-b",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
			publicationResult: false,
		});
		await assert.rejects(
			updateModelEndpointService(
				state.repos,
				"endpoint-1",
				{ status: "verified" },
				"admin-2",
				NOW
			),
			/changed during verification/
		);
		assert.deepEqual(state.patches, []);
		assert.deepEqual(state.subjectUpdates, []);
		assert.ok(state.links.every((link) => link.subject_fingerprint === null));
	});

	it("rejects unknown mutation fields and mismatched route bindings", async () => {
		const state = repositories({
			rows: [row()],
			routes: {
				wrong: route("wrong", { model_id: "other/model" }),
				good: route("good"),
			},
		});
		await assert.rejects(
			createModelEndpointService(
				state.repos,
				{ ...validMutation(), secret: true } as ReturnType<
					typeof validMutation
				>,
				"admin-1",
				NOW
			),
			/Unsupported endpoint field: secret/
		);
		await assert.rejects(
			linkModelEndpointRouteService(state.repos, "endpoint-1", "wrong", NOW),
			/Route model\/provider must match/
		);
		await linkModelEndpointRouteService(state.repos, "endpoint-1", "good", NOW);
		assert.equal(state.links.at(-1)?.route_target_id, "good");
		assert.equal(state.links.at(-1)?.subject_fingerprint, null);
		assert.equal(state.getLastPatch()?.status, "draft");
		assert.equal(state.getLastPatch()?.verified_by, null);
		assert.equal(state.getLastPatch()?.verified_at, null);
		assert.deepEqual(state.events.slice(-2), [
			"link:good",
			"update:endpoint:draft",
		]);

		const draftState = repositories({
			rows: [row({ status: "draft", verified_by: null, verified_at: null })],
			routes: { good: route("good") },
		});
		await linkModelEndpointRouteService(
			draftState.repos,
			"endpoint-1",
			"good",
			NOW
		);
		assert.equal(draftState.links[0]?.subject_fingerprint, null);
		assert.equal(draftState.patches.length, 0);

		const racingState = repositories({
			rows: [row({ status: "draft", verified_by: null, verified_at: null })],
			routes: { good: route("good") },
			linkResult: false,
		});
		await assert.rejects(
			linkModelEndpointRouteService(
				racingState.repos,
				"endpoint-1",
				"good",
				NOW
			),
			/Endpoint changed while the route was being linked/u
		);
		assert.deepEqual(racingState.links, []);
		assert.deepEqual(racingState.patches, []);
	});

	it("unlinks directly without changing endpoint verification state", async () => {
		const state = repositories({
			rows: [row()],
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-1",
					subject_fingerprint: "a".repeat(64),
					created_at: NOW.toISOString(),
				},
			],
		});
		await unlinkModelEndpointRouteService(state.repos, "endpoint-1", "route-1");
		assert.deepEqual(state.events, ["unlink:route-1"]);
		assert.equal(state.patches.length, 0);
		assert.equal(state.links.length, 0);
	});

	it("returns parsed admin rows and route ids without exposing invalid JSON as facts", async () => {
		const state = repositories({
			rows: [row(), row({ id: "draft-bad", status: "draft", pricing: "{bad" })],
			links: [
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-1",
					subject_fingerprint: null,
					created_at: NOW.toISOString(),
				},
			],
		});
		const listed = await listModelEndpointsService(state.repos, {});
		assert.deepEqual(listed[0]?.supported_parameters, [
			"temperature",
			"tool_choice",
		]);
		assert.deepEqual(listed[0]?.route_target_ids, ["route-1"]);
		assert.equal(listed[0]?.audio_capabilities, null);
		assert.equal(listed[1]?.pricing, null);
		assert.deepEqual(listed[1]?.supported_parameters, []);
	});

	it("returns normalized audio capabilities from both list and get DTOs", async () => {
		const state = repositories({ rows: [audioOnlyEndpointRow()] });
		const listed = await listModelEndpointsService(state.repos, {});
		const fetched = await getModelEndpointService(state.repos, "endpoint-1");
		for (const endpoint of [listed[0], fetched]) {
			assert.deepEqual(endpoint?.audio_capabilities, {
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
						request: "0.01",
						discount: 0.25,
					},
				},
			});
		}
	});

	it("paginates beyond 100 rows and rejects catalogs above the safety limit", async () => {
		const many = Array.from({ length: 101 }, (_, index) =>
			row({ id: `endpoint-${index}` })
		);
		assert.equal(
			(await listModelEndpointsService(repositories({ rows: many }).repos, {}))
				.length,
			101
		);
		const overflow = Array.from({ length: 1_001 }, (_, index) =>
			row({ id: `overflow-${index}` })
		);
		await assert.rejects(
			listModelEndpointsService(repositories({ rows: overflow }).repos, {}),
			/safety limit 1000/
		);
	});
});

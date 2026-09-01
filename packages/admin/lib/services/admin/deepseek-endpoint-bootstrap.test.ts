import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	GatewayRepositories,
	InsertUnpublishedModelEndpointParams,
	LinkModelEndpointRouteParams,
	ModelEndpointRow,
	ModelEndpointRouteLinkRow,
	ModelRouteJoinRow,
	ProviderRow,
	PublishVerifiedModelEndpointParams,
	UpdateUnpublishedModelEndpointParams,
} from "@octafuse/core";
import { bootstrapDeepSeekEndpointsService } from "./deepseek-endpoint-bootstrap";

const NOW = new Date("2026-09-01T06:00:00.000Z");

const PROVIDER: ProviderRow = {
	id: "deepseek-official",
	name: "DeepSeek",
	endpoints: JSON.stringify({
		openai: {
			endpoints: {
				chat: "https://api.deepseek.com/chat/completions",
				responses: "https://api.deepseek.com/responses",
			},
		},
		anthropic: { base: "https://api.deepseek.com/anthropic" },
	}),
	api_key: "env:DEEPSEEK_API_KEY",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: NOW.toISOString(),
};

function route(
	modelId: string,
	protocol: "openai" | "anthropic",
	operation: "chat" | "responses" | "messages",
	overrides: Partial<ModelRouteJoinRow> = {}
): ModelRouteJoinRow {
	return {
		id: `${modelId}:${protocol}:${operation}`,
		model_id: modelId,
		provider_id: PROVIDER.id,
		provider_model_name: modelId,
		priority: 0,
		status: "active",
		route_group: "default",
		weight: 1,
		price_override: null,
		custom_params: null,
		routing_metadata: null,
		upstream_protocol: protocol,
		route_pool_id: `${modelId}:${protocol}:${operation}:pool`,
		upstream_operation: operation,
		adapter: "passthrough",
		surfaces: null,
		pool_name: "default",
		pool_strategy: null,
		pool_tier_strategies: null,
		pool_status: "active",
		model_name: modelId,
		provider_name: PROVIDER.name,
		provider_status: "active",
		...overrides,
	};
}

function rowFromInsert(
	input: InsertUnpublishedModelEndpointParams
): ModelEndpointRow {
	return {
		id: input.id,
		model_id: input.modelId,
		provider_id: input.providerId,
		provider_slug: input.providerSlug,
		tag: input.tag,
		endpoint_class: input.endpointClass,
		region: input.region,
		context_length: input.contextLength,
		max_prompt_tokens: input.maxPromptTokens,
		max_completion_tokens: input.maxCompletionTokens,
		quantization: input.quantization,
		supported_parameters: input.supportedParameters,
		pricing: input.pricing,
		supports_implicit_caching: input.supportsImplicitCaching,
		supports_voice_cloning: input.supportsVoiceCloning,
		supports_tool_choice: input.supportsToolChoice,
		image_capabilities: input.imageCapabilities,
		audio_capabilities: input.audioCapabilities ?? "{}",
		evidence_url: input.evidenceUrl,
		verified_by: null,
		verified_at: null,
		expires_at: input.expiresAt,
		status: input.status,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	};
}

function repositoryState(options: {
	models?: string[];
	routes?: ModelRouteJoinRow[];
	provider?: ProviderRow | null;
} = {}) {
	const models = new Set(
		options.models ?? ["deepseek-v4-flash", "deepseek-v4-pro"]
	);
	const routes =
		options.routes ??
		[...models].flatMap((modelId) => [
			route(modelId, "openai", "chat"),
			route(modelId, "openai", "responses"),
			route(modelId, "anthropic", "messages"),
		]);
	const provider = options.provider === undefined ? PROVIDER : options.provider;
	const endpoints: ModelEndpointRow[] = [];
	const links: ModelEndpointRouteLinkRow[] = [];

	const repositories = {
		modelRouting: {
			getModelById: async (id: string) => (models.has(id) ? { id } : null),
		},
		providers: {
			getProviderById: async (id: string) =>
				id === PROVIDER.id ? provider : null,
		},
		routes: {
			listModelRoutesWithJoins: async (filters: {
				modelId?: string;
				providerId?: string;
			}) =>
				routes.filter(
					(item) =>
						(!filters.modelId || item.model_id === filters.modelId) &&
						(!filters.providerId || item.provider_id === filters.providerId)
				),
			getModelRouteRowById: async (id: string) =>
				routes.find((item) => item.id === id) ?? null,
		},
		modelEndpoints: {
			list: async (filters?: {
				modelId?: string;
				providerId?: string;
				limit?: number;
				offset?: number;
			}) =>
				endpoints
					.filter(
						(item) =>
							(!filters?.modelId || item.model_id === filters.modelId) &&
							(!filters?.providerId ||
								item.provider_id === filters.providerId)
					)
					.slice(
						filters?.offset ?? 0,
						(filters?.offset ?? 0) + (filters?.limit ?? 100)
					),
			getByIdentity: async (modelId: string, providerId: string, tag: string) =>
				endpoints.find(
					(item) =>
						item.model_id === modelId &&
						item.provider_id === providerId &&
						item.tag === tag
				) ?? null,
			getById: async (id: string) =>
				endpoints.find((item) => item.id === id) ?? null,
			insert: async (input: InsertUnpublishedModelEndpointParams) => {
				endpoints.push(rowFromInsert(input));
			},
			updateUnpublished: async (
				id: string,
				params: UpdateUnpublishedModelEndpointParams
			) => {
				const index = endpoints.findIndex((item) => item.id === id);
				if (index < 0) return 0;
				endpoints[index] = {
					...endpoints[index]!,
					...params.endpointPatch,
					status: params.status,
					verified_by: null,
					verified_at: null,
					updated_at: params.updatedAt,
				};
				return 1;
			},
			listRouteLinks: async (endpointIds: string[]) =>
				links.filter((link) => endpointIds.includes(link.endpoint_id)),
			linkRoute: async (params: LinkModelEndpointRouteParams) => {
				links.push({
					endpoint_id: params.endpointId,
					route_target_id: params.routeTargetId,
					subject_fingerprint: null,
					created_at: params.createdAt,
				});
				return true;
			},
			publishVerified: async (params: PublishVerifiedModelEndpointParams) => {
				const index = endpoints.findIndex(
					(item) => item.id === params.endpointId
				);
				if (index < 0) return false;
				endpoints[index] = {
					...endpoints[index]!,
					...params.endpointPatch,
					status: "verified",
					verified_by: params.verifiedBy,
					verified_at: params.verifiedAt,
					updated_at: params.updatedAt,
				};
				for (const subject of params.routeSubjects) {
					const link = links.find(
						(item) =>
							item.endpoint_id === params.endpointId &&
							item.route_target_id === subject.routeTargetId
					);
					if (link) link.subject_fingerprint = subject.subjectFingerprint;
				}
				return true;
			},
		} as GatewayRepositories["modelEndpoints"],
	} as unknown as GatewayRepositories;

	return { repositories, endpoints, links };
}

describe("official DeepSeek endpoint bootstrap", () => {
	it("creates drafts, links every eligible route, and explicitly publishes both current text models", async () => {
		const state = repositoryState();
		const result = await bootstrapDeepSeekEndpointsService(
			state.repositories,
			{ publish: true },
			"console:admin",
			NOW
		);
		assert.equal(result.published, 2);
		assert.equal(result.linked_routes, 6);
		assert.equal(result.failed, 0);
		assert.equal(result.pricing_basis, "peak");
		assert.equal(state.endpoints.length, 2);
		assert.equal(state.links.length, 6);
		assert.ok(state.endpoints.every((item) => item.status === "verified"));
		assert.ok(
			state.links.every((item) => /^[0-9a-f]{64}$/u.test(item.subject_fingerprint ?? ""))
		);
		assert.equal(
			JSON.parse(
				state.endpoints.find((item) => item.model_id === "deepseek-v4-flash")
					?.pricing ?? "{}"
			).prompt,
			"0.00000044"
		);

		const repeated = await bootstrapDeepSeekEndpointsService(
			state.repositories,
			{ publish: true },
			"console:admin",
			NOW
		);
		assert.equal(repeated.published, 2);
		assert.equal(repeated.linked_routes, 0);
		assert.equal(state.endpoints.length, 2);
		assert.equal(state.links.length, 6);
	});

	it("skips missing models and models without eligible active routes without creating drafts", async () => {
		const state = repositoryState({
			models: ["deepseek-v4-flash"],
			routes: [
				route("deepseek-v4-flash", "openai", "chat", {
					status: "disabled",
				}),
			],
		});
		const result = await bootstrapDeepSeekEndpointsService(
			state.repositories,
			{ publish: true },
			"console:admin",
			NOW
		);
		assert.equal(result.published, 0);
		assert.equal(result.skipped, 2);
		assert.deepEqual(
			result.models.map((item) => item.status),
			["skipped_no_routes", "skipped_missing_model"]
		);
		assert.equal(state.endpoints.length, 0);
	});

	it("requires an explicit publish flag and an active credentialed official provider", async () => {
		await assert.rejects(
			bootstrapDeepSeekEndpointsService(
				repositoryState().repositories,
				{},
				"console:admin",
				NOW
			),
			/publish must be true/
		);
		await assert.rejects(
			bootstrapDeepSeekEndpointsService(
				repositoryState({
					provider: { ...PROVIDER, status: "disabled" },
				}).repositories,
				{ publish: true },
				"console:admin",
				NOW
			),
			/must be active/
		);
		await assert.rejects(
			bootstrapDeepSeekEndpointsService(
				repositoryState({
					provider: { ...PROVIDER, api_key: "" },
				}).repositories,
				{ publish: true },
				"console:admin",
				NOW
			),
			/credential is unavailable/
		);
	});

	it("fails closed as a draft when legacy route claims drift from official evidence", async () => {
		const state = repositoryState({
			models: ["deepseek-v4-flash"],
			routes: [
				route("deepseek-v4-flash", "openai", "chat", {
					routing_metadata: JSON.stringify({ context_length: 128_000 }),
				}),
			],
		});
		const result = await bootstrapDeepSeekEndpointsService(
			state.repositories,
			{ publish: true },
			"console:admin",
			NOW
		);
		assert.equal(result.published, 0);
		assert.equal(result.failed, 1);
		assert.match(result.models[0]?.message ?? "", /routing_metadata drifts/);
		assert.equal(state.endpoints[0]?.status, "draft");
		assert.equal(state.links[0]?.subject_fingerprint, null);
	});
});

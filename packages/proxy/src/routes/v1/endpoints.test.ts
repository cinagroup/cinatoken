import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type GatewayRepositories,
	type ManagementApiKeyRow,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelRouteJoinRow,
	type ModelEndpointRow,
	type ModelRow,
	type ProviderRow,
	type ResolvedGatewayKeyRow,
	type RouteDataPolicyRow,
	type StorageContext,
} from "@octafuse/core";
import { Hono } from "hono";
import { createProxyApp, type Env } from "../../app";
import { requireApiKey } from "../../middleware/auth";
import { GatewayErrorCode } from "../../services/gateway-error-codes";

const MANAGEMENT_SECRET = `sk-cina-mgmt-${"a".repeat(64)}`;
const MANAGEMENT_ROW: ManagementApiKeyRow = {
	id: "management-1",
	key_hash: `sha256:${"a".repeat(64)}`,
	key_preview: "sk-cina-mgmt-aaaa…aaaa",
	account_type: "personal",
	personal_owner_user_id: "user-1",
	organization_id: null,
	name: "Endpoint discovery",
	status: "active",
	expires_at: null,
	last_used_at: null,
	created_by_user_id: "user-1",
	created_at: "2026-08-31T00:00:00.000Z",
	updated_at: "2026-08-31T00:00:00.000Z",
};

const MODEL: ModelRow = {
	id: "openai/model-one",
	display_name: "Model One",
	vendor: "openai",
	context_window: 128_000,
	max_tokens: 8_000,
	pricing_profile: JSON.stringify({
		tiers: [{ upto: null, input_price: 3, output_price: 6 }],
	}),
	tags: "[]",
	description: null,
	metadata: null,
	input_modalities: '["text"]',
	output_modalities: '["text","image"]',
	released_at: null,
	created_at: "2026-08-30T00:00:00.000Z",
};

const ROUTE: ModelRouteJoinRow = {
	id: "route-1",
	model_id: MODEL.id,
	provider_id: "provider-1",
	provider_model_name: "private-model",
	priority: 0,
	status: "active",
	route_group: "default",
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: JSON.stringify({
		supported_parameters: ["temperature"],
		quantization: "fp16",
		endpoint_slug: "openai",
		endpoint_class: "standard",
		region: "us",
		context_length: 128_000,
		max_prompt_tokens: 120_000,
		max_completion_tokens: 8_000,
	}),
	upstream_protocol: "openai",
	route_pool_id: "pool-1",
	upstream_operation: "chat",
	adapter: "passthrough",
	surfaces: null,
	pool_name: null,
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: "active",
	model_name: MODEL.display_name,
	provider_name: "Provider One",
	provider_status: "active",
};

const PROVIDER: ProviderRow = {
	id: "provider-1",
	name: "Provider One",
	endpoints: JSON.stringify({ openai: { base: "https://private.example/v1" } }),
	api_key: "sk-provider-private",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: "2026-08-30T00:00:00.000Z",
};

function discoveryRouteBinding(
	subjectFingerprint: string
): ModelEndpointDiscoveryRouteBindingRow {
	return {
		endpoint_id: ENDPOINT.id,
		subject_fingerprint: subjectFingerprint,
		id: ROUTE.id,
		model_id: ROUTE.model_id,
		provider_id: ROUTE.provider_id,
		provider_model_name: ROUTE.provider_model_name,
		status: ROUTE.status,
		route_group: ROUTE.route_group,
		custom_params: ROUTE.custom_params,
		routing_metadata: ROUTE.routing_metadata,
		upstream_protocol: ROUTE.upstream_protocol,
		upstream_operation: ROUTE.upstream_operation,
		adapter: ROUTE.adapter,
		route_pool_id: ROUTE.route_pool_id,
		pool_status: ROUTE.pool_status,
	};
}

const ENDPOINT: ModelEndpointRow = {
	id: "endpoint-1",
	model_id: MODEL.id,
	provider_id: PROVIDER.id,
	provider_slug: "openai",
	tag: "openai",
	endpoint_class: "standard",
	region: "us",
	context_length: 128_000,
	max_prompt_tokens: 120_000,
	max_completion_tokens: 8_000,
	quantization: "fp16",
	supported_parameters: '["temperature"]',
	pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',
	supports_implicit_caching: false,
	supports_voice_cloning: false,
	supports_tool_choice:
		'{"auto":true,"function":false,"none":true,"required":false}',
	image_capabilities: JSON.stringify({
		provider_slug: "openai",
		provider_tag: "image-fast",
		supports_streaming: false,
		allowed_passthrough_parameters: ["seed"],
		supported_parameters: { seed: { type: "range", min: 0, max: 100 } },
		pricing: [{ billable: "output_image", unit: "image", cost_usd: "0.04" }],
	}),
	evidence_url: "https://evidence.example/endpoint",
	verified_by: "operator",
	verified_at: "2026-08-01T00:00:00.000Z",
	expires_at: "2027-08-01T00:00:00.000Z",
	status: "verified",
	created_at: "2026-08-01T00:00:00.000Z",
	updated_at: "2026-08-01T00:00:00.000Z",
};

function gatewayKey(): ResolvedGatewayKeyRow {
	return {
		id: "key-1",
		key: "sk-test",
		user_id: "user-1",
		workspace_id: "workspace-1",
		name: "Test",
		status: "active",
		metadata: null,
		last_used_at: null,
		created_at: "2026-08-30T00:00:00.000Z",
		updated_at: "2026-08-30T00:00:00.000Z",
		user_email: "user@example.com",
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: 1,
		budget_base: 1,
		budget_spent: 1,
		budget_period: "none",
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
	};
}

async function testRepositories(): Promise<GatewayRepositories> {
	const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
		ROUTE,
		PROVIDER
	);
	const policy: RouteDataPolicyRow = {
		route_target_id: ROUTE.id,
		subject_fingerprint: fingerprint,
		retention_days: 0,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: "https://policy.example/evidence",
		verified_by: "operator",
		verified_at: "2026-08-01T00:00:00.000Z",
		expires_at: "2027-08-01T00:00:00.000Z",
		status: "verified",
		invalidated_at: null,
		invalidation_reason: null,
		updated_at: "2026-08-01T00:00:00.000Z",
	};
	return {
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === MANAGEMENT_SECRET ? MANAGEMENT_ROW : null,
		},
		apiKeys: {
			getApiKeyWithUserByKey: async (key: string) =>
				key === "sk-test" ? gatewayKey() : null,
		},
		modelRouting: {
			getModelById: async (id: string) => (id === MODEL.id ? MODEL : null),
			listModelsWithActiveRoutes: async () => [MODEL],
		},
		routes: {
			listModelRoutesWithJoins: async (filters: { modelId?: string }) =>
				filters.modelId && filters.modelId !== MODEL.id ? [] : [ROUTE],
		},
		providers: {
			getProviderById: async (id: string) =>
				id === PROVIDER.id ? PROVIDER : null,
			getProvidersByIds: async (ids: string[]) =>
				ids.includes(PROVIDER.id) ? [PROVIDER] : [],
		},
		modelEndpoints: {
			list: async () => [ENDPOINT],
			listByModelId: async () => [ENDPOINT],
			listRouteLinks: async () => [
				{
					endpoint_id: ENDPOINT.id,
					route_target_id: ROUTE.id,
					subject_fingerprint: fingerprint,
					created_at: ENDPOINT.created_at,
				},
			],
			listDiscoveryRouteBindings: async () => [
				discoveryRouteBinding(fingerprint),
			],
		},
		routeDataPolicies: {
			getByRouteTargetIds: async (ids: string[]) =>
				ids.includes(ROUTE.id) ? [policy] : [],
		},
		requestLogs: {
			getRecentRoutePerformanceSamples: async () => [],
			getRouteAvailabilityAggregates: async () => [],
		},
	} as GatewayRepositories;
}

describe("OpenRouter endpoint routes", () => {
	it("requires a Management key for canonical endpoints while preserving Gateway-key aliases", async () => {
		const repositories = await testRepositories();
		const app = createProxyApp(
			async () => ({ repositories } as StorageContext)
		);
		const unauthenticatedCanonical = await app.request(
			"/api/v1/models/openai/model-one/endpoints",
			{},
			{ REQUEST_BODY_LOGGING: "off" }
		);
		assert.equal(unauthenticatedCanonical.status, 401);
		for (const invalidSecret of [
			"not-a-real-key",
			`sk-cina-mgmt-${"b".repeat(64)}`,
		]) {
			const invalidCanonical = await app.request(
				"/api/v1/models/openai/model-one/endpoints",
				{ headers: { Authorization: `Bearer ${invalidSecret}` } },
				{ REQUEST_BODY_LOGGING: "off" }
			);
			assert.equal(invalidCanonical.status, 401);
			assert.equal(
				invalidCanonical.headers.get("x-octafuse-error-code"),
				GatewayErrorCode.authFailed
			);
		}

		const ordinaryCanonical = await app.request(
			"/api/v1/models/openai/model-one/endpoints",
			{ headers: { Authorization: "Bearer sk-test" } },
			{ REQUEST_BODY_LOGGING: "off" }
		);
		assert.equal(ordinaryCanonical.status, 403);
		assert.equal(
			ordinaryCanonical.headers.get("x-octafuse-error-code"),
			GatewayErrorCode.permissionDenied
		);
		assert.equal(
			((await ordinaryCanonical.json()) as { error: { message: string } }).error.message,
			"Only management keys can perform this operation"
		);

		const canonical = await app.request(
			"/api/v1/models/openai/model-one/endpoints",
			{ headers: { Authorization: `Bearer ${MANAGEMENT_SECRET}` } },
			{ REQUEST_BODY_LOGGING: "off" }
		);
		assert.equal(canonical.status, 200);
		assert.equal(canonical.headers.get("cache-control"), "private, no-store");
		assert.ok(((await canonical.json()) as { data: unknown }).data);

		const paths = [
			"/v1/models/openai/model-one/endpoints",
			"/v1/endpoints/zdr",
			"/api/v1/endpoints/zdr",
			"/v1/images/models",
			"/api/v1/images/models",
		];
		for (const path of paths) {
			const unauthenticated = await app.request(
				path,
				{},
				{ REQUEST_BODY_LOGGING: "off" }
			);
			assert.equal(
				unauthenticated.status,
				401,
				`${path} must require a bearer key`
			);
			const response = await app.request(
				path,
				{
					headers: { Authorization: "Bearer sk-test" },
				},
				{ REQUEST_BODY_LOGGING: "off" }
			);
			assert.equal(
				response.status,
				200,
				`${path} must remain readable after budget exhaustion`
			);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			const body = (await response.json()) as { data: unknown };
			assert.ok(body.data);
		}
		for (const path of [
			"/v1/images/models/openai/model-one/endpoints",
			"/api/v1/images/models/openai/model-one/endpoints",
		]) {
			const response = await app.request(
				path,
				{ headers: { Authorization: "Bearer sk-test" } },
				{ REQUEST_BODY_LOGGING: "off" }
			);
			assert.equal(response.status, 200, path);
			const body = (await response.json()) as Record<string, unknown>;
			assert.deepEqual(Object.keys(body).sort(), ["endpoints", "id"]);
			assert.equal(body.id, "openai/model-one");
			assert.equal("data" in body, false);
		}
	});

	it("returns an OpenRouter-style 404 without leaking inactive model details", async () => {
		const repositories = await testRepositories();
		const app = createProxyApp(
			async () => ({ repositories } as StorageContext)
		);
		const response = await app.request(
			"/api/v1/models/openai/missing/endpoints",
			{ headers: { Authorization: `Bearer ${MANAGEMENT_SECRET}` } },
			{ REQUEST_BODY_LOGGING: "off" }
		);
		assert.equal(response.status, 404);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), {
			error: {
				code: 404,
				message: "Resource not found",
				metadata: { error_type: "not_found" },
			},
			code: GatewayErrorCode.modelNotFound,
		});
	});

	it("uses the unified no-store 500 envelope without exposing repository errors", async () => {
		const repositories = await testRepositories();
		repositories.modelEndpoints.listDiscoveryRouteBindings = async () => {
			throw new Error(
				"database shard db-17 at postgres://secret.example failed"
			);
		};
		const app = createProxyApp(
			async () => ({ repositories } as StorageContext)
		);

		for (const path of [
			"/api/v1/models/openai/model-one/endpoints",
			"/api/v1/endpoints/zdr",
		]) {
			const response = await app.request(
				path,
				{
					headers: {
						Authorization: path.includes("/models/")
							? `Bearer ${MANAGEMENT_SECRET}`
							: "Bearer sk-test",
					},
				},
				{ REQUEST_BODY_LOGGING: "off" }
			);
			assert.equal(response.status, 500, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			const body = await response.json();
			assert.deepEqual(body, {
				error: {
					code: 500,
					message: "Internal server error",
					metadata: { error_type: "server" },
				},
				code: GatewayErrorCode.internalError,
			});
			assert.doesNotMatch(
				JSON.stringify(body),
				/db-17|secret\.example|postgres/iu
			);
		}
	});
});

describe("endpoint discovery budget exemption", () => {
	it("is GET-only and path-exact while still requiring a valid key", async () => {
		const repositories = await testRepositories();
		const app = new Hono<Env>();
		app.use("*", async (c, next) => {
			c.set("repositories", repositories);
			await next();
		});
		app.use("*", requireApiKey);
		app.all("*", (c) => c.json({ ok: true }));
		const env = { REQUEST_BODY_LOGGING: "off" } as Env["Bindings"];

		for (const path of [
			"/v1/models/openai/model-one/endpoints",
			"/v1/endpoints/zdr",
			"/api/v1/endpoints/zdr",
		]) {
			assert.equal(
				(
					await app.request(
						path,
						{
							headers: { Authorization: "Bearer sk-test" },
						},
						env
					)
				).status,
				200,
				path
			);
			assert.equal(
				(await app.request(path, {}, env)).status,
				401,
				`${path} must still authenticate`
			);
		}

		for (const [method, path] of [
			["GET", "/api/v1/models/openai/model-one/endpoints"],
			["GET", "/v1/models/openai/model-one/endpoints/extra"],
			["GET", "/api/v1/endpoints/zdr/extra"],
			["GET", "/v1/other/models/openai/model-one/endpoints"],
			["POST", "/v1/endpoints/zdr"],
		] as const) {
			assert.equal(
				(
					await app.request(
						path,
						{
							method,
							headers: { Authorization: "Bearer sk-test" },
						},
						env
					)
				).status,
				402,
				`${method} ${path} must not bypass budget enforcement`
			);
		}
	});
});

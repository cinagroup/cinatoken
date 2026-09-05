import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	GatewayRepositories,
	ModelEndpointRow,
	ModelRouteRow,
	ProviderRow,
} from "@octafuse/core";
import { computeRouteDataPolicySubjectFingerprintFromRows } from "@octafuse/core";
import {
	resolveRouteResultsFromRows,
	resolveRoutesForSurface,
	routeMatchesSurface,
} from "./model-router";

const provider: ProviderRow = {
	id: "provider-a",
	name: "Provider A",
	endpoints: '{"openai":{"base":"https://provider.test/v1"}}',
	api_key: "secret",
	status: "active",
	description: null,
	created_at: "2026-01-01T00:00:00.000Z",
};

function route(id: string, routingMetadata: string | null = null): ModelRouteRow {
	return {
		id,
		model_id: "model-a",
		provider_id: provider.id,
		provider_model_name: "private-model-a",
		priority: 10,
		status: "active",
		route_group: "default",
		weight: 1,
		price_override: null,
		custom_params: null,
		upstream_protocol: "openai",
		upstream_operation: "chat",
		adapter: "passthrough",
		routing_metadata: routingMetadata,
	};
}

function endpointRow(overrides: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return {
		id: "endpoint-a",
		model_id: "model-a",
		provider_id: provider.id,
		provider_slug: "provider-a",
		tag: "provider-a",
		endpoint_class: null,
		region: null,
		context_length: 8_192,
		max_prompt_tokens: 6_144,
		max_completion_tokens: 2_048,
		quantization: null,
		supported_parameters: '["tools"]',
		pricing: '{"currency":"USD","prompt":"0.000001","completion":"0.000002","request":"0.01"}',
		supports_implicit_caching: false,
		supports_voice_cloning: false,
		supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
		image_capabilities: '{}',
		evidence_url: "https://provider.test/evidence",
		verified_by: "test",
		verified_at: "2026-01-01T00:00:00.000Z",
		expires_at: "2099-01-01T00:00:00.000Z",
		status: "verified",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function imageEndpointRow(
	overrides: Partial<ModelEndpointRow> = {}
): ModelEndpointRow {
	return endpointRow({
		context_length: null,
		max_prompt_tokens: null,
		max_completion_tokens: null,
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: JSON.stringify({
			provider_slug: "provider-a",
			provider_tag: "fast",
			supports_streaming: false,
			supported_parameters: {},
			allowed_passthrough_parameters: [],
			pricing: [
				{ billable: "output_image", unit: "image", cost_usd: "0.04" },
			],
		}),
		...overrides,
	});
}

describe("routeMatchesSurface", () => {
	it("accepts the declared DashScope ASR adapter for an OpenAI surface", () => {
		assert.equal(
			routeMatchesSurface(
				{
					adapter: "dashscope-asr-qwen-file",
					upstreamProtocol: "dashscope",
					upstreamOperation: "audio.transcriptions.multimodal",
				},
				{ protocol: "openai", operation: "audio.transcriptions" }
			),
			true
		);
		assert.equal(
			routeMatchesSurface(
				{
					adapter: "dashscope-asr-qwen-audio-file",
					upstreamProtocol: "dashscope",
					upstreamOperation: "audio.transcriptions.multimodal",
				},
				{ protocol: "openai", operation: "audio.transcriptions" }
			),
			true
		);
	});

	it("rejects a cross-protocol passthrough target", () => {
		assert.equal(
			routeMatchesSurface(
				{
					adapter: "passthrough",
					upstreamProtocol: "dashscope",
					upstreamOperation: "audio.transcriptions.multimodal",
				},
				{ protocol: "openai", operation: "audio.transcriptions" }
			),
			false
		);
	});
});

describe("verified endpoint runtime loading", () => {
	it("batch-loads providers and bindings once and attaches only current snapshots", async () => {
		const valid = route("route-valid", '{"max_completion_tokens":2048}');
		const stale = route("route-stale");
		const validSubject = await computeRouteDataPolicySubjectFingerprintFromRows(valid, provider);
		const calls: string[] = [];
		const repos = {
			modelEndpoints: {
				listRuntimeBindingsByRouteTargetIds: async (ids: string[]) => {
					calls.push(`bindings:${ids.join(",")}`);
					return [
						{ ...endpointRow(), route_target_id: valid.id, subject_fingerprint: validSubject },
						{ ...endpointRow({ id: "endpoint-stale" }), route_target_id: stale.id, subject_fingerprint: "0".repeat(64) },
					];
				},
			} as GatewayRepositories["modelEndpoints"],
			providers: {
				getProvidersByIds: async (ids: string[]) => {
					calls.push(`providers:${ids.join(",")}`);
					return [provider];
				},
			} as GatewayRepositories["providers"],
		} as GatewayRepositories;

		const result = await resolveRouteResultsFromRows(repos, [valid, stale]);
		assert.deepEqual(calls.sort(), ["bindings:route-valid,route-stale", "providers:provider-a"]);
		assert.deepEqual(result.map((item) => item.targetId), [valid.id]);
		assert.equal(result[0]?.endpoint?.id, "endpoint-a");
		assert.equal(result[0]?.endpoint?.maxCompletionTokens, 2_048);
	});

	it("fails closed at surface resolution when endpoint facts do not match the effective operation", async () => {
		const cases: Array<{
			name: string;
			operation: "chat" | "images.generations";
			endpoint: ModelEndpointRow;
			expectedRoutes: number;
		}> = [
			{
				name: "text facts serve chat",
				operation: "chat",
				endpoint: endpointRow(),
				expectedRoutes: 1,
			},
			{
				name: "image facts cannot serve chat",
				operation: "chat",
				endpoint: imageEndpointRow(),
				expectedRoutes: 0,
			},
			{
				name: "text facts cannot serve images",
				operation: "images.generations",
				endpoint: endpointRow(),
				expectedRoutes: 0,
			},
			{
				name: "image facts serve images",
				operation: "images.generations",
				endpoint: imageEndpointRow(),
				expectedRoutes: 1,
			},
		];

		for (const scenario of cases) {
			const candidate = {
				...route(`route-${scenario.operation}`),
				upstream_operation: scenario.operation,
			};
			const subject = await computeRouteDataPolicySubjectFingerprintFromRows(
				candidate,
				provider
			);
			const repos = {
				modelRouting: {
					resolveModelSurface: async () => null,
					getModelRoutesByModelId: async () => [candidate],
				},
				modelEndpoints: {
					listRuntimeBindingsByRouteTargetIds: async () => [
						{
							...scenario.endpoint,
							route_target_id: candidate.id,
							subject_fingerprint: subject,
						},
					],
				} as GatewayRepositories["modelEndpoints"],
				providers: {
					getProvidersByIds: async () => [provider],
				} as GatewayRepositories["providers"],
			} as GatewayRepositories;

			const resolved = await resolveRoutesForSurface(repos, {
				modelId: "model-a",
				routeGroup: "default",
				requestProtocol: "openai",
				requestOperation: scenario.operation,
			});
			assert.equal(
				resolved.routes.length,
				scenario.expectedRoutes,
				scenario.name
			);
		}
	});

	it("rejects endpoint identity and declared legacy metadata drift", async () => {
		const identityMismatch = route("route-identity");
		const legacyDrift = route("route-drift", '{"max_completion_tokens":4096}');
		const identitySubject = await computeRouteDataPolicySubjectFingerprintFromRows(identityMismatch, provider);
		const driftSubject = await computeRouteDataPolicySubjectFingerprintFromRows(legacyDrift, provider);
		const repos = {
			modelEndpoints: {
				listRuntimeBindingsByRouteTargetIds: async () => [
					{ ...endpointRow({ model_id: "other-model" }), route_target_id: identityMismatch.id, subject_fingerprint: identitySubject },
					{ ...endpointRow({ id: "endpoint-drift" }), route_target_id: legacyDrift.id, subject_fingerprint: driftSubject },
				],
			} as GatewayRepositories["modelEndpoints"],
			providers: { getProvidersByIds: async () => [provider] } as GatewayRepositories["providers"],
		} as GatewayRepositories;

		assert.deepEqual(await resolveRouteResultsFromRows(repos, [identityMismatch, legacyDrift]), []);
	});

	it("keeps active routes that can be credentialized by shared keys or BYOK", async () => {
		const providerCases: ProviderRow[] = [
			{ ...provider, id: "provider-shared", api_key: "", shared_channel_type: "openai" },
			{ ...provider, id: "provider-byok-only", api_key: "   " },
		];
		const rows = providerCases.map((candidate, index) => ({
			...route(`route-credentialized-${index}`),
			provider_id: candidate.id,
		}));
		const bindings = await Promise.all(rows.map(async (candidate, index) => ({
			...endpointRow({
				id: `endpoint-credentialized-${index}`,
				provider_id: candidate.provider_id,
				provider_slug: index === 0 ? "openai" : "provider-byok",
			}),
			route_target_id: candidate.id,
			subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
				candidate,
				providerCases[index]!,
			),
		})));
		const repos = {
			modelEndpoints: {
				listRuntimeBindingsByRouteTargetIds: async () => bindings,
			} as GatewayRepositories["modelEndpoints"],
			providers: {
				getProvidersByIds: async () => providerCases,
			} as GatewayRepositories["providers"],
		} as GatewayRepositories;

		const resolved = await resolveRouteResultsFromRows(repos, rows);
		assert.deepEqual(resolved.map((candidate) => candidate.targetId), rows.map((row) => row.id));
	});

	it("rejects disabled, pending-import, and protocol-incompatible providers", async () => {
		const providerCases: ProviderRow[] = [
			{ ...provider, id: "provider-disabled", status: "disabled" },
			{ ...provider, id: "provider-pending-key", api_key: "__OCTAFUSE_PENDING_PROVIDER_API_KEY__" },
			{
				...provider,
				id: "provider-wrong-protocol",
				endpoints: '{"anthropic":{"base":"https://provider.test"}}',
			},
		];
		const rows = providerCases.map((candidate, index) => ({
			...route(`route-uncallable-${index}`),
			provider_id: candidate.id,
		}));
		const bindings = await Promise.all(rows.map(async (candidate, index) => ({
			...endpointRow({
				id: `endpoint-uncallable-${index}`,
				provider_id: candidate.provider_id,
			}),
			route_target_id: candidate.id,
			subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
				candidate,
				providerCases[index]!,
			),
		})));
		const repos = {
			modelEndpoints: {
				listRuntimeBindingsByRouteTargetIds: async () => bindings,
			} as GatewayRepositories["modelEndpoints"],
			providers: {
				getProvidersByIds: async () => providerCases,
			} as GatewayRepositories["providers"],
		} as GatewayRepositories;

		assert.deepEqual(await resolveRouteResultsFromRows(repos, rows), []);
	});

	it("fails before repository I/O when a route batch exceeds the safety limit", async () => {
		const rows = Array.from({ length: 101 }, (_, index) => route(`route-${index}`));
		await assert.rejects(
			resolveRouteResultsFromRows({} as GatewayRepositories, rows),
			/100-row batch safety limit/,
		);
	});
});

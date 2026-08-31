import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type GatewayRepositories,
	type InsertUnpublishedModelEndpointParams,
	type ModelEndpointRow,
	type UpdateUnpublishedModelEndpointParams,
} from "@octafuse/core";
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { adminModelEndpointsRoutes } from "@/lib/routes/admin/model-endpoints";

function audioCapabilities(price: string) {
	return {
		v: 1,
		pricing_by_operation: {
			"audio.speech.stream": {
				currency: "USD",
				meter: {
					kind: "characters",
					unit: "unicode_code_point",
					price,
					minimum_units: 0,
					increment_units: 1,
				},
			},
		},
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
		verified_by: input.verifiedBy,
		verified_at: input.verifiedAt,
		expires_at: input.expiresAt,
		status: input.status,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	};
}

describe("admin model endpoint HTTP audio contract", () => {
	it("round-trips strict audio capabilities through create, list, get, and update", async () => {
		let stored: ModelEndpointRow | null = null;
		const requireStored = (): ModelEndpointRow => {
			const current = stored as ModelEndpointRow | null;
			if (!current) throw new Error("Expected a persisted endpoint row");
			return current;
		};
		const repositories = {
			modelRouting: {
				getModelById: async (id: string) =>
					id === "openai/audio-model" ? { id } : null,
			},
			providers: {
				getProviderById: async (id: string) =>
					id === "provider-1" ? { id, name: "Provider" } : null,
			},
			modelEndpoints: {
				insert: async (input: InsertUnpublishedModelEndpointParams) => {
					stored = rowFromInsert(input);
				},
				list: async () => (stored ? [stored] : []),
				getById: async (id: string) =>
					stored && stored.id === id ? stored : null,
				updateUnpublished: async (
					id: string,
					params: UpdateUnpublishedModelEndpointParams
				) => {
					if (!stored || stored.id !== id) return 0;
					stored = {
						...stored,
						...params.endpointPatch,
						status: params.status,
						verified_by: null,
						verified_at: null,
						updated_at: params.updatedAt,
					};
					return 1;
				},
				listRouteLinks: async () => [],
			},
		} as unknown as GatewayRepositories;
		const app = new Hono<AdminEnv>();
		app.use("*", async (c, next) => {
			c.set("repositories", repositories);
			c.set("principal", {
				type: "console",
				id: "console:admin",
				username: "admin",
			});
			await next();
		});
		app.route("/endpoints", adminModelEndpointsRoutes);

		const create = await app.request("/endpoints", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model_id: "openai/audio-model",
				provider_id: "provider-1",
				provider_slug: "provider-one",
				tag: "provider-one",
				endpoint_class: "standard",
				supported_parameters: [],
				pricing: null,
				supports_implicit_caching: null,
				supports_voice_cloning: null,
				supports_tool_choice: {
					auto: null,
					function: null,
					none: null,
					required: null,
				},
				audio_capabilities: audioCapabilities("0.00002000"),
				status: "draft",
			}),
		});
		assert.equal(create.status, 201);
		const created = (await create.json()) as {
			data: {
				id: string;
				status: string;
				audio_capabilities: ReturnType<typeof audioCapabilities>;
			};
		};
		assert.ok(created.data.id);
		assert.equal(created.data.status, "draft");
		assert.equal(
			created.data.audio_capabilities.pricing_by_operation[
				"audio.speech.stream"
			].meter.price,
			"0.00002"
		);
		assert.equal(
			JSON.parse(requireStored().audio_capabilities ?? "{}")
				.pricing_by_operation["audio.speech.stream"].meter.price,
			"0.00002"
		);

		const list = await app.request("/endpoints");
		assert.equal(list.status, 200);
		const listBody = (await list.json()) as {
			data: Array<{ audio_capabilities: ReturnType<typeof audioCapabilities> }>;
		};
		assert.equal(
			listBody.data[0]?.audio_capabilities.pricing_by_operation[
				"audio.speech.stream"
			].meter.price,
			"0.00002"
		);

		const get = await app.request(`/endpoints/${created.data.id}`);
		assert.equal(get.status, 200);
		const getBody = (await get.json()) as {
			data: { audio_capabilities: ReturnType<typeof audioCapabilities> };
		};
		assert.equal(getBody.data.audio_capabilities.v, 1);

		const update = await app.request(`/endpoints/${created.data.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				audio_capabilities: audioCapabilities("0.00003000"),
			}),
		});
		assert.equal(update.status, 200);
		const updateBody = (await update.json()) as {
			data: {
				status: string;
				audio_capabilities: ReturnType<typeof audioCapabilities>;
			};
		};
		assert.equal(updateBody.data.status, "draft");
		assert.equal(
			updateBody.data.audio_capabilities.pricing_by_operation[
				"audio.speech.stream"
			].meter.price,
			"0.00003"
		);
		assert.equal(
			JSON.parse(requireStored().audio_capabilities ?? "{}")
				.pricing_by_operation["audio.speech.stream"].meter.price,
			"0.00003"
		);

		const invalid = await app.request(`/endpoints/${created.data.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				audio_capabilities: {
					v: 1,
					pricing_by_operation: { "audio.unknown": {} },
				},
			}),
		});
		assert.equal(invalid.status, 400);
		const invalidBody = (await invalid.json()) as { message: string };
		assert.match(invalidBody.message, /unsupported key: audio\.unknown/);
	});
});

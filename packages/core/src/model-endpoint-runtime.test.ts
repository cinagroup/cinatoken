import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelEndpointRow } from "./db/model-endpoints-types";
import {
	MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT,
	modelEndpointSubjectFingerprintIsValid,
	modelEndpointSupportsOperation,
	modelEndpointTagIsValidForProvider,
	parseVerifiedModelEndpointSnapshot,
	verifiedEndpointMatchesLegacyRoutingMetadata,
} from "./model-endpoint-runtime";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function row(patch: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return {
		id: "endpoint-1",
		model_id: "author/model",
		provider_id: "provider-1",
		provider_slug: "provider-one",
		tag: "provider-one/turbo",
		endpoint_class: "standard",
		region: "us",
		context_length: 128_000,
		max_prompt_tokens: 120_000,
		max_completion_tokens: 8_000,
		quantization: "fp8",
		supported_parameters: JSON.stringify(["tools", "temperature"]),
		pricing: JSON.stringify({
			currency: "USD",
			prompt: "0.000001",
			completion: "0.000002",
			request: "0.01",
		}),
		supports_implicit_caching: 1,
		supports_voice_cloning: 0,
		supports_tool_choice: JSON.stringify({
			auto: true,
			function: true,
			none: true,
			required: false,
		}),
		image_capabilities: "{}",
		audio_capabilities: "{}",
		evidence_url: "https://evidence.example/endpoint-1",
		verified_by: "admin-1",
		verified_at: "2026-08-30T11:00:00.000Z",
		expires_at: "2026-09-30T00:00:00.000Z",
		status: "verified",
		created_at: "2026-08-30T10:00:00.000Z",
		updated_at: "2026-08-30T11:00:00.000Z",
		...patch,
	};
}

function audioOnlyRow(patch: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return row({
		context_length: null,
		max_prompt_tokens: null,
		max_completion_tokens: null,
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: "{}",
		audio_capabilities: JSON.stringify({
			v: 1,
			pricing_by_operation: {
				"audio.transcriptions": {
					currency: "USD",
					meter: {
						kind: "duration",
						unit: "second",
						price: "0.0001",
						minimum_units: 1,
						increment_units: 1,
					},
				},
				"audio.speech": {
					currency: "USD",
					meter: {
						kind: "characters",
						unit: "unicode_code_point",
						price: "0.000015",
						minimum_units: 0,
						increment_units: 1,
					},
				},
			},
		}),
		...patch,
	});
}

function imageOnlyRow(patch: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
	return row({
		context_length: null,
		max_prompt_tokens: null,
		max_completion_tokens: null,
		pricing: "{}",
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		supports_tool_choice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: JSON.stringify({
			provider_slug: "provider-one",
			provider_tag: "turbo",
			supports_streaming: false,
			supported_parameters: {},
			allowed_passthrough_parameters: [],
			pricing: [
				{ billable: "output_image", unit: "image", cost_usd: "0.04" },
			],
		}),
		...patch,
	});
}

describe("verified model endpoint runtime snapshot", () => {
	it("accepts current complete evidence and exposes exact endpoint facts", () => {
		const snapshot = parseVerifiedModelEndpointSnapshot(row(), NOW);
		assert.ok(snapshot);
		assert.equal(snapshot.selectorSlug, "provider-one/turbo");
		assert.equal(snapshot.maxCompletionTokens, 8_000);
		assert.equal(snapshot.pricing?.request, "0.01");
		assert.deepEqual(snapshot.supportedParameters, ["tools", "temperature"]);
	});

	it("binds text, image, and audio operations to their complete fact families", () => {
		const text = parseVerifiedModelEndpointSnapshot(row(), NOW);
		const image = parseVerifiedModelEndpointSnapshot(imageOnlyRow(), NOW);
		const audio = parseVerifiedModelEndpointSnapshot(audioOnlyRow(), NOW);
		const mixed = parseVerifiedModelEndpointSnapshot(
			row({ image_capabilities: imageOnlyRow().image_capabilities }),
			NOW
		);
		assert.ok(text);
		assert.ok(image);
		assert.ok(audio);
		assert.ok(mixed);

		for (const operation of [
			"chat",
			"responses",
			"embeddings",
			"messages",
			"models.generate",
		]) {
			assert.equal(modelEndpointSupportsOperation(text, operation), true);
			assert.equal(modelEndpointSupportsOperation(image, operation), false);
			assert.equal(modelEndpointSupportsOperation(audio, operation), false);
		}
		for (const operation of ["images.generations", "images.edits"]) {
			assert.equal(modelEndpointSupportsOperation(text, operation), false);
			assert.equal(modelEndpointSupportsOperation(image, operation), true);
			assert.equal(modelEndpointSupportsOperation(audio, operation), false);
		}
		assert.equal(
			modelEndpointSupportsOperation(audio, "audio.transcriptions"),
			true
		);
		assert.equal(modelEndpointSupportsOperation(audio, "audio.speech"), true);
		assert.equal(
			modelEndpointSupportsOperation(audio, "audio.transcriptions.multimodal"),
			false
		);
		assert.equal(
			modelEndpointSupportsOperation(audio, "audio.speech.realtime.session"),
			false
		);
		assert.equal(
			modelEndpointSupportsOperation(text, "audio.transcriptions"),
			false,
			"legacy verified text pricing must not authorize an audio route"
		);
		assert.equal(modelEndpointSupportsOperation(text, "*"), false);
		assert.equal(modelEndpointSupportsOperation(image, "*"), false);
		assert.equal(
			modelEndpointSupportsOperation(mixed, "*"),
			false,
			"legacy wildcard evidence without complete audio pricing must fail closed"
		);
		assert.equal(modelEndpointSupportsOperation(mixed, "future.operation"), false);
	});

	it("shares the supported-parameter limit and provider-qualified tag rule", () => {
		const atLimit = Array.from(
			{ length: MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT },
			(_, index) => `p${index}`
		);
		assert.ok(
			parseVerifiedModelEndpointSnapshot(
				row({ supported_parameters: JSON.stringify(atLimit) }),
				NOW
			)
		);
		assert.equal(
			parseVerifiedModelEndpointSnapshot(
				row({ supported_parameters: JSON.stringify([...atLimit, "overflow"]) }),
				NOW
			),
			null
		);
		assert.equal(
			modelEndpointTagIsValidForProvider(
				"provider-one/turbo",
				"provider-one"
			),
			true
		);
		assert.equal(
			modelEndpointTagIsValidForProvider(
				"another-provider/turbo",
				"provider-one"
			),
			false
		);
	});

	it("fails closed for unverified, expired, future, incomplete, or cross-provider claims", () => {
		for (const candidate of [
			row({ status: "draft" }),
			row({ expires_at: NOW.toISOString() }),
			row({ verified_at: "2026-08-31T00:00:00.000Z" }),
			row({ evidence_url: "http://evidence.example/endpoint-1" }),
			row({ pricing: "{}" }),
			row({ tag: "another-provider/turbo" }),
		]) {
			assert.equal(parseVerifiedModelEndpointSnapshot(candidate, NOW), null);
		}
	});

	it("treats legacy routing metadata as a declared-field drift gate", () => {
		const snapshot = parseVerifiedModelEndpointSnapshot(row(), NOW);
		assert.ok(snapshot);
		assert.equal(verifiedEndpointMatchesLegacyRoutingMetadata(snapshot, null), true);
		assert.equal(verifiedEndpointMatchesLegacyRoutingMetadata(snapshot, {}), true);
		assert.equal(
			verifiedEndpointMatchesLegacyRoutingMetadata(snapshot, {
				supported_parameters: ["temperature", "TOOLS"],
				quantization: "fp8",
				endpoint_slug: "provider-one/turbo",
				endpoint_class: "standard",
				region: "US",
				context_length: 128_000,
				max_prompt_tokens: 120_000,
				max_completion_tokens: 8_000,
			}),
			true,
		);
		for (const drift of [
			{ supported_parameters: ["temperature"] },
			{ quantization: "fp16" },
			{ endpoint_slug: "provider-one/other", endpoint_class: "standard" },
			{ endpoint_slug: "provider-one/turbo", endpoint_class: "service_tier" },
			{ region: "eu" },
			{ context_length: 64_000 },
			{ max_prompt_tokens: 64_000 },
			{ max_completion_tokens: 16_000 },
		]) {
			assert.equal(
				verifiedEndpointMatchesLegacyRoutingMetadata(snapshot, drift),
				false,
				JSON.stringify(drift),
			);
		}
		assert.equal(verifiedEndpointMatchesLegacyRoutingMetadata(snapshot, "{"), false);
	});

	it("accepts only canonical lowercase sha256 link subjects", () => {
		assert.equal(modelEndpointSubjectFingerprintIsValid("a".repeat(64)), true);
		assert.equal(modelEndpointSubjectFingerprintIsValid("A".repeat(64)), false);
		assert.equal(modelEndpointSubjectFingerprintIsValid("a".repeat(63)), false);
	});
});

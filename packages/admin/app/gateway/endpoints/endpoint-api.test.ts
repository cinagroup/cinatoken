import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	endpointMutationFromForm,
	endpointToForm,
	isoToLocalDateTimeInput,
	previewAudioCapabilitiesJson,
	summarizeAudioCapabilities,
} from "./endpoint-api";
import { EMPTY_ENDPOINT_FORM, type EndpointListItem } from "./types";

describe("endpoint admin form mapping", () => {
	it("builds structured endpoint pricing and preserves explicit false evidence", () => {
		const mutation = endpointMutationFromForm({
			...EMPTY_ENDPOINT_FORM,
			model_id: "openai/model",
			provider_id: "provider",
			provider_slug: "provider",
			tag: "provider",
			context_length: "128000",
			supported_parameters: "temperature, tools\ntool_choice",
			prompt_price: "0.000001",
			completion_price: "0.000002",
			pricing_extras_json:
				'{"audio":"0.000003","discount":0.25,"web_search":"0.01"}',
			implicit_caching: "false",
			voice_cloning: "unknown",
			tool_choice_auto: "true",
			tool_choice_function: "false",
			audio_capabilities_json: JSON.stringify({
				v: 1,
				pricing_by_operation: {
					"audio.transcriptions": {
						currency: "USD",
						meter: {
							kind: "duration",
							unit: "second",
							price: "0.00100",
							minimum_units: 0.5,
							increment_units: 0.25,
						},
					},
				},
			}),
		});
		assert.equal(mutation.context_length, 128000);
		assert.deepEqual(mutation.supported_parameters, [
			"temperature",
			"tools",
			"tool_choice",
		]);
		assert.deepEqual(mutation.pricing, {
			currency: "USD",
			prompt: "0.000001",
			completion: "0.000002",
			audio: "0.000003",
			discount: 0.25,
			web_search: "0.01",
		});
		assert.equal(mutation.supports_implicit_caching, false);
		assert.equal(mutation.supports_voice_cloning, null);
		assert.deepEqual(mutation.supports_tool_choice, {
			auto: true,
			function: false,
			none: null,
			required: null,
		});
		assert.deepEqual(mutation.audio_capabilities, {
			v: 1,
			pricing_by_operation: {
				"audio.transcriptions": {
					currency: "USD",
					meter: {
						kind: "duration",
						unit: "second",
						price: "0.001",
						minimum_units: 0.5,
						increment_units: 0.25,
					},
				},
			},
		});
	});

	it("strictly validates audio JSON and derives deterministic operation/meter summaries", () => {
		const valid = previewAudioCapabilitiesJson(
			JSON.stringify({
				v: 1,
				pricing_by_operation: {
					"audio.speech": {
						currency: "USD",
						meter: {
							kind: "characters",
							unit: "unicode_code_point",
							price: "0.002",
							minimum_units: 0,
							increment_units: 1,
						},
					},
					"audio.transcriptions": {
						currency: "USD",
						meter: {
							kind: "tokens",
							unit: "token",
							rates: {
								input_audio: "0.01",
								input_text: "0.02",
								output_text: "0.03",
								output_audio: "0.04",
								input_audio_cache: "0.005",
							},
							require_authoritative_breakdown: true,
						},
					},
				},
			})
		);
		assert.equal(valid.ok, true);
		if (!valid.ok) return;
		assert.deepEqual(valid.summary, [
			{
				operation: "audio.transcriptions",
				meterKind: "tokens",
				unit: "token",
			},
			{
				operation: "audio.speech",
				meterKind: "characters",
				unit: "unicode_code_point",
			},
		]);
		assert.deepEqual(
			summarizeAudioCapabilities(valid.capabilities),
			valid.summary
		);

		const invalidOperation = previewAudioCapabilitiesJson(
			'{"v":1,"pricing_by_operation":{"audio.unknown":{}}}'
		);
		assert.equal(invalidOperation.ok, false);
		if (!invalidOperation.ok) {
			assert.match(invalidOperation.message, /unsupported key: audio\.unknown/);
		}
		assert.deepEqual(previewAudioCapabilitiesJson(""), {
			ok: true,
			capabilities: null,
			summary: [],
		});
	});

	it("round-trips endpoint evidence into editable tri-state fields", () => {
		const endpoint = {
			id: "endpoint",
			model_id: "openai/model",
			provider_id: "provider",
			provider_slug: "provider",
			tag: "provider",
			endpoint_class: "standard",
			region: null,
			context_length: 128000,
			max_prompt_tokens: null,
			max_completion_tokens: 8000,
			quantization: "fp16",
			supported_parameters: ["temperature"],
			pricing: {
				currency: "USD",
				prompt: "0.1",
				completion: "0.2",
				audio_output: "0.3",
				input_cache_write_1h: "0.4",
			},
			supports_implicit_caching: false,
			supports_voice_cloning: true,
			supports_tool_choice: {
				auto: true,
				function: false,
				none: true,
				required: false,
			},
			image_capabilities: null,
			audio_capabilities: {
				v: 1,
				pricing_by_operation: {
					"audio.speech.stream": {
						currency: "USD",
						meter: {
							kind: "characters",
							unit: "unicode_code_point",
							price: "0.0001",
							minimum_units: 0,
							increment_units: 1,
						},
					},
				},
			},
			evidence_url: "https://provider.test/evidence",
			verified_by: "admin",
			verified_at: "2026-08-01T00:00:00.000Z",
			expires_at: "2026-12-01T00:00:00.000Z",
			status: "verified",
			created_at: "2026-08-01T00:00:00.000Z",
			updated_at: "2026-08-01T00:00:00.000Z",
			route_target_ids: ["route"],
		} satisfies EndpointListItem;
		const form = endpointToForm(endpoint);
		assert.equal(form.implicit_caching, "false");
		assert.equal(form.voice_cloning, "true");
		assert.equal(form.tool_choice_function, "false");
		assert.deepEqual(JSON.parse(form.pricing_extras_json), {
			audio_output: "0.3",
			input_cache_write_1h: "0.4",
		});
		assert.deepEqual(JSON.parse(form.audio_capabilities_json), {
			v: 1,
			pricing_by_operation: endpoint.audio_capabilities.pricing_by_operation,
		});
		assert.equal(
			new Date(form.expires_at).toISOString(),
			"2026-12-01T00:00:00.000Z"
		);
	});

	it("round-trips UTC expiry through a datetime-local value", () => {
		const iso = "2026-12-01T00:00:00.000Z";
		assert.equal(new Date(isoToLocalDateTimeInput(iso)).toISOString(), iso);
	});
});

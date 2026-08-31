import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	audioEndpointSupportsOperation,
	isAudioEndpointReady,
	isImageEndpointReady,
	isPublicEndpointCapabilityReady,
	normalizeAudioEndpointCapabilities,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	normalizeUsdDecimal,
	serializeImagePricingLine,
} from "./model-endpoint-catalog";

describe("endpoint catalog metadata", () => {
	it("normalizes authoritative USD text pricing without inventing optional prices", () => {
		assert.deepEqual(
			normalizeTextEndpointPricing({
				currency: "USD",
				prompt: "0.00000100",
				completion: "00.000002",
				request: "0",
				discount: 0,
			}),
			{
				currency: "USD",
				prompt: "0.000001",
				completion: "0.000002",
				request: "0",
				discount: 0,
			}
		);
		assert.equal(normalizeUsdDecimal("000"), "0");
	});

	it("rejects incomplete, ambiguous, or excessive text pricing", () => {
		assert.throws(
			() => normalizeTextEndpointPricing({ currency: "USD", prompt: "1" }),
			/completion/
		);
		assert.throws(
			() =>
				normalizeTextEndpointPricing({
					currency: "EUR",
					prompt: "1",
					completion: "1",
				}),
			/currency/
		);
		for (const prompt of ["-1", "1e-6", "unknown", "1.1234567890123456789"]) {
			assert.throws(
				() =>
					normalizeTextEndpointPricing({
						currency: "USD",
						prompt,
						completion: "1",
					}),
				/decimal/
			);
		}
		assert.throws(
			() =>
				normalizeTextEndpointPricing({
					currency: "USD",
					prompt: "1",
					completion: "1",
					overrides: [],
				}),
			/unsupported key/
		);
	});

	it("keeps false distinct from unknown and requires complete capability evidence", () => {
		const partial = normalizeEndpointCapabilities({
			implicit_caching: false,
			voice_cloning: null,
			tool_choice: { auto: true, function: false, none: null, required: false },
		});
		assert.equal(isPublicEndpointCapabilityReady(partial), false);
		assert.equal(
			isPublicEndpointCapabilityReady(
				normalizeEndpointCapabilities({
					implicit_caching: false,
					voice_cloning: false,
					tool_choice: {
						auto: true,
						function: false,
						none: true,
						required: false,
					},
				})
			),
			true
		);
		assert.throws(
			() =>
				normalizeEndpointCapabilities({
					implicit_caching: undefined,
					voice_cloning: false,
					tool_choice: {
						auto: true,
						function: false,
						none: true,
						required: false,
					},
				}),
			/implicit_caching/
		);
	});

	it("normalizes exact operation-scoped audio duration and character prices", () => {
		const audio = normalizeAudioEndpointCapabilities({
			v: 1,
			pricing_by_operation: {
				"audio.transcriptions.multimodal": {
					currency: "USD",
					meter: {
						kind: "duration",
						unit: "second",
						price: "00.0001000",
						minimum_units: 0.25,
						increment_units: 0.1,
					},
					request: "0.0100",
					discount: 0,
				},
				"audio.speech": {
					currency: "USD",
					meter: {
						kind: "characters",
						unit: "unicode_code_point",
						price: "0.00001500",
						minimum_units: 0,
						increment_units: 1,
					},
				},
			},
		});
		assert.equal(isAudioEndpointReady(audio), true);
		assert.equal(
			audio.pricing_by_operation["audio.transcriptions.multimodal"]
				?.meter.price,
			"0.0001"
		);
		assert.equal(
			audio.pricing_by_operation["audio.transcriptions.multimodal"]
				?.request,
			"0.01"
		);
		const duration = audio.pricing_by_operation[
			"audio.transcriptions.multimodal"
		]?.meter;
		assert.ok(duration?.kind === "duration");
		assert.equal(duration.minimum_units, 0.25);
		assert.equal(duration.increment_units, 0.1);
		assert.equal(audioEndpointSupportsOperation(audio, "audio.speech"), true);
		assert.equal(
			audioEndpointSupportsOperation(audio, "audio.speech.stream"),
			false
		);
	});

	it("requires complete authoritative token dimensions", () => {
		const audio = normalizeAudioEndpointCapabilities({
			v: 1,
			pricing_by_operation: {
				"audio.transcriptions": {
					currency: "USD",
					meter: {
						kind: "tokens",
						unit: "token",
						rates: {
							input_audio: "0.000006",
							input_text: "0",
							output_text: "0.00001",
							output_audio: "0",
							input_audio_cache: "0.000003",
						},
						require_authoritative_breakdown: true,
					},
				},
			},
		});
		assert.equal(
			audio.pricing_by_operation["audio.transcriptions"]?.meter.kind,
			"tokens"
		);
		assert.throws(
			() =>
				normalizeAudioEndpointCapabilities({
					v: 1,
					pricing_by_operation: {
						"audio.transcriptions": {
							currency: "USD",
							meter: {
								kind: "tokens",
								unit: "token",
								rates: {
									input_audio: "1",
									input_text: "0",
									output_text: "0",
									output_audio: "0",
								},
								require_authoritative_breakdown: true,
							},
						},
					},
				}),
			/input_audio_cache/
		);
	});

	it("rejects unknown audio operations, implicit units, and meter mismatches", () => {
		const duration = {
			currency: "USD",
			meter: {
				kind: "duration",
				unit: "second",
				price: "0.1",
				minimum_units: 0,
				increment_units: 1,
			},
		};
		for (const pricingByOperation of [
			{},
			{ "audio.future": duration },
			{ "audio.speech": duration },
			{
				"audio.transcriptions": {
					...duration,
					meter: { ...duration.meter, unit: "minute" },
				},
			},
			{
				"audio.transcriptions": {
					...duration,
					meter: { ...duration.meter, price: "1e-3" },
				},
			},
		]) {
			assert.throws(() =>
				normalizeAudioEndpointCapabilities({
					v: 1,
					pricing_by_operation: pricingByOperation,
				})
			);
		}
		assert.throws(() =>
			normalizeAudioEndpointCapabilities({
				v: 1,
				pricing_by_operation: {
					"audio.speech.realtime.session": {
						currency: "USD",
						meter: {
							kind: "characters",
							unit: "unicode_code_point",
							price: "0.1",
							minimum_units: 0,
							increment_units: 1,
						},
					},
				},
			})
		);
		for (const meter of [
			{ ...duration.meter, minimum_units: 1_000_000_001 },
			{ ...duration.meter, increment_units: 0 },
			{ ...duration.meter, increment_units: Number.POSITIVE_INFINITY },
		]) {
			assert.throws(() =>
				normalizeAudioEndpointCapabilities({
					v: 1,
					pricing_by_operation: {
						"audio.transcriptions": { currency: "USD", meter },
					},
				})
			);
		}
		for (const minimumUnits of [0.5, 1_000_000_001]) {
			assert.throws(() =>
				normalizeAudioEndpointCapabilities({
					v: 1,
					pricing_by_operation: {
						"audio.speech": {
							currency: "USD",
							meter: {
								kind: "characters",
								unit: "unicode_code_point",
								price: "0.1",
								minimum_units: minimumUnits,
								increment_units: 1,
							},
						},
					},
				})
			);
		}
	});

	it("normalizes definitive image endpoint capabilities and serializes decimal cost", () => {
		const image = normalizeImageEndpointCapabilities({
			provider_slug: "example-provider",
			provider_tag: null,
			supports_streaming: false,
			allowed_passthrough_parameters: ["seed", "safety.level"],
			supported_parameters: {
				seed: { type: "range", min: 0, max: 100 },
				format: { type: "enum", values: ["png", "webp"] },
				transparent: { type: "boolean" },
			},
			pricing: [
				{
					billable: "output_image",
					unit: "image",
					cost_usd: "0.0400",
					variant: "1024x1024",
				},
			],
		});
		assert.equal(isImageEndpointReady(image), true);
		assert.equal(image.pricing[0]?.cost_usd, "0.04");
		assert.deepEqual(serializeImagePricingLine(image.pricing[0]!), {
			billable: "output_image",
			unit: "image",
			cost_usd: 0.04,
			variant: "1024x1024",
		});
	});

	it("rejects unknown image keys, malformed descriptors, duplicate allowlists and price identities", () => {
		const valid = {
			provider_slug: "provider",
			provider_tag: "fast",
			supports_streaming: null,
			allowed_passthrough_parameters: [],
			supported_parameters: {},
			pricing: [],
		};
		assert.equal(
			isImageEndpointReady(normalizeImageEndpointCapabilities(valid)),
			false
		);
		assert.throws(
			() => normalizeImageEndpointCapabilities({ ...valid, secret: true }),
			/unsupported key/
		);
		assert.throws(
			() =>
				normalizeImageEndpointCapabilities({
					...valid,
					allowed_passthrough_parameters: ["seed", "seed"],
				}),
			/duplicate/
		);
		assert.throws(
			() =>
				normalizeImageEndpointCapabilities({
					...valid,
					supported_parameters: { size: { type: "range", min: 2, max: 1 } },
				}),
			/min <= max/
		);
		assert.throws(
			() =>
				normalizeImageEndpointCapabilities({
					...valid,
					pricing: [
						{ billable: "output_image", unit: "image", cost_usd: "1" },
						{ billable: "output_image", unit: "image", cost_usd: "2" },
					],
				}),
			/duplicate/
		);
	});

	it("refuses image costs outside the public numeric safety bound", () => {
		assert.throws(
			() =>
				serializeImagePricingLine({
					billable: "output_image",
					unit: "image",
					cost_usd: "1000000001",
				}),
			/represented safely/
		);
	});
});

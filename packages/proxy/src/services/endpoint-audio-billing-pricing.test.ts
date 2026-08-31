import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	AudioEndpointCapabilities,
	AudioOperationPricing,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import { resolveEndpointAudioPricing } from './endpoint-audio-billing-pricing';

function endpoint(
	pricingByOperation: AudioEndpointCapabilities['pricing_by_operation'],
	patch: Partial<VerifiedModelEndpointSnapshot> = {},
): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-audio-1',
		modelId: 'author/audio-model',
		providerId: 'provider-audio-1',
		providerSlug: 'provider',
		selectorSlug: 'provider',
		endpointClass: 'standard',
		region: null,
		contextLength: null,
		maxPromptTokens: null,
		maxCompletionTokens: null,
		quantization: null,
		supportedParameters: [],
		pricing: null,
		capabilities: {
			implicit_caching: null,
			voice_cloning: null,
			tool_choice: { auto: null, function: null, none: null, required: null },
		},
		imageCapabilities: null,
		audioCapabilities: { v: 1, pricing_by_operation: pricingByOperation },
		evidenceUrl: 'https://evidence.example/endpoint-audio-1',
		verifiedBy: 'auditor-audio-1',
		verifiedAt: '2026-08-30T00:00:00.000Z',
		expiresAt: '2027-08-30T00:00:00.000Z',
		...patch,
	};
}

function durationPricing(
	patch: Partial<AudioOperationPricing> = {},
): AudioOperationPricing {
	return {
		currency: 'USD',
		meter: {
			kind: 'duration',
			unit: 'second',
			price: '0.08',
			minimum_units: 0,
			increment_units: 1,
		},
		...patch,
	};
}

function characterPricing(
	patch: Partial<AudioOperationPricing> = {},
): AudioOperationPricing {
	return {
		currency: 'USD',
		meter: {
			kind: 'characters',
			unit: 'unicode_code_point',
			price: '0.002',
			minimum_units: 0,
			increment_units: 1,
		},
		...patch,
	};
}

describe('verified endpoint audio billing pricing', () => {
	it('rounds a fractional duration above the minimum to the next increment', () => {
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions': durationPricing({
				meter: {
					kind: 'duration',
					unit: 'second',
					price: '0.08',
					minimum_units: 1.5,
					increment_units: 0.25,
				},
			}),
		}), 'audio.transcriptions', { durationSeconds: 1.61 });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.actualUnits, 1.61);
		assert.equal(result.value.billableUnits, 1.75);
		assert.equal(result.value.standardUnitPrice, 0.08);
		assert.equal(result.value.standardMeterCost, 0.14);
		assert.equal(result.value.standardBaseCost, 0.14);
		assert.equal(result.value.chargedBaseCost, 0.14);
		assert.deepEqual(result.value.audit, {
			source: 'verified_model_endpoint',
			endpoint_id: 'endpoint-audio-1',
			model_id: 'author/audio-model',
			provider_id: 'provider-audio-1',
			evidence_url: 'https://evidence.example/endpoint-audio-1',
			verified_by: 'auditor-audio-1',
			verified_at: '2026-08-30T00:00:00.000Z',
			expires_at: '2027-08-30T00:00:00.000Z',
			currency: 'USD',
			operation: 'audio.transcriptions',
			meter: 'duration',
			unit: 'second',
			unit_price: 0.08,
			minimum_units: 1.5,
			increment_units: 0.25,
			request_fee: 0,
			discount: 0,
		});

		const strictCeiling = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions': durationPricing({
				meter: {
					kind: 'duration',
					unit: 'second',
					price: '0',
					minimum_units: 0,
					increment_units: 0.01,
				},
			}),
		}), 'audio.transcriptions', { durationSeconds: 0.07000000000000002 });
		assert.equal(strictCeiling.ok, true);
		if (strictCeiling.ok) {
			assert.equal(strictCeiling.value.billableUnits, 0.08);
		}
	});

	it('meters speech by Unicode code points rather than UTF-16 code units', () => {
		const text = 'A😀e\u0301';
		assert.equal(text.length, 5);
		assert.equal(Array.from(text).length, 4);
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.speech': characterPricing({
				meter: {
					kind: 'characters',
					unit: 'unicode_code_point',
					price: '0.002',
					minimum_units: 5,
					increment_units: 3,
				},
			}),
		}), 'audio.speech', { unicodeCodePoints: Array.from(text).length });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.meterKind, 'characters');
		assert.equal(result.value.unit, 'unicode_code_point');
		assert.equal(result.value.actualUnits, 4);
		assert.equal(result.value.billableUnits, 6);
		assert.equal(result.value.standardBaseCost, 0.012);
	});

	it('adds the request fee before applying the verified endpoint discount', () => {
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions.async': durationPricing({
				meter: {
					kind: 'duration',
					unit: 'second',
					price: '0.1',
					minimum_units: 0,
					increment_units: 1,
				},
				request: '0.25',
				discount: 0.2,
			}),
		}), 'audio.transcriptions.async', { durationSeconds: 10 });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.standardMeterCost, 1);
		assert.equal(result.value.standardRequestFee, 0.25);
		assert.equal(result.value.standardBaseCost, 1.25);
		assert.equal(result.value.discount, 0.2);
		assert.equal(result.value.chargedMeterCost, 0.8);
		assert.equal(result.value.chargedRequestFee, 0.2);
		assert.equal(result.value.chargedBaseCost, 1);
	});

	it('accepts explicit zero usage, unit price, request fee, and discount', () => {
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.speech.stream': characterPricing({
				meter: {
					kind: 'characters',
					unit: 'unicode_code_point',
					price: '0.0000',
					minimum_units: 0,
					increment_units: 1,
				},
				request: '0',
				discount: 0,
			}),
		}), 'audio.speech.stream', { unicodeCodePoints: 0 });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.actualUnits, 0);
		assert.equal(result.value.billableUnits, 0);
		assert.equal(result.value.standardUnitPrice, 0);
		assert.equal(result.value.standardRequestFee, 0);
		assert.equal(result.value.standardBaseCost, 0);
		assert.equal(result.value.chargedBaseCost, 0);
	});

	it('requires an exact operation and never borrows another operation tariff', () => {
		const priced = endpoint({ 'audio.speech': characterPricing() });
		const missingInput = resolveEndpointAudioPricing(
			priced,
			undefined,
			{ unicodeCodePoints: 4 },
		);
		assert.equal(missingInput.ok, false);
		if (!missingInput.ok) {
			assert.equal(missingInput.reason, 'invalid_audio_pricing_operation');
		}

		const mismatch = resolveEndpointAudioPricing(
			priced,
			'audio.transcriptions',
			{ durationSeconds: 4 },
		);
		assert.equal(mismatch.ok, false);
		if (!mismatch.ok) {
			assert.equal(mismatch.reason, 'missing_verified_endpoint_audio_pricing');
		}
	});

	it('rejects facts for the wrong meter and malformed operation-meter pairs', () => {
		const wrongFacts = resolveEndpointAudioPricing(endpoint({
			'audio.speech': characterPricing(),
		}), 'audio.speech', { durationSeconds: 1 });
		assert.equal(wrongFacts.ok, false);
		if (!wrongFacts.ok) {
			assert.equal(wrongFacts.reason, 'invalid_audio_pricing_facts');
		}

		const malformed = durationPricing() as AudioOperationPricing;
		const wrongMeter = resolveEndpointAudioPricing(endpoint({
			'audio.speech': malformed,
		}), 'audio.speech', { durationSeconds: 1 });
		assert.equal(wrongMeter.ok, false);
		if (!wrongMeter.ok) {
			assert.equal(wrongMeter.reason, 'invalid_endpoint_audio_pricing');
		}
	});

	it('rejects token pricing until authoritative component usage exists', () => {
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions': {
				currency: 'USD',
				meter: {
					kind: 'tokens',
					unit: 'token',
					rates: {
						input_audio: '0.001',
						input_text: '0.002',
						output_text: '0.003',
						output_audio: '0.004',
						input_audio_cache: '0.0001',
					},
					require_authoritative_breakdown: true,
				},
			},
		}), 'audio.transcriptions', { durationSeconds: 1 });

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, 'unsupported_endpoint_audio_pricing_meter');
		}
	});

	it('rejects non-finite or negative facts and incomplete endpoint identity', () => {
		const priced = endpoint({ 'audio.transcriptions': durationPricing() });
		for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			const invalid = resolveEndpointAudioPricing(
				priced,
				'audio.transcriptions',
				{ durationSeconds },
			);
			assert.equal(invalid.ok, false);
			if (!invalid.ok) {
				assert.equal(invalid.reason, 'invalid_audio_pricing_facts');
			}
		}
		const identity = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions': durationPricing(),
		}, { verifiedBy: '' }), 'audio.transcriptions', { durationSeconds: 1 });
		assert.equal(identity.ok, false);
		if (!identity.ok) {
			assert.equal(identity.reason, 'invalid_endpoint_audio_pricing');
		}
	});

	it('fails closed when meter arithmetic exceeds the safe billing range', () => {
		const result = resolveEndpointAudioPricing(endpoint({
			'audio.transcriptions': durationPricing({
				meter: {
					kind: 'duration',
					unit: 'second',
					price: '9000000000000000',
					minimum_units: 0,
					increment_units: 1,
				},
			}),
		}), 'audio.transcriptions', { durationSeconds: 2 });

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, 'endpoint_audio_pricing_overflow');
		}
	});
});

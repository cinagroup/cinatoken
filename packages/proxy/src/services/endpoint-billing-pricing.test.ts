import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VerifiedModelEndpointSnapshot } from '@octafuse/core';
import {
	resolveEndpointTextPricing,
	routeUsesUnsupportedMultimediaEndpointPriceSelection,
} from './endpoint-billing-pricing';

function endpoint(): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-1', modelId: 'openai/model', providerId: 'provider-1',
		providerSlug: 'provider', selectorSlug: 'provider', endpointClass: 'standard', region: null,
		contextLength: 128_000, maxPromptTokens: null, maxCompletionTokens: 8_192,
		quantization: null, supportedParameters: [],
		pricing: {
			currency: 'USD', prompt: '0.000001', completion: '0.000002',
			input_cache_read: '0.0000002', input_cache_write: '0.0000012',
			input_cache_write_1h: '0.0000015', request: '0.1', discount: 0.25,
		},
		capabilities: {
			implicit_caching: true, voice_cloning: false,
			tool_choice: { auto: true, function: true, none: true, required: true },
		},
		imageCapabilities: null,
		evidenceUrl: 'https://evidence.example/endpoint-1', verifiedBy: 'auditor',
		verifiedAt: '2026-08-29T00:00:00.000Z', expiresAt: '2027-08-29T00:00:00.000Z',
	};
}

describe('verified endpoint billing pricing', () => {
	it('materializes the exact discounted token/request tariff and pins evidence identity', () => {
		const result = resolveEndpointTextPricing(endpoint());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.standardPrices.input_price, 1);
		assert.equal(result.value.standardPrices.output_price, 2);
		assert.ok(Math.abs(result.value.standardPrices.cache_read_price! - 0.2) < 1e-12);
		assert.equal(result.value.standardPrices.cache_write_price, 1.5);
		assert.equal(result.value.chargedPrices.input_price, 0.75);
		assert.equal(result.value.chargedPrices.output_price, 1.5);
		assert.ok(Math.abs(result.value.chargedPrices.cache_read_price! - 0.15) < 1e-12);
		assert.equal(result.value.chargedPrices.cache_write_price, 1.125);
		assert.equal(result.value.standardRequestCost, 0.1);
		assert.equal(result.value.chargedRequestCost, 0.07500000000000001);
		assert.equal(result.value.audit.endpoint_id, 'endpoint-1');
		assert.equal(result.value.audit.evidence_url, 'https://evidence.example/endpoint-1');
		assert.equal(result.value.audit.verified_at, '2026-08-29T00:00:00.000Z');
		assert.equal(result.value.audit.expires_at, '2027-08-29T00:00:00.000Z');
	});

	it('does not silently ignore a positive dimension absent from the text usage ledger', () => {
		const value = endpoint();
		value.pricing = { ...value.pricing!, internal_reasoning: '0.000003' };
		const result = resolveEndpointTextPricing(value);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'unsupported_endpoint_pricing_dimension');
	});

	it('keeps image/audio out of endpoint price caps and price ordering before settlement cutover', () => {
		const trace = {
			configured_target_ids: [], eligible_target_ids: [], partition: 'model' as const,
			global_endpoint_rank: null, require_parameters: false,
			data_collection: 'allow' as const, zdr: false, quantizations: null,
		};
		assert.equal(routeUsesUnsupportedMultimediaEndpointPriceSelection({
			providerRoutingTrace: { ...trace, sort: null, max_price: { image: 0.1 } },
		}), true);
		assert.equal(routeUsesUnsupportedMultimediaEndpointPriceSelection({
			providerRoutingTrace: { ...trace, sort: 'price', max_price: null },
		}), true);
		assert.equal(routeUsesUnsupportedMultimediaEndpointPriceSelection({
			providerRoutingTrace: undefined,
		}), false);
	});
});

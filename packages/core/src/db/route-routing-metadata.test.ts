import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	normalizeRouteRoutingMetadataInput,
	parseRouteRoutingMetadata,
} from './route-routing-metadata';

describe('route routing metadata', () => {
	it('normalizes endpoint capabilities without upstream defaults', () => {
		assert.equal(
			normalizeRouteRoutingMetadataInput({
				supported_parameters: ['tools', 'response_format', 'TOOLS'],
				quantization: 'FP8',
				endpoint_slug: 'OpenAI/Turbo-V2',
				endpoint_class: 'standard',
				region: 'US-East',
				context_length: 128_000,
				max_prompt_tokens: 120_000,
				max_completion_tokens: 16_384,
			}),
			JSON.stringify({
				supported_parameters: ['tools', 'response_format'],
				quantization: 'fp8',
				endpoint_slug: 'openai/turbo-v2',
				endpoint_class: 'standard',
				region: 'us-east',
				context_length: 128_000,
				max_prompt_tokens: 120_000,
				max_completion_tokens: 16_384,
			}),
		);
	});

	it('rejects unknown keys and unsupported quantization on writes', () => {
		assert.throws(() => normalizeRouteRoutingMetadataInput({ secret: true }), /unsupported key/);
		assert.throws(() => normalizeRouteRoutingMetadataInput({ quantization: 'q4_k_m' }), /must be one of/);
		assert.throws(() => normalizeRouteRoutingMetadataInput({ endpoint_slug: 'openai//turbo' }), /public endpoint slug/);
		assert.throws(() => normalizeRouteRoutingMetadataInput({ endpoint_slug: 'openai/turbo?' }), /public endpoint slug/);
		assert.throws(() => normalizeRouteRoutingMetadataInput({ endpoint_slug: 'openai/turbo' }), /endpoint_class is required/);
		assert.throws(
			() => normalizeRouteRoutingMetadataInput({ endpoint_slug: 'openai', endpoint_class: 'service_tier' }),
			/service_tier requires a slash-variant/,
		);
		for (const value of [0, -1, 1.5, '4096', Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(
				() => normalizeRouteRoutingMetadataInput({ max_completion_tokens: value }),
				/positive safe integer/,
			);
		}
	});

	it('keeps unclassified stored variants exact-matchable while withholding base-match classification', () => {
		assert.deepEqual(parseRouteRoutingMetadata({ endpoint_slug: 'openai/fast' }), {
			supported_parameters: [],
			quantization: null,
			endpoint_slug: 'openai/fast',
			endpoint_class: null,
			region: null,
			context_length: null,
			max_prompt_tokens: null,
			max_completion_tokens: null,
		});
	});

	it('fails closed for malformed stored metadata', () => {
		assert.equal(parseRouteRoutingMetadata('{not-json'), null);
		assert.equal(parseRouteRoutingMetadata({ supported_parameters: [''] }), null);
		assert.equal(parseRouteRoutingMetadata({ max_completion_tokens: 0 }), null);
	});
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	ImageEndpointPricingLine,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import { resolveEndpointImagePricing } from './endpoint-image-billing-pricing';

function endpoint(
	pricing: ImageEndpointPricingLine[],
	patch: Partial<VerifiedModelEndpointSnapshot> = {},
): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-1',
		modelId: 'author/image-model',
		providerId: 'provider-1',
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
		imageCapabilities: {
			provider_slug: 'provider',
			provider_tag: null,
			supports_streaming: false,
			supported_parameters: {},
			allowed_passthrough_parameters: [],
			pricing,
		},
		evidenceUrl: 'https://evidence.example/endpoint-1',
		verifiedBy: 'auditor-1',
		verifiedAt: '2026-08-30T00:00:00.000Z',
		expiresAt: '2027-08-30T00:00:00.000Z',
		...patch,
	};
}

const facts = {
	operation: 'images.generations' as const,
	imageCount: 3,
	referenceCount: 2,
};

describe('verified endpoint image billing pricing', () => {
	it('resolves output, one semantic input-image dimension, and a conditional request charge', () => {
		const result = resolveEndpointImagePricing(endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
			{ billable: 'input_image', unit: 'image', cost_usd: '0.01' },
			{ billable: 'input_reference', unit: 'request', cost_usd: '0.005' },
		]), facts);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.standardOutputUnitCost, 0.04);
		assert.equal(result.value.standardOutputComponentCost, 0.12);
		assert.equal(result.value.standardInputComponentCost, 0.02);
		assert.equal(result.value.standardFixedRequestCost, 0.005);
		assert.equal(result.value.standardBaseCost, 0.145);
		assert.deepEqual(result.value.selectedLines.map((line) => ({
			billable: line.billable,
			unit: line.unit,
			quantity: line.quantity,
		})), [
			{ billable: 'output_image', unit: 'image', quantity: 3 },
			{ billable: 'input_image', unit: 'image', quantity: 2 },
			{ billable: 'input_reference', unit: 'request', quantity: 1 },
		]);
		assert.deepEqual(result.value.audit, {
			source: 'verified_model_endpoint',
			endpoint_id: 'endpoint-1',
			model_id: 'author/image-model',
			provider_id: 'provider-1',
			evidence_url: 'https://evidence.example/endpoint-1',
			verified_by: 'auditor-1',
			verified_at: '2026-08-30T00:00:00.000Z',
			expires_at: '2027-08-30T00:00:00.000Z',
			currency: 'USD',
		});
	});

	it('accepts input_reference/image as the alternative per-reference dimension', () => {
		const result = resolveEndpointImagePricing(endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.05' },
			{ billable: 'input_reference', unit: 'image', cost_usd: '0.2' },
		]), { ...facts, operation: 'images.edits' });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.standardBaseCost, 0.55);
		assert.equal(result.value.selectedLines[1]?.billable, 'input_reference');
	});

	it('charges input_reference/request once only when references are present', () => {
		const priced = endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
			{ billable: 'input_reference', unit: 'request', cost_usd: '0.01' },
		]);
		const withoutReferences = resolveEndpointImagePricing(priced, {
			...facts,
			referenceCount: 0,
		});
		assert.equal(withoutReferences.ok, true);
		if (withoutReferences.ok) {
			assert.equal(withoutReferences.value.standardFixedRequestCost, 0);
			assert.equal(withoutReferences.value.selectedLines[1]?.quantity, 0);
		}
		const withReferences = resolveEndpointImagePricing(priced, facts);
		assert.equal(withReferences.ok, true);
		if (withReferences.ok) {
			assert.equal(withReferences.value.standardFixedRequestCost, 0.01);
			assert.equal(withReferences.value.selectedLines[1]?.quantity, 1);
		}
	});

	it('distinguishes an explicit free output from missing pricing', () => {
		const free = resolveEndpointImagePricing(endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.0000' },
		]), facts);
		assert.equal(free.ok, true);
		if (free.ok) {
			assert.equal(free.value.standardBaseCost, 0);
			assert.equal(free.value.standardOutputUnitCost, 0);
		}

		for (const missing of [
			null,
			endpoint([], {}),
			endpoint([], { imageCapabilities: null }),
		]) {
			const result = resolveEndpointImagePricing(missing, facts);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, 'missing_verified_endpoint_image_pricing');
			}
		}
	});

	it('rejects every variant because no request selector is verified yet', () => {
		for (const variant of ['1k', 'low_1k', 'high_resolution']) {
			const result = resolveEndpointImagePricing(endpoint([
				{ billable: 'output_image', unit: 'image', cost_usd: '0', variant },
			]), facts);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, 'unsupported_endpoint_image_pricing_dimension');
			}
		}
	});

	it('rejects token, megapixel, input_font, and unsupported billable/unit pairs even at zero', () => {
		const unsupported: ImageEndpointPricingLine[] = [
			{ billable: 'output_image', unit: 'token', cost_usd: '0' },
			{ billable: 'output_image', unit: 'megapixel', cost_usd: '0' },
			{ billable: 'input_font', unit: 'image', cost_usd: '0' },
			{ billable: 'output_image', unit: 'request', cost_usd: '0' },
			{ billable: 'input_image', unit: 'request', cost_usd: '0' },
			{ billable: 'input_text', unit: 'token', cost_usd: '0' },
		];
		for (const line of unsupported) {
			const result = resolveEndpointImagePricing(endpoint([
				{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				line,
			]), facts);
			assert.equal(result.ok, false, `${line.billable}/${line.unit}`);
			if (!result.ok) {
				assert.equal(result.reason, 'unsupported_endpoint_image_pricing_dimension');
			}
		}
	});

	it('rejects duplicate exact and duplicate semantic input dimensions', () => {
		const cases: ImageEndpointPricingLine[][] = [
			[
				{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				{ billable: 'output_image', unit: 'image', cost_usd: '0.05' },
			],
			[
				{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				{ billable: 'input_image', unit: 'image', cost_usd: '0.01' },
				{ billable: 'input_reference', unit: 'image', cost_usd: '0.02' },
			],
			[
				{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				{ billable: 'input_reference', unit: 'request', cost_usd: '0.01' },
				{ billable: 'input_reference', unit: 'request', cost_usd: '0.02' },
			],
		];
		for (const pricing of cases) {
			const result = resolveEndpointImagePricing(endpoint(pricing), facts);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, 'ambiguous_endpoint_image_pricing');
			}
		}
	});

	it('rejects malformed prices and incomplete verification identity', () => {
		for (const cost_usd of ['-1', '1e-3', '1000000001']) {
			const result = resolveEndpointImagePricing(endpoint([
				{ billable: 'output_image', unit: 'image', cost_usd },
			]), facts);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.reason, 'invalid_endpoint_image_pricing');
		}
		const identity = resolveEndpointImagePricing(endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
		], { verifiedBy: '' }), facts);
		assert.equal(identity.ok, false);
		if (!identity.ok) assert.equal(identity.reason, 'invalid_endpoint_image_pricing');
	});

	it('rejects invalid counts and arithmetic overflow before returning a snapshot', () => {
		const priced = endpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '1000000000' },
		]);
		for (const invalid of [
			{ ...facts, imageCount: 0 },
			{ ...facts, imageCount: 1.5 },
			{ ...facts, referenceCount: -1 },
			{ ...facts, referenceCount: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			const result = resolveEndpointImagePricing(priced, invalid);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.reason, 'invalid_image_pricing_request');
		}

		const overflow = resolveEndpointImagePricing(priced, {
			...facts,
			imageCount: Number.MAX_SAFE_INTEGER,
		});
		assert.equal(overflow.ok, false);
		if (!overflow.ok) assert.equal(overflow.reason, 'endpoint_image_pricing_overflow');
	});

	it('requires an explicit output_image/image line instead of treating input-only pricing as free output', () => {
		const result = resolveEndpointImagePricing(endpoint([
			{ billable: 'input_reference', unit: 'request', cost_usd: '0.01' },
		]), facts);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, 'missing_verified_endpoint_image_pricing');
		}
	});
});

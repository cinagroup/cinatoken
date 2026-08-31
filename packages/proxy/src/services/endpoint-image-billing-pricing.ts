import {
	normalizeUsdDecimal,
	serializeImagePricingLine,
	type ImageEndpointPricingLine,
	type VerifiedModelEndpointSnapshot,
} from '@octafuse/core';

const MAX_SAFE_COST = Number.MAX_SAFE_INTEGER;

export type EndpointImagePricingOperation = 'images.generations' | 'images.edits';

export type EndpointImagePricingRequestFacts = {
	operation: EndpointImagePricingOperation;
	imageCount: number;
	referenceCount: number;
};

export type EndpointImagePricingAuditIdentity = {
	source: 'verified_model_endpoint';
	endpoint_id: string;
	model_id: string;
	provider_id: string;
	evidence_url: string;
	verified_by: string;
	verified_at: string;
	expires_at: string;
	currency: 'USD';
};

export type ResolvedEndpointImagePricingLine = {
	billable: 'output_image' | 'input_image' | 'input_reference';
	unit: 'image' | 'request';
	cost_usd: number;
	quantity: number;
	standard_cost: number;
};

export type ResolvedEndpointImagePricing = {
	operation: EndpointImagePricingOperation;
	imageCount: number;
	referenceCount: number;
	/** Endpoint list price before route or user factors. */
	standardBaseCost: number;
	/** Total output component for the admitted output-image count. */
	standardOutputComponentCost: number;
	/** Comparable endpoint list price for one output image. */
	standardOutputUnitCost: number;
	/** Input-image/reference per-image component for this request. */
	standardInputComponentCost: number;
	/** Conditional input-reference request charge for this request. */
	standardFixedRequestCost: number;
	selectedLines: ResolvedEndpointImagePricingLine[];
	audit: EndpointImagePricingAuditIdentity;
};

export type EndpointImagePricingFailureReason =
	| 'missing_verified_endpoint_image_pricing'
	| 'invalid_image_pricing_request'
	| 'invalid_endpoint_image_pricing'
	| 'unsupported_endpoint_image_pricing_dimension'
	| 'ambiguous_endpoint_image_pricing'
	| 'endpoint_image_pricing_overflow';

export type EndpointImagePricingFailure = {
	ok: false;
	reason: EndpointImagePricingFailureReason;
	message: string;
};

export type EndpointImagePricingResolution =
	| { ok: true; value: ResolvedEndpointImagePricing }
	| EndpointImagePricingFailure;

type SupportedLineKind =
	| 'output_image_per_image'
	| 'input_reference_per_image'
	| 'input_reference_per_request';

type CanonicalLine = {
	kind: SupportedLineKind;
	billable: ResolvedEndpointImagePricingLine['billable'];
	unit: ResolvedEndpointImagePricingLine['unit'];
	costUsd: number;
};

function failure(
	reason: EndpointImagePricingFailureReason,
	message: string,
): EndpointImagePricingFailure {
	return { ok: false, reason, message };
}

function nonEmpty(value: string): boolean {
	return value.trim().length > 0;
}

function auditIdentity(
	endpoint: VerifiedModelEndpointSnapshot,
): EndpointImagePricingAuditIdentity | null {
	if (
		![
			endpoint.id,
			endpoint.modelId,
			endpoint.providerId,
			endpoint.evidenceUrl,
			endpoint.verifiedBy,
			endpoint.verifiedAt,
			endpoint.expiresAt,
		].every(nonEmpty)
	) {
		return null;
	}
	return {
		source: 'verified_model_endpoint',
		endpoint_id: endpoint.id,
		model_id: endpoint.modelId,
		provider_id: endpoint.providerId,
		evidence_url: endpoint.evidenceUrl,
		verified_by: endpoint.verifiedBy,
		verified_at: endpoint.verifiedAt,
		expires_at: endpoint.expiresAt,
		currency: 'USD',
	};
}

function supportedLineKind(
	line: ImageEndpointPricingLine,
): SupportedLineKind | null {
	if (line.billable === 'output_image' && line.unit === 'image') {
		return 'output_image_per_image';
	}
	if (
		(line.billable === 'input_image' || line.billable === 'input_reference')
		&& line.unit === 'image'
	) {
		return 'input_reference_per_image';
	}
	if (line.billable === 'input_reference' && line.unit === 'request') {
		return 'input_reference_per_request';
	}
	return null;
}

function canonicalLine(
	line: ImageEndpointPricingLine,
): CanonicalLine | EndpointImagePricingFailure {
	if (line.variant !== undefined) {
		return failure(
			'unsupported_endpoint_image_pricing_dimension',
			`Endpoint image pricing variant "${line.variant}" has no verified request selector`,
		);
	}
	const kind = supportedLineKind(line);
	if (!kind) {
		return failure(
			'unsupported_endpoint_image_pricing_dimension',
			`Endpoint image pricing cannot meter ${line.billable}/${line.unit}`,
		);
	}
	try {
		if (typeof line.cost_usd !== 'string') {
			throw new TypeError('cost_usd must be a fixed decimal string');
		}
		const normalized = normalizeUsdDecimal(line.cost_usd, 'image cost_usd');
		const serialized = serializeImagePricingLine({ ...line, cost_usd: normalized });
		return {
			kind,
			billable: line.billable as CanonicalLine['billable'],
			unit: line.unit as CanonicalLine['unit'],
			costUsd: serialized.cost_usd,
		};
	} catch (error) {
		return failure(
			'invalid_endpoint_image_pricing',
			error instanceof Error ? error.message : 'Endpoint image price is invalid',
		);
	}
}

function checkedComponent(
	costUsd: number,
	quantity: number,
	label: string,
): number | EndpointImagePricingFailure {
	const result = costUsd * quantity;
	if (!Number.isFinite(result) || result < 0 || result > MAX_SAFE_COST) {
		return failure(
			'endpoint_image_pricing_overflow',
			`${label} exceeds the safe billing range`,
		);
	}
	return result;
}

function checkedTotal(
	components: readonly number[],
): number | EndpointImagePricingFailure {
	let total = 0;
	for (const component of components) {
		total += component;
		if (!Number.isFinite(total) || total < 0 || total > MAX_SAFE_COST) {
			return failure(
				'endpoint_image_pricing_overflow',
				'Endpoint image price total exceeds the safe billing range',
			);
		}
	}
	return total;
}

/**
 * Resolve the subset of verified Image Endpoint pricing that the current
 * request/usage ledger can prove without inference. Missing facts, variants,
 * token/megapixel prices, and ambiguous semantic dimensions fail closed.
 * Route schedules, route factors, and user factors are intentionally outside
 * this resolver so every consumer starts from the same endpoint list price.
 */
export function resolveEndpointImagePricing(
	endpoint: VerifiedModelEndpointSnapshot | null | undefined,
	facts: EndpointImagePricingRequestFacts,
): EndpointImagePricingResolution {
	if (
		(facts.operation !== 'images.generations' && facts.operation !== 'images.edits')
		|| !Number.isSafeInteger(facts.imageCount)
		|| facts.imageCount <= 0
		|| !Number.isSafeInteger(facts.referenceCount)
		|| facts.referenceCount < 0
	) {
		return failure(
			'invalid_image_pricing_request',
			'Image pricing requires a supported operation, a positive safe image count, and a non-negative safe reference count',
		);
	}
	const pricing = endpoint?.imageCapabilities?.pricing;
	if (!endpoint || !pricing || pricing.length === 0) {
		return failure(
			'missing_verified_endpoint_image_pricing',
			'Route has no verified endpoint image-pricing snapshot',
		);
	}
	const audit = auditIdentity(endpoint);
	if (!audit) {
		return failure(
			'invalid_endpoint_image_pricing',
			'Endpoint image pricing has an incomplete verification identity',
		);
	}

	const byKind = new Map<SupportedLineKind, CanonicalLine>();
	for (const line of pricing) {
		const canonical = canonicalLine(line);
		if ('ok' in canonical) return canonical;
		const existing = byKind.get(canonical.kind);
		if (existing) {
			return failure(
				'ambiguous_endpoint_image_pricing',
				`Endpoint image pricing declares ${canonical.kind} more than once`,
			);
		}
		byKind.set(canonical.kind, canonical);
	}

	const output = byKind.get('output_image_per_image');
	if (!output) {
		return failure(
			'missing_verified_endpoint_image_pricing',
			'Endpoint image pricing must explicitly declare output_image/image, including for a free output',
		);
	}
	const input = byKind.get('input_reference_per_image');
	const fixed = byKind.get('input_reference_per_request');

	const outputCost = checkedComponent(output.costUsd, facts.imageCount, 'Output image price');
	if (typeof outputCost !== 'number') return outputCost;
	const inputCost = input
		? checkedComponent(input.costUsd, facts.referenceCount, 'Input reference price')
		: 0;
	if (typeof inputCost !== 'number') return inputCost;
	const fixedQuantity = facts.referenceCount > 0 ? 1 : 0;
	const fixedCost = fixed
		? checkedComponent(fixed.costUsd, fixedQuantity, 'Input reference request price')
		: 0;
	if (typeof fixedCost !== 'number') return fixedCost;
	const total = checkedTotal([outputCost, inputCost, fixedCost]);
	if (typeof total !== 'number') return total;

	const selectedLines: ResolvedEndpointImagePricingLine[] = [
		{
			billable: output.billable,
			unit: output.unit,
			cost_usd: output.costUsd,
			quantity: facts.imageCount,
			standard_cost: outputCost,
		},
	];
	if (input) {
		selectedLines.push({
			billable: input.billable,
			unit: input.unit,
			cost_usd: input.costUsd,
			quantity: facts.referenceCount,
			standard_cost: inputCost,
		});
	}
	if (fixed) {
		selectedLines.push({
			billable: fixed.billable,
			unit: fixed.unit,
			cost_usd: fixed.costUsd,
			quantity: fixedQuantity,
			standard_cost: fixedCost,
		});
	}

	return {
		ok: true,
		value: {
			operation: facts.operation,
			imageCount: facts.imageCount,
			referenceCount: facts.referenceCount,
			standardBaseCost: total,
			standardOutputComponentCost: outputCost,
			standardOutputUnitCost: output.costUsd,
			standardInputComponentCost: inputCost,
			standardFixedRequestCost: fixedCost,
			selectedLines,
			audit,
		},
	};
}

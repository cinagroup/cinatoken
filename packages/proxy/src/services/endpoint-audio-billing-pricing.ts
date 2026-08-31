import {
	AUDIO_ENDPOINT_PRICING_OPERATIONS,
	normalizeUsdDecimal,
	type AudioEndpointPricingOperation,
	type VerifiedModelEndpointSnapshot,
} from '@octafuse/core';

const MAX_SAFE_COST = Number.MAX_SAFE_INTEGER;
const MAX_AUDIO_METER_UNITS = 1_000_000_000;

export type EndpointAudioPricingFacts = {
	durationSeconds?: number;
	unicodeCodePoints?: number;
};

export type EndpointAudioPricingAuditIdentity = {
	source: 'verified_model_endpoint';
	endpoint_id: string;
	model_id: string;
	provider_id: string;
	evidence_url: string;
	verified_by: string;
	verified_at: string;
	expires_at: string;
	currency: 'USD';
	operation: AudioEndpointPricingOperation;
	meter: 'duration' | 'characters';
	unit: 'second' | 'unicode_code_point';
	unit_price: number;
	minimum_units: number;
	increment_units: number;
	request_fee: number;
	discount: number;
};

export type ResolvedEndpointAudioPricing = {
	operation: AudioEndpointPricingOperation;
	meterKind: 'duration' | 'characters';
	unit: 'second' | 'unicode_code_point';
	actualUnits: number;
	minimumUnits: number;
	incrementUnits: number;
	billableUnits: number;
	standardUnitPrice: number;
	standardMeterCost: number;
	standardRequestFee: number;
	/** Endpoint list price before route or user factors. */
	standardBaseCost: number;
	discount: number;
	chargedMeterCost: number;
	chargedRequestFee: number;
	/** Endpoint price after its verified discount, before route or user factors. */
	chargedBaseCost: number;
	audit: EndpointAudioPricingAuditIdentity;
};

export type EndpointAudioPricingFailureReason =
	| 'missing_verified_endpoint_audio_pricing'
	| 'invalid_audio_pricing_operation'
	| 'invalid_audio_pricing_facts'
	| 'invalid_endpoint_audio_pricing'
	| 'unsupported_endpoint_audio_pricing_meter'
	| 'endpoint_audio_pricing_overflow';

export type EndpointAudioPricingFailure = {
	ok: false;
	reason: EndpointAudioPricingFailureReason;
	message: string;
};

export type EndpointAudioPricingResolution =
	| { ok: true; value: ResolvedEndpointAudioPricing }
	| EndpointAudioPricingFailure;

type SupportedMeter = {
	kind: 'duration' | 'characters';
	unit: 'second' | 'unicode_code_point';
	price: number;
	minimumUnits: number;
	incrementUnits: number;
};

const AUDIO_OPERATION_SET = new Set<string>(AUDIO_ENDPOINT_PRICING_OPERATIONS);

function failure(
	reason: EndpointAudioPricingFailureReason,
	message: string,
): EndpointAudioPricingFailure {
	return { ok: false, reason, message };
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function identity(
	endpoint: VerifiedModelEndpointSnapshot,
	operation: AudioEndpointPricingOperation,
	meter: SupportedMeter,
	requestFee: number,
	discount: number,
): EndpointAudioPricingAuditIdentity | null {
	if (![
		endpoint.id,
		endpoint.modelId,
		endpoint.providerId,
		endpoint.evidenceUrl,
		endpoint.verifiedBy,
		endpoint.verifiedAt,
		endpoint.expiresAt,
	].every(nonEmpty)) {
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
		operation,
		meter: meter.kind,
		unit: meter.unit,
		unit_price: meter.price,
		minimum_units: meter.minimumUnits,
		increment_units: meter.incrementUnits,
		request_fee: requestFee,
		discount,
	};
}

function decimal(
	value: unknown,
	label: string,
): number | EndpointAudioPricingFailure {
	let normalized: string;
	try {
		normalized = normalizeUsdDecimal(value, label);
	} catch (error) {
		return failure(
			'invalid_endpoint_audio_pricing',
			error instanceof Error ? error.message : `${label} is invalid`,
		);
	}
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`${label} cannot be represented by the billing ledger`,
		);
	}
	if (parsed > MAX_SAFE_COST) {
		return failure(
			'endpoint_audio_pricing_overflow',
			`${label} exceeds the safe billing range`,
		);
	}
	return parsed;
}

function operationAllowsMeter(
	operation: AudioEndpointPricingOperation,
	meter: 'duration' | 'characters' | 'tokens',
): boolean {
	switch (operation) {
		case 'audio.transcriptions':
			return meter === 'duration' || meter === 'tokens';
		case 'audio.transcriptions.multimodal':
		case 'audio.transcriptions.async':
		case 'audio.transcriptions.realtime.inference':
		case 'audio.transcriptions.realtime.session':
			return meter === 'duration';
		case 'audio.speech':
		case 'audio.speech.stream':
		case 'audio.speech.multimodal':
		case 'audio.speech.realtime.inference':
			return meter === 'characters';
	}
}

function supportedMeter(
	value: unknown,
	operation: AudioEndpointPricingOperation,
): SupportedMeter | EndpointAudioPricingFailure {
	const meter = record(value);
	if (!meter || !['duration', 'characters', 'tokens'].includes(String(meter.kind))) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio pricing for ${operation} has an invalid meter`,
		);
	}
	const kind = meter.kind as 'duration' | 'characters' | 'tokens';
	if (!operationAllowsMeter(operation, kind)) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio pricing meter ${kind} is not valid for ${operation}`,
		);
	}
	if (kind === 'tokens') {
		return failure(
			'unsupported_endpoint_audio_pricing_meter',
			'Endpoint audio token pricing requires an authoritative usage breakdown that is not available',
		);
	}

	const unit = kind === 'duration' ? 'second' : 'unicode_code_point';
	if (meter.unit !== unit) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio ${kind} pricing must use ${unit}`,
		);
	}
	const price = decimal(meter.price, `audio pricing ${operation}.meter.price`);
	if (typeof price !== 'number') return price;
	const minimumUnits = meter.minimum_units;
	const incrementUnits = meter.increment_units;
	const validDurationBounds = kind === 'duration'
		&& typeof minimumUnits === 'number'
		&& Number.isFinite(minimumUnits)
		&& minimumUnits >= 0
		&& minimumUnits <= MAX_AUDIO_METER_UNITS
		&& typeof incrementUnits === 'number'
		&& Number.isFinite(incrementUnits)
		&& incrementUnits > 0
		&& incrementUnits <= MAX_AUDIO_METER_UNITS;
	const validCharacterBounds = kind === 'characters'
		&& typeof minimumUnits === 'number'
		&& Number.isSafeInteger(minimumUnits)
		&& minimumUnits >= 0
		&& minimumUnits <= MAX_AUDIO_METER_UNITS
		&& typeof incrementUnits === 'number'
		&& Number.isSafeInteger(incrementUnits)
		&& incrementUnits > 0
		&& incrementUnits <= MAX_AUDIO_METER_UNITS;
	if (!validDurationBounds && !validCharacterBounds) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio ${kind} pricing has invalid minimum or increment units`,
		);
	}
	return {
		kind,
		unit,
		price,
		minimumUnits: minimumUnits as number,
		incrementUnits: incrementUnits as number,
	};
}

function actualUnits(
	facts: EndpointAudioPricingFacts | null | undefined,
	meter: SupportedMeter,
): number | EndpointAudioPricingFailure {
	if (!record(facts)) {
		return failure(
			'invalid_audio_pricing_facts',
			'Endpoint audio pricing requires request or usage facts',
		);
	}
	if (meter.kind === 'duration') {
		if (
			typeof facts?.durationSeconds !== 'number'
			|| !Number.isFinite(facts.durationSeconds)
			|| facts.durationSeconds < 0
			|| facts.durationSeconds > MAX_AUDIO_METER_UNITS
			|| facts.unicodeCodePoints !== undefined
		) {
			return failure(
				'invalid_audio_pricing_facts',
				'Duration pricing requires finite non-negative durationSeconds and no character count',
			);
		}
		return facts.durationSeconds;
	}
	if (
		typeof facts?.unicodeCodePoints !== 'number'
		|| !Number.isSafeInteger(facts.unicodeCodePoints)
		|| facts.unicodeCodePoints < 0
		|| facts.unicodeCodePoints > MAX_AUDIO_METER_UNITS
		|| facts.durationSeconds !== undefined
	) {
		return failure(
			'invalid_audio_pricing_facts',
			'Character pricing requires a non-negative safe unicodeCodePoints count and no duration',
		);
	}
	return facts.unicodeCodePoints;
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
	const [mantissa, rawExponent] = value.toString().toLowerCase().split('e');
	const exponent = rawExponent === undefined ? 0 : Number(rawExponent);
	const [integer, fraction = ''] = mantissa!.split('.');
	let coefficient = BigInt(`${integer}${fraction}`);
	let scale = fraction.length - exponent;
	if (scale < 0) {
		coefficient *= 10n ** BigInt(-scale);
		scale = 0;
	}
	return { coefficient, scale };
}

function decimalNumber(coefficient: bigint, scale: number): number {
	const digits = coefficient.toString();
	if (scale === 0) return Number(digits);
	const padded = digits.padStart(scale + 1, '0');
	const splitAt = padded.length - scale;
	return Number(`${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`);
}

function roundBillableUnits(
	actual: number,
	meter: SupportedMeter,
): number | EndpointAudioPricingFailure {
	const bounded = Math.max(actual, meter.minimumUnits);
	const boundedDecimal = decimalParts(bounded);
	const incrementDecimal = decimalParts(meter.incrementUnits);
	const numerator = boundedDecimal.coefficient
		* 10n ** BigInt(incrementDecimal.scale);
	const denominator = incrementDecimal.coefficient
		* 10n ** BigInt(boundedDecimal.scale);
	const steps = numerator === 0n
		? 0n
		: (numerator + denominator - 1n) / denominator;
	if (steps > BigInt(Number.MAX_SAFE_INTEGER)) {
		return failure(
			'endpoint_audio_pricing_overflow',
			'Endpoint audio billing increment requires an unsafe number of steps',
		);
	}
	const billable = decimalNumber(
		steps * incrementDecimal.coefficient,
		incrementDecimal.scale,
	);
	if (!Number.isFinite(billable) || billable < 0 || billable > MAX_SAFE_COST) {
		return failure(
			'endpoint_audio_pricing_overflow',
			'Endpoint audio billable units exceed the safe billing range',
		);
	}
	return billable;
}

function checkedProduct(
	left: number,
	right: number,
	label: string,
): number | EndpointAudioPricingFailure {
	const result = left * right;
	if (!Number.isFinite(result) || result < 0 || result > MAX_SAFE_COST) {
		return failure(
			'endpoint_audio_pricing_overflow',
			`${label} exceeds the safe billing range`,
		);
	}
	return result;
}

function checkedTotal(
	left: number,
	right: number,
	label: string,
): number | EndpointAudioPricingFailure {
	const result = left + right;
	if (!Number.isFinite(result) || result < 0 || result > MAX_SAFE_COST) {
		return failure(
			'endpoint_audio_pricing_overflow',
			`${label} exceeds the safe billing range`,
		);
	}
	return result;
}

/**
 * Resolve a single verified Audio Endpoint tariff using facts whose unit is
 * authoritative for that operation. Token meters deliberately fail closed
 * until the usage ledger can prove the complete provider token breakdown.
 * Route schedules, route factors, and user factors are intentionally outside
 * this resolver.
 */
export function resolveEndpointAudioPricing(
	endpoint: VerifiedModelEndpointSnapshot | null | undefined,
	operation: AudioEndpointPricingOperation | null | undefined,
	facts: EndpointAudioPricingFacts | null | undefined,
): EndpointAudioPricingResolution {
	if (!operation || !AUDIO_OPERATION_SET.has(operation)) {
		return failure(
			'invalid_audio_pricing_operation',
			'Endpoint audio pricing requires an exact supported operation',
		);
	}
	if (!endpoint || !endpoint.audioCapabilities) {
		return failure(
			'missing_verified_endpoint_audio_pricing',
			'Route has no verified endpoint audio-pricing snapshot',
		);
	}
	const capabilities = record(endpoint.audioCapabilities);
	const pricingByOperation = record(capabilities?.pricing_by_operation);
	if (capabilities?.v !== 1 || !pricingByOperation) {
		return failure(
			'invalid_endpoint_audio_pricing',
			'Endpoint audio pricing has an invalid capability envelope',
		);
	}
	const operationPricing = record(pricingByOperation[operation]);
	if (!operationPricing) {
		return failure(
			'missing_verified_endpoint_audio_pricing',
			`Route has no verified endpoint audio pricing for ${operation}`,
		);
	}
	if (operationPricing.currency !== 'USD') {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio pricing for ${operation} must use USD`,
		);
	}

	const meter = supportedMeter(operationPricing.meter, operation);
	if ('ok' in meter) return meter;
	const units = actualUnits(facts, meter);
	if (typeof units !== 'number') return units;
	const billableUnits = roundBillableUnits(units, meter);
	if (typeof billableUnits !== 'number') return billableUnits;
	const requestFee = operationPricing.request === undefined
		? 0
		: decimal(operationPricing.request, `audio pricing ${operation}.request`);
	if (typeof requestFee !== 'number') return requestFee;
	const discount = operationPricing.discount === undefined
		? 0
		: operationPricing.discount;
	if (
		typeof discount !== 'number'
		|| !Number.isFinite(discount)
		|| discount < 0
		|| discount > 1
	) {
		return failure(
			'invalid_endpoint_audio_pricing',
			`Endpoint audio pricing discount for ${operation} must be between 0 and 1`,
		);
	}

	const standardMeterCost = checkedProduct(meter.price, billableUnits, 'Audio meter cost');
	if (typeof standardMeterCost !== 'number') return standardMeterCost;
	const standardBaseCost = checkedTotal(standardMeterCost, requestFee, 'Audio standard cost');
	if (typeof standardBaseCost !== 'number') return standardBaseCost;
	const discountFactor = 1 - discount;
	const chargedMeterCost = checkedProduct(
		standardMeterCost,
		discountFactor,
		'Discounted audio meter cost',
	);
	if (typeof chargedMeterCost !== 'number') return chargedMeterCost;
	const chargedRequestFee = checkedProduct(
		requestFee,
		discountFactor,
		'Discounted audio request fee',
	);
	if (typeof chargedRequestFee !== 'number') return chargedRequestFee;
	const chargedBaseCost = checkedTotal(
		chargedMeterCost,
		chargedRequestFee,
		'Audio charged cost',
	);
	if (typeof chargedBaseCost !== 'number') return chargedBaseCost;
	const audit = identity(endpoint, operation, meter, requestFee, discount);
	if (!audit) {
		return failure(
			'invalid_endpoint_audio_pricing',
			'Endpoint audio pricing has an incomplete verification identity',
		);
	}

	return {
		ok: true,
		value: {
			operation,
			meterKind: meter.kind,
			unit: meter.unit,
			actualUnits: units,
			minimumUnits: meter.minimumUnits,
			incrementUnits: meter.incrementUnits,
			billableUnits,
			standardUnitPrice: meter.price,
			standardMeterCost,
			standardRequestFee: requestFee,
			standardBaseCost,
			discount,
			chargedMeterCost,
			chargedRequestFee,
			chargedBaseCost,
			audit,
		},
	};
}

import type {
	BillingPriceSnapshot,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import type { RouteResult } from './model-router';

const TOKENS_PER_MILLION = 1_000_000;

export type EndpointPricingAuditIdentity = {
	source: 'verified_model_endpoint';
	endpoint_id: string;
	model_id: string;
	provider_id: string;
	evidence_url: string;
	verified_by: string;
	verified_at: string;
	expires_at: string;
	currency: 'USD';
	discount: number;
};

export type ResolvedEndpointTextPricing = {
	/** Provider/list price before the endpoint's discount-to-user value. */
	standardPrices: BillingPriceSnapshot;
	/** Exact flat prices used for provider.max_price, budget admission, and debit. */
	chargedPrices: BillingPriceSnapshot;
	standardRequestCost: number;
	chargedRequestCost: number;
	audit: EndpointPricingAuditIdentity & {
		cache_write_strategy: 'maximum_declared_rate';
	};
};

export type EndpointPricingFailure = {
	ok: false;
	reason:
		| 'missing_verified_endpoint_pricing'
		| 'invalid_endpoint_pricing'
		| 'unsupported_endpoint_pricing_dimension';
	message: string;
};

export type EndpointPricingResolution =
	| { ok: true; value: ResolvedEndpointTextPricing }
	| EndpointPricingFailure;

function decimal(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function perMillion(value: string | undefined): number | null {
	const parsed = decimal(value);
	if (parsed === null) return value === undefined ? null : Number.NaN;
	const result = parsed * TOKENS_PER_MILLION;
	return Number.isFinite(result) && result >= 0 ? result : Number.NaN;
}

function scaled(prices: BillingPriceSnapshot, factor: number): BillingPriceSnapshot {
	const scale = (value: number | null): number | null => value === null ? null : value * factor;
	return {
		input_price: scale(prices.input_price),
		output_price: scale(prices.output_price),
		cache_read_price: scale(prices.cache_read_price),
		cache_write_price: scale(prices.cache_write_price),
		image_input_price: scale(prices.image_input_price),
		image_input_cache_price: scale(prices.image_input_cache_price),
		image_output_price: scale(prices.image_output_price),
	};
}

function positiveUnsupportedDimensions(
	pricing: NonNullable<VerifiedModelEndpointSnapshot['pricing']>,
): string[] {
	return [
		'audio',
		'audio_output',
		'image',
		'image_output',
		'image_token',
		'input_audio_cache',
		'internal_reasoning',
		'web_search',
	].filter((field) => {
		const value = pricing[field as keyof typeof pricing];
		return typeof value === 'string' && Number(value) > 0;
	});
}

/**
 * Materialize the verified endpoint's flat text tariff into the legacy billing
 * unit ($/1M tokens) without consulting models.pricing_profile. Dimensions for
 * which the text usage ledger has no authoritative counter fail closed. Cache
 * writes use the largest declared write tariff because usage does not identify
 * the cache lifetime.
 */
export function resolveEndpointTextPricing(
	endpoint: VerifiedModelEndpointSnapshot | null | undefined,
): EndpointPricingResolution {
	const pricing = endpoint?.pricing;
	if (!endpoint || !pricing) {
		return {
			ok: false,
			reason: 'missing_verified_endpoint_pricing',
			message: 'Route has no verified endpoint text-pricing snapshot',
		};
	}
	const unsupported = positiveUnsupportedDimensions(pricing);
	if (unsupported.length > 0) {
		return {
			ok: false,
			reason: 'unsupported_endpoint_pricing_dimension',
			message: `Endpoint pricing has unsupported metered dimensions: ${unsupported.join(', ')}`,
		};
	}

	const input = perMillion(pricing.prompt);
	const output = perMillion(pricing.completion);
	const cacheRead = perMillion(pricing.input_cache_read);
	const cacheWriteCandidates = [
		perMillion(pricing.input_cache_write),
		perMillion(pricing.input_cache_write_1h),
	].filter((value): value is number => value !== null);
	const cacheWrite = cacheWriteCandidates.length > 0
		? Math.max(...cacheWriteCandidates)
		: null;
	const requestCost = decimal(pricing.request) ?? 0;
	const discount = pricing.discount ?? 0;
	if (
		[input, output, cacheRead, cacheWrite, requestCost, discount]
			.some((value) => value !== null && (!Number.isFinite(value) || value < 0))
		|| discount > 1
	) {
		return {
			ok: false,
			reason: 'invalid_endpoint_pricing',
			message: 'Endpoint pricing cannot be represented safely by the billing ledger',
		};
	}
	const standardPrices: BillingPriceSnapshot = {
		input_price: input,
		output_price: output,
		cache_read_price: cacheRead,
		cache_write_price: cacheWrite,
		image_input_price: null,
		image_input_cache_price: null,
		image_output_price: null,
	};
	const discountFactor = 1 - discount;
	return {
		ok: true,
		value: {
			standardPrices,
			chargedPrices: scaled(standardPrices, discountFactor),
			standardRequestCost: requestCost,
			chargedRequestCost: requestCost * discountFactor,
			audit: {
				source: 'verified_model_endpoint',
				endpoint_id: endpoint.id,
				model_id: endpoint.modelId,
				provider_id: endpoint.providerId,
				evidence_url: endpoint.evidenceUrl,
				verified_by: endpoint.verifiedBy,
				verified_at: endpoint.verifiedAt,
				expires_at: endpoint.expiresAt,
				currency: 'USD',
				discount,
				cache_write_strategy: 'maximum_declared_rate',
			},
		},
	};
}

export function endpointTextPricingProfileJson(
	endpoint: VerifiedModelEndpointSnapshot | null | undefined,
	options: { charged: boolean },
): string | null {
	const resolved = resolveEndpointTextPricing(endpoint);
	if (!resolved.ok) return null;
	const prices = options.charged
		? resolved.value.chargedPrices
		: resolved.value.standardPrices;
	return JSON.stringify({
		tiers: [{
			upto: null,
			input_price: prices.input_price,
			output_price: prices.output_price,
			cache_read_price: prices.cache_read_price,
			cache_write_price: prices.cache_write_price,
		}],
	});
}

/**
 * Image/audio settlement still has independent usage dimensions. Keep those
 * routes out of endpoint-price caps/order until their debit path consumes the
 * same verified endpoint evidence.
 */
export function routeUsesUnsupportedMultimediaEndpointPriceSelection(
	route: Pick<RouteResult, 'providerRoutingTrace'>,
): boolean {
	return route.providerRoutingTrace?.max_price != null
		|| route.providerRoutingTrace?.sort === 'price';
}

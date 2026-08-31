import {
	applyUserChargedCostFactor,
	guardrailBudgetUnits,
	lookupUserChargedCostFactor,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	parseUserChargedCostFactors,
	roundGatewayMoney,
} from '@octafuse/core';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import { buildRouteRequestBody } from './route-default-params';
import { resolveEndpointTextPricing } from './endpoint-billing-pricing';

const TOKENS_PER_MILLION = 1_000_000;
const ADAPTER_INPUT_OVERHEAD_TOKENS = 4_096;

function jsonBytes(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return 0;
	}
}

function explicitOutputLimit(body: Record<string, unknown>): number | null {
	const candidates: unknown[] = ['max_output_tokens', 'max_completion_tokens', 'max_tokens']
		.map((field) => body[field])
	const generationConfig = body.generationConfig ?? body.generation_config;
	if (generationConfig != null && typeof generationConfig === 'object' && !Array.isArray(generationConfig)) {
		const nested = generationConfig as Record<string, unknown>;
		candidates.push(nested.maxOutputTokens, nested.max_output_tokens);
	}
	const valid = candidates.filter(
		(value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0,
	);
	return valid.length > 0 ? Math.max(...valid) : null;
}

function routeFactorCeiling(raw: string | null): number {
	const base = parseRouteBaseFactors(raw).chargedFactor;
	const schedule = parseRoutePricingSchedule(raw);
	const windowCeiling = Math.max(1, ...schedule.charged.map((window) => window.factor));
	return schedule.mode === 'override'
		? Math.max(base, ...schedule.charged.map((window) => window.factor))
		: base * windowCeiling;
}

type StrictPricingCeilingResult =
	| {
		ok: true;
		input: number;
		output: number;
		request: number;
		contextWindow: number;
		maxCompletionTokens: number | null;
	}
	| {
		ok: false;
		reason: 'missing_or_invalid_endpoint_pricing' | 'unsupported_endpoint_pricing_dimension';
		message: string;
	};

function strictPricingCeiling(
	route: ModelFallbackCandidatePlan['routes'][number],
): StrictPricingCeilingResult {
	const resolved = resolveEndpointTextPricing(route.endpoint);
	if (!resolved.ok) {
		return {
			ok: false,
			reason: resolved.reason === 'unsupported_endpoint_pricing_dimension'
				? resolved.reason
				: 'missing_or_invalid_endpoint_pricing',
			message: resolved.message,
		};
	}
	const endpoint = route.endpoint!;
	if (!Number.isSafeInteger(endpoint.contextLength) || endpoint.contextLength! <= 0) {
		return {
			ok: false,
			reason: 'missing_or_invalid_endpoint_pricing',
			message: 'Verified endpoint has no finite context-length ceiling',
		};
	}
	const prices = resolved.value.chargedPrices;
	return {
		ok: true,
		input: Math.max(
			prices.input_price ?? 0,
			prices.cache_read_price ?? prices.input_price ?? 0,
			prices.cache_write_price ?? prices.input_price ?? 0,
		),
		output: prices.output_price ?? 0,
		request: resolved.value.chargedRequestCost,
		contextWindow: endpoint.contextLength!,
		maxCompletionTokens: endpoint.maxCompletionTokens,
	};
}

function candidateCostCeiling(
	candidate: ModelFallbackCandidatePlan,
	chargedFactorsJson: string | null | undefined,
): number {
	const routeCustomBytes = Math.max(0, ...candidate.routes.map((route) => jsonBytes(route.customParams)));
	const rawInputCeiling = jsonBytes(candidate.upstreamBody) + routeCustomBytes + ADAPTER_INPUT_OVERHEAD_TOKENS;
	const userFactor = lookupUserChargedCostFactor(
		parseUserChargedCostFactors(chargedFactorsJson),
		candidate.baseModelId,
	);
	let ceiling = 0;
	for (const route of candidate.routes) {
		const pricing = strictPricingCeiling(route);
		if (!pricing.ok) return Number.POSITIVE_INFINITY;
		if (pricing.input === 0 && pricing.output === 0 && pricing.request === 0) continue;
		const inputTokens = Math.min(rawInputCeiling, pricing.contextWindow);
		const routeBody = buildRouteRequestBody(route, candidate.upstreamBody);
		const outputTokens = explicitOutputLimit(routeBody)
			?? pricing.maxCompletionTokens
			?? pricing.contextWindow;
		const factor = routeFactorCeiling(route.priceOverrideRaw);
		const raw = (
			((inputTokens * pricing.input) + (outputTokens * pricing.output)) / TOKENS_PER_MILLION
			+ pricing.request
		);
		const routeCost = roundGatewayMoney(raw * factor);
		ceiling = Math.max(ceiling, applyUserChargedCostFactor(routeCost, userFactor));
	}
	return ceiling;
}

/**
 * Upper bound for the charged cost of the terminal model/route candidate.
 * It uses whole-request UTF-8 bytes as a tokenizer-independent input ceiling,
 * the model/request output cap, the highest catalog tier, and the highest
 * configured route schedule factor. One micro-unit of guard is added for the
 * billing path's intermediate rounding.
 */
export function estimateGuardrailBudgetMicros(
	candidates: ModelFallbackCandidatePlan[],
	chargedFactorsJson: string | null | undefined,
): number {
	let ceiling = 0;
	for (const candidate of candidates) {
		ceiling = Math.max(ceiling, candidateCostCeiling(candidate, chargedFactorsJson));
	}
	if (ceiling <= 0) return 0;
	const micros = guardrailBudgetUnits(ceiling, 'ceiling') + 1;
	return Number.isSafeInteger(micros) ? micros : Number.MAX_SAFE_INTEGER;
}

export type OrdinaryBudgetChargedCostEstimate =
	| {
		ok: true;
		kind: 'free' | 'bounded';
		estimatedChargedCost: number;
	}
	| {
		ok: false;
			reason:
			| 'missing_or_invalid_endpoint_pricing'
			| 'unsupported_endpoint_pricing_dimension'
			| 'missing_context_window'
			| 'missing_output_limit'
			| 'non_finite_cost';
		candidateModelId: string;
		message: string;
	};

/**
 * Conservative ordinary-user charged-cost ceiling across the complete
 * cross-model/route failover plan. Unlike the legacy Guardrail estimator,
 * missing or malformed pricing is never interpreted as free. A zero result is
 * returned only when every possible terminal candidate is provably free.
 */
export function estimateOrdinaryBudgetChargedCost(
	candidates: ModelFallbackCandidatePlan[],
	chargedFactorsJson: string | null | undefined,
): OrdinaryBudgetChargedCostEstimate {
	let ceiling = 0;
	for (const candidate of candidates) {
		if (candidate.routes.length === 0) continue;
		const userFactor = lookupUserChargedCostFactor(
			parseUserChargedCostFactors(chargedFactorsJson),
			candidate.baseModelId,
		);

		for (const route of candidate.routes) {
			const pricing = strictPricingCeiling(route);
			if (!pricing.ok) {
				return {
					ok: false,
					reason: pricing.reason,
					candidateModelId: candidate.baseModelId,
					message: `${pricing.message} for route "${route.targetId}"`,
				};
			}
			// A zero user factor makes the debit free, but never bypasses the
			// pre-dispatch endpoint evidence/pricing validation above.
			if (userFactor === 0) continue;
			if (pricing.input === 0 && pricing.output === 0 && pricing.request === 0) continue;
			const routeBody = buildRouteRequestBody(route, candidate.upstreamBody);
			const outputTokens = explicitOutputLimit(routeBody)
				?? pricing.maxCompletionTokens
				?? pricing.contextWindow;
			if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
				return {
					ok: false,
					reason: 'missing_output_limit',
					candidateModelId: candidate.baseModelId,
					message: `Model "${candidate.baseModelId}" has no finite output-token ceiling`,
				};
			}
			const raw = (
				(pricing.contextWindow * pricing.input)
				+ (outputTokens * pricing.output)
			) / TOKENS_PER_MILLION + pricing.request;
			const routeCost = roundGatewayMoney(raw * routeFactorCeiling(route.priceOverrideRaw));
			const chargedCost = applyUserChargedCostFactor(routeCost, userFactor);
			if (!Number.isFinite(chargedCost) || chargedCost < 0) {
				return {
					ok: false,
					reason: 'non_finite_cost',
					candidateModelId: candidate.baseModelId,
					message: `Model "${candidate.baseModelId}" produced an unsafe charged-cost ceiling`,
				};
			}
			ceiling = Math.max(ceiling, chargedCost);
		}
	}

	if (ceiling === 0) {
		return { ok: true, kind: 'free', estimatedChargedCost: 0 };
	}
	// Match the billing path's micro precision and retain one micro of guard for
	// intermediate route/user-factor rounding.
	const guarded = roundGatewayMoney(roundGatewayMoney(ceiling) + (1 / TOKENS_PER_MILLION));
	if (!Number.isFinite(guarded)) {
		return {
			ok: false,
			reason: 'non_finite_cost',
			candidateModelId: candidates[0]?.baseModelId ?? 'unknown',
			message: 'The failover plan produced an unsafe charged-cost ceiling',
		};
	}
	return { ok: true, kind: 'bounded', estimatedChargedCost: guarded };
}

/**
 * Embeddings have no generated-token charge, but a batch can contain several
 * independently context-bounded inputs. Reserve against `count × context` and
 * force the output-token ceiling to zero.
 */
export function estimateEmbeddingOrdinaryBudgetChargedCost(
	candidates: ModelFallbackCandidatePlan[],
	inputCount: number,
	chargedFactorsJson: string | null | undefined,
): OrdinaryBudgetChargedCostEstimate {
	if (!Number.isSafeInteger(inputCount) || inputCount <= 0) {
		return {
			ok: false,
			reason: 'non_finite_cost',
			candidateModelId: candidates[0]?.baseModelId ?? 'unknown',
			message: 'The embeddings batch has no safe token ceiling',
		};
	}
	let ceiling = 0;
	for (const candidate of candidates) {
		if (candidate.routes.length === 0) continue;
		const userFactor = lookupUserChargedCostFactor(
			parseUserChargedCostFactors(chargedFactorsJson),
			candidate.baseModelId,
		);
		for (const route of candidate.routes) {
			const pricing = strictPricingCeiling(route);
			if (!pricing.ok) {
				return {
					ok: false,
					reason: pricing.reason,
					candidateModelId: candidate.baseModelId,
					message: `${pricing.message} for route "${route.targetId}"`,
				};
			}
			if (userFactor === 0) continue;
			const batchInputCeiling = pricing.contextWindow * inputCount;
			if (!Number.isSafeInteger(batchInputCeiling) || batchInputCeiling <= 0) {
				return {
					ok: false,
					reason: 'non_finite_cost',
					candidateModelId: candidate.baseModelId,
					message: 'The embeddings batch exceeds the safe token ceiling',
				};
			}
			const raw = (batchInputCeiling * pricing.input) / TOKENS_PER_MILLION + pricing.request;
			const routeCost = roundGatewayMoney(raw * routeFactorCeiling(route.priceOverrideRaw));
			const chargedCost = applyUserChargedCostFactor(routeCost, userFactor);
			if (!Number.isFinite(chargedCost) || chargedCost < 0) {
				return {
					ok: false,
					reason: 'non_finite_cost',
					candidateModelId: candidate.baseModelId,
					message: `Model "${candidate.baseModelId}" produced an unsafe charged-cost ceiling`,
				};
			}
			ceiling = Math.max(ceiling, chargedCost);
		}
	}
	if (ceiling === 0) return { ok: true, kind: 'free', estimatedChargedCost: 0 };
	const guarded = roundGatewayMoney(roundGatewayMoney(ceiling) + (1 / TOKENS_PER_MILLION));
	if (!Number.isFinite(guarded)) {
		return {
			ok: false,
			reason: 'non_finite_cost',
			candidateModelId: candidates[0]?.baseModelId ?? 'unknown',
			message: 'The embeddings failover plan produced an unsafe charged-cost ceiling',
		};
	}
	return { ok: true, kind: 'bounded', estimatedChargedCost: guarded };
}

export function estimateEmbeddingGuardrailBudgetMicros(
	candidates: ModelFallbackCandidatePlan[],
	inputCount: number,
	chargedFactorsJson: string | null | undefined,
): number {
	const estimate = estimateEmbeddingOrdinaryBudgetChargedCost(
		candidates,
		inputCount,
		chargedFactorsJson,
	);
	if (!estimate.ok) return Number.MAX_SAFE_INTEGER;
	if (estimate.estimatedChargedCost <= 0) return 0;
	const micros = guardrailBudgetUnits(estimate.estimatedChargedCost, 'ceiling');
	return Number.isSafeInteger(micros) ? micros : Number.MAX_SAFE_INTEGER;
}

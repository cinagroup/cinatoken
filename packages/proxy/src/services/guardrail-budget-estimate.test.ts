import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRow, VerifiedModelEndpointSnapshot } from '@octafuse/core';
import {
	estimateEmbeddingGuardrailBudgetMicros,
	estimateEmbeddingOrdinaryBudgetChargedCost,
	estimateGuardrailBudgetMicros,
	estimateOrdinaryBudgetChargedCost,
} from './guardrail-budget-estimate';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import type { RouteResult } from './model-router';

function pricing(tiers: Array<Record<string, unknown>>): string {
	return JSON.stringify({ tiers: tiers.map((tier) => ({ upto: null, ...tier })) });
}

function route(priceOverrideRaw: string | null = null, customParams: Record<string, unknown> | null = null): RouteResult {
	return {
		targetId: crypto.randomUUID(), modelSurfaceId: null, routePoolId: null,
		providerId: 'provider-1', providerName: 'Provider', providerModelName: 'upstream-model',
		upstreamProtocol: 'openai', upstreamOperation: 'chat.completions', adapter: 'passthrough',
		providerEndpoints: {}, providerApiKey: 'secret', providerSharedChannelType: null,
		priceOverrideRaw, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams, routeGroup: 'default', routePriority: 0, routeWeight: 1,
	};
}

function endpointFromPricingProfile(options: {
	id: string;
	pricingProfile: string | null;
	contextWindow: number | null;
	maxTokens: number | null;
}): VerifiedModelEndpointSnapshot | undefined {
	if (!options.pricingProfile) return undefined;
	let tiers: Array<Record<string, unknown>>;
	try {
		const parsed = JSON.parse(options.pricingProfile) as { tiers?: unknown };
		if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) return undefined;
		tiers = parsed.tiers as Array<Record<string, unknown>>;
	} catch {
		return undefined;
	}
	const maximum = (fields: string[]): number => Math.max(0, ...tiers.flatMap((tier) =>
		fields.map((field) => Number(tier[field] ?? 0)).filter(Number.isFinite)
	));
	return {
		id: `endpoint:${options.id}`,
		modelId: options.id,
		providerId: 'provider-1',
		providerSlug: 'provider',
		selectorSlug: 'provider',
		endpointClass: 'standard',
		region: null,
		contextLength: options.contextWindow,
		maxPromptTokens: options.contextWindow,
		maxCompletionTokens: options.maxTokens,
		quantization: null,
		supportedParameters: [],
		pricing: {
			currency: 'USD',
			prompt: String(maximum(['input_price', 'cache_read_price', 'cache_write_price']) / 1_000_000),
			completion: String(maximum(['output_price']) / 1_000_000),
		},
		capabilities: {
			implicit_caching: false,
			voice_cloning: false,
			tool_choice: { auto: false, function: false, none: false, required: false },
		},
		imageCapabilities: null,
		evidenceUrl: 'https://evidence.example/pricing',
		verifiedBy: 'test',
		verifiedAt: '2026-08-29T00:00:00.000Z',
		expiresAt: '2027-08-29T00:00:00.000Z',
	};
}

function candidate(options: {
	id?: string;
	pricingProfile?: string | null;
	contextWindow?: number | null;
	maxTokens?: number | null;
	body?: Record<string, unknown>;
	routes?: RouteResult[];
} = {}): ModelFallbackCandidatePlan {
	const id = options.id ?? 'openai/test-model';
	const model: ModelRow = {
		id, display_name: 'Test model', vendor: 'openai',
		context_window: options.contextWindow === undefined ? 10 : options.contextWindow,
		max_tokens: options.maxTokens === undefined ? 100 : options.maxTokens,
		pricing_profile: options.pricingProfile === undefined
			? pricing([{ input_price: 1, output_price: 2 }])
			: options.pricingProfile,
		tags: '[]', description: null, metadata: null, input_modalities: '["text"]',
		output_modalities: '["text"]', released_at: null, route_policy: null,
		created_at: '2026-08-29T00:00:00.000Z',
	};
	const resolvedRoutes = (options.routes ?? [route()]).map((item) => ({
		...item,
		endpoint: item.endpoint ?? endpointFromPricingProfile({
			id,
			pricingProfile: model.pricing_profile,
			contextWindow: model.context_window,
			maxTokens: model.max_tokens,
		}),
	}));
	return {
		requestedModelId: id, model, baseModelId: id, effectiveRouteGroup: 'default',
		routes: resolvedRoutes, surface: null,
		strategy: {} as ModelFallbackCandidatePlan['strategy'],
		upstreamBody: options.body ?? { model: id }, hasProviderPreferences: false,
	};
}

describe('estimateGuardrailBudgetMicros', () => {
	it('uses the request/model output ceiling, context cap, and highest catalog tier price', () => {
		const result = estimateGuardrailBudgetMicros([candidate({
			contextWindow: 10,
			body: { max_tokens: 100, max_completion_tokens: 120, max_output_tokens: 80 },
			pricingProfile: pricing([
				{ upto: 1_000, input_price: 1, output_price: 2 },
				{ input_price: 0.5, output_price: 10, cache_write_price: 20 },
			]),
		})], null);

		// 10 input × max cache/input price 20 + 120 output × max output price 10.
		assert.equal(result, 1_401);
	});

	it('accounts for UTF-8 request bytes, route custom parameters, and the adapter overhead', () => {
		const body = { model: '模型', messages: [{ role: 'user', content: '你好' }], max_tokens: 0 };
		const customParams = { safety: '严格' };
		const inputTokens = new TextEncoder().encode(JSON.stringify(body)).byteLength
			+ new TextEncoder().encode(JSON.stringify(customParams)).byteLength
			+ 4_096;
		const result = estimateGuardrailBudgetMicros([candidate({
			contextWindow: 10_000,
			body,
			routes: [route(null, customParams)],
			pricingProfile: pricing([{ input_price: 1, output_price: 2 }]),
		})], null);

		assert.equal(result, inputTokens + 1);
	});

	it('applies the largest multiply schedule factor and then the user model factor', () => {
		const override = JSON.stringify({
			charged_factor: 2,
			schedule: {
				mode: 'multiply',
				charged: [
					{ start: '00:00', end: '12:00', factor: 0.5 },
					{ start: '12:00', end: '24:00', factor: 3 },
				],
			},
		});
		const result = estimateGuardrailBudgetMicros([candidate({
			contextWindow: 100,
			maxTokens: 100,
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(override)],
		})], JSON.stringify({ 'openai/test-model': 0.5 }));

		// Raw .0002 × (base 2 × schedule 3) × user .5, plus one micro guard.
		assert.equal(result, 601);
	});

	it('uses the greater base/window factor for override schedules', () => {
		const windowWins = JSON.stringify({
			charged_factor: 2,
			schedule: { mode: 'override', charged: [{ start: '00:00', end: '24:00', factor: 3 }] },
		});
		const baseWins = JSON.stringify({
			charged_factor: 4,
			schedule: { mode: 'override', charged: [{ start: '00:00', end: '24:00', factor: 3 }] },
		});
		assert.equal(estimateGuardrailBudgetMicros([candidate({
			contextWindow: 100, maxTokens: 100,
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(windowWins)],
		})], null), 601);
		assert.equal(estimateGuardrailBudgetMicros([candidate({
			contextWindow: 100, maxTokens: 100,
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(baseWins)],
		})], null), 801);
	});

	it('reserves the maximum terminal candidate/route ceiling rather than summing fallbacks', () => {
		const cheap = candidate({
			id: 'openai/cheap', contextWindow: 100, maxTokens: 100,
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(JSON.stringify({ charged_factor: 1 }))],
		});
		const expensive = candidate({
			id: 'openai/expensive', contextWindow: 100, maxTokens: 100,
			pricingProfile: pricing([{ input_price: 2, output_price: 3 }]),
			routes: [
				route(JSON.stringify({ charged_factor: 1 })),
				route(JSON.stringify({ charged_factor: 2 })),
			],
		});

		assert.equal(estimateGuardrailBudgetMicros([cheap, expensive], null), 1_001);
	});

	it('returns zero for free/unpriced work and saturates unsafe estimates', () => {
		assert.equal(estimateGuardrailBudgetMicros([], null), 0);
		assert.equal(estimateGuardrailBudgetMicros([candidate({
			pricingProfile: pricing([{ input_price: 0, output_price: 0 }]),
		})], null), 0);
		assert.equal(estimateGuardrailBudgetMicros([candidate({
			contextWindow: 10_000,
			maxTokens: 10_000,
			pricingProfile: pricing([{ input_price: 1_000_000_000_000_000, output_price: 1_000_000_000_000_000 }]),
		})], null), Number.MAX_SAFE_INTEGER);
	});
});

describe('estimateOrdinaryBudgetChargedCost', () => {
	it('uses endpoint flat pricing, discount, request fee, and route factor instead of conflicting model pricing', () => {
		const planned = candidate({
			contextWindow: 100,
			maxTokens: 100,
			pricingProfile: pricing([{ input_price: 999_000, output_price: 999_000 }]),
			routes: [route(JSON.stringify({ charged_factor: 2 }))],
		});
		planned.routes[0]!.endpoint = {
			...planned.routes[0]!.endpoint!,
			pricing: {
				currency: 'USD',
				prompt: '0.000001',
				completion: '0.000002',
				request: '0.1',
				discount: 0.5,
			},
		};

		assert.deepEqual(estimateOrdinaryBudgetChargedCost([planned], null), {
			ok: true,
			kind: 'bounded',
			estimatedChargedCost: 0.100301,
		});
	});

	it('fails closed when endpoint pricing declares an unsupported positive dimension', () => {
		const planned = candidate();
		planned.routes[0]!.endpoint = {
			...planned.routes[0]!.endpoint!,
			pricing: {
				...planned.routes[0]!.endpoint!.pricing!,
				web_search: '0.01',
			},
		};
		const result = estimateOrdinaryBudgetChargedCost([planned], null);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'unsupported_endpoint_pricing_dimension');
		assert.equal(
			estimateGuardrailBudgetMicros([planned], null),
			Number.MAX_SAFE_INTEGER,
		);
		const discountedToFree = estimateOrdinaryBudgetChargedCost(
			[planned],
			JSON.stringify({ 'openai/test-model': 0 }),
		);
		assert.equal(discountedToFree.ok, false, 'no-budget/free-user path must still gate before dispatch');
	});

	it('distinguishes explicit free pricing from missing or malformed pricing', () => {
		assert.deepEqual(estimateOrdinaryBudgetChargedCost([candidate({
			pricingProfile: pricing([{ input_price: 0, output_price: 0 }]),
		})], null), {
			ok: true,
			kind: 'free',
			estimatedChargedCost: 0,
		});

		for (const pricingProfile of [null, '{']) {
			const result = estimateOrdinaryBudgetChargedCost([candidate({ pricingProfile })], null);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.reason, 'missing_or_invalid_endpoint_pricing');
		}
	});

	it('recognizes an explicit zero user factor as provably free', () => {
		assert.deepEqual(estimateOrdinaryBudgetChargedCost([
			candidate({ id: 'openai/free-for-user' }),
		], JSON.stringify({ 'openai/free-for-user': 0 })), {
			ok: true,
			kind: 'free',
			estimatedChargedCost: 0,
		});
	});

	it('uses the full model context ceiling, output ceiling, route factor, and user factor', () => {
		const result = estimateOrdinaryBudgetChargedCost([candidate({
			contextWindow: 100,
			maxTokens: 100,
			body: { model: 'openai/test-model', messages: [] },
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(JSON.stringify({ charged_factor: 2 }))],
		})], JSON.stringify({ 'openai/test-model': 0.5 }));

		assert.deepEqual(result, {
			ok: true,
			kind: 'bounded',
			estimatedChargedCost: 0.000201,
		});
	});

	it('takes the maximum charged ceiling across every candidate and route', () => {
		const result = estimateOrdinaryBudgetChargedCost([
			candidate({
				id: 'openai/cheap', contextWindow: 100, maxTokens: 100,
				pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			}),
			candidate({
				id: 'openai/expensive', contextWindow: 100, maxTokens: 100,
				pricingProfile: pricing([{ input_price: 2, output_price: 3 }]),
				routes: [route(), route(JSON.stringify({ charged_factor: 2 }))],
			}),
		], null);

		assert.deepEqual(result, {
			ok: true,
			kind: 'bounded',
			estimatedChargedCost: 0.001001,
		});
	});

	it('includes route-default output ceilings, including native Gemini nesting', () => {
		const flat = estimateOrdinaryBudgetChargedCost([candidate({
			contextWindow: 100,
			maxTokens: 100,
			body: { model: 'openai/test-model' },
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(null, { max_tokens: 500 })],
		})], null);
		assert.deepEqual(flat, {
			ok: true,
			kind: 'bounded',
			estimatedChargedCost: 0.000601,
		});

		const nested = estimateOrdinaryBudgetChargedCost([candidate({
			contextWindow: 100,
			maxTokens: 100,
			body: { model: 'google/test-model' },
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
			routes: [route(null, { generationConfig: { maxOutputTokens: 300 } })],
		})], null);
		assert.deepEqual(nested, {
			ok: true,
			kind: 'bounded',
			estimatedChargedCost: 0.000401,
		});
	});

	it('fails closed when a priced model has no finite context ceiling', () => {
		const result = estimateOrdinaryBudgetChargedCost([candidate({
			contextWindow: null,
			pricingProfile: pricing([{ input_price: 1, output_price: 1 }]),
		})], null);

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'missing_or_invalid_endpoint_pricing');
	});
});

describe('embedding budget estimates', () => {
	it('charges only batch input tokens and multiplies the context ceiling by input count', () => {
		const embedding = candidate({
			contextWindow: 100,
			maxTokens: 999,
			pricingProfile: pricing([{ input_price: 2, output_price: 500 }]),
		});
		assert.deepEqual(
			estimateEmbeddingOrdinaryBudgetChargedCost([embedding], 3, null),
			{ ok: true, kind: 'bounded', estimatedChargedCost: 0.000601 },
		);
		assert.equal(estimateEmbeddingGuardrailBudgetMicros([embedding], 3, null), 601);
	});

	it('fails closed for an unsafe input count', () => {
		const result = estimateEmbeddingOrdinaryBudgetChargedCost([candidate()], 0, null);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'non_finite_cost');
		assert.equal(
			estimateEmbeddingGuardrailBudgetMicros([candidate()], 0, null),
			Number.MAX_SAFE_INTEGER,
		);
	});
});

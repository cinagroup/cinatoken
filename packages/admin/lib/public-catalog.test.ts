import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parsePublicCatalogModelResponse,
	parsePublicCatalogProvidersResponse,
	parsePublicCatalogResponse,
	parsePublicModelStatsResponse,
	resolvePublicApiOrigin,
} from "./public-catalog";

describe("public catalog boundary", () => {
	it("treats a valid empty catalog as ready instead of a gateway failure", () => {
		const result = parsePublicCatalogResponse({
			object: "list",
			data: [],
			billing_currency: "usd",
			generated_at: "2026-08-30T00:00:00.000Z",
		});

		assert.equal(result.status, "ready");
		assert.deepEqual(result.models, []);
		assert.equal(result.billingCurrency, "USD");
		assert.equal(result.generatedAt, "2026-08-30T00:00:00.000Z");
	});

	it("sanitizes a valid public model and preserves billing metadata", () => {
		const result = parsePublicCatalogResponse({
			billing_currency: "cny",
			generated_at: "2026-08-27T00:00:00.000Z",
			data: [
				{
					id: "vendor/model",
					display_name: "Model",
					vendor: "vendor",
					protocols: ["openai", "unknown"],
					recommended_protocol: "openai",
					context_window: 128000,
					pricing_profile: {
						tiers: [{ upto: null, input_price: 1, output_price: 3 }],
					},
					input_modalities: ["text"],
					output_modalities: ["text"],
					released_at: "2026-08-01",
					endpoint_slugs: ["provider/turbo", "https://must-not-pass.example"],
					regions: ["eu", "../unsafe"],
					data_policy_summary: {
						verified_route_count: 2,
						zdr_available: true,
						latest_verified_at: "2026-08-28T00:00:00.000Z",
					},
				},
			],
		});

		assert.equal(result.status, "ready");
		assert.equal(result.billingCurrency, "CNY");
		assert.equal(result.models.length, 1);
		assert.equal(result.models[0]?.slug, "~dmVuZG9yL21vZGVs");
		assert.deepEqual(result.models[0]?.protocols, ["openai"]);
		assert.deepEqual(result.models[0]?.pricingProfile?.tiers[0], {
			upto: null,
			label: null,
			input_price: 1,
			output_price: 3,
			cache_read_price: null,
			cache_write_price: null,
			image_input_price: null,
			image_input_cache_price: null,
			image_output_price: null,
		});
		assert.deepEqual(result.models[0]?.endpointSlugs, ["provider/turbo"]);
		assert.deepEqual(result.models[0]?.regions, ["eu"]);
		assert.deepEqual(result.models[0]?.dataPolicySummary, {
			verifiedRouteCount: 2,
			zdrAvailable: true,
			latestVerifiedAt: "2026-08-28T00:00:00.000Z",
		});
	});

	it("accepts only bounded privacy-safe public model statistics", () => {
		const result = parsePublicModelStatsResponse(
			{
				range: "30d",
				minimum_sample_size: 20,
				data: [
					{
						id: "model",
						slug: "model",
						display_name: "Model",
						vendor: "Vendor",
						request_count: 50,
						success_rate: 98,
						avg_latency_ms: 120,
						output_tokens: 1000,
					},
				],
			},
			"7d"
		);
		assert.equal(result.status, "ready");
		assert.equal(result.range, "30d");
		assert.deepEqual(result.models[0], {
			id: "model",
			slug: "model",
			displayName: "Model",
			vendor: "Vendor",
			requestCount: 50,
			successRate: 98,
			avgLatencyMs: 120,
			outputTokens: 1000,
		});
		assert.equal(
			parsePublicModelStatsResponse(
				{
					data: [
						{
							id: "x",
							slug: "x",
							vendor: "v",
							request_count: 1,
							success_rate: 101,
							output_tokens: 0,
						},
					],
				},
				"7d"
			).models.length,
			0
		);
	});

	it("sanitizes one model detail and provider aggregates", () => {
		const detail = parsePublicCatalogModelResponse({
			billing_currency: "usd",
			data: {
				id: "model-safe",
				slug: "model-safe",
				vendor: "Vendor",
				protocols: ["openai"],
				recommended_protocol: "openai",
				metadata: { secret: "must-not-cross-boundary" },
			},
		});
		assert.equal(detail.status, "ready");
		assert.equal(detail.model?.slug, "model-safe");
		assert.equal("metadata" in (detail.model ?? {}), false);

		const providers = parsePublicCatalogProvidersResponse({
			billing_currency: "cny",
			data: [
				{
					id: "vendor",
					display_name: "Vendor",
					model_count: 2,
					protocols: ["openai", "smtp"],
					output_modalities: ["text"],
					latest_released_at: "2026-08-20",
				},
			],
		});
		assert.equal(providers.status, "ready");
		assert.equal(providers.billingCurrency, "CNY");
		assert.deepEqual(providers.providers[0], {
			id: "vendor",
			displayName: "Vendor",
			modelCount: 2,
			protocols: ["openai"],
			routeGroups: [],
			inputModalities: [],
			outputModalities: ["text"],
			latestReleasedAt: "2026-08-20",
		});
	});

	it("rejects malformed responses and models without a supported protocol", () => {
		assert.equal(parsePublicCatalogResponse(null).status, "unavailable");
		assert.deepEqual(
			parsePublicCatalogResponse({ data: [{ id: "x", protocols: ["smtp"] }] })
				.models,
			[]
		);
	});

	it("accepts only credential-free HTTP origins", () => {
		assert.equal(
			resolvePublicApiOrigin("https://gateway.example/path"),
			"https://gateway.example"
		);
		assert.equal(
			resolvePublicApiOrigin("https://user:secret@gateway.example"),
			"https://api.cinatoken.com"
		);
		assert.equal(
			resolvePublicApiOrigin("file:///tmp/catalog.json"),
			"https://api.cinatoken.com"
		);
	});
});

function publicPricing(profile: unknown) {
	return parsePublicCatalogModelResponse({
		billing_currency: "EUR",
		data: {
			id: "vendor/model",
			vendor: "vendor",
			protocols: ["openai"],
			pricing_profile: profile,
		},
	}).model?.pricingProfile;
}

it("preserves complete token tiers, finite negative/cache prices and zero image fields without private data", () => {
	const profile = publicPricing({
		tiers: [
			{
				upto: 20,
				label: "published tier",
				input_price: -0.000000001,
				output_price: 0,
				cache_read_price: -0.5,
				cache_write_price: 0,
				image_input_price: 0,
				image_input_cache_price: 0.125,
				image_output_price: 1.5,
				supplier_cost: 999,
				credentials: "secret",
			},
			{ upto: null, input_price: 2, output_price: 3 },
		],
		audio_billing_mode: "token",
		supplier_cost: 123,
		credentials: "secret",
	});
	assert.equal(profile?.audio_billing_mode, "token");
	assert.deepEqual(profile?.tiers[0], {
		upto: 20,
		label: "published tier",
		input_price: -0.000000001,
		output_price: 0,
		cache_read_price: -0.5,
		cache_write_price: 0,
		image_input_price: 0,
		image_input_cache_price: 0.125,
		image_output_price: 1.5,
	});
	assert.equal(JSON.stringify(profile).includes("secret"), false);
	assert.equal(JSON.stringify(profile).includes("supplier_cost"), false);
});

it("keeps image quality/size/reference maps and uncertainty policy without activating legacy billing", () => {
	const image = {
		default: 0.000000001,
		by_quality: { high: 0.2 },
		by_size: { "1024x1024": 0.3 },
		by_quality_size: { "high:1024x1024": 0.4 },
		input: { default: 0, by_quality: { high: 0.01 } },
		uncertain_result_policy: "zero",
	};
	assert.deepEqual(publicPricing({ image_billing_mode: "per_image", image }), {
		tiers: [],
		image_billing_mode: "per_image",
		image,
	});
	const legacy = publicPricing({
		tiers: [{ upto: null, input_price: 1, output_price: 2 }],
		image,
	});
	assert.equal(legacy?.image_billing_mode, undefined);
	assert.deepEqual(legacy?.image, image);
});

it("preserves fractional audio minimum seconds and integer minimum characters in their true modes", () => {
	for (const [mode, audio] of [
		["per_second", { price_per_second: 0.000000001, minimum_seconds: 1.5 }],
		["per_character", { price_per_character: 0, minimum_characters: 20 }],
	] as const) {
		assert.deepEqual(publicPricing({ audio_billing_mode: mode, audio }), {
			tiers: [],
			audio_billing_mode: mode,
			audio,
		});
	}
});

it("uses Core constraints for malformed modes and tier bounds instead of silently changing their meaning", () => {
	const tier = { upto: null, input_price: 1, output_price: 2 };
	for (const profile of [
		{ audio_billing_mode: "tokens", tiers: [tier] },
		{ tiers: [tier, tier] },
		{ tiers: [{ ...tier, image_input_price: -1 }] },
	])
		assert.equal(publicPricing(profile), null);
	// Core drops an invalid audio block while keeping the declared profile mode.
	// The UI must treat the absent price as unavailable, rather than inventing zero.
	assert.deepEqual(
		publicPricing({
			audio_billing_mode: "per_character",
			audio: { price_per_character: 1, minimum_characters: 1.5 },
		}),
		{ tiers: [], audio_billing_mode: "per_character" }
	);
});

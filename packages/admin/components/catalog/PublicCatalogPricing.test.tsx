import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import ja from "../../messages/ja.json";
import ko from "../../messages/ko.json";
import { parsePublicCatalogResponse } from "../../lib/public-catalog";
import {
	PublicCatalogPriceSummary,
	PublicCatalogPricingDetails,
} from "./PublicCatalogPricing";
import {
	catalogPriceRows,
	compareCatalogPrices,
	formatCatalogMoney,
} from "./public-catalog-pricing";
import PublicModelsPage from "./PublicModelsPage";
import PublicModelDetail from "./PublicModelDetail";
import PublicComparePage from "./PublicComparePage";

const catalog = (pricing: unknown) =>
	parsePublicCatalogResponse({
		billing_currency: "EUR",
		generated_at: "2026-09-27T00:00:00Z",
		data: [
			{
				id: "vendor/model",
				vendor: "Vendor",
				display_name: "Model",
				protocols: ["openai"],
				recommended_protocol: "openai",
				pricing_profile: pricing,
			},
		],
	});
const token = {
	tiers: [
		{
			upto: null,
			input_price: -0.000000001,
			output_price: 0,
			cache_read_price: -0.5,
			cache_write_price: 0.000000002,
			image_input_price: 0.2,
			image_input_cache_price: 0,
			image_output_price: 0.3,
		},
	],
	audio_billing_mode: "token",
};
const image = {
	image_billing_mode: "per_image",
	image: {
		default: 0.000000001,
		by_quality: { high: 0.2 },
		by_size: { "1024x1024": 0.3 },
		by_quality_size: { "high:1024x1024": 0.4 },
		input: { default: 0.01 },
		uncertain_result_policy: "zero",
	},
};

for (const [locale, messages] of Object.entries({ en, zh, ja, ko })) {
	test(`actual SSR pricing preserves cache/image fields, currency, negative/zero/tiny prices in ${locale}`, () => {
		const profile = catalog(token).models[0].pricingProfile;
		const html = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				messages={messages}
				timeZone="UTC"
			>
				<PublicCatalogPriceSummary profile={profile} currency="EUR" />
				<PublicCatalogPricingDetails profile={profile} currency="EUR" />
			</NextIntlClientProvider>
		);
		for (const field of [
			"cache_read_price",
			"cache_write_price",
			"image_input_price",
			"image_input_cache_price",
			"image_output_price",
		] as const)
			assert.ok(html.includes(messages.publicPricing[field]));
		assert.ok(html.includes(formatCatalogMoney(-0.000000001, "EUR", locale)));
		assert.ok(html.includes(formatCatalogMoney(0, "EUR", locale)));
		assert.ok(html.includes(messages.publicPricing.perMillion));
		assert.equal(html.includes("USD"), false);
	});
	test(`actual SSR multimodal maps and minimums are displayed in ${locale}`, () => {
		const profiles = [
			image,
			{
				audio_billing_mode: "per_second",
				audio: { price_per_second: 0.000000001, minimum_seconds: 1.5 },
			},
			{
				audio_billing_mode: "per_character",
				audio: { price_per_character: 0, minimum_characters: 20 },
			},
		].map((value) => catalog(value).models[0].pricingProfile);
		const html = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				messages={messages}
				timeZone="UTC"
			>
				{profiles.map((profile, i) => (
					<PublicCatalogPricingDetails
						key={i}
						profile={profile}
						currency="EUR"
					/>
				))}
			</NextIntlClientProvider>
		);
		for (const key of [
			"by_quality",
			"by_size",
			"by_quality_size",
			"reference",
			"zero",
			"perSecond",
			"perCharacter",
		] as const)
			assert.ok(html.includes(messages.publicPricing[key]));
		assert.ok(html.includes("high:1024x1024"));
		assert.ok(html.includes("20"));
		assert.equal(html.includes(messages.publicPricing.perMillion), false);
	});
}

test("legacy blocks never override the real token rate and unit groups never compare raw image/second values against tokens", () => {
	const tier = { upto: null, input_price: 2, output_price: 3 };
	const legacy = catalog({
		tiers: [tier],
		image: { default: 999 },
		audio: { price_per_second: 888 },
	}).models[0].pricingProfile;
	assert.deepEqual(catalogPriceRows(legacy), [
		{ unit: "token", input: 2, output: 3 },
	]);
	const perImage = catalog(image).models[0].pricingProfile;
	assert.equal(
		Math.sign(compareCatalogPrices(perImage, legacy)),
		Math.sign("image".localeCompare("token"))
	);
	const cheapToken = catalog(token).models[0].pricingProfile;
	assert.ok(compareCatalogPrices(cheapToken, legacy) < 0);
	assert.ok(compareCatalogPrices(null, legacy) > 0);
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<PublicCatalogPricingDetails profile={legacy} currency="EUR" />
		</NextIntlClientProvider>
	);
	assert.ok(html.includes(en.publicPricing.legacyImage));
	assert.equal(html.includes("999"), false);
	assert.equal(html.includes("888"), false);
});

test("all three existing SSR pages consume the shared pricing UI with true units and a detailed comparison", () => {
	const result = catalog(image);
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<PublicModelsPage catalog={result} />
			<PublicModelDetail
				result={{
					status: "ready",
					model: result.models[0],
					billingCurrency: result.billingCurrency,
					generatedAt: result.generatedAt,
				}}
			/>
			<PublicComparePage catalog={result} />
		</NextIntlClientProvider>
	);
	assert.ok(html.includes("EUR"));
	assert.ok(html.includes("0.000000001"));
	assert.ok((html.match(/high:1024x1024/g) ?? []).length >= 2);
	assert.ok(html.includes("<details"));
});

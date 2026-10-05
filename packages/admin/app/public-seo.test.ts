import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	PublicCatalogModel,
	PublicCatalogResult,
} from "@/lib/public-catalog";
import {
	publicModelPath,
	publicPageMetadata,
	publicRobots,
	publicSiteOrigin,
	publicSitemap,
} from "./public-seo";

const ORIGIN = "https://cinatoken.com";
const model = (vendor: string, slug: string): PublicCatalogModel => ({
	id: `${vendor}/${slug}`,
	slug,
	displayName: slug,
	vendor,
	contextWindow: null,
	maxTokens: null,
	pricingProfile: null,
	tags: [],
	routeGroups: [],
	protocols: ["openai"],
	recommendedProtocol: "openai",
	description: null,
	inputModalities: [],
	outputModalities: [],
	releasedAt: null,
	endpointSlugs: [],
	regions: [],
	dataPolicySummary: {
		verifiedRouteCount: 0,
		zdrAvailable: false,
		latestVerifiedAt: null,
	},
});

describe("public SEO origin", () => {
	it("uses the configured canonical HTTPS origin, never a request Host", () => {
		assert.equal(publicSiteOrigin(undefined), ORIGIN);
		assert.equal(
			publicSiteOrigin("https://preview.example"),
			"https://preview.example"
		);
		for (const value of [
			"http://cinatoken.com",
			"https://cinatoken.com/",
			"https://cinatoken.com,https://attacker.example",
			"https://attacker.example/path",
			"https://user:pass@attacker.example",
			"https://attacker.example:444",
			"",
		]) {
			assert.equal(publicSiteOrigin(value), null, value);
		}
	});

	it("emits canonical and share metadata only for a safely indexable page", () => {
		const indexable = publicPageMetadata(
			"/models",
			"Models",
			"Published models",
			true,
			ORIGIN
		);
		assert.equal(indexable.alternates?.canonical, `${ORIGIN}/models`);
		assert.equal(indexable.openGraph?.url, `${ORIGIN}/models`);
		assert.equal(indexable.openGraph?.title, "Models");
		assert.deepEqual(indexable.twitter, {
			card: "summary",
			title: "Models",
			description: "Published models",
		});
		assert.deepEqual(indexable.robots, { index: true, follow: true });
		assert.equal(indexable.alternates?.languages, undefined);

		const chat = publicPageMetadata("/chat", "Chat", "Try chat", false, ORIGIN);
		assert.equal(chat.alternates, undefined);
		assert.deepEqual(chat.robots, { index: false, follow: true });

		const invalidOrigin = publicPageMetadata(
			"/models",
			"Models",
			"Published models",
			true,
			null
		);
		assert.equal(invalidOrigin.alternates, undefined);
		assert.deepEqual(invalidOrigin.robots, { index: false, follow: true });
	});
});

describe("public sitemap and robots", () => {
	it("lists only public indexable pages and distinct published model paths", () => {
		const catalog: PublicCatalogResult = {
			status: "ready",
			models: [
				model("anthropic", "claude:sonnet~4"),
				model("anthropic", "claude:sonnet~4"),
				model("../admin", "bad"),
			],
			billingCurrency: "USD",
			generatedAt: null,
		};
		const urls = publicSitemap(catalog, ORIGIN).map(({ url }) => url);
		assert.deepEqual(urls, [
			`${ORIGIN}/`,
			`${ORIGIN}/models`,
			`${ORIGIN}/providers`,
			`${ORIGIN}/compare`,
			`${ORIGIN}/rankings`,
			`${ORIGIN}/benchmarks`,
			`${ORIGIN}/models/anthropic/claude%3Asonnet~4`,
		]);
		assert.equal(
			urls.some((url) => url.includes("/chat") || url.includes("/account")),
			false
		);
	});

	it("retains static discovery URLs when the catalog is unavailable and fails closed on invalid origin", () => {
		const catalog: PublicCatalogResult = {
			status: "unavailable",
			models: [],
			billingCurrency: "USD",
			generatedAt: null,
		};
		assert.equal(publicSitemap(catalog, ORIGIN).length, 6);
		assert.deepEqual(publicSitemap(catalog, null), []);
		assert.deepEqual(publicRobots(null).rules, {
			userAgent: "*",
			disallow: "/",
		});
		assert.equal(publicRobots(ORIGIN).sitemap, `${ORIGIN}/sitemap.xml`);
	});

	it("rejects paths that cannot be a single published model route", () => {
		assert.equal(
			publicModelPath("openai", "gpt-5.4"),
			"/models/openai/gpt-5.4"
		);
		for (const [vendor, slug] of [
			["../admin", "model"],
			["OpenAI", "model"],
			["openai", ".."],
			["openai", "bad/slug"],
		]) {
			assert.equal(publicModelPath(vendor!, slug!), null);
		}
	});
});

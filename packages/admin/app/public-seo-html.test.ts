import assert from "node:assert/strict";
import { describe, it } from "node:test";

const base = process.env.CINATOKEN_SEO_TEST_BASE_URL;
const canonicalOrigin =
	process.env.CINATOKEN_SEO_TEST_CANONICAL_ORIGIN ?? "https://cinatoken.com";
const knownMissingModelPath = process.env.CINATOKEN_SEO_TEST_MISSING_MODEL_PATH;
const knownReadyModelPath = process.env.CINATOKEN_SEO_TEST_READY_MODEL_PATH;
const knownReadyModelName = process.env.CINATOKEN_SEO_TEST_READY_MODEL_NAME;
const unavailableModelPath =
	process.env.CINATOKEN_SEO_TEST_UNAVAILABLE_MODEL_PATH;

async function html(
	path: string,
	headers: Record<string, string> = {}
): Promise<{ status: number; head: string; body: string }> {
	if (!base) throw new Error("CINATOKEN_SEO_TEST_BASE_URL is required");
	const response = await fetch(new URL(path, base), {
		headers: {
			accept: "text/html",
			"user-agent": "facebookexternalhit/1.1",
			...headers,
		},
	});
	const body = await response.text();
	const head = body.split("</head>", 1)[0] ?? "";
	return { status: response.status, head, body };
}

describe("actual Next initial HTML SEO contract", { skip: !base }, () => {
	it("renders discovery metadata in the initial head without JavaScript", async () => {
		for (const path of [
			"/",
			"/models",
			"/providers",
			"/compare",
			"/rankings",
			"/benchmarks",
		]) {
			const response = await html(path);
			assert.equal(response.status, 200, path);
			assert.match(response.head, /<title>[^<]+<\/title>/u, path);
			assert.match(
				response.head,
				/<meta name="description" content="[^"]+"/u,
				path
			);
			assert.ok(
				response.head.includes(
					`rel="canonical" href="${canonicalOrigin}${path === "/" ? "" : path}"`
				),
				path
			);
			assert.match(
				response.head,
				/<meta property="og:title" content="[^"]+"/u,
				path
			);
			assert.match(
				response.head,
				/<meta name="twitter:card" content="summary"/u,
				path
			);
			assert.doesNotMatch(response.head, /hreflang=/u, path);
		}
	});

	it("keeps chat out of the index and returns a real 404 for invalid model segments", async () => {
		const chat = await html("/chat");
		assert.equal(chat.status, 200);
		assert.match(chat.head, /<meta name="robots" content="noindex, follow"/u);
		assert.doesNotMatch(chat.head, /rel="canonical"/u);

		const missing = await html("/models/INVALID_VENDOR/no-such-model");
		assert.equal(missing.status, 404);
		assert.match(missing.body, /<meta name="robots" content="noindex"/u);
	});

	it("keeps canonical on the configured origin across locale cookies and spoofed Host", async () => {
		for (const locale of ["en", "zh", "ja", "ko"]) {
			const localized = await html("/models", {
				cookie: `NEXT_LOCALE=${locale}`,
			});
			assert.equal(localized.status, 200, locale);
			assert.match(
				localized.body,
				new RegExp(`<html[^>]+lang="${locale}"`, "u")
			);
			assert.ok(
				localized.head.includes(
					`rel="canonical" href="${canonicalOrigin}/models"`
				),
				locale
			);
			assert.doesNotMatch(localized.head, /hreflang=/u, locale);
		}

		const spoofed = await html("/models", { host: "attacker.invalid" });
		assert.equal(spoofed.status, 200);
		assert.ok(
			spoofed.head.includes(`rel="canonical" href="${canonicalOrigin}/models"`)
		);
		assert.doesNotMatch(spoofed.head, /attacker\.invalid/u);
	});

	it(
		"returns HTTP 404 for a valid model path the catalog explicitly reports missing",
		{ skip: !knownMissingModelPath },
		async () => {
			const missing = await html(knownMissingModelPath!);
			assert.equal(missing.status, 404);
			assert.match(missing.body, /<meta name="robots" content="noindex"/u);
		}
	);

	it(
		"renders a published model in initial HTML and keeps an upstream outage out of the index",
		{
			skip:
				!knownReadyModelPath || !knownReadyModelName || !unavailableModelPath,
		},
		async () => {
			const ready = await html(knownReadyModelPath!);
			assert.equal(ready.status, 200);
			assert.ok(
				ready.head.includes(
					`rel="canonical" href="${canonicalOrigin}${knownReadyModelPath}"`
				)
			);
			assert.ok(
				ready.body.includes("<h1") &&
					ready.body.includes(`>${knownReadyModelName}</h1>`)
			);

			const unavailable = await html(unavailableModelPath!);
			assert.equal(unavailable.status, 200);
			assert.match(
				unavailable.head,
				/<meta name="robots" content="noindex, follow"/u
			);
			assert.doesNotMatch(unavailable.head, /rel="canonical"/u);
		}
	);

	it("serves robots and sitemap without private or fabricated locale URLs", async () => {
		const robots = await html("/robots.txt");
		assert.equal(robots.status, 200);
		assert.match(robots.body, /Disallow: \/account/u);
		assert.match(robots.body, /Disallow: \/gateway/u);
		assert.match(
			robots.body,
			new RegExp(`Sitemap: ${canonicalOrigin}/sitemap\\.xml`, "u")
		);

		const sitemap = await html("/sitemap.xml");
		assert.equal(sitemap.status, 200);
		assert.ok(sitemap.body.includes(`<loc>${canonicalOrigin}/models</loc>`));
		assert.doesNotMatch(
			sitemap.body,
			/<loc>[^<]*(?:\/account|\/chat|\/gateway)/u
		);
		assert.doesNotMatch(sitemap.body, /hreflang=/u);
	});
});

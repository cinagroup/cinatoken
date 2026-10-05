import assert from "node:assert/strict";
import test from "node:test";
import { createPublicCatalogApi } from "../../web/src/cinatoken/public/catalog-api";
import { GET as getModel } from "../app/api/public/catalog/model/[vendor]/[slug]/route";
import { GET as getModels } from "../app/api/public/catalog/models/route";
import { GET as getProviders } from "../app/api/public/catalog/providers/route";
import { GET as getStats } from "../app/api/public/catalog/stats/models/route";
import { GET as getLegacyStats } from "../app/api/public/stats/route";
import {
	createPublicCatalogBff,
	type CatalogBffResource,
} from "./public-catalog-bff";
import type { fetchPublicGateway } from "./public-gateway";

const tier = {
	upto: null,
	label: null,
	input_price: 2,
	output_price: 8,
	cache_read_price: 0,
	cache_write_price: 2.5,
	image_input_price: 1,
	image_input_cache_price: 0.2,
	image_output_price: 4,
};
const model = {
	id: "vendor/model",
	slug: "~dmVuZG9yL21vZGVs",
	display_name: null,
	vendor: "Vendor% Labs",
	context_window: null,
	max_tokens: 0,
	pricing_profile: { tiers: [tier], audio_billing_mode: "token" },
	tags: [],
	route_groups: ["default"],
	protocols: ["openai"],
	protocols_by_group: { default: ["openai"] },
	recommended_protocol: "openai",
	description: null,
	input_modalities: ["text", "image"],
	output_modalities: null,
	released_at: null,
	endpoint_slugs: ["vendor/region"],
	regions: ["US"],
	data_policy_summary: {
		verified_route_count: 1,
		zdr_available: true,
		latest_verified_at: null,
	},
};
const envelope = {
	object: "list",
	data: [model],
	billing_currency: "CNY",
	generated_at: "2026-09-27T02:00:00.000Z",
};
const stats = {
	object: "list",
	data: [
		{
			id: model.id,
			slug: model.slug,
			display_name: "Model",
			vendor: model.vendor,
			request_count: 20,
			success_rate: 95,
			avg_latency_ms: null,
			output_tokens: 0,
			total_tokens: 300,
		},
	],
	range: "7d",
	window_start: "2026-09-21T00:00:00.000Z",
	window_end: envelope.generated_at,
	minimum_sample_size: 20,
	generated_at: envelope.generated_at,
};
const request = (query = "", init: RequestInit = {}) =>
	new Request(`https://portal.example/api/public/catalog/models${query}`, init);

test("real anonymous client round trip through BFF strips credentials and internal fields while preserving rich prices", async () => {
	const published = {
		...envelope,
		secret: "private",
		data: [
			{
				...model,
				provider_key: "private",
				target_url: "private",
				pricing_profile: {
					tiers: [{ ...tier, cost: 1 }],
					audio_billing_mode: "token",
					image: {
						default: 0,
						by_quality_size: { "high:1024x1024": 0.3 },
						input: { default: 0.1 },
						uncertain_result_policy: "zero",
					},
					key: "private",
				},
				data_policy_summary: {
					...model.data_policy_summary,
					evidence_url: "private",
				},
			},
		],
	};
	const bff = createPublicCatalogBff(async (path, init, runtime) => {
		assert.equal(path, "/catalog/models?route_groups=default");
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "error");
		assert.deepEqual(
			[...new Headers(init?.headers)],
			[["accept", "application/json"]]
		);
		assert.equal(
			runtime?.request?.headers.get("cookie"),
			"portal=must-not-forward"
		);
		return Response.json(published, {
			headers: { "Set-Cookie": "bad=private", "X-Internal-Host": "private" },
		});
	});
	const api = createPublicCatalogApi((path, init) =>
		bff(
			"models",
			new Request(`https://portal.example${String(path)}`, {
				...init,
				headers: {
					...init?.headers,
					Cookie: "portal=must-not-forward",
					Authorization: "Bearer must-not-forward",
					"X-CinaToken-Workspace": "must-not-forward",
				},
			})
		)
	);
	const result = await api.models({ routeGroups: ["Default"] });
	assert.equal(result.billing_currency, "CNY");
	assert.equal(
		result.data[0]?.pricing_profile?.tiers[0]?.image_input_cache_price,
		0.2
	);
	assert.equal(
		result.data[0]?.pricing_profile?.image?.by_quality_size?.["high:1024x1024"],
		0.3
	);
	assert.equal(JSON.stringify(result).includes("private"), false);
	const response = await bff(
		"models",
		request("?route_groups=default", {
			headers: { Cookie: "portal=must-not-forward" },
		})
	);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("x-internal-host"), null);
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=60, stale-while-revalidate=300"
	);
});

test("per-image, per-second and per-character prices retain exact maps/minimums through BFF and browser schemas", async () => {
	for (const profile of [
		{
			tiers: [],
			image_billing_mode: "per_image",
			image: {
				default: 0,
				by_quality: { high: 0.2 },
				by_size: { "1024x1024": 0.3 },
				by_quality_size: { "high:1024x1024": 0.5 },
				input: { default: 0.1 },
				uncertain_result_policy: "requested",
			},
		},
		{
			tiers: [],
			audio_billing_mode: "per_second",
			audio: { price_per_second: 0.005, minimum_seconds: 1.5 },
		},
		{
			tiers: [],
			audio_billing_mode: "per_character",
			audio: { price_per_character: 0.00001, minimum_characters: 20 },
		},
	]) {
		const bff = createPublicCatalogBff(async () =>
			Response.json({
				...envelope,
				data: [{ ...model, pricing_profile: profile }],
			})
		);
		const api = createPublicCatalogApi((_input, init) =>
			bff("models", request("", init))
		);
		assert.deepEqual((await api.models()).data[0]?.pricing_profile, profile);
	}
});

test("Core-compatible negative token/cache prices and unsorted finite tiers survive the public boundary", async () => {
	const profile = {
		tiers: [
			{
				...tier,
				upto: 100,
				input_price: -1,
				output_price: -2,
				cache_read_price: -0.5,
				cache_write_price: -0.1,
			},
			{ ...tier, upto: 10 },
			tier,
		],
	};
	const bff = createPublicCatalogBff(async () =>
		Response.json({
			...envelope,
			data: [{ ...model, pricing_profile: profile }],
		})
	);
	const result = await createPublicCatalogApi((_input, init) =>
		bff("models", request("", init))
	).models();
	assert.deepEqual(result.data[0]?.pricing_profile, profile);
	const invalid = await createPublicCatalogBff(async () =>
		Response.json({
			...envelope,
			data: [
				{
					...model,
					pricing_profile: { tiers: [{ ...tier, image_input_price: -1 }] },
				},
			],
		})
	)("models", request());
	assert.equal(invalid.status, 502);
});

test("invalid and duplicate input never reaches the gateway or changes the selected resource", async () => {
	let requests = 0;
	const bff = createPublicCatalogBff(async () => {
		requests++;
		return Response.json(envelope);
	});
	for (const query of [
		"?url=https://evil.example",
		"?route_groups=a&route_groups=b",
		"?route_groups=",
		"?route_groups=a%0Ab",
		`?route_groups=${Array.from({ length: 33 }, () => "a").join(",")}`,
	])
		assert.equal((await bff("models", request(query))).status, 400);
	assert.equal((await bff("stats", request("?range=all"))).status, 400);
	assert.equal(
		(await bff("providers", request("?authorization=secret"))).status,
		400
	);
	assert.equal(
		(await bff("model", request(), { vendor: "Vendor", slug: "../private" }))
			.status,
		400
	);
	assert.equal(
		(await bff("model", request(), { vendor: "a/b", slug: model.slug })).status,
		400
	);
	assert.equal(
		(await bff("models", request("", { method: "POST" }))).status,
		405
	);
	assert.equal(requests, 0);
});

test("detail path preserves encoded percent vendor names and rejects another model identity", async () => {
	let captured = "";
	const bff = createPublicCatalogBff(async (path) => {
		captured = path;
		return Response.json({ ...envelope, object: "model", data: model });
	});
	assert.equal(
		(await bff("model", request(), { vendor: model.vendor, slug: model.slug }))
			.status,
		200
	);
	assert.equal(captured, "/catalog/models/Vendor%25%20Labs/~dmVuZG9yL21vZGVs");
	assert.equal(
		(await bff("model", request(), { vendor: "Other", slug: model.slug }))
			.status,
		502
	);
});

test("empty arrays stay valid but malformed success/duplicates/unknown currency fail closed", async () => {
	assert.equal(
		(
			await createPublicCatalogBff(async () =>
				Response.json({ ...envelope, data: [] })
			)("models", request())
		).status,
		200
	);
	for (const body of [
		{ data: [] },
		{ ...envelope, billing_currency: "usd" },
		{ ...envelope, data: [model, model] },
		{
			...envelope,
			data: [
				{
					...model,
					pricing_profile: { tiers: [tier], audio_billing_mode: "tokens" },
				},
			],
		},
	]) {
		const response = await createPublicCatalogBff(async () =>
			Response.json(body)
		)("models", request());
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("cache-control"), "no-store");
	}
});

for (const status of [401, 403, 404, 429, 503]) {
	test(`upstream ${status} survives without cached false success or private errors`, async () => {
		const bff = createPublicCatalogBff(async () =>
			Response.json(
				{ message: "private-key/internal-origin" },
				{
					status,
					headers: {
						"Retry-After": "60",
						"Set-Cookie": "private",
						"Cache-Control": "public, max-age=999999",
					},
				}
			)
		);
		for (const resource of ["stats", "legacy-stats"] as const) {
			const response = await bff(resource, request("?range=7d"));
			assert.equal(response.status, status);
			assert.equal(response.headers.get("retry-after"), "60");
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get("set-cookie"), null);
			assert.equal((await response.text()).includes("private"), false);
		}
	});
}

test("redirects, invalid JSON, oversized declared/streamed responses and network failures return safe no-store errors", async () => {
	for (const response of [
		new Response("", {
			status: 302,
			headers: { location: "https://private.example" },
		}),
		new Response("private html"),
		new Response("{", { headers: { "content-type": "application/json" } }),
		Response.json(envelope, {
			headers: { "content-length": String(17 * 1_024 * 1_024) },
		}),
	]) {
		const result = await createPublicCatalogBff(async () => response)(
			"models",
			request()
		);
		assert.equal(result.status, 502);
		assert.equal(result.headers.get("cache-control"), "no-store");
		assert.equal(result.headers.get("location"), null);
	}
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(17 * 1_024 * 1_024));
		},
		cancel() {
			cancelled = true;
		},
	});
	assert.equal(
		(
			await createPublicCatalogBff(
				async () =>
					new Response(stream, {
						headers: { "content-type": "application/json" },
					})
			)("models", request())
		).status,
		502
	);
	assert.equal(cancelled, true);
	const result = await createPublicCatalogBff(async () => {
		throw new Error("private origin");
	})("models", request());
	assert.equal(result.status, 502);
	assert.equal((await result.text()).includes("private"), false);
});

test("stats retain real totals/range/sample and preserve the old camel public UI response", async () => {
	const bff = createPublicCatalogBff(async (path) => {
		assert.equal(path, "/catalog/stats/models?range=7d");
		return Response.json(stats);
	});
	const modern = await bff("stats", request("?range=7d"));
	assert.equal(modern.headers.get("cache-control"), "public, max-age=60");
	assert.deepEqual(await modern.json(), stats);
	const legacy = await bff("legacy-stats", request("?range=7d"));
	assert.deepEqual(await legacy.json(), {
		status: "ready",
		range: "7d",
		windowStart: stats.window_start,
		windowEnd: stats.window_end,
		minimumSampleSize: 20,
		generatedAt: stats.generated_at,
		models: [
			{
				id: model.id,
				slug: model.slug,
				displayName: "Model",
				vendor: model.vendor,
				requestCount: 20,
				successRate: 95,
				avgLatencyMs: null,
				outputTokens: 0,
			},
		],
	});
	for (const invalid of [
		{ ...stats, range: "30d", data: [] },
		{ ...stats, minimum_sample_size: 1 },
		{ ...stats, data: [{ ...stats.data[0], request_count: 19 }] },
		{ ...stats, data: [{ ...stats.data[0], success_rate: 101 }] },
	])
		assert.equal(
			(
				await createPublicCatalogBff(async () => Response.json(invalid))(
					"stats",
					request("?range=7d")
				)
			).status,
			502
		);
});

test("pre-cancelled and late cancelled requests do not publish success", async () => {
	let called = false;
	const controller = new AbortController();
	controller.abort();
	const bff = createPublicCatalogBff(async () => {
		called = true;
		return Response.json(envelope);
	});
	assert.equal(
		(await bff("models", request("", { signal: controller.signal }))).status,
		499
	);
	assert.equal(called, false);
	const late = new AbortController();
	assert.equal(
		(
			await createPublicCatalogBff(async () => {
				late.abort();
				return Response.json(envelope);
			})("models", request("", { signal: late.signal }))
		).status,
		499
	);
});

test("cancelling during body streaming cancels the reader rather than hanging or publishing a partial catalog", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const bff = createPublicCatalogBff(async () => {
		setTimeout(() => controller.abort(), 5);
		return new Response(stream, {
			headers: { "content-type": "application/json" },
		});
	});
	assert.equal(
		(await bff("models", request("", { signal: controller.signal }))).status,
		499
	);
	assert.equal(cancelled, true);
});

test(
	"ignored fetch signals and never-settling stream cancellation still have bounded responses",
	{ timeout: 1_000 },
	async () => {
		assert.equal(
			(
				await createPublicCatalogBff(
					() => new Promise<Response>(() => undefined),
					{ timeoutMs: 5 }
				)("models", request())
			).status,
			504
		);
		const controller = new AbortController();
		const pending = createPublicCatalogBff(
			() => new Promise<Response>(() => undefined)
		)("models", request("", { signal: controller.signal }));
		controller.abort();
		assert.equal((await pending).status, 499);
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
				return new Promise<void>(() => undefined);
			},
		});
		assert.equal(
			(
				await createPublicCatalogBff(
					async () =>
						new Response(stream, {
							headers: { "content-type": "application/json" },
						}),
					{ timeoutMs: 5 }
				)("models", request())
			).status,
			504
		);
		assert.equal(cancelled, true);
	}
);

test("legacy and new catalog HEAD preserve GET status/headers with no body", async () => {
	for (const resource of ["models", "legacy-stats"] as const) {
		const bff = createPublicCatalogBff(async (_path, init) => {
			assert.equal(init?.method, "GET");
			return Response.json(resource === "models" ? envelope : stats);
		});
		const get = await bff(resource, request());
		const head = await bff(resource, request("", { method: "HEAD" }));
		assert.equal(head.status, get.status);
		assert.deepEqual([...head.headers], [...get.headers]);
		assert.equal(await head.text(), "");
		const unavailable = await createPublicCatalogBff(async () =>
			Response.json({}, { status: 503, headers: { "Retry-After": "60" } })
		)(resource, request("", { method: "HEAD" }));
		assert.equal(unavailable.status, 503);
		assert.equal(unavailable.headers.get("retry-after"), "60");
		assert.equal(unavailable.headers.get("cache-control"), "no-store");
		assert.equal(await unavailable.text(), "");
	}
});

test("providers are sanitized aggregates rather than upstream connection records", async () => {
	const provider = {
		id: "vendor",
		display_name: "Vendor",
		model_count: 1,
		protocols: ["openai"],
		route_groups: ["default"],
		input_modalities: [],
		output_modalities: ["text"],
		latest_released_at: null,
	};
	const gateway: typeof fetchPublicGateway = async (path) => {
		assert.equal(path, "/catalog/providers");
		return Response.json({
			...envelope,
			data: [{ ...provider, base_url: "private", api_key: "private" }],
		});
	};
	const resource: CatalogBffResource = "providers";
	const response = await createPublicCatalogBff(gateway)(resource, request());
	assert.deepEqual(await response.json(), { ...envelope, data: [provider] });
});

test("all actual Next route handlers use the Proxy service binding with exact anonymous paths", async () => {
	const captured: Request[] = [];
	const provider = {
		id: "vendor",
		display_name: "Vendor",
		model_count: 1,
		protocols: ["openai"],
		route_groups: ["default"],
		input_modalities: [],
		output_modalities: ["text"],
		latest_released_at: null,
	};
	const service: Pick<Fetcher, "fetch"> = {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const sent = new Request(input, init);
			captured.push(sent);
			const url = new URL(sent.url);
			if (url.pathname === "/catalog/providers")
				return Response.json({ ...envelope, data: [provider] });
			if (url.pathname === "/catalog/stats/models") return Response.json(stats);
			if (url.pathname === "/catalog/models") return Response.json(envelope);
			return Response.json({ ...envelope, object: "model", data: model });
		},
	};
	const boundRequest = (path: string) =>
		Object.assign(
			new Request(`https://portal.example${path}`, {
				headers: {
					Cookie: "must-not-forward",
					Authorization: "Bearer must-not-forward",
					"X-CinaToken-Workspace": "must-not-forward",
				},
			}),
			{ env: { CINATOKEN_PROXY_SERVICE: service } }
		);
	assert.equal(
		(await getModels(boundRequest("/api/public/catalog/models"))).status,
		200
	);
	assert.equal(
		(
			await getModel(
				boundRequest(
					"/api/public/catalog/model/Vendor%25%20Labs/~dmVuZG9yL21vZGVs"
				),
				{ params: Promise.resolve({ vendor: model.vendor, slug: model.slug }) }
			)
		).status,
		200
	);
	assert.equal(
		(await getProviders(boundRequest("/api/public/catalog/providers"))).status,
		200
	);
	assert.equal(
		(await getStats(boundRequest("/api/public/catalog/stats/models?range=7d")))
			.status,
		200
	);
	assert.equal(
		(await getLegacyStats(boundRequest("/api/public/stats?range=7d"))).status,
		200
	);
	assert.deepEqual(
		captured.map(
			(sent) => `${new URL(sent.url).pathname}${new URL(sent.url).search}`
		),
		[
			"/catalog/models",
			"/catalog/models/Vendor%25%20Labs/~dmVuZG9yL21vZGVs",
			"/catalog/providers",
			"/catalog/stats/models?range=7d",
			"/catalog/stats/models?range=7d",
		]
	);
	for (const sent of captured)
		assert.deepEqual([...sent.headers], [["accept", "application/json"]]);
});

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Controlled HTTP data follows public-http.fixture.ts. This is never an upstream
// for a deployed application and intentionally contains no users or credentials.
const model = {
	id: "vendor/http-fixture",
	slug: "http-fixture",
	display_name: "HTTP authority model",
	vendor: "Vendor",
	context_window: 128_000,
	max_tokens: 32_000,
	pricing_profile: {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: -0.000001,
				output_price: 0,
				cache_read_price: 0.0000001,
				cache_write_price: null,
				image_input_price: null,
				image_input_cache_price: null,
				image_output_price: null,
			},
		],
	},
	tags: ["http-proof"],
	route_groups: ["default"],
	protocols: ["openai"],
	protocols_by_group: { default: ["openai"] },
	recommended_protocol: "openai",
	description:
		"HTTP authority description </script><script>unsafe-marker</script>",
	input_modalities: ["text"],
	output_modalities: ["text"],
	released_at: null,
	endpoint_slugs: [],
	regions: [],
	data_policy_summary: {
		verified_route_count: 0,
		zdr_available: false,
		latest_verified_at: null,
	},
};
const generatedAt = "2026-10-02T00:00:00.000Z";
const catalogPath =
	/^\/api\/public\/catalog\/(?:models|providers|stats\/models|model\/[^/]+\/[^/]+)$/;

export function catalogResponse(url) {
	const common = { billing_currency: "SGD", generated_at: generatedAt };
	if (url.pathname.includes("/catalog/model/")) {
		const slug = decodeURIComponent(url.pathname.split("/").at(-1));
		if (slug === "unavailable")
			return { status: 503, body: { error: "fixture-unavailable" } };
		if (slug !== model.slug)
			return { status: 404, body: { error: "fixture-not-found" } };
		return { status: 200, body: { object: "model", data: model, ...common } };
	}
	if (url.pathname.endsWith("/providers"))
		return {
			status: 200,
			body: {
				object: "list",
				data: [
					{
						id: "Vendor",
						display_name: "HTTP authority provider",
						model_count: 1,
						protocols: ["openai"],
						route_groups: ["default"],
						input_modalities: ["text"],
						output_modalities: ["text"],
						latest_released_at: null,
					},
				],
				...common,
			},
		};
	if (url.pathname.includes("/stats/")) {
		const range = url.searchParams.get("range") ?? "7d";
		const days = { "7d": 7, "30d": 30, "90d": 90 }[range];
		if (!days) return { status: 400, body: { error: "fixture-invalid-range" } };
		const start = new Date(generatedAt);
		start.setUTCDate(start.getUTCDate() - days + 1);
		return {
			status: 200,
			body: {
				object: "list",
				data: [
					{
						id: model.id,
						slug: model.slug,
						display_name: model.display_name,
						vendor: model.vendor,
						request_count: 20,
						success_rate: 100,
						avg_latency_ms: 25,
						output_tokens: 10,
						total_tokens: 30,
					},
				],
				range,
				window_start: start.toISOString(),
				window_end: generatedAt,
				minimum_sample_size: 20,
				generated_at: generatedAt,
			},
		};
	}
	return { status: 200, body: { object: "list", data: [model], ...common } };
}

export function createCatalogFixtureServer() {
	const requests = [];
	const violations = [];
	const server = createServer((incoming, outgoing) => {
		const url = new URL(incoming.url ?? "/", "http://catalog-fixture.invalid");
		const observation = {
			method: incoming.method,
			path: catalogPath.test(url.pathname) ? url.pathname : "<rejected>",
			acceptIsJson: incoming.headers.accept === "application/json",
			hadCookie: incoming.headers.cookie !== undefined,
			hadAuthorization: incoming.headers.authorization !== undefined,
			hadWorkspace: incoming.headers["x-cinatoken-workspace"] !== undefined,
			hadBody:
				Number(incoming.headers["content-length"] ?? 0) !== 0 ||
				incoming.headers["transfer-encoding"] !== undefined,
		};
		const send = (status, value) => {
			outgoing.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
				...(status === 503 ? { "retry-after": "17" } : {}),
			});
			outgoing.end(
				incoming.method === "HEAD" ? undefined : JSON.stringify(value)
			);
		};
		if (
			!["GET", "HEAD"].includes(incoming.method) ||
			observation.hadCookie ||
			observation.hadAuthorization ||
			observation.hadWorkspace ||
			observation.hadBody
		) {
			violations.push(observation);
			incoming.resume();
			send(400, { error: "fixture-rejected-request" });
			return;
		}
		// A read-only audit on the owned internal network; no raw headers/body/query.
		if (url.pathname === "/__fixture/observations" && !url.search) {
			send(200, { requests, violations });
			return;
		}
		if (!catalogPath.test(url.pathname)) {
			violations.push(observation);
			send(404, { error: "fixture-unknown-path" });
			return;
		}
		requests.push(observation);
		try {
			const response = catalogResponse(url);
			send(response.status, response.body);
		} catch {
			send(400, { error: "fixture-invalid-path" });
		}
	});
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	server.keepAliveTimeout = 1_000;
	return { server, requests, violations };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const { server } = createCatalogFixtureServer();
	server.listen(8789, "0.0.0.0");
	const close = () => {
		server.close();
		server.closeIdleConnections();
	};
	process.once("SIGTERM", close);
	process.once("SIGINT", close);
}

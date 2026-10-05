import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type {
	GatewayRepositories,
	ModelRouteJoinRow,
	ModelWithRouteCountsRow,
	ProviderRow,
} from "@octafuse/core";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { expectedRealtimeSubject } from "@/lib/routes/admin/playground";
import { safePlaygroundWireJson } from "@/lib/playground/private-preview";
import {
	playgroundUploadLimits,
	validatePlaygroundUploads,
} from "@/lib/playground/uploads";
import { getPlaygroundContext } from "./playground-context-service";
import { previewPlaygroundRequest } from "./playground-preview-service";
import { invokePlaygroundUpstream } from "./playground-service";
import { AdminServiceError } from "./errors";

const originalFetch = globalThis.fetch;
const originalPair = Object.getOwnPropertyDescriptor(
	globalThis,
	"WebSocketPair"
);
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalPair)
		Object.defineProperty(globalThis, "WebSocketPair", originalPair);
	else Reflect.deleteProperty(globalThis, "WebSocketPair");
});
const execute: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:local",
	keyId: "local",
	permissions: ["playground.execute"],
};
const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:cinaauth:local-subject",
	username: "cinaauth:local-subject",
};

function fixture(operation = "chat", modalities: string[] = ["text"]) {
	let credentials = 0;
	let upstream = 0;
	const model: ModelWithRouteCountsRow = {
		id: "model-local",
		display_name: "Synthetic",
		vendor: "local",
		context_window: null,
		max_tokens: 1024,
		pricing_profile: null,
		tags: "[]",
		description: null,
		metadata: '{"secret":"model-private"}',
		input_modalities: '["text","unsupported"]',
		output_modalities: JSON.stringify(modalities),
		released_at: null,
		route_policy: null,
		created_at: "2026-10-01",
		routes_count: 1,
		active_routes_count: 0,
	};
	const provider: ProviderRow = {
		id: "provider-local",
		name: "Synthetic provider",
		status: "active",
		api_key: "arbitrary-provider-secret",
		description: null,
		created_at: "2026-10-01",
		endpoints: JSON.stringify({
			openai: {
				base: "https://user:pass@provider.example.invalid/v1?key=url-secret",
			},
		}),
	};
	const row: ModelRouteJoinRow = {
		id: "route-local",
		model_id: model.id,
		provider_id: provider.id,
		provider_model_name: "upstream-model",
		priority: 1,
		status: "disabled",
		route_group: "default",
		price_override: '{"input":1.25,"opaque":"price-secret"}',
		custom_params:
			'{"max_tokens":99,"temperature":0.5,"opaque":"arbitrary-default-secret","authorization":"Bearer credential-secret"}',
		routing_metadata: '{"secret":"routing-private"}',
		upstream_protocol: "openai",
		upstream_operation: operation,
		adapter: "passthrough",
		route_pool_id: "pool-local",
		pool_name: "Local pool",
		pool_strategy: "random",
		pool_tier_strategies: null,
		pool_status: "active",
		model_name: model.display_name,
		provider_name: provider.name,
		provider_status: "active",
		surfaces:
			'[{"id":"s-local","request_protocol":"openai","request_operation":"chat","status":"active","secret":"surface-private"}]',
	};
	const config: Record<string, string> = {
		WEB_SEARCH_CATALOG:
			'{"bocha":{"apiKey":"search-secret"},"tavily":{"apiKey":"inactive-secret"}}',
		WEB_SEARCH_ACTIVE: "bocha",
		WEB_FETCH_CATALOG: '{"jina":{"apiKey":"fetch-secret"}}',
		WEB_DEEP_SEARCH_CATALOG: '{"firecrawl":{"apiKey":"deep-secret"}}',
		AI_DETECTION_CATALOG:
			'{"tencent_tms":{"secretId":"tms-id-secret","secretKey":"tms-key-secret"}}',
	};
	const repos = {
		routes: {
			async getModelRouteRowById() {
				return row;
			},
			async listModelRoutesWithJoins() {
				return [row];
			},
		},
		providers: {
			async getProvidersByIds() {
				credentials++;
				return [provider];
			},
			async getProviderProtocolBases() {
				return { id: provider.id, endpoints: provider.endpoints };
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return model;
			},
			async listModelsWithRouteCounts() {
				return [model];
			},
		},
		systemConfig: {
			async getConfig(key: string) {
				return config[key] ?? null;
			},
		},
	} as unknown as GatewayRepositories;
	globalThis.fetch = async () => {
		upstream++;
		throw new Error("Unexpected provider call");
	};
	const app = createAdminApp();
	const request = (
		path: string,
		init?: RequestInit,
		principal: AdminPrincipal | null = execute
	) =>
		app.request(path, init, {
			STORAGE_CONTEXT: { repositories: repos },
			ADMIN_PRINCIPAL: principal ?? undefined,
		} as unknown as AdminBindings);
	return {
		repos,
		row,
		model,
		provider,
		config,
		request,
		credentials: () => credentials,
		upstream: () => upstream,
	};
}
const rejected = (status: number) => (error: unknown) =>
	error instanceof AdminServiceError && error.status === status;

test("execute-only context projects selection metadata, all ten engines and no credentials, config, prices or raw parameters", async () => {
	const f = fixture();
	const response = await f.request("/admin/playground/context");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const { data } = (await response.json()) as {
		data: Awaited<ReturnType<typeof getPlaygroundContext>>;
	};
	assert.equal(data.billing_currency, null);
	assert.equal(
		data.routes[0].status,
		"disabled",
		"inactive route diagnostics remain available"
	);
	assert.equal(data.routes[0].custom_params_preview, null);
	assert.equal(data.routes[0].price_override_preview, null);
	assert.equal(
		data.tools.reduce((sum, family) => sum + family.providers.length, 0),
		10
	);
	assert.equal(
		data.tools[0].providers.find((item) => item.provider === "tavily")
			?.configured,
		true
	);
	assert.equal(
		data.tools[0].providers.find((item) => item.provider === "tavily")?.active,
		false
	);
	assert.deepEqual(data.models[0].input_modalities, ["text"]);
	assert.doesNotMatch(
		JSON.stringify(data),
		/secret|routing-private|surface-private|model-private|api_key|endpoints|catalogRaw/u
	);
	assert.equal(f.credentials(), 0);
	assert.equal(f.upstream(), 0);
});

test("extra route read permission exposes only bounded parameter and numeric price projections; unavailable currency stays unavailable", async () => {
	const f = fixture();
	const principal = {
		...execute,
		permissions: ["playground.execute", "routes.read"],
	} satisfies AdminPrincipal;
	const context = await getPlaygroundContext(f.repos, principal);
	const params = JSON.parse(
		context.routes[0].custom_params_preview ?? "{}"
	) as Record<string, unknown>;
	assert.equal(params.max_tokens, 99, "token counts are ordinary parameters");
	assert.equal(params.opaque, "[redacted route parameter]");
	assert.doesNotMatch(
		JSON.stringify(context),
		/arbitrary-default-secret|credential-secret|price-secret/u
	);
	f.config.BILLING_CURRENCY = " cny ";
	assert.equal(
		(await getPlaygroundContext(f.repos, execute)).billing_currency,
		"CNY"
	);
	f.config.BILLING_CURRENCY = "invalid";
	assert.equal(
		(await getPlaygroundContext(f.repos, execute)).billing_currency,
		null
	);
	f.repos.systemConfig.getConfig = async () => {
		throw new Error("database error secret");
	};
	await assert.rejects(
		getPlaygroundContext(f.repos, execute),
		(error) => rejected(502)(error) && !String(error).includes("secret")
	);
});

test("pricing detail preserves authorized schedule times and enum metadata", async () => {
	const f = fixture();
	f.row.price_override =
		'{"charged_factor":1,"schedule":{"mode":"override","charged":[{"start":"09:00","end":"18:00","factor":0.5,"days":[1,2]}]}}';
	const context = await getPlaygroundContext(f.repos, {
		...execute,
		permissions: ["playground.execute", "routes.read"],
	});
	const pricing = JSON.parse(context.routes[0].price_override_preview ?? "{}");
	assert.equal(pricing.schedule.mode, "override");
	assert.equal(pricing.schedule.charged[0].start, "09:00");
});

test("Gemini preview marks deferred credential resolution and never exchanges OAuth or reads provider keys", async () => {
	const f = fixture("models.generate");
	f.row.upstream_protocol = "gemini";
	f.provider.endpoints =
		'{"gemini":{"base":"https://generativelanguage.googleapis.com/v1beta/models"}}';
	const preview = await previewPlaygroundRequest(f.repos, {
		routeId: f.row.id,
		body: { contents: [] },
	});
	assert.equal(preview.credential_resolution, "execution-only");
	assert.equal(preview.auth_resolution_deferred, true);
	f.provider.endpoints =
		'{"gemini":{"base":"https://gemini.example.invalid/models","auth":"bearer"}}';
	assert.equal(
		(
			await previewPlaygroundRequest(f.repos, {
				routeId: f.row.id,
				body: { contents: [] },
			})
		).auth_resolution_deferred,
		undefined
	);
	assert.equal(f.credentials(), 0);
	assert.equal(f.upstream(), 0);
});

test("preview merges defaults with user precedence and forced provider model without credential reads or upstream requests", async () => {
	const f = fixture();
	const preview = await previewPlaygroundRequest(f.repos, {
		routeId: f.row.id,
		body: { model: "wrong", temperature: 0.9, messages: [] },
	});
	assert.equal(preview.ready, true);
	assert.equal(preview.wire_format, "json");
	assert.equal(preview.preview_only, true);
	const wire = JSON.parse(preview.request_body_json) as Record<string, unknown>;
	assert.equal(wire.model, "upstream-model");
	assert.equal(wire.temperature, 0.9);
	assert.equal(wire.max_tokens, 99);
	assert.doesNotMatch(
		preview.upstream_url + preview.request_body_json,
		/user:pass|url-secret|arbitrary-default-secret|credential-secret/u
	);
	assert.equal(f.credentials(), 0);
	assert.equal(f.upstream(), 0);
});

test("image preview works before selection and reports binary upload summaries without allocating declared file bytes", async () => {
	const f = fixture("images.edits", ["image"]);
	const empty = await previewPlaygroundRequest(f.repos, {
		routeId: f.row.id,
		body: { prompt: "synthetic" },
	});
	assert.equal(empty.ready, false);
	assert.equal(empty.missing_upload, "images");
	assert.equal(empty.wire_format, "multipart");
	const populated = await previewPlaygroundRequest(f.repos, {
		routeId: f.row.id,
		body: { prompt: "synthetic" },
		uploadManifest: {
			images: [
				{ name: "image.png", type: "image/png", size: 20 * 1024 * 1024 },
			],
		},
	});
	assert.equal(populated.ready, true);
	assert.match(populated.request_body_json, /20971520 bytes/u);
	assert.equal(f.upstream(), 0);
	assert.equal(f.credentials(), 0);
});

test("actual image multipart preserves File bytes and actual defaults while public metadata redacts defaults and provider headers", async () => {
	const f = fixture("images.edits", ["image"]);
	const binary = new Uint8Array(3 * 1024 * 1024);
	binary.set([1, 2, 3, 4]);
	const image = new File([binary], "image.png", { type: "image/png" });
	let calls = 0;
	globalThis.fetch = async (_url, init) => {
		calls++;
		assert.equal(init?.redirect, "manual");
		assert.ok(init?.body instanceof FormData);
		assert.equal(
			new Headers(init.headers).get("content-type"),
			null,
			"fetch creates the multipart boundary"
		);
		const uploaded = init.body.get("image") as File;
		assert.equal(uploaded.size, 3 * 1024 * 1024);
		assert.deepEqual(
			new Uint8Array(await uploaded.slice(0, 4).arrayBuffer()),
			new Uint8Array([1, 2, 3, 4])
		);
		return new Response('{"data":[]}', {
			headers: {
				"content-type": "application/json",
				"set-cookie": "secret",
				"x-debug": "secret",
			},
		});
	};
	const form = new FormData();
	form.set("routeId", f.row.id);
	form.set("body", '{"prompt":"synthetic"}');
	form.append("image", image);
	const response = await f.request("/admin/playground", {
		method: "POST",
		body: form,
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("x-debug"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(calls, 1);
	assert.deepEqual(await response.json(), { data: [] });
});

test("unknown operations and embeddings are explicit rejection, with no provider request", async () => {
	for (const operation of ["embeddings", "unknown.operation"]) {
		const f = fixture(operation);
		await assert.rejects(
			previewPlaygroundRequest(f.repos, { routeId: f.row.id, body: {} }),
			rejected(400)
		);
		await assert.rejects(
			invokePlaygroundUpstream(f.repos, { routeId: f.row.id, body: {} }),
			rejected(400)
		);
		assert.equal(f.upstream(), 0);
	}
});

test("auth, permission and expected-subject failures are private and precede malformed-body parsing", async () => {
	const f = fixture();
	const denied = { ...execute, permissions: [] } satisfies AdminPrincipal;
	for (const [principal, status] of [
		[null, 401],
		[denied, 403],
	] as const) {
		const response = await f.request(
			"/admin/playground",
			{
				method: "POST",
				body: "malformed",
				headers: { "Content-Type": "multipart/form-data" },
			},
			principal
		);
		assert.equal(response.status, status);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const mismatch = await f.request(
		"/admin/playground/preview",
		{
			method: "POST",
			body: "malformed",
			headers: { "X-CinaToken-Expected-Console-Subject": "different-subject" },
		},
		consolePrincipal
	);
	assert.equal(mismatch.status, 403);
	assert.equal(
		((await mismatch.json()) as { code: string }).code,
		"console_subject_mismatch"
	);
	assert.equal(f.credentials(), 0);
	assert.equal(f.upstream(), 0);
});

test("JSON and neighboring APIs retain 2 MiB while only invoke multipart exceeds it; malformed/repeated/tool uploads reject", async () => {
	const f = fixture();
	const oversized = JSON.stringify({
		routeId: f.row.id,
		body: { prompt: "x".repeat(2 * 1024 * 1024) },
	});
	for (const path of [
		"/admin/playground",
		"/admin/playground/preview",
		"/admin/providers",
	]) {
		const response = await f.request(path, {
			method: "POST",
			body: oversized,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(Buffer.byteLength(oversized)),
			},
		});
		assert.equal(response.status, 413);
	}
	for (const extra of ["toolId", "unknown", "duplicate"]) {
		const form = new FormData();
		form.set("routeId", f.row.id);
		form.set("body", "{}");
		if (extra === "duplicate") form.append("routeId", f.row.id);
		else form.set(extra, "web-search");
		const response = await f.request("/admin/playground", {
			method: "POST",
			body: form,
		});
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const malformed = await f.request("/admin/playground", {
		method: "POST",
		body: "broken",
		headers: { "Content-Type": "multipart/form-data; boundary=missing" },
	});
	assert.equal(malformed.status, 400);
	const nullBody = await f.request("/admin/playground", {
		method: "POST",
		body: "null",
	});
	assert.equal(nullBody.status, 400);
	assert.equal(f.upstream(), 0);
});

test("runtime upload limits differ honestly and reject type, empty file, count and aggregate violations", () => {
	Reflect.deleteProperty(globalThis, "WebSocketPair");
	assert.equal(
		playgroundUploadLimits().multipart_body_bytes,
		104 * 1024 * 1024
	);
	assert.equal(playgroundUploadLimits().image_total_bytes, 100 * 1024 * 1024);
	const fake = (size: number, type = "image/png") =>
		({ name: "image.png", type, size } as File);
	validatePlaygroundUploads({
		images: Array.from({ length: 5 }, () => fake(20 * 1024 * 1024)),
	});
	Object.defineProperty(globalThis, "WebSocketPair", {
		configurable: true,
		value: class {},
	});
	assert.equal(playgroundUploadLimits().multipart_body_bytes, 36 * 1024 * 1024);
	assert.equal(playgroundUploadLimits().image_total_bytes, 32 * 1024 * 1024);
	for (const images of [
		[fake(0)],
		[fake(20 * 1024 * 1024 + 1)],
		[fake(20 * 1024 * 1024), fake(20 * 1024 * 1024)],
		[fake(1, "text/plain")],
		Array.from({ length: 6 }, () => fake(1)),
	])
		assert.throws(() => validatePlaygroundUploads({ images }), rejected(400));
});

test("metadata bounds encoded multibyte body and protects outer failures for exact new context/key routes", () => {
	const wire = safePlaygroundWireJson(
		JSON.stringify({ text: "中😀".repeat(20_000), max_tokens: 999 })
	);
	assert.ok(encodeURIComponent(wire).length <= 6144);
	assert.equal(JSON.parse(wire).__playground_truncated, true);
	for (const path of [
		"/api/admin/playground/context",
		"/api/admin/playground/preview",
		"/api/admin/playground/realtime",
		"/api/admin/simulator/context",
		"/api/admin/keys/key-local/verify-secret",
	]) {
		for (const status of [401, 403, 413, 500, 502]) {
			const response = protectAdminConfigResponse(
				new Request("https://admin.example.invalid" + path),
				new Response("", { status })
			);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
		}
	}
	assert.equal(
		protectAdminConfigResponse(
			new Request(
				"https://admin.example.invalid/api/admin/simulator/context-neighbor"
			),
			new Response("")
		).headers.get("cache-control"),
		null
	);
});

test("WebSocket subject encoding is canonical and never requires subject in URL", () => {
	const subject = encodeURIComponent("opaque-subject%中文");
	const token = btoa(subject)
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/u, "");
	assert.equal(
		expectedRealtimeSubject(
			"cinatoken-playground, cinatoken-playground-subject." + token
		),
		subject
	);
	assert.equal(expectedRealtimeSubject(undefined), undefined);
	for (const value of [
		"cinatoken-playground-subject.=",
		"cinatoken-playground-subject.x,cinatoken-playground-subject.x",
	])
		assert.throws(() => expectedRealtimeSubject(value));
});

test("actual JSON bytes are bounded with dishonest or missing Content-Length and parsing errors remain private 413", async () => {
	const f = fixture();
	const raw = JSON.stringify({
		routeId: f.row.id,
		body: { prompt: "x".repeat(2 * 1024 * 1024) },
	});
	const dishonest = await f.request("/admin/playground", {
		method: "POST",
		body: raw,
		headers: { "Content-Type": "application/json", "Content-Length": "1" },
	});
	assert.equal(dishonest.status, 413);
	assert.equal(dishonest.headers.get("cache-control"), "private, no-store");
	const chunked = await f.request("/admin/playground/preview", {
		method: "POST",
		body: raw,
		headers: { "Content-Type": "application/json" },
	});
	assert.equal(chunked.status, 413);
	assert.equal(chunked.headers.get("cache-control"), "private, no-store");
	assert.equal(f.upstream(), 0);
	assert.equal(f.credentials(), 0);
});

test("cancel during a stalled upload stops parsing, cancels the body without acknowledgement and cannot fetch", async () => {
	const f = fixture(),
		controller = new AbortController();
	let reading = false,
		discarded = false;
	const stream = new ReadableStream<Uint8Array>({
		pull() {
			reading = true;
			return new Promise(() => {});
		},
		cancel() {
			discarded = true;
			return new Promise(() => {});
		},
	});
	const pending = f.request("/admin/playground", {
		method: "POST",
		body: stream,
		signal: controller.signal,
		headers: { "Content-Type": "multipart/form-data; boundary=local" },
		duplex: "half",
	} as RequestInit);
	const deadline = performance.now() + 3000;
	while (!reading) {
		if (performance.now() > deadline)
			throw new Error("Local upload observation timeout");
		await nextTurn();
	}
	controller.abort();
	const response = await pending;
	assert.equal(response.status, 499);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(discarded, true);
	assert.equal(f.upstream(), 0);
	assert.equal(f.credentials(), 0);
});

test("realtime preview uses the same operation URL and event merge without requiring native WebSocketPair or credentials", async () => {
	const f = fixture("audio.transcriptions.realtime.session", ["transcription"]);
	f.row.upstream_protocol = "dashscope";
	f.row.custom_params =
		'{"session":{"sample_rate":16000},"opaque":"realtime-private"}';
	f.provider.endpoints =
		'{"dashscope":{"base":"https://dashscope.example.invalid/api/v1"}}';
	const result = await previewPlaygroundRequest(f.repos, {
		routeId: f.row.id,
		body: { type: "session.update", session: { voice: "synthetic" } },
	});
	assert.equal(result.ready, true);
	assert.equal(result.wire_format, "json");
	const wire = JSON.parse(result.request_body_json);
	assert.deepEqual(wire.session, { sample_rate: 16000, voice: "synthetic" });
	assert.match(result.upstream_url, /model=/u);
	assert.doesNotMatch(result.request_body_json, /realtime-private/u);
	assert.equal(f.credentials(), 0);
	assert.equal(f.upstream(), 0);
});

test("unauthorized Playground parser never reads or locks a request body", async () => {
	const f = fixture();
	let reads = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull() {
				reads++;
				throw new Error("must not parse unauthorized input");
			},
		},
		{ highWaterMark: 0 }
	);
	const response = await f.request(
		"/admin/playground",
		{
			method: "POST",
			body: stream,
			duplex: "half",
			headers: { "Content-Type": "multipart/form-data; boundary=local" },
		} as RequestInit,
		{ ...execute, permissions: [] }
	);
	assert.equal(response.status, 403);
	assert.equal(reads, 0);
	assert.equal(stream.locked, false);
});

test("OpenAI Responses retains actual custom defaults while metadata redacts them and upstream auth failure remains an invoke result", async () => {
	const f = fixture("responses");
	let requests = 0;
	globalThis.fetch = async (url, init) => {
		requests++;
		assert.match(String(url), /\/responses/u);
		const wire = JSON.parse(String(init?.body));
		assert.equal(wire.opaque, "arbitrary-default-secret");
		assert.equal(wire.model, "upstream-model");
		assert.equal(wire.max_tokens, 99);
		return Response.json(
			{ error: "synthetic provider auth failure" },
			{ status: 401, headers: { "set-cookie": "provider=secret" } }
		);
	};
	const response = await f.request("/admin/playground", {
		method: "POST",
		body: JSON.stringify({
			routeId: f.row.id,
			body: { input: "synthetic", store: false },
		}),
		headers: { "Content-Type": "application/json" },
	});
	assert.equal(response.status, 401);
	assert.equal(response.headers.get("x-playground-mode"), "route");
	assert.equal(
		response.headers.get("x-playground-upstream-outcome"),
		"unknown"
	);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.doesNotMatch(
		decodeURIComponent(response.headers.get("x-playground-request-body") ?? ""),
		/arbitrary-default-secret|credential-secret/u
	);
	assert.equal(requests, 1);
	await response.body?.cancel();
});

test("OpenAI ASR binary multipart preserves audio and parameters without a data URL roundtrip", async () => {
	const f = fixture("audio.transcriptions", ["transcription"]);
	const audio = new File([new Uint8Array([82, 73, 70, 70])], "speech.wav", {
		type: "audio/wav",
	});
	globalThis.fetch = async (_url, init) => {
		assert.ok(init?.body instanceof FormData);
		assert.equal(init.body.get("model"), "upstream-model");
		assert.equal(init.body.get("language"), "zh");
		assert.equal(init.body.get("response_format"), "json");
		assert.deepEqual(
			new Uint8Array(await (init.body.get("file") as File).arrayBuffer()),
			new Uint8Array([82, 73, 70, 70])
		);
		return Response.json({ text: "synthetic transcript" });
	};
	const form = new FormData();
	form.set("routeId", f.row.id);
	form.set("body", '{"language":"zh","response_format":"json"}');
	form.set("file", audio);
	const response = await f.request("/admin/playground", {
		method: "POST",
		body: form,
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { text: "synthetic transcript" });
	assert.match(
		decodeURIComponent(response.headers.get("x-playground-request-body") ?? ""),
		/4 bytes, audio\/wav/u
	);
});

test("DashScope synchronous file upload builds the provider native JSON once and respects its encoded size limit", async () => {
	const f = fixture("audio.transcriptions.multimodal", ["transcription"]);
	f.row.upstream_protocol = "dashscope";
	f.row.adapter = "dashscope-asr-fun-file";
	f.provider.endpoints =
		'{"dashscope":{"base":"https://dashscope.example.invalid/api/v1"}}';
	globalThis.fetch = async (_url, init) => {
		const wire = JSON.parse(String(init?.body));
		assert.equal(wire.model, "upstream-model");
		assert.equal(
			wire.input.messages[0].content[0].audio,
			"data:audio/wav;base64,UklGRg=="
		);
		assert.equal(
			wire.parameters.opaque,
			"arbitrary-default-secret",
			"wire defaults remain unchanged"
		);
		return Response.json({ output: { text: "synthetic" } });
	};
	const result = await invokePlaygroundUpstream(f.repos, {
		routeId: f.row.id,
		body: {},
		uploads: {
			audio: new File([new Uint8Array([82, 73, 70, 70])], "speech.wav", {
				type: "audio/wav",
			}),
		},
	});
	assert.doesNotMatch(
		result.upstreamWireBodyJson,
		/UklGRg==|arbitrary-default-secret|credential-secret/u
	);
	await result.response.body?.cancel();
	await assert.rejects(
		previewPlaygroundRequest(f.repos, {
			routeId: f.row.id,
			body: {},
			uploadManifest: {
				audio: { name: "speech.wav", type: "audio/wav", size: 8 * 1024 * 1024 },
			},
		}),
		rejected(400)
	);
});

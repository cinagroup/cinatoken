import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories, RequestLogRow } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { projectAdminRequestLogDetail } from "./request-log-detail-service";
import { listAdminGlobalRequestLogsService } from "./dashboard-service";

const row = (extra: Record<string, unknown> = {}): RequestLogRow =>
	({
		id: "request-1",
		user_id: "user-1",
		api_key_id: "gateway-key-1",
		workspace_id: "workspace-1",
		user_email: "owner@example.test",
		model_id: "vendor/model",
		provider_id: "provider-1",
		provider_model_name: "model",
		model_name: "Model",
		provider_name: "Provider",
		request_body: '{"secret":"sk-sensitive-value"}',
		upstream_request_body: '{"prompt":"private"}',
		request_protocol: "openai-chat",
		upstream_protocol: "openai-chat",
		request_operation: "chat",
		upstream_operation: "chat",
		input_tokens: 10,
		output_tokens: 20,
		cache_read_tokens: 3,
		cache_write_tokens: 4,
		reasoning_tokens: 5,
		total_tokens: 30,
		metered_cost: 0.01,
		standard_cost: 0.02,
		charged_cost: 0.03,
		charged_wallet_cost: 0.02,
		route_group: "shared-pool",
		status: "success",
		latency_ms: 100,
		gateway_overhead_ms: 10,
		upstream_response_ms: 90,
		final_upstream_headers_ms: 50,
		first_reasoning_token_ms: null,
		first_token_ms: 60,
		stream_duration_ms: 40,
		upstream_attempt_count: 1,
		upstream_failover_count: 0,
		timing_metadata: "private timing",
		error_message: "upstream leaked sk-sensitive",
		raw_usage: "raw private",
		pricing_audit: "economic private",
		provider_key_id: "sharedkey:key-1",
		provider_key_label: "private label",
		provider_key_fingerprint: "f".repeat(64),
		upstream_request_id: "upstream-request-1",
		upstream_message_id: "message-1",
		ingress_host: "Gateway.Example.test:8443",
		billing_kind: "tokens",
		input_image_count: 0,
		output_image_count: 0,
		audio_duration_seconds: null,
		audio_characters: null,
		created_at: "2026-09-30 01:02:03.123456+00",
		...extra,
	}) as RequestLogRow;
const named: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:reader",
	keyId: "reader",
	permissions: ["logs.read"],
};
function fixture(
	options: {
		principal?: AdminPrincipal | null;
		result?: RequestLogRow | null;
		missing?: boolean;
		fail?: boolean;
		failList?: boolean;
	} = {},
) {
	const failList = options.failList;
	const reads: string[] = [];
	let ordinaryReads = 0;
	const listOptions: Array<
		Parameters<GatewayRepositories["requestLogs"]["getRequestLogs"]>[0]
	> = [];
	const repositories = {
		requestLogs: {
			getAdminRequestLogById: options.missing
				? undefined
				: async (id: string) => {
						reads.push(id);
						if (options.fail) throw new Error("private SQL sk-sensitive-value");
						return options.result === undefined ? row() : options.result;
					},
			getRequestLogs: async (
				options: Parameters<
					GatewayRepositories["requestLogs"]["getRequestLogs"]
				>[0],
			) => {
				listOptions.push(options);
				ordinaryReads++;
				if (failList) throw new Error("private SQL sk-sensitive-value");
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === undefined
				? named
				: (options.principal ?? undefined),
	} as unknown as AdminBindings;
	return {
		reads,
		listOptions,
		ordinaryReads: () => ordinaryReads,
		request: (
			path = "/admin/request-logs/request-1",
			method = "GET",
			body?: string,
		) =>
			createAdminApp().request(
				path,
				{
					method,
					...(body === undefined
						? {}
						: {
								body,
								headers: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(body)),
								},
							}),
				},
				bindings,
			),
	};
}

test("exact logs.read lookup returns a safe whitelist including Shared Key ID without any first-page fallback", async () => {
	const f = fixture();
	const response = await f.request();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const data = ((await response.json()) as { data: Record<string, unknown> })
		.data;
	assert.deepEqual(f.reads, ["request-1"]);
	assert.equal(f.ordinaryReads(), 0);
	assert.equal(data.id, "request-1");
	assert.equal(data.provider_key_id, "sharedkey:key-1");
	assert.equal(data.api_key_id, "gateway-key-1");
	assert.equal(data.charged_wallet_cost, 0.02);
	assert.equal(data.ingress_host, "Gateway.Example.test:8443");
	assert.equal(data.created_at, "2026-09-30T01:02:03.123Z");
	for (const field of [
		"request_body",
		"upstream_request_body",
		"raw_usage",
		"pricing_audit",
		"timing_metadata",
		"route_trace",
		"provider_key_label",
		"provider_key_fingerprint",
		"error_message",
	])
		assert.ok(!Object.hasOwn(data, field), field);
	for (const value of ["sk-sensitive-value", "private", "f".repeat(64)])
		assert.ok(!JSON.stringify(data).includes(value), value);
});

test("request detail rejects empty, malformed IDs and all query parameters before storage", async () => {
	for (const path of [
		"/admin/request-logs/bad%20id",
		"/admin/request-logs/bad%2Fid",
		"/admin/request-logs/sk-secret-value",
		`/admin/request-logs/${"x".repeat(256)}`,
		"/admin/request-logs/request-1?request_id=request-1",
		"/admin/request-logs/request-1?page=1&page=2",
	]) {
		const f = fixture();
		const response = await f.request(path);
		assert.equal(response.status, 400, path);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.reads.length, 0);
		assert.equal(f.ordinaryReads(), 0);
	}
});

test("anonymous/permission denials and unavailable/missing/exact-ID mismatches stay private and do not become a list", async () => {
	for (const [options, expected] of [
		[{ principal: null }, 401],
		[{ principal: { ...named, permissions: ["analytics.read"] } }, 403],
		[{ missing: true }, 503],
		[{ result: null }, 404],
		[{ result: row({ id: "other-request" }) }, 500],
		[{ fail: true }, 500],
	] as const) {
		const f = fixture(options as Parameters<typeof fixture>[0]);
		const response = await f.request();
		assert.equal(response.status, expected);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.ordinaryReads(), 0);
		if (expected === 401 || expected === 403 || expected === 503)
			assert.equal(f.reads.length, 0);
		assert.ok(!(await response.text()).includes("sk-sensitive-value"));
	}
});

test("future fields and free text secret patterns cannot leak through the detail DTO", () => {
	const safe = projectAdminRequestLogDetail(
		row({
			futureSecret: "unlisted value",
			request_headers: "Bearer private",
			provider_name: "sk-sensitive-value",
			model_name: "f".repeat(64),
			upstream_request_id: "Bearer sk-secret",
			ingress_host: "sk-sensitive-value",
		}),
		"request-1",
	);
	assert.ok(!Object.hasOwn(safe, "futureSecret"));
	assert.ok(!Object.hasOwn(safe, "request_headers"));
	assert.equal(safe.provider_name, "[redacted]");
	assert.equal(safe.model_name, "[redacted]");
	assert.equal(safe.upstream_request_id, "[redacted]");
	assert.equal(safe.ingress_host, "[redacted]");
});

test("required counters/cost/calendar drift fails closed while safe SQL decimal costs are normalized", () => {
	const projected = projectAdminRequestLogDetail(
		row({ metered_cost: "0.010000", created_at: "2026-09-30 01:02:03" }),
		"request-1",
	);
	assert.equal(projected.metered_cost, 0.01);
	assert.equal(projected.created_at, "2026-09-30T01:02:03.000Z");
	for (const patch of [
		{ input_tokens: -1 },
		{ output_tokens: Number.MAX_SAFE_INTEGER + 1 },
		{ metered_cost: NaN },
		{ charged_cost: "NaN" },
		{ created_at: "2026-02-30T00:00:00.000Z" },
		{ latency_ms: -1 },
	])
		assert.throws(() => projectAdminRequestLogDetail(row(patch), "request-1"));
});

test("ordinary list semantics remain unchanged and new detail never interprets list filters", async () => {
	const f = fixture();
	assert.equal(
		(await f.request("/admin/request-logs?api_key_id=gateway-key-1&page=2"))
			.status,
		200,
	);
	assert.equal(f.ordinaryReads(), 1);
	assert.equal(f.reads.length, 0);
});

test("request-log child preflight/body-limit/setup failures retain private no-store", async () => {
	const f = fixture();
	const preflight = await f.request("/admin/request-logs/request-1", "OPTIONS");
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get("cache-control"), "private, no-store");
	const oversized = await f.request(
		"/admin/request-logs/request-1",
		"POST",
		JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }),
	);
	assert.equal(oversized.status, 413);
	assert.equal(oversized.headers.get("cache-control"), "private, no-store");
	assert.equal(f.reads.length, 0);
	const originalError = console.error;
	console.error = () => {};
	try {
		const failed = await createAdminApp().request(
			"/admin/request-logs/request-1",
			{},
			{ DATABASE_DRIVER: "invalid" },
		);
		assert.equal(failed.status, 500);
		assert.equal(failed.headers.get("cache-control"), "private, no-store");
	} finally {
		console.error = originalError;
	}
});

test("outer response classification includes all child failures and encoded paths without changing URLs or adjacent paths", () => {
	for (const path of [
		"/api/admin/request-logs/request-1",
		"/api/admin/request-logs/request-1/unknown",
		"/api/admin/%72equest-logs/request-1",
		"/api/admin/request-logs/%72equest-1",
		"/api/admin/%2572equest-logs/request-1",
	]) {
		for (const status of [200, 400, 401, 403, 404, 413, 500, 503]) {
			const request = new Request(`https://admin.example.test${path}`);
			const response = Response.json(
				{ success: false },
				{ status, headers: { "Cache-Control": "public, max-age=600" } },
			);
			assert.equal(protectAdminConfigResponse(request, response), response);
			assert.equal(response.status, status);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.equal(new URL(request.url).pathname, path);
		}
	}
	for (const path of [
		"/api/admin/request-logs-extra",
		"/api/admin/request-log",
		"/api/admin/other/request-logs",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			new Response("", { headers: { "Cache-Control": "public" } }),
		);
		assert.equal(response.headers.get("cache-control"), "public");
	}
});

test("ingress host list filtering preserves case, ports, MCP prefix and existing resource filters", async () => {
	for (const host of ["Gateway.Example.test:8443", "[2001:db8::1]:8787"]) {
		const f = fixture();
		const query = new URLSearchParams({
			ingress_host: ` ${host} `,
			page: "2",
			api_key_id: "key-1",
			user_id: "user-1",
			provider_id: "octafuse-mcp",
			model_id_prefix: "mcp:qa/",
		});
		const response = await f.request("/admin/request-logs?" + query);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.listOptions[0].ingressHost, host);
		assert.deepEqual(
			(
				(await response.json()) as {
					applied_filters: { ingress_host: string; model_id_prefix: string };
				}
			).applied_filters,
			{ ingress_host: host, model_id_prefix: "mcp:qa/" },
		);
		assert.equal(f.listOptions[0].providerId, "octafuse-mcp");
		assert.equal(f.listOptions[0].modelIdPrefix, "mcp:qa/");
		assert.equal(f.listOptions[0].userId, "user-1");
		assert.equal(f.listOptions[0].apiKeyId, "key-1");
		assert.equal(f.listOptions[0].page, 2);
	}
});

test("invalid or repeated ingress host cannot silently broaden a list request", async () => {
	for (const query of [
		new URLSearchParams({ ingress_host: " " }).toString(),
		new URLSearchParams({ ingress_host: "a\nb" }).toString(),
		new URLSearchParams({ ingress_host: "x".repeat(256) }).toString(),
		"ingress_host=a&ingress_host=b",
	]) {
		const f = fixture();
		const response = await f.request("/admin/request-logs?" + query);
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.ordinaryReads(), 0);
	}
});

test("omitted and explicitly cleared ingress filters retain legacy list behavior", async () => {
	for (const query of [
		"",
		"?ingress_host=",
		"?model_id_prefix=",
		"?ingress_host=&model_id_prefix=",
	]) {
		const f = fixture();
		const response = await f.request("/admin/request-logs" + query);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			success: true,
			data: [],
			total: 0,
			page: 1,
			page_size: 20,
		});
		assert.equal(f.ordinaryReads(), 1);
		assert.equal(f.listOptions[0].ingressHost, undefined);
		assert.equal(f.listOptions[0].modelIdPrefix, undefined);
	}
});

test("request detail keeps absent and null legacy host snapshots distinct", () => {
	for (const ingress_host of [undefined, null]) {
		const safe = projectAdminRequestLogDetail(
			row({ ingress_host }),
			"request-1",
		);
		assert.equal(safe.ingress_host, ingress_host);
		assert.equal(Object.hasOwn(safe, "ingress_host"), ingress_host === null);
	}
});

test("prefix-only reads acknowledge the normalized literal scope only after the repository succeeds", async () => {
	for (const prefix of [
		"mcp:Deep_Wiki%\\目录🧪/",
		"x".repeat(600),
		"x' OR 1=1 --",
	]) {
		const f = fixture();
		const query = new URLSearchParams({ model_id_prefix: prefix });
		const response = await f.request("/admin/request-logs?" + query);
		assert.equal(response.status, 200);
		assert.equal(f.listOptions[0].modelIdPrefix, prefix);
		assert.deepEqual(await response.json(), {
			success: true,
			data: [],
			total: 0,
			page: 1,
			page_size: 20,
			applied_filters: { model_id_prefix: prefix },
		});
	}
	const normalized = fixture();
	const response = await normalized.request(
		"/admin/request-logs?" +
			new URLSearchParams({ model_id_prefix: " mcp:QA/ " }),
	);
	assert.equal(normalized.listOptions[0].modelIdPrefix, "mcp:QA/");
	assert.deepEqual(
		((await response.json()) as { applied_filters: unknown }).applied_filters,
		{ model_id_prefix: "mcp:QA/" },
	);
	const originalError = console.error;
	console.error = () => {};
	try {
		const failed = fixture({ failList: true });
		const result = await failed.request(
			"/admin/request-logs?model_id_prefix=mcp%3AQA%2F&ingress_host=Gateway.Example",
		);
		assert.equal(result.status, 500);
		assert.equal(result.headers.get("cache-control"), "private, no-store");
		const body = await result.text();
		assert.ok(!body.includes("applied_filters"));
		assert.ok(!body.includes("sk-sensitive-value"));
	} finally {
		console.error = originalError;
	}
});

test("invalid or repeated model prefixes fail before storage rather than widening the query", async () => {
	for (const query of [
		...[" ", "a\nb", "x".repeat(601)].map((model_id_prefix) =>
			new URLSearchParams({ model_id_prefix }).toString(),
		),
		"model_id_prefix=mcp:a/&model_id_prefix=mcp:b/",
		"model_id_prefix=&model_id_prefix=mcp:a/",
	]) {
		const f = fixture();
		const response = await f.request("/admin/request-logs?" + query);
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.ordinaryReads(), 0);
		assert.ok(!Object.hasOwn(await response.json(), "applied_filters"));
	}
});

test("provider sets are normalized and acknowledged on empty pages alongside exact-provider and other scopes", async () => {
	const f = fixture();
	const query = new URLSearchParams({
		provider_ids: " octafuse-tools,octafuse-mcp,,octafuse-tools ",
		provider_id: "octafuse-mcp",
		model_id_prefix: "mcp:qa/",
		ingress_host: "Gateway.Example:8443",
		page: "2",
		page_size: "50",
		user_id: "user-1",
		api_key_id: "key-1",
	});
	const response = await f.request("/admin/request-logs?" + query);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(f.listOptions[0].providerIds, [
		"octafuse-mcp",
		"octafuse-tools",
	]);
	assert.equal(f.listOptions[0].providerId, "octafuse-mcp");
	assert.equal(f.listOptions[0].modelIdPrefix, "mcp:qa/");
	assert.equal(f.listOptions[0].userId, "user-1");
	assert.equal(f.listOptions[0].apiKeyId, "key-1");
	assert.deepEqual(await response.json(), {
		success: true,
		data: [],
		total: 0,
		page: 2,
		page_size: 50,
		applied_filters: {
			ingress_host: "Gateway.Example:8443",
			model_id_prefix: "mcp:qa/",
			provider_ids: ["octafuse-mcp", "octafuse-tools"],
		},
	});
});

test("invalid and repeated provider sets fail before storage and cannot broaden the query", async () => {
	for (const query of [
		...[
			" ",
			",,",
			"a\nb",
			"x".repeat(601),
			",".repeat(6010),
			Array.from({ length: 11 }, (_, index) => `p${index}`).join(","),
		].map((provider_ids) => new URLSearchParams({ provider_ids }).toString()),
		"provider_ids=a&provider_ids=b",
		"provider_ids=&provider_ids=a",
	]) {
		const f = fixture();
		const response = await f.request("/admin/request-logs?" + query);
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.ordinaryReads(), 0);
		assert.ok(!Object.hasOwn(await response.json(), "applied_filters"));
	}
});

test("provider sets keep legacy omission compatible and permission/repository failures unacknowledged", async () => {
	for (const suffix of ["", "?provider_ids="]) {
		const f = fixture();
		const response = await f.request("/admin/request-logs" + suffix);
		assert.equal(response.status, 200);
		assert.equal(f.listOptions[0].providerIds, undefined);
		assert.ok(!Object.hasOwn(await response.json(), "applied_filters"));
	}
	for (const principal of [
		null,
		{ ...named, permissions: ["analytics.read"] } as AdminPrincipal,
	]) {
		const f = fixture({ principal });
		const response = await f.request(
			"/admin/request-logs?provider_ids=octafuse-mcp,octafuse-tools",
		);
		assert.equal(response.status, principal ? 403 : 401);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.ordinaryReads(), 0);
		assert.ok(!Object.hasOwn(await response.json(), "applied_filters"));
	}
	const originalError = console.error;
	console.error = () => {};
	try {
		const f = fixture({ failList: true });
		const response = await f.request(
			"/admin/request-logs?provider_ids=octafuse-mcp,octafuse-tools",
		);
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = await response.text();
		assert.ok(!body.includes("applied_filters"));
		assert.ok(!body.includes("sk-sensitive-value"));
	} finally {
		console.error = originalError;
	}
});

test("provider-set service rejects malformed raw input before reading, including ill-formed UTF16", async () => {
	let reads = 0;
	const repositories = {
		requestLogs: {
			getRequestLogs: async () => {
				reads++;
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	for (const provider_ids of [
		null,
		123,
		[],
		{},
		"\ud800",
		"a,\udfff",
		"a,\tb",
	]) {
		await assert.rejects(
			listAdminGlobalRequestLogsService(repositories, {
				provider_ids: provider_ids as string,
			}),
			(error: unknown) =>
				error instanceof Error && error.message === "Invalid provider IDs",
		);
	}
	assert.equal(reads, 0);
});

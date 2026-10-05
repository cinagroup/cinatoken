import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories, RequestLogRow } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { projectAdminRequestLogDetail } from "./request-log-detail-service";

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
		billing_kind: "tokens",
		input_image_count: 0,
		output_image_count: 0,
		audio_duration_seconds: null,
		audio_characters: null,
		created_at: "2026-09-30 01:02:03.123456+00",
		...extra,
	} as RequestLogRow);
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
	} = {}
) {
	const reads: string[] = [];
	let ordinaryReads = 0;
	const repositories = {
		requestLogs: {
			getAdminRequestLogById: options.missing
				? undefined
				: async (id: string) => {
						reads.push(id);
						if (options.fail) throw new Error("private SQL sk-sensitive-value");
						return options.result === undefined ? row() : options.result;
				  },
			getRequestLogs: async () => {
				ordinaryReads++;
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === undefined ? named : options.principal ?? undefined,
	} as unknown as AdminBindings;
	return {
		reads,
		ordinaryReads: () => ordinaryReads,
		request: (
			path = "/admin/request-logs/request-1",
			method = "GET",
			body?: string
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
				bindings
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
		}),
		"request-1"
	);
	assert.ok(!Object.hasOwn(safe, "futureSecret"));
	assert.ok(!Object.hasOwn(safe, "request_headers"));
	assert.equal(safe.provider_name, "[redacted]");
	assert.equal(safe.model_name, "[redacted]");
	assert.equal(safe.upstream_request_id, "[redacted]");
});

test("required counters/cost/calendar drift fails closed while safe SQL decimal costs are normalized", () => {
	const projected = projectAdminRequestLogDetail(
		row({ metered_cost: "0.010000", created_at: "2026-09-30 01:02:03" }),
		"request-1"
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
		200
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
		JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) })
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
			{ DATABASE_DRIVER: "invalid" }
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
				{ status, headers: { "Cache-Control": "public, max-age=600" } }
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
			new Response("", { headers: { "Cache-Control": "public" } })
		);
		assert.equal(response.headers.get("cache-control"), "public");
	}
});

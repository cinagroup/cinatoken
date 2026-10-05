import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";

const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:history-cache",
	username: "operator",
};

function fixture(
	principal: AdminPrincipal | undefined = consolePrincipal,
	fail = false
) {
	let reads = 0;
	const read = () => {
		reads++;
		if (fail) throw new Error("injected history storage failure");
	};
	const repositories = {
		sharedKeys: {
			listAdminSharedKeys: async () => {
				read();
				return { keys: [], total: 0 };
			},
		},
		systemConfig: { getConfig: async () => null },
		requestLogs: {
			getRequestLogs: async () => {
				read();
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string, method = "GET", body?: unknown) => {
			const serialized = body === undefined ? undefined : JSON.stringify(body);
			return app.request(
				path,
				{
					method,
					...(serialized === undefined
						? {}
						: {
								body: serialized,
								headers: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(serialized)),
								},
						  }),
				},
				bindings
			);
		},
		reads: () => reads,
	};
}

const endpoints = [
	{ path: "/admin/shared-keys", method: "GET", permission: "providers.read" },
	{
		path: "/admin/earnings/rederive",
		method: "POST",
		permission: "users.write",
	},
] as const;

test("Shared Keys and historical review keep success, errors and early denials private", async () => {
	for (const endpoint of endpoints) {
		const allowed: AdminPrincipal = {
			type: "api_key",
			id: "admin_key:history-cache",
			keyId: "history-cache",
			permissions: [endpoint.permission],
		};
		assert.deepEqual(
			getAdminAuthorizationDecision(endpoint.method, endpoint.path),
			{ kind: "permission", permission: endpoint.permission }
		);
		const success = fixture(allowed);
		const response = await success.request(endpoint.path, endpoint.method);
		assert.equal(response.status, 200, endpoint.path);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(success.reads(), 1);
		const failure = await fixture(consolePrincipal, true).request(
			endpoint.path,
			endpoint.method
		);
		assert.equal(failure.status, 500);
		assert.equal(failure.headers.get("cache-control"), "private, no-store");
		for (const [principal, expected] of [
			[undefined, 401],
			[
				{
					type: "api_key",
					id: "admin_key:denied",
					keyId: "denied",
					permissions: ["analytics.read"],
				},
				403,
			],
		] as const) {
			// Passing undefined must not fall back to the fixture's Console default.
			const bindings = {
				STORAGE_CONTEXT: { repositories: {} },
				ADMIN_PRINCIPAL: principal,
			} as unknown as AdminBindings;
			const denied = await createAdminApp().request(
				endpoint.path,
				{ method: endpoint.method },
				bindings
			);
			assert.equal(denied.status, expected);
			assert.equal(denied.headers.get("cache-control"), "private, no-store");
		}
	}
});

test("Shared Keys and earnings preflight, oversized bodies and unknown children stay private", async () => {
	for (const base of ["/admin/shared-keys", "/admin/earnings"]) {
		const subject = fixture();
		const preflight = await subject.request(`${base}/child`, "OPTIONS");
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("cache-control"), "private, no-store");
		const oversized = await subject.request(`${base}/child`, "POST", {
			value: "x".repeat(2 * 1024 * 1024),
		});
		assert.equal(oversized.status, 413);
		assert.equal(oversized.headers.get("cache-control"), "private, no-store");
		const missing = await subject.request(`${base}/unknown/child`);
		assert.equal(missing.headers.get("cache-control"), "private, no-store");
		assert.equal(subject.reads(), 0);
	}
});

test("outer cache classification covers encoded sensitive paths without changing routing or adjacent paths", () => {
	for (const path of [
		"/api/admin/shared-keys",
		"/api/admin/shared-keys/",
		"/api/admin/shared-keys/key-1",
		"/api/admin/earnings",
		"/api/admin/earnings/rederive/",
		"/api/admin/earnings/unknown/child",
		"/api/admin/%73hared-keys",
		"/api/admin/%2573hared-keys/key-1",
		"/api/admin/%65arnings%2Frederive",
	]) {
		for (const status of [200, 400, 401, 403, 404, 413, 500, 503]) {
			const request = new Request(`https://admin.example.test${path}?apply=1`);
			const original = Response.json(
				{ success: status < 400 },
				{ status, headers: { "Cache-Control": "public, max-age=600" } }
			);
			const response = protectAdminConfigResponse(request, original);
			assert.equal(response, original);
			assert.equal(response.status, status);
			assert.equal(request.url, `https://admin.example.test${path}?apply=1`);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
	for (const path of [
		"/api/admin/shared-keys-backup",
		"/api/admin/shared-key",
		"/api/admin/earnings-export",
		"/api/admin/other/earnings",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			new Response("", { headers: { "Cache-Control": "public" } })
		);
		assert.equal(response.headers.get("cache-control"), "public", path);
	}
});

test("legacy governance writes distinguish guarded state conflicts from a missing key", async () => {
	for (const exists of [true, false]) {
		const repositories = {
			sharedKeys: {
				updateSharedKey: async () => false,
				getAdminSharedKeyById: async () =>
					exists ? { id: "key-1", status: "disabled" } : null,
			},
		} as unknown as GatewayRepositories;
		const bindings = {
			STORAGE_CONTEXT: { repositories },
			ADMIN_PRINCIPAL: consolePrincipal,
		} as unknown as AdminBindings;
		const response = await createAdminApp().request(
			"/admin/shared-keys/key-1",
			{
				method: "PATCH",
				body: JSON.stringify({ status: "active" }),
				headers: { "Content-Type": "application/json" },
			},
			bindings
		);
		assert.equal(response.status, exists ? 409 : 404);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		if (exists)
			assert.equal(
				((await response.json()) as { code: string }).code,
				"shared_key_state_conflict"
			);
	}
});

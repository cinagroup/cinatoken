import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";

function fixture(permissions: AdminPermission[] | null) {
	let reads = 0;
	let lastOptions: unknown;
	const repositories = {
		requestLogs: {
			getRequestLogs: async (options: unknown) => {
				reads++;
				lastOptions = options;
				return { logs: [], total: 0 };
			},
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal | undefined =
		permissions === null
			? undefined
			: {
					type: "api_key",
					id: "admin_key:request-logs-cache-test",
					keyId: "request-logs-cache-test",
					permissions,
			  };
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string) => app.request(path, { method: "GET" }, bindings),
		reads: () => reads,
		lastOptions: () => lastOptions,
	};
}

test("request-log user_id deep link uses the stored user identity instead of current email", async () => {
	const allowed = fixture(["logs.read"]);
	const response = await allowed.request(
		"/admin/request-logs?user_id=user-42&page=2"
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(allowed.reads(), 1);
	assert.deepEqual(allowed.lastOptions(), {
		page: 2,
		pageSize: 20,
		apiKeyId: undefined,
		userId: "user-42",
		userEmail: undefined,
		modelId: undefined,
		providerId: undefined,
		routeGroup: undefined,
		protocol: undefined,
		status: undefined,
		startDate: undefined,
		endDate: undefined,
	});
	const denied = fixture(["analytics.read"]);
	const forbidden = await denied.request("/admin/request-logs?user_id=user-42");
	assert.equal(forbidden.status, 403);
	assert.equal(denied.reads(), 0);
	const invalid = fixture(["logs.read"]);
	const badId = await invalid.request("/admin/request-logs?user_id=bad%0Auser");
	assert.equal(badId.status, 400);
	assert.equal(badId.headers.get("cache-control"), "private, no-store");
	assert.equal(invalid.reads(), 0);
});

test("request logs list and its auth failures are private, and denial does not read logs", async () => {
	for (const path of ["/admin/request-logs", "/admin/request-logs?page=1"]) {
		const allowed = fixture(["logs.read"]);
		const success = await allowed.request(path);
		assert.equal(success.status, 200, path);
		assert.equal(
			success.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.equal(allowed.reads(), 1, path);

		const denied = fixture(["analytics.read"]);
		const forbidden = await denied.request(path);
		assert.equal(forbidden.status, 403, path);
		assert.equal(
			forbidden.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.deepEqual(await forbidden.json(), {
			success: false,
			message: "Forbidden",
			required_permission: "logs.read",
		});
		assert.equal(denied.reads(), 0, path);

		const anonymous = fixture(null);
		const unauthorized = await anonymous.request(path);
		assert.equal(unauthorized.status, 401, path);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.equal(anonymous.reads(), 0, path);
	}
	const trailing = fixture(["logs.read"]);
	const notFound = await trailing.request("/admin/request-logs/");
	assert.equal(notFound.status, 404);
	assert.equal(notFound.headers.get("cache-control"), "private, no-store");
	assert.equal(trailing.reads(), 0);
});

test("outer request-logs response policy keeps pre-Hono failures private without affecting adjacent routes", () => {
	for (const suffix of ["", "/", "?page=1", "/detail", "/detail/unknown"]) {
		const path = `/api/admin/request-logs${suffix}`;
		for (const status of [200, 401, 403, 503]) {
			const response = protectAdminConfigResponse(
				new Request(`https://admin.example.test${path}`),
				Response.json(
					{ success: status === 200 },
					{
						status,
						headers: { "Cache-Control": "public, max-age=600" },
					}
				)
			);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
	for (const path of ["/api/admin/request-logs-extra"]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			Response.json(
				{ success: false },
				{
					status: 503,
					headers: { "Cache-Control": "public, max-age=600" },
				}
			)
		);
		assert.equal(
			response.headers.get("cache-control"),
			"public, max-age=600",
			path
		);
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";

function fixture(permissions: AdminPermission[] | null) {
	let storageReads = 0;
	const repositories = {
		users: {
			list: async () => {
				storageReads++;
				return { users: [], total: 0 };
			},
			getById: async (id: string) => {
				storageReads++;
				return { id };
			},
		},
		apiKeys: {
			listKeysByUserId: async () => {
				storageReads++;
				return [];
			},
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal | undefined =
		permissions === null
			? undefined
			: {
					type: "api_key",
					id: "admin_key:users-cache-test",
					keyId: "users-cache-test",
					permissions,
			  };
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string, method = "GET") =>
			app.request(path, { method }, bindings),
		storageReads: () => storageReads,
	};
}

test("user list success and authorization failures are private and non-cacheable", async () => {
	const permitted = fixture(["users.read"]);
	const success = await permitted.request("/admin/users?page=1");
	assert.equal(success.status, 200);
	assert.equal(success.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await success.json(), {
		success: true,
		data: [],
		total: 0,
		page: 1,
		page_size: 20,
	});
	assert.equal(permitted.storageReads(), 1);

	for (const path of [
		"/admin/users",
		"/admin/users/user-1",
		"/admin/users/user-1/keys",
		"/admin/users/user-1/keys/key-1",
		"/admin/users/user-1/logs",
		"/admin/users/user-1/audit-logs",
	]) {
		const denied = fixture(["analytics.read"]);
		const forbidden = await denied.request(path);
		assert.equal(forbidden.status, 403);
		assert.equal(forbidden.headers.get("cache-control"), "private, no-store");
		assert.equal(denied.storageReads(), 0);
		const missing = fixture(null);
		const unauthorized = await missing.request(path);
		assert.equal(unauthorized.status, 401);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store"
		);
		assert.equal(missing.storageReads(), 0);
	}
});

test("user key child success remains private", async () => {
	const permitted = fixture(["user_keys.read"]);
	const success = await permitted.request(
		"/admin/users/f2b74bc0-32f3-4613-aea7-96f723d08e12/keys"
	);
	assert.equal(success.status, 200);
	assert.equal(success.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await success.json(), { success: true, data: [] });
	assert.equal(permitted.storageReads(), 2);
});

test("user create authorization failure is private and cannot reach storage", async () => {
	const denied = fixture(["users.read"]);
	const response = await denied.request("/admin/users", "POST");
	assert.equal(response.status, 403);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(denied.storageReads(), 0);
});

test("outer user API policy protects detail and child responses before Hono, without adjacent paths", () => {
	const id = "f2b74bc0-32f3-4613-aea7-96f723d08e12";
	for (const path of [
		"/api/admin/users",
		"/api/admin/users/",
		`/api/admin/users/${id}`,
		`/api/admin/users/${id}/`,
		"/api/admin/users/ext%3Aerp%2F42",
		`/api/admin/users/${id}/keys`,
		`/api/admin/users/${id}/keys/`,
		`/api/admin/users/${id}/keys/key-1`,
		`/api/admin/users/${id}/logs`,
		`/api/admin/users/${id}/audit-logs`,
		`/api/admin/users/${id}/budget/transition`,
		`/api/admin/users/${id}/budget/transition/preview`,
	]) {
		for (const status of [200, 401, 403, 503]) {
			const response = protectAdminConfigResponse(
				new Request(`https://admin.example.test${path}?keep=1`),
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
				`${status} ${path}`
			);
		}
	}
	for (const path of [
		"/api/admin/users-extra",
		"/api/admin/users//",
		`/api/admin/users/${id}/unknown`,
		`/api/admin/users/${id}/keys/key-1/logs`,
		`/api/admin/users/${id}/audit-logs/extra`,
		`/api/admin/users/${id}/budget/transition/extra`,
	]) {
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

test("global Gateway Key children have their own private cache boundary", () => {
	// This belongs to /keys, whose entire subtree is private under ADM-08;
	// it is not an unprotected adjacent resource of the /users policy.
	for (const status of [200, 401, 403, 500]) {
		const response = protectAdminConfigResponse(
			new Request("https://admin.example.test/api/admin/keys/key-1/logs"),
			Response.json(
				{ success: false },
				{ status, headers: { "Cache-Control": "public, max-age=600" } }
			)
		);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
});

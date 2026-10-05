import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";

const analyticsPaths = ["models", "providers", "users"] as const;

function fixture(permissions: AdminPermission[] | null) {
	let analyticsReads = 0;
	const readEmpty = async () => {
		analyticsReads++;
		return [];
	};
	const repositories = {
		analytics: {
			queryModelAnalytics: readEmpty,
			queryProviderAnalytics: readEmpty,
			queryUserAnalytics: readEmpty,
			queryDistinctModelTags: readEmpty,
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal | undefined =
		permissions === null
			? undefined
			: {
					type: "api_key",
					id: "admin_key:analytics-cache-test",
					keyId: "analytics-cache-test",
					permissions,
			  };
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string) => app.request(path, { method: "GET" }, bindings),
		analyticsReads: () => analyticsReads,
	};
}

test("models, providers, and users analytics successes are private and reach only their read service", async () => {
	for (const endpoint of analyticsPaths) {
		const f = fixture(["analytics.read"]);
		const response = await f.request(
			`/admin/analytics/${endpoint}?start_date=2026-09-27&end_date=2026-09-28`
		);
		assert.equal(response.status, 200, endpoint);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			endpoint
		);
		assert.equal(
			((await response.json()) as { success: boolean }).success,
			true,
			endpoint
		);
		assert.equal(f.analyticsReads(), endpoint === "users" ? 1 : 2, endpoint);
	}
});

test("models, providers, and users analytics auth failures are private before analytics reads", async () => {
	for (const endpoint of analyticsPaths) {
		const path = `/admin/analytics/${endpoint}`;
		const denied = fixture(["logs.read"]);
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
			required_permission: "analytics.read",
		});
		assert.equal(denied.analyticsReads(), 0, path);

		const anonymous = fixture(null);
		const unauthorized = await anonymous.request(path);
		assert.equal(unauthorized.status, 401, path);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.equal(anonymous.analyticsReads(), 0, path);
	}
});

test("Hono cache middleware does not capture adjacent analytics paths", async () => {
	for (const path of [
		"/admin/analytics/models/detail",
		"/admin/analytics/models-extra",
		"/admin/analytics/providers/detail",
		"/admin/analytics/providers-extra",
		"/admin/analytics/users/detail",
		"/admin/analytics/users-extra",
	]) {
		const f = fixture(null);
		const response = await f.request(path);
		assert.equal(response.status, 401, path);
		assert.equal(response.headers.get("cache-control"), null, path);
		assert.equal(f.analyticsReads(), 0, path);
	}
});

test("outer Admin response policy covers exact analytics paths before Hono and overrides public cache headers", () => {
	for (const endpoint of analyticsPaths) {
		for (const suffix of ["", "/", "?start_date=2026-09-27"]) {
			const path = `/api/admin/analytics/${endpoint}${suffix}`;
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
				assert.equal(response.status, status, path);
				assert.equal(
					response.headers.get("cache-control"),
					"private, no-store",
					path
				);
			}
		}
	}
});

test("outer Admin response policy does not capture nearby analytics paths", () => {
	for (const path of [
		"/api/admin/analytics/models/detail",
		"/api/admin/analytics/models//",
		"/api/admin/analytics/models-extra",
		"/api/admin/analytics/providers/detail",
		"/api/admin/analytics/providers-extra",
		"/api/admin/analytics/users/detail",
		"/api/admin/analytics/users-extra",
		"/api/admin/analytics/other",
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

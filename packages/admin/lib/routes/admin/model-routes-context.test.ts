import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { adminModelRoutes } from "./model-routes";

const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:test",
	username: "test",
};

function apiKey(permissions: AdminPermission[]): AdminPrincipal {
	return { type: "api_key", id: "admin_key:test", keyId: "test", permissions };
}

function fixture(
	values: Record<string, string | null | Error>,
	principal: AdminPrincipal | null = consolePrincipal
) {
	const reads: string[] = [];
	const repositories = {
		systemConfig: {
			getConfig: async (key: string) => {
				reads.push(key);
				const value = values[key] ?? null;
				if (value instanceof Error) throw value;
				return value;
			},
		},
		routes: {
			listModelRoutesWithJoins: () =>
				assert.fail("Context must not read route rows"),
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		if (principal) c.set("principal", principal);
		await next();
	});
	app.route("/admin/routes", adminModelRoutes);
	return { app, reads };
}

test("context is a three-field projection of normalized current configuration, even with no route rows", async () => {
	const { app, reads } = fixture({
		ROUTE_STRATEGY: " WeIgHtEd_RoUnD_RoBiN ",
		BILLING_CURRENCY: " eur ",
		BUSINESS_TIMEZONE: " Asia/Singapore ",
		PRIVATE_WEBHOOK_SECRET: "never-returned",
	});
	const response = await app.request("/admin/routes/context");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await response.json(), {
		success: true,
		data: {
			global_route_strategy: "weighted_round_robin",
			billing_currency: "EUR",
			business_timezone: "Asia/Singapore",
		},
	});
	assert.deepEqual(reads.sort(), [
		"BILLING_CURRENCY",
		"BUSINESS_TIMEZONE",
		"ROUTE_STRATEGY",
	]);
});

test("missing and invalid settings follow Core defaults without exposing raw values", async () => {
	for (const values of [
		{ ROUTE_STRATEGY: null, BILLING_CURRENCY: null, BUSINESS_TIMEZONE: null },
		{
			ROUTE_STRATEGY: "unknown",
			BILLING_CURRENCY: "not-money",
			BUSINESS_TIMEZONE: "Mars/Olympus",
		},
	]) {
		const { app } = fixture(values);
		const response = await app.request("/admin/routes/context");
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()) as unknown, {
			success: true,
			data: {
				global_route_strategy: "hash_affinity",
				billing_currency: "USD",
				business_timezone: "UTC",
			},
		});
	}
});

test("context requires both routes.read and config.read before any configuration access", async () => {
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", "/admin/routes/context"),
		{
			kind: "permission",
			permission: "routes.read",
		}
	);
	for (const [permissions, required] of [
		[["routes.read"], "config.read"],
		[["config.read"], "routes.read"],
	] as const) {
		const { app, reads } = fixture({}, apiKey([...permissions]));
		const response = await app.request("/admin/routes/context");
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), {
			success: false,
			message: "Forbidden",
			required_permission: required,
		});
		assert.deepEqual(reads, []);
	}
	const permitted = fixture({}, apiKey(["routes.read", "config.read"]));
	assert.equal(
		(await permitted.app.request("/admin/routes/context")).status,
		200
	);
	const unauthenticated = fixture({}, null);
	assert.equal(
		(await unauthenticated.app.request("/admin/routes/context")).status,
		401
	);
	assert.deepEqual(unauthenticated.reads, []);
});

test("each configuration read failure returns private no-store 500 instead of invented defaults", async () => {
	for (const failedKey of [
		"ROUTE_STRATEGY",
		"BILLING_CURRENCY",
		"BUSINESS_TIMEZONE",
	]) {
		const { app } = fixture({
			[failedKey]: new Error("private storage detail"),
		});
		const response = await app.request("/admin/routes/context");
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = await response.text();
		assert.deepEqual(JSON.parse(body), {
			success: false,
			message: "Failed to get route context",
		});
		assert.equal(body.includes("private storage detail"), false);
	}
});

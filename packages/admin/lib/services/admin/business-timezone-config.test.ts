import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import { getBusinessDayWindow } from "@octafuse/core/lib/business-timezone";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import {
	hasAdminPermission,
	type AdminPermission,
	type AdminPrincipal,
} from "@/lib/admin-principal";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { adminBusinessTimezoneRoutes } from "@/lib/routes/admin/business-timezone";
import { adminConfigRoutes } from "@/lib/routes/admin/config";

const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:test",
	username: "test",
};
const apiKey = (permissions: AdminPermission[]): AdminPrincipal => ({
	type: "api_key",
	id: "admin_key:test",
	keyId: "test",
	permissions,
});

function fixture(
	options: {
		initial?: string | null;
		principal?: AdminPrincipal | null;
		readFailure?: Error;
		writeFailure?: Error;
	} = {}
) {
	const values = new Map<string, string>();
	if (options.initial !== undefined && options.initial !== null)
		values.set("BUSINESS_TIMEZONE", options.initial);
	values.set("PRIVATE_WEBHOOK_SECRET", "private-value");
	const reads: string[] = [];
	const writes: Array<{ key: string; value: string }> = [];
	const repositories = {
		systemConfig: {
			async getConfig(key: string): Promise<string | null> {
				reads.push(key);
				if (options.readFailure) throw options.readFailure;
				return values.get(key) ?? null;
			},
			async listSystemConfigRows() {
				reads.push("*");
				if (options.readFailure) throw options.readFailure;
				return [...values].map(([key, value]) => ({
					key,
					value,
					description: null,
				}));
			},
			async upsertSystemConfigValueWithAudit({
				key,
				value,
			}: {
				key: string;
				value: string;
			}): Promise<void> {
				writes.push({ key, value });
				if (options.writeFailure) throw options.writeFailure;
				values.set(key, value);
			},
		},
	} as unknown as GatewayRepositories;
	const principal =
		options.principal === undefined ? consolePrincipal : options.principal;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401);
		const decision = getAdminAuthorizationDecision(c.req.method, c.req.path);
		if (
			decision.kind !== "permission" ||
			!hasAdminPermission(principal, decision.permission)
		)
			return c.json({ success: false, message: "Forbidden" }, 403);
		c.set("principal", principal);
		await next();
	});
	app.route("/admin/business-timezone", adminBusinessTimezoneRoutes);
	app.route("/admin/config", adminConfigRoutes);
	return { app, reads, writes, values };
}

async function putConfig(
	app: Hono<AdminEnv>,
	key: string,
	value: unknown
): Promise<Response> {
	return await app.request("/admin/config", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key, value }),
	});
}

test("dedicated GET reads only timezone once and distinguishes configured, missing and legacy invalid values", async () => {
	for (const [initial, business_timezone, source] of [
		[" Asia/Singapore ", "Asia/Singapore", "configured"],
		[null, "UTC", "missing"],
		["Mars/Olympus", "UTC", "invalid"],
		["EST", "EST", "legacy"],
		["+01:00", "+01:00", "legacy"],
	] as const) {
		const { app, reads } = fixture({ initial });
		const response = await app.request("/admin/business-timezone");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), {
			success: true,
			data: { business_timezone, source },
		});
		assert.deepEqual(reads, ["BUSINESS_TIMEZONE"]);
	}
});

test("generic config PUT stores only trimmed valid IANA values and explicit UTC resets business-day boundaries", async () => {
	const { app, writes, values } = fixture({ initial: "UTC" });
	const updated = await putConfig(app, "BUSINESS_TIMEZONE", " Asia/Shanghai ");
	assert.equal(updated.status, 200);
	assert.equal(updated.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(writes, [
		{ key: "BUSINESS_TIMEZONE", value: "Asia/Shanghai" },
	]);
	const timezone = await app.request("/admin/business-timezone");
	assert.deepEqual(((await timezone.json()) as { data: unknown }).data, {
		business_timezone: "Asia/Shanghai",
		source: "configured",
	});
	assert.deepEqual(
		getBusinessDayWindow(
			new Date("2026-07-09T01:00:00Z"),
			values.get("BUSINESS_TIMEZONE")!
		),
		{
			dateKey: "2026-07-09",
			startUtcSql: "2026-07-08 16:00:00",
			endExclusiveUtcSql: "2026-07-09 16:00:00",
		}
	);
	const reset = await putConfig(app, "BUSINESS_TIMEZONE", " UTC ");
	assert.equal(reset.status, 200);
	assert.deepEqual(writes[1], { key: "BUSINESS_TIMEZONE", value: "UTC" });
});

test("blank, invalid, control, oversized and non-string timezone writes return 400 before repository write", async () => {
	const { app, writes, values } = fixture({ initial: "Asia/Singapore" });
	for (const value of [
		"",
		"   ",
		"Mars/Olympus",
		"UTC\n",
		"Asia/\u0000Shanghai",
		"a".repeat(129),
		"+01:00",
		"-04:30",
		"EST",
		null,
		10,
	]) {
		const response = await putConfig(app, "BUSINESS_TIMEZONE", value);
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = await response.text();
		if (String(value)) assert.equal(body.includes(String(value)), false);
	}
	assert.deepEqual(writes, []);
	assert.equal(values.get("BUSINESS_TIMEZONE"), "Asia/Singapore");
	const other = await putConfig(app, "UNRELATED_KEY", null);
	assert.equal(other.status, 200);
	assert.deepEqual(writes, [{ key: "UNRELATED_KEY", value: "" }]);
});

test("config read is masked, private no-store, and access decisions keep read/write permission boundaries", async () => {
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", "/admin/business-timezone"),
		{ kind: "permission", permission: "config.read" }
	);
	assert.deepEqual(getAdminAuthorizationDecision("GET", "/admin/config"), {
		kind: "permission",
		permission: "config.read",
	});
	assert.deepEqual(getAdminAuthorizationDecision("PUT", "/admin/config"), {
		kind: "permission",
		permission: "config.write",
	});
	const reader = fixture({ principal: apiKey(["config.read"]) });
	const response = await reader.app.request("/admin/config");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal((await response.text()).includes("private-value"), false);
	assert.equal(
		(await putConfig(reader.app, "BUSINESS_TIMEZONE", "UTC")).status,
		403
	);
	assert.deepEqual(reader.writes, []);
	const denied = fixture({ principal: apiKey(["routes.read"]) });
	assert.equal(
		(await denied.app.request("/admin/business-timezone")).status,
		403
	);
	assert.equal((await denied.app.request("/admin/config")).status, 403);
	assert.equal(
		(await putConfig(denied.app, "BUSINESS_TIMEZONE", "UTC")).status,
		403
	);
	assert.deepEqual(denied.reads, []);
	assert.deepEqual(denied.writes, []);
	const unauthenticated = fixture({ principal: null });
	assert.equal(
		(await unauthenticated.app.request("/admin/business-timezone")).status,
		401
	);
	assert.equal(
		(await putConfig(unauthenticated.app, "BUSINESS_TIMEZONE", "UTC")).status,
		401
	);
	assert.deepEqual(unauthenticated.reads, []);
	assert.deepEqual(unauthenticated.writes, []);
});

test("read and write failures stay private, no-store and do not echo storage diagnostics", async () => {
	const read = fixture({ readFailure: new Error("private storage detail") });
	for (const path of ["/admin/business-timezone", "/admin/config"]) {
		const response = await read.app.request(path);
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(
			(await response.text()).includes("private storage detail"),
			false
		);
	}
	const write = fixture({ writeFailure: new Error("private storage detail") });
	const response = await putConfig(write.app, "BUSINESS_TIMEZONE", "UTC");
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(
		(await response.text()).includes("private storage detail"),
		false
	);
	assert.deepEqual(write.writes, [{ key: "BUSINESS_TIMEZONE", value: "UTC" }]);
});

test("public catch-all protects early 401, 403 and 500 responses before Hono runs", () => {
	for (const path of [
		"/api/admin/config",
		"/api/admin/config/",
		"/api/admin/business-timezone",
		"/api/admin/presets",
		"/api/admin/presets/",
		"/api/admin/presets/owned/version-summaries",
		"/api/admin/providers",
		"/api/admin/providers/provider-a/reveal",
		"/api/admin/models",
		"/api/admin/models/model-a",
		"/api/admin/endpoints",
		"/api/admin/endpoints/endpoint-a/link/model-a",
		"/api/admin/routes",
		"/api/admin/routes/pools/pool-a/sticky",
	]) {
		for (const status of [401, 403, 500]) {
			const response = protectAdminConfigResponse(
				new Request("https://cinatoken.test" + path),
				Response.json({ success: false }, { status })
			);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
		}
	}
	for (const path of [
		"/api/admin/models-extra",
		"/api/admin/providers-extra",
		"/api/admin/endpoints-extra",
		"/api/admin/routes-extra",
		"/api/admin/presets-extra",
		"/api/admin/preset",
	]) {
		const unrelated = protectAdminConfigResponse(
			new Request("https://cinatoken.test" + path),
			Response.json({ success: false }, { status: 403 })
		);
		assert.equal(unrelated.headers.get("cache-control"), null);
	}
});

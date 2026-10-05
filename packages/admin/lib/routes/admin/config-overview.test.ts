import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { adminConfigRoutes } from "./config";

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

const CONFIG_KEYS = [
	"BUSINESS_TIMEZONE",
	"BILLING_CURRENCY",
	"ROUTE_STRATEGY",
	"ALERT_WEBHOOK_WECOM_URL",
	"ALERT_WEBHOOK_FEISHU_URL",
].sort();

function fixture(
	values: Record<string, string | null | Error>,
	principal: AdminPrincipal | null = consolePrincipal
) {
	const reads: string[] = [];
	const repositories = {
		systemConfig: {
			async getConfigSnapshot(
				key: string
			): Promise<{ value: string | null; revision: string | null }> {
				reads.push(key);
				const value = values[key] ?? null;
				if (value instanceof Error) throw value;
				return { value, revision: value === null ? null : "legacy" };
			},
			listSystemConfigRows: () =>
				assert.fail("Overview must not list arbitrary system_config rows"),
			upsertSystemConfigValueWithAudit: () =>
				assert.fail("Overview must not write configuration"),
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		if (principal) c.set("principal", principal);
		await next();
	});
	app.route("/admin/config", adminConfigRoutes);
	return { app, reads };
}

test("overview reads exactly five keys and returns only safe values and webhook presence", async () => {
	const secretWecom = "https://wecom.example.test/hook?key=private-wecom-token";
	const secretFeishu = "https://feishu.example.test/hook/private-feishu-token";
	const { app, reads } = fixture({
		BUSINESS_TIMEZONE: " Asia/Singapore ",
		BILLING_CURRENCY: " cny ",
		ROUTE_STRATEGY: " WEIGHTED_RANDOM ",
		ALERT_WEBHOOK_WECOM_URL: secretWecom,
		ALERT_WEBHOOK_FEISHU_URL: "  ",
		UNRELATED_SECRET: secretFeishu,
	});
	const response = await app.request("/admin/config/overview");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const text = await response.text();
	assert.deepEqual(JSON.parse(text), {
		success: true,
		data: {
			businessTimezone: {
				value: "Asia/Singapore",
				source: "configured",
				revision: "legacy",
			},
			billingCurrency: {
				value: "CNY",
				source: "configured",
				revision: "legacy",
			},
			routeStrategy: {
				value: "weighted_random",
				source: "configured",
				revision: "legacy",
			},
			webhooks: {
				wecom: { configured: true, revision: "legacy" },
				feishu: { configured: false, revision: "legacy" },
			},
			canWrite: true,
			canReveal: true,
		},
	});
	assert.deepEqual(reads.sort(), CONFIG_KEYS);
	assert.equal(text.includes(secretWecom), false);
	assert.equal(text.includes(secretFeishu), false);
});

test("overview distinguishes legacy, missing, invalid and unsupported settings without inventing a configured value", async () => {
	for (const [values, expected] of [
		[
			{},
			{
				businessTimezone: { value: "UTC", source: "missing", revision: null },
				billingCurrency: { value: "USD", source: "missing", revision: null },
				routeStrategy: {
					value: "hash_affinity",
					source: "missing",
					revision: null,
				},
			},
		],
		[
			{
				BUSINESS_TIMEZONE: "EST",
				BILLING_CURRENCY: " eur ",
				ROUTE_STRATEGY: "not-a-strategy",
			},
			{
				businessTimezone: {
					value: "EST",
					source: "legacy",
					revision: "legacy",
				},
				billingCurrency: {
					value: "EUR",
					source: "unsupported",
					revision: "legacy",
				},
				routeStrategy: {
					value: "hash_affinity",
					source: "invalid",
					revision: "legacy",
				},
			},
		],
		[
			{
				BUSINESS_TIMEZONE: "Mars/Olympus",
				BILLING_CURRENCY: "not-money",
				ROUTE_STRATEGY: "  ",
			},
			{
				businessTimezone: {
					value: "UTC",
					source: "invalid",
					revision: "legacy",
				},
				billingCurrency: {
					value: "USD",
					source: "invalid",
					revision: "legacy",
				},
				routeStrategy: {
					value: "hash_affinity",
					source: "missing",
					revision: "legacy",
				},
			},
		],
	] as const) {
		const { app } = fixture(values);
		const response = await app.request("/admin/config/overview");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = (await response.json()) as { data: Record<string, unknown> };
		assert.deepEqual(body.data.businessTimezone, expected.businessTimezone);
		assert.deepEqual(body.data.billingCurrency, expected.billingCurrency);
		assert.deepEqual(body.data.routeStrategy, expected.routeStrategy);
	}
});

test("overview requires config.read and reports independent write and secret-reveal capabilities", async () => {
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", "/admin/config/overview"),
		{ kind: "permission", permission: "config.read" }
	);
	assert.deepEqual(
		getAdminAuthorizationDecision("HEAD", "/admin/config/overview"),
		{ kind: "permission", permission: "config.read" }
	);
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		assert.deepEqual(
			getAdminAuthorizationDecision(method, "/admin/config/overview"),
			{ kind: "deny" }
		);
	}
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", "/admin/config/overview-extra"),
		{ kind: "deny" }
	);
	const reader = fixture({}, apiKey(["config.read"]));
	const readResponse = await reader.app.request("/admin/config/overview");
	assert.equal(readResponse.status, 200);
	assert.equal(readResponse.headers.get("cache-control"), "private, no-store");
	const readData = (
		(await readResponse.json()) as {
			data: { canWrite: boolean; canReveal: boolean };
		}
	).data;
	assert.deepEqual([readData.canWrite, readData.canReveal], [false, false]);
	const writer = fixture({}, apiKey(["config.write"]));
	const writeResponse = await writer.app.request("/admin/config/overview");
	assert.equal(writeResponse.status, 200);
	const writeData = (
		(await writeResponse.json()) as {
			data: { canWrite: boolean; canReveal: boolean };
		}
	).data;
	assert.deepEqual([writeData.canWrite, writeData.canReveal], [true, false]);
	const revealer = fixture({}, apiKey(["config.read", "config.secrets.read"]));
	const revealResponse = await revealer.app.request("/admin/config/overview");
	assert.equal(revealResponse.status, 200);
	const revealData = (
		(await revealResponse.json()) as {
			data: { canWrite: boolean; canReveal: boolean };
		}
	).data;
	assert.deepEqual([revealData.canWrite, revealData.canReveal], [false, true]);
	const denied = fixture({}, apiKey(["routes.read"]));
	const deniedResponse = await denied.app.request("/admin/config/overview");
	assert.equal(deniedResponse.status, 403);
	assert.equal(
		deniedResponse.headers.get("cache-control"),
		"private, no-store"
	);
	assert.deepEqual(denied.reads, []);
	const unauthenticated = fixture({}, null);
	const unauthorizedResponse = await unauthenticated.app.request(
		"/admin/config/overview"
	);
	assert.equal(unauthorizedResponse.status, 401);
	assert.equal(
		unauthorizedResponse.headers.get("cache-control"),
		"private, no-store"
	);
	assert.deepEqual(unauthenticated.reads, []);
});

test("failure of any projected configuration key returns private generic 500 without a false default or secret", async () => {
	for (const key of CONFIG_KEYS) {
		const { app } = fixture({ [key]: new Error("private storage detail") });
		const response = await app.request("/admin/config/overview");
		assert.equal(response.status, 500, key);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), {
			success: false,
			message: "Failed to get config overview",
		});
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userGatewayKeysRoutes } from "@/lib/routes/user/gateway-keys";

function createFixture(currency: string | null) {
	const calls: unknown[][] = [];
	const repositories = {
		apiKeys: {
			listKeysByWorkspaceId: async (...args: unknown[]) => {
				calls.push(args);
				return [
					{
						id: "key-1",
						workspace_id: "personal:user-1",
						key: "sk-0123456789abcdef",
						name: "Test",
						status: "active",
						limit_micros: 12_500_000,
						limit_reset: "monthly",
						expires_at: null,
						last_used_at: null,
						created_at: "2026-09-27T00:00:00.000Z",
					},
				];
			},
		},
		systemConfig: {
			getConfig: async (key: string) => {
				assert.equal(key, "BILLING_CURRENCY");
				return currency;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
		} as UserEnv["Variables"]["principal"]);
		c.set("workspaceContext", {
			currentWorkspace: { id: "personal:user-1" },
		} as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.route("/gateway-keys", userGatewayKeysRoutes);
	return { app, calls };
}

test("Gateway Key budgets expose the configured CNY unit without changing the existing data array", async () => {
	const { app, calls } = createFixture("CNY");
	const response = await app.request("/gateway-keys");
	const result = (await response.json()) as {
		billingCurrency: string;
		data: { limit: number; key: string }[];
	};
	assert.equal(response.status, 200);
	assert.equal(result.billingCurrency, "CNY");
	assert.equal(result.data[0].limit, 12.5);
	assert.equal(result.data[0].key, "sk-01234…cdef");
	assert.equal(JSON.stringify(result).includes("sk-0123456789abcdef"), false);
	assert.deepEqual(calls, [["personal:user-1", { creatorUserId: "user-1" }]]);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("Gateway Key budget currency applies the same USD fallback as billing", async () => {
	for (const currency of [null, "invalid"]) {
		const { app } = createFixture(currency);
		const result = (await (await app.request("/gateway-keys")).json()) as {
			billingCurrency: string;
		};
		assert.equal(result.billingCurrency, "USD");
	}
});

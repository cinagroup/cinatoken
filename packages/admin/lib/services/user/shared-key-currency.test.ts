import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1DatabaseClient } from "@octafuse/core";
import type { GatewayRepositories, SharedKeyRow } from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userSharedKeysRoutes } from "@/lib/routes/user/shared-keys";

const sharedKey: SharedKeyRow = {
	id: "shared-1",
	sellerUserId: "seller-1",
	channelType: "openai",
	apiKey: "sk-synthetic-shared-secret",
	keyFingerprint: "synthetic-fingerprint",
	label: "Production",
	status: "active",
	sellerPriority: 0,
	weight: 1,
	inputPrice: 1.5,
	outputPrice: 2,
	cacheReadPrice: null,
	cacheWritePrice: 0,
	validatedAt: null,
	lastUsedAt: null,
	lastFailureAt: null,
	failureReason: null,
	servedInputTokens: 20,
	servedOutputTokens: 10,
	earnedTotal: 0.000045,
	createdAt: "2026-09-27T00:00:00.000Z",
	updatedAt: "2026-09-27T00:00:00.000Z",
};

function fixture(
	currency: string | null,
	rows: SharedKeyRow[] = [sharedKey],
	canManage = true
) {
	const sellers: string[] = [];
	const configuration = new Map<string, string | null>([
		["BILLING_CURRENCY", currency],
		["SHARED_KEY_ENABLED_CHANNELS", "openai,deepseek"],
		["SHARED_KEY_MAX_INPUT_PRICE", "3"],
		["SHARED_KEY_MAX_OUTPUT_PRICE", "6"],
		["SHARED_KEY_COMMISSION_RATE", "0.2"],
	]);
	const configurationDatabase = {
		prepare: () => ({
			bind: (key: string) => ({
				// Drizzle's selected-column projection reads positional values.
				raw: async () =>
					configuration.has(key) ? [[configuration.get(key)]] : [],
			}),
		}),
	} as unknown as D1Database;
	const repositories = {
		client: createD1DatabaseClient(configurationDatabase),
		sharedKeys: {
			listSharedKeysBySeller: async (seller: string) => {
				sellers.push(seller);
				return rows;
			},
		},
		systemConfig: {
			getConfig: async (key: string) => configuration.get(key) ?? null,
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "seller-1",
			capabilities: canManage ? ["shared_keys.manage"] : [],
			isAdmin: true,
		} as UserEnv["Variables"]["principal"]);
		// Shared credentials belong to the seller even while an organization is selected.
		c.set("workspaceContext", {
			currentWorkspace: { id: "organization:team" },
		} as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.route("/shared-keys", userSharedKeysRoutes);
	return { app, sellers };
}

test("shared quote currency and channel limits come from server configuration", async () => {
	const { app } = fixture("cny");
	const response = await app.request("/shared-keys/channels");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const result = (await response.json()) as {
		data: {
			billingCurrency: string;
			channels: { channelType: string }[];
			limits: {
				maxInputPrice: number;
				maxOutputPrice: number;
				commissionRate: number;
			};
		};
	};
	assert.equal(result.data.billingCurrency, "CNY");
	assert.deepEqual(
		result.data.channels.map((row) => row.channelType),
		["openai", "deepseek"]
	);
	assert.deepEqual(result.data.limits, {
		maxInputPrice: 3,
		maxOutputPrice: 6,
		commissionRate: 0.2,
	});
});

test("shared quote currency uses the billing contract fallback", async () => {
	for (const currency of [null, "invalid"]) {
		const { app } = fixture(currency);
		const result = (await (
			await app.request("/shared-keys/channels")
		).json()) as { data: { billingCurrency: string } };
		assert.equal(result.data.billingCurrency, "USD");
	}
});

test("seller list keeps masked values and recorded ledger units separate from quote currency", async () => {
	const { app, sellers } = fixture("CNY");
	const response = await app.request("/shared-keys");
	const result = (await response.json()) as {
		sellerUserId: string;
		earningsCurrency: string;
		data: Array<Omit<SharedKeyRow, "apiKey"> & { apiKeyMasked: string }>;
	};
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(sellers, ["seller-1"]);
	assert.equal(result.sellerUserId, "seller-1");
	assert.equal(result.earningsCurrency, "USD");
	assert.equal(result.data[0].inputPrice, sharedKey.inputPrice);
	assert.equal(result.data[0].earnedTotal, sharedKey.earnedTotal);
	assert.equal(result.data[0].sellerUserId, "seller-1");
	assert.ok(
		result.data[0].apiKeyMasked.includes("*") ||
			result.data[0].apiKeyMasked.includes("…")
	);
	assert.equal("apiKey" in result.data[0], false);
	assert.equal(JSON.stringify(result).includes(sharedKey.apiKey), false);
});

test("empty shared list still identifies the authenticated seller", async () => {
	const { app, sellers } = fixture("CNY", []);
	const result = (await (await app.request("/shared-keys")).json()) as {
		sellerUserId: string;
		earningsCurrency: string;
		data: unknown[];
	};
	assert.deepEqual(sellers, ["seller-1"]);
	assert.equal(result.sellerUserId, "seller-1");
	assert.equal(result.earningsCurrency, "USD");
	assert.deepEqual(result.data, []);
});

test("historical validation failures cannot expose the seller credential in masked lists", async () => {
	const row = {
		...sharedKey,
		failureReason: `Headers.append: Bearer ${sharedKey.apiKey} is invalid; retry ${sharedKey.apiKey}`,
	};
	const { app } = fixture("USD", [row]);
	const response = await app.request("/shared-keys");
	const result = (await response.json()) as {
		data: Array<{ failureReason: string }>;
	};
	assert.equal(
		result.data[0].failureReason,
		"Headers.append: Bearer [redacted] is invalid; retry [redacted]"
	);
	assert.equal(JSON.stringify(result).includes(sharedKey.apiKey), false);
	assert.equal(row.failureReason.includes(sharedKey.apiKey), true);
});

test("every seller operation requires shared_keys.manage before reading or changing resources", async () => {
	const { app, sellers } = fixture("USD", [sharedKey], false);
	for (const [path, method] of [
		["/shared-keys", "GET"],
		["/shared-keys/channels", "GET"],
		["/shared-keys", "POST"],
		["/shared-keys/shared-1", "PATCH"],
		["/shared-keys/shared-1", "DELETE"],
		["/shared-keys/shared-1/revalidate", "POST"],
	]) {
		const response = await app.request(path, { method });
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), {
			success: false,
			message: "Shared key access is not available",
		});
	}
	assert.deepEqual(sellers, []);
});

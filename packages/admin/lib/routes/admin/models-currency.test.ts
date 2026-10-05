import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { adminModelsRoutes } from "./models";

const model = {
	id: "legacy/model",
	display_name: "Legacy model",
	vendor: "other",
	context_window: 8192,
	max_tokens: 4096,
	pricing_profile: '{"tiers":[{"upto":null,"input_price":1,"output_price":2}]}',
	input_modalities: '["text"]',
	output_modalities: '["text"]',
	released_at: null,
	description: null,
	metadata: null,
	route_policy: null,
	created_at: "2026-09-27T00:00:00.000Z",
	routes_count: 0,
	active_routes_count: 0,
	tags: '["reasoning"]',
};

function fixture(rawCurrency: string | null | Error, rows = [model]) {
	let currencyReads = 0;
	const repositories = {
		models: {
			listModelsWithRouteCounts: async () => rows,
			getModelDetailWithRouteCounts: async (id: string) =>
				rows.find((row) => row.id === id) ?? null,
		},
		systemConfig: {
			getConfig: async (key: string) => {
				assert.equal(key, "BILLING_CURRENCY");
				currencyReads++;
				if (rawCurrency instanceof Error) throw rawCurrency;
				return rawCurrency;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			type: "console",
			id: "console:test",
			username: "test",
		});
		await next();
	});
	app.route("/admin/models", adminModelsRoutes);
	return { app, currencyReads: () => currencyReads };
}

test("list and detail expose the current gateway billing currency without changing old row prices", async () => {
	const { app, currencyReads } = fixture(" cny ");
	const list = await app.request("/admin/models");
	assert.equal(list.status, 200);
	const listed = (await list.json()) as {
		billing_currency: string;
		count: number;
		data: Array<{
			id: string;
			pricing_profile: string;
			tags: string[];
			billing_currency?: string;
		}>;
	};
	assert.equal(listed.billing_currency, "CNY");
	assert.equal(listed.count, 1);
	assert.equal(listed.data[0].id, model.id);
	assert.equal(listed.data[0].pricing_profile, model.pricing_profile);
	assert.deepEqual(listed.data[0].tags, ["reasoning"]);
	assert.equal(
		listed.data[0].billing_currency,
		undefined,
		"historical rows have no per-row provenance"
	);

	const detail = await app.request("/admin/models/legacy%2Fmodel");
	assert.equal(detail.status, 200);
	const found = (await detail.json()) as {
		billing_currency: string;
		data: { id: string; pricing_profile: string };
	};
	assert.equal(found.billing_currency, "CNY");
	assert.equal(found.data.id, model.id);
	assert.equal(found.data.pricing_profile, model.pricing_profile);
	assert.equal(currencyReads(), 2);
});

test("empty list still reports the configured currency and preserves legacy default semantics", async () => {
	for (const [raw, expected] of [
		[null, "USD"],
		["", "USD"],
		["invalid!", "USD"],
		["eur", "EUR"],
	] as const) {
		const { app } = fixture(raw, []);
		const response = await app.request("/admin/models");
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			success: true,
			data: [],
			count: 0,
			billing_currency: expected,
		});
	}
});

test("config read failure does not mislabel model prices as default USD", async () => {
	const { app } = fixture(new Error("private configuration failure"));
	for (const url of ["/admin/models", "/admin/models/legacy%2Fmodel"]) {
		const response = await app.request(url);
		assert.equal(response.status, 500);
		const body = (await response.json()) as {
			data?: unknown;
			billing_currency?: unknown;
		};
		assert.equal(body.data, undefined);
		assert.equal(body.billing_currency, undefined);
	}
});

test("unsupported configured currency rejects catalog preview and import before any model access", async () => {
	let modelAccesses = 0;
	const repositories = {
		systemConfig: { getConfig: async () => "EUR" },
		models: new Proxy(
			{},
			{
				get() {
					modelAccesses++;
					throw new Error("model repository must not be accessed");
				},
			}
		),
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			type: "console",
			id: "console:test",
			username: "test",
		});
		await next();
	});
	app.route("/admin/models", adminModelsRoutes);
	for (const [url, init] of [
		["/admin/models/import/catalog", undefined],
		[
			"/admin/models/import",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids: ["catalog/new"] }),
			},
		],
	] as const) {
		const response = await app.request(url, init);
		assert.equal(response.status, 400);
		const body = (await response.json()) as {
			success: boolean;
			message: string;
			data?: unknown;
			billing_currency?: unknown;
		};
		assert.equal(body.success, false);
		assert.match(body.message, /EUR.*USD or CNY/);
		assert.equal(body.data, undefined);
		assert.equal(body.billing_currency, undefined);
	}
	assert.equal(modelAccesses, 0);
});

test("unset or malformed configuration keeps the original USD catalog branch", async () => {
	for (const raw of [null, "invalid!"]) {
		const { app } = fixture(raw, []);
		const response = await app.request("/admin/models/import/catalog");
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			billing_currency: string;
			data: unknown[];
		};
		assert.equal(body.billing_currency, "USD");
		assert.ok(body.data.length > 0);
	}
});

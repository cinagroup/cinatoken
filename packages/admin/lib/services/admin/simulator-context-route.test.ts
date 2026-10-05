/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";

function fixture(
	permissions: AdminPermission[],
	currency: string | null | Error = " cny ",
	modelOverride?: Record<string, unknown>
) {
	const reads: string[] = [];
	const secret = "sk-synthetic-hidden-context";
	const repositories = {
		client: { driver: "d1", raw: {} },
		models: {
			listModelsWithRouteCounts: async () => {
				reads.push("models");
				return [
					{
						id: "model-1",
						display_name: "Model 1",
						vendor: "synthetic",
						input_modalities: '["text","image"]',
						output_modalities: '["text"]',
						metadata: secret,
						pricing_profile: secret,
						route_policy: secret,
						...modelOverride,
					},
				];
			},
		},
		routes: {
			listModelRoutesWithJoins: async () => {
				reads.push("routes");
				return [
					{
						id: "route-1",
						model_id: "model-1",
						provider_id: "provider-1",
						provider_model_name: "synthetic-model",
						provider_name: "Synthetic",
						priority: 1,
						status: "active",
						route_group: "default",
						upstream_protocol: "openai",
						upstream_operation: "chat.completions",
						adapter: "",
						route_pool_id: "pool-1",
						pool_name: "Pool 1",
						custom_params: secret,
						price_override: secret,
						routing_metadata: secret,
						endpoints: secret,
						surfaces: JSON.stringify([
							{
								id: "surface-1",
								request_protocol: "openai",
								request_operation: "chat.completions",
								status: "active",
								secret,
							},
						]),
					},
				];
			},
		},
		systemConfig: {
			getConfig: async (key: string) => {
				reads.push(key);
				if (currency instanceof Error) throw currency;
				return currency;
			},
		},
		providers: {
			getProviderRowById: () =>
				assert.fail("Simulator context must not reveal Provider credentials"),
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal = {
		type: "api_key",
		id: "admin_key:test",
		keyId: "test",
		permissions,
	};
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		reads,
		secret,
		request: (path = "/admin/simulator/context", method = "GET") =>
			app.request(path, { method }, bindings),
	};
}

test("Simulator uses models/routes read permissions independently of Playground and ancillary capabilities", async () => {
	for (const permissions of [
		["playground.execute"],
		["models.read"],
		["routes.read"],
	] as AdminPermission[][]) {
		const subject = fixture(permissions);
		const response = await subject.request();
		assert.equal(response.status, 403);
		assert.equal(subject.reads.length, 0);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	const subject = fixture(["models.read", "routes.read"]);
	const response = await subject.request();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = (await response.json()) as {
		data: {
			billing_currency: string | null;
			capabilities: object;
			models: object[];
			routes: object[];
		};
	};
	assert.equal(body.data.billing_currency, null);
	assert.deepEqual(body.data.capabilities, {
		can_read_keys: false,
		can_read_logs: false,
	});
	assert.equal(JSON.stringify(body).includes(subject.secret), false);
	assert.equal(subject.reads.includes("BILLING_CURRENCY"), false);
	assert.deepEqual(Object.keys(body.data.models[0]).sort(), [
		"audio_operation",
		"display_name",
		"id",
		"input_modalities",
		"kind",
		"output_modalities",
		"vendor",
	]);
	assert.equal("custom_params" in body.data.routes[0], false);
});

test("legacy audio pricing classification is projected as an operation without exposing the profile", async () => {
	for (const [profile, expected] of [
		[
			{
				audio_billing_mode: "per_character",
				audio: { price_per_character: 0.0001 },
			},
			"speech",
		],
		[
			{ audio_billing_mode: "per_second", audio: { price_per_second: 0.0001 } },
			"transcriptions",
		],
	] as const) {
		const raw = JSON.stringify(profile);
		const subject = fixture(["models.read", "routes.read"], null, {
			output_modalities: null,
			pricing_profile: raw,
		});
		const response = await subject.request();
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			data: { models: Array<{ kind: string; audio_operation: string | null }> };
		};
		assert.equal(body.data.models[0].kind, "audio");
		assert.equal(body.data.models[0].audio_operation, expected);
		assert.equal(JSON.stringify(body).includes(raw), false);
		assert.equal("pricing_profile" in body.data.models[0], false);
	}
});

test("currency is explicitly unavailable on missing/invalid/failing config; safe surfaces have an exact projection", async () => {
	for (const currency of [
		null,
		"not-a-currency",
		new Error("configuration unavailable"),
		" cny ",
	]) {
		const subject = fixture(
			[
				"models.read",
				"routes.read",
				"config.read",
				"user_keys.read",
				"logs.read",
			],
			currency
		);
		const response = await subject.request();
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			data: {
				billing_currency: string | null;
				capabilities: object;
				realtime_tts_supported: boolean;
				routes: Array<{ surfaces: object[] }>;
			};
		};
		assert.equal(
			body.data.billing_currency,
			currency === " cny " ? "CNY" : null
		);
		assert.deepEqual(body.data.capabilities, {
			can_read_keys: true,
			can_read_logs: true,
		});
		assert.equal(body.data.realtime_tts_supported, false);
		assert.deepEqual(body.data.routes[0].surfaces, [
			{
				id: "surface-1",
				request_protocol: "openai",
				request_operation: "chat.completions",
				status: "active",
			},
		]);
		assert.equal(JSON.stringify(body).includes(subject.secret), false);
	}
});

test("context rejects queries and methods, returns a bodyless private HEAD", async () => {
	const subject = fixture(["models.read", "routes.read"]);
	assert.equal(
		(await subject.request("/admin/simulator/context?secret=unused")).status,
		400
	);
	assert.equal(subject.reads.length, 0);
	assert.equal(
		(await subject.request("/admin/simulator/context", "POST")).status,
		403
	);
	assert.equal(subject.reads.length, 0);
	const response = await subject.request("/admin/simulator/context", "HEAD");
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});

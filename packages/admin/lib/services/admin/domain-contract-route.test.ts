import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { EXPECTED_CONSOLE_SUBJECT_HEADER } from "./expected-console-subject";

const consolePrincipal = (subject = "operator%one"): AdminPrincipal => ({
	type: "console",
	username: `cinaauth:${subject}`,
	id: `console:cinaauth:${subject}`,
});
const named = (
	permissions: AdminPermission[] = [
		"providers.write",
		"models.write",
		"routes.write",
	]
): AdminPrincipal => ({
	type: "api_key",
	id: "admin_key:synthetic",
	keyId: "synthetic",
	permissions,
});
const domains = ["providers", "models", "endpoints", "routes"] as const;
function fixture(
	options: {
		principal?: AdminPrincipal | null;
		requirePolicy?: string;
		stale?: boolean;
		absent?: boolean;
		wrongId?: boolean;
		fault?: boolean;
		unavailable?: boolean;
		providerId?: string;
		modelId?: string;
	} = {}
) {
	const calls: { kind: string; args: unknown[] }[] = [];
	const call =
		(kind: string, result: unknown) =>
		async (...args: unknown[]) => {
			calls.push({ kind, args });
			if (options.fault) throw new Error("Synthetic repository failure");
			if (options.unavailable)
				throw Object.assign(new Error("CONNECTION_CLOSED"), {
					code: "CONNECTION_CLOSED",
				});
			return result;
		};
	const row = (id: string, extra = {}) =>
		options.absent
			? null
			: { id: options.wrongId ? "wrong-resource" : id, ...extra };
	const repositories = {
		client: { driver: "d1", raw: {} },
		models: {
			insertModel: call("model.insert", undefined),
			getModelDetailWithRouteCounts: call(
				"model.read",
				row(options.modelId ?? "model-1", { route_policy: null, tags: "[]" })
			),
			updateModelByPatch: call("model.legacy", 1),
			replaceModelTags: call("model.tags", undefined),
			updateModelWithPolicyPrecondition: call("model.cas", !options.stale),
			deleteModelCascade: call("model.delete", 1),
			listModelsWithRouteCounts: call("model.list", []),
		},
		providers: {
			providerIdExists: call("provider.exists", false),
			insertProvider: call("provider.insert", undefined),
			getProviderById: call(
				"provider.resource",
				row("provider-1", {
					api_key: "synthetic-resource-key",
					endpoints: JSON.stringify({
						dashscope: { base: "https://synthetic-provider.invalid/api/v1" },
					}),
				})
			),
			getProviderRowById: call(
				"provider.read",
				row(options.providerId ?? "provider-1")
			),
			getProviderApiKeyPlaintext: call("provider.reveal", {
				api_key: "synthetic-only",
			}),
			updateProviderByPatch: call("provider.update", 1),
			deleteProviderById: call("provider.delete", 1),
			listProviders: call("provider.list", []),
		},
		routes: {
			getModelRouteRowById: call(
				"route.read",
				row("route-1", {
					model_id: "model-1",
					provider_id: "provider-1",
					route_pool_id: null,
				})
			),
			deleteModelRouteById: call("route.delete", 1),
			listModelRoutesWithJoins: call("route.list", []),
			updateRoutePoolPolicy: call("pool.policy", options.absent ? 0 : 1),
			bumpRoutePoolStickyEpoch: call("pool.reset", options.absent ? null : 7),
		},
		routePoolSticky: { forceClearBinding: call("pool.clear", false) },
		modelEndpoints: {
			getById: call(
				"endpoint.read",
				row("endpoint-1", {
					model_id: "model-1",
					provider_id: "provider-1",
					status: "draft",
					updated_at: "2026-10-01T00:00:00Z",
				})
			),
			delete: call("endpoint.delete", 1),
			linkRoute: call("endpoint.link", !options.stale),
			unlinkRoute: call("endpoint.unlink", options.absent ? 0 : 1),
			list: call("endpoint.list", []),
		},
		systemConfig: { getConfig: call("config.read", "USD") },
	} as unknown as GatewayRepositories;
	const app = createAdminApp();
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === undefined
				? consolePrincipal()
				: options.principal ?? undefined,
		CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION:
			options.requirePolicy,
	} as unknown as AdminBindings;
	return {
		calls,
		request: (
			path: string,
			method = "GET",
			body?: unknown,
			headers: Record<string, string> = {}
		) =>
			app.fetch(
				new Request(`https://test.invalid/admin/${path}`, {
					method,
					headers: {
						...(body === undefined
							? {}
							: { "Content-Type": "application/json" }),
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
				bindings
			),
		raw: (path: string, init: RequestInit) =>
			app.fetch(
				new Request(`https://test.invalid/admin/${path}`, init),
				bindings
			),
	};
}
type TestBody = {
	acknowledgement?: unknown;
	code?: string;
	data: {
		api_key?: string;
		created?: number;
		skipped_existing?: string[];
		failed: { id: string }[];
	};
};
const json = (response: Response) => response.json() as Promise<TestBody>;
const privateResponse = (response: Response, status: number) => {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
};

for (const domain of [
	...domains,
	"presets",
	"guardrails",
	"data-policies",
] as const) {
	test(`${domain} real Hono: early 401/403/413 are private with zero business calls`, async () => {
		const unauthorized = fixture({ principal: null });
		privateResponse(await unauthorized.request(domain, "POST", {}), 401);
		assert.equal(unauthorized.calls.length, 0);
		const forbidden = fixture({ principal: named([]) });
		privateResponse(await forbidden.request(domain, "POST", {}), 403);
		assert.equal(forbidden.calls.length, 0);
		const large = fixture();
		privateResponse(
			await large.raw(domain, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": "20971521",
				},
				body: "{}",
			}),
			413
		);
		assert.equal(large.calls.length, 0);
	});
	test(`${domain} real Hono: supplied subject rejects malformed/stale/bearer even on reads before repository access`, async () => {
		for (const header of [
			"",
			"operator%25one%20",
			"other",
			"%6Fperator%25one",
		]) {
			const f = fixture();
			const response = await f.request(`${domain}/missing`, "GET", undefined, {
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: header,
			});
			assert.ok(response.status === 400 || response.status === 403);
			assert.equal(response.headers.get("Cache-Control"), "private, no-store");
			assert.equal(f.calls.length, 0);
		}
		const f = fixture({
			principal: named([
				"providers.read",
				"models.read",
				"routes.read",
				"presets.read",
				"guardrails.read",
			]),
		});
		privateResponse(
			await f.request(`${domain}/missing`, "GET", undefined, {
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: "operator%25one",
			}),
			400
		);
		assert.equal(f.calls.length, 0);
	});
	if (
		domain === "presets" ||
		domain === "guardrails" ||
		domain === "data-policies"
	)
		continue;
	test(`${domain} real Hono: authorized headerless Console/Bearer delete keeps exact domain/operation/resource ACK`, async () => {
		const id = {
			providers: "provider-1",
			models: "model-1",
			endpoints: "endpoint-1",
			routes: "route-1",
		}[domain];
		for (const principal of [consolePrincipal(), named()]) {
			const f = fixture({ principal });
			const response = await f.request(`${domain}/${id}`, "DELETE");
			privateResponse(response, 200);
			assert.deepEqual((await json(response)).acknowledgement, {
				domain,
				operation: "delete",
				id,
			});
		}
	});
	test(`${domain} real Hono: absent/wrong stored resource and repository faults have no success ACK`, async () => {
		const id = {
			providers: "provider-1",
			models: "model-1",
			endpoints: "endpoint-1",
			routes: "route-1",
		}[domain];
		for (const options of [
			{ absent: true },
			{ wrongId: true },
			{ fault: true },
		]) {
			const f = fixture(options);
			const response = await f.request(`${domain}/${id}`, "DELETE");
			privateResponse(response, options.fault ? 500 : 404);
			assert.equal((await json(response)).acknowledgement, undefined);
			assert.equal(
				f.calls.some((call) => call.kind.endsWith(".delete")),
				false
			);
		}
	});
}

test("model CAS actual Hono: null/raw read-set and all fields/tags pass once to atomic repository", async () => {
	for (const expected of [null, ' {"strategy":"hash_affinity"} ']) {
		const f = fixture();
		const response = await f.request(
			"models/model-1",
			"PATCH",
			{
				expected_route_policy: expected,
				route_policy: null,
				pricing_profile: null,
				description: null,
				display_name: "New",
				tags: ["a"],
			},
			{ [EXPECTED_CONSOLE_SUBJECT_HEADER]: "operator%25one" }
		);
		privateResponse(response, 200);
		assert.deepEqual((await json(response)).acknowledgement, {
			domain: "models",
			operation: "update",
			id: "model-1",
		});
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.calls[0], {
			kind: "model.cas",
			args: [
				"model-1",
				{
					route_policy: null,
					pricing_profile: null,
					description: null,
					display_name: "New",
				},
				expected,
				["a"],
			],
		});
	}
});
test("model CAS actual Hono: conflict/malformed/missing-required input never falls back to legacy or tags", async () => {
	const stale = fixture({ stale: true });
	const conflict = await stale.request("models/model-1", "PATCH", {
		expected_route_policy: null,
		route_policy: null,
		tags: ["a"],
	});
	privateResponse(conflict, 409);
	assert.equal((await json(conflict)).code, "model_route_policy_conflict");
	assert.equal(stale.calls.length, 1);
	const required = fixture({ requirePolicy: "true" });
	const missing = await required.request("models/model-1", "PATCH", {
		route_policy: null,
	});
	privateResponse(missing, 428);
	assert.equal(
		(await json(missing)).code,
		"model_route_policy_precondition_required"
	);
	assert.equal(required.calls.length, 0);
	for (const expected of [{}, [], 3, true]) {
		const f = fixture();
		const response = await f.request("models/model-1", "PATCH", {
			expected_route_policy: expected,
			route_policy: null,
		});
		privateResponse(response, 400);
		assert.equal(
			(await json(response)).code,
			"invalid_model_route_policy_precondition"
		);
		assert.equal(f.calls.length, 0);
	}
});
test("model CAS actual Hono: guard default off keeps legacy writes; existing no-op gets exact ACK, absent no-op cannot succeed", async () => {
	for (const requirePolicy of [undefined, "false", "TRUE"]) {
		const f = fixture({ requirePolicy, principal: named() });
		const response = await f.request("models/model-1", "PATCH", {
			route_policy: null,
		});
		privateResponse(response, 200);
		assert.deepEqual(
			f.calls.map((c) => c.kind),
			["model.read", "model.legacy"]
		);
	}
	const noop = fixture();
	privateResponse(await noop.request("models/model-1", "PATCH", {}), 200);
	const missing = fixture({ absent: true });
	privateResponse(await missing.request("models/model-1", "PATCH", {}), 404);
});
test("provider reveal provided stale subject cannot read a secret; legacy read remains private", async () => {
	const f = fixture();
	privateResponse(
		await f.request("providers/provider-1/api-key", "GET", undefined, {
			[EXPECTED_CONSOLE_SUBJECT_HEADER]: "other",
		}),
		403
	);
	assert.equal(f.calls.length, 0);
	const old = fixture();
	const response = await old.request("providers/provider-1/api-key");
	privateResponse(response, 200);
	assert.equal((await json(response)).data.api_key, "synthetic-only");
});
test("pool policy and sticky ACK identify exact pool/hash; a known missing binding is a successful no-op", async () => {
	const f = fixture();
	const policy = await f.request("routes/pools/pool-1", "PATCH", {
		strategy: "hash_affinity",
	});
	privateResponse(policy, 200);
	assert.deepEqual((await json(policy)).acknowledgement, {
		domain: "routes",
		operation: "policy",
		id: "pool-1",
	});
	const hash = "a".repeat(64);
	const cleared = await f.request(
		`routes/pools/pool-1/sticky/bindings/${hash}`,
		"DELETE"
	);
	privateResponse(cleared, 200);
	assert.deepEqual(await json(cleared), {
		success: true,
		message: "No sticky binding found",
		acknowledgement: {
			domain: "routes",
			operation: "clear-sticky",
			id: "pool-1",
			related_id: hash,
		},
		data: { cleared: false },
	});
	const reset = await f.request("routes/pools/pool-1/sticky/reset", "POST");
	privateResponse(reset, 200);
	assert.deepEqual((await json(reset)).acknowledgement, {
		domain: "routes",
		operation: "reset-sticky",
		id: "pool-1",
	});
});
test("endpoint link/unlink ACK bind both endpoint and target; conflict has no ACK", async () => {
	for (const [method, operation, status] of [
		["POST", "link", 201],
		["DELETE", "unlink", 200],
	] as const) {
		const f = fixture();
		const response = await f.request(
			"endpoints/endpoint-1/routes/route-1",
			method
		);
		privateResponse(response, status);
		assert.deepEqual((await json(response)).acknowledgement, {
			domain: "endpoints",
			operation,
			id: "endpoint-1",
			related_id: "route-1",
		});
	}
	const f = fixture({ stale: true });
	const response = await f.request(
		"endpoints/endpoint-1/routes/route-1",
		"POST"
	);
	privateResponse(response, 409);
	assert.equal((await json(response)).acknowledgement, undefined);
});
test("four domains outer BFF cache classifier protects actual/encoded early responses including 5xx", () => {
	for (const domain of domains)
		for (const status of [401, 403, 413, 500, 503])
			for (const path of [
				`/api/admin/${domain}`,
				`/api/admin/${domain}/child`,
				`/api/admin/%${domain.charCodeAt(0).toString(16)}${domain.slice(
					1
				)}/child`,
			]) {
				const response = protectAdminConfigResponse(
					new Request(`https://test.invalid${path}`),
					Response.json({ success: false }, { status })
				);
				privateResponse(response, status);
			}
});

test("four domains actual Hono: database connection failure is a private 503 without mutation ACK", async () => {
	for (const domain of domains) {
		const id = {
			providers: "provider-1",
			models: "model-1",
			endpoints: "endpoint-1",
			routes: "route-1",
		}[domain];
		const f = fixture({ unavailable: true });
		const response = await f.request(`${domain}/${id}`, "DELETE");
		privateResponse(response, 503);
		assert.equal((await json(response)).acknowledgement, undefined);
	}
});
test("DashScope resource preserves official body and binds ACK header to provider/resource only on HTTP success", async (t) => {
	const native = {
		model: "synthetic-resource-model",
		input: { action: "list" },
		parameters: { page_size: 10 },
	};
	let upstreamStatus = 200;
	const requests: { body: unknown; url: string }[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: unknown, init: RequestInit) => {
			requests.push({
				url: String(input),
				body: JSON.parse(String(init.body)),
			});
			return Response.json(
				{ request_id: "synthetic", output: { items: [] } },
				{ status: upstreamStatus }
			);
		}
	);
	const f = fixture();
	const denied = await f.request(
		"providers/provider-1/dashscope/hotwords",
		"POST",
		native,
		{
			[EXPECTED_CONSOLE_SUBJECT_HEADER]: "other",
		}
	);
	privateResponse(denied, 403);
	assert.equal(requests.length, 0);
	assert.equal(f.calls.length, 0);
	const wrong = fixture({ wrongId: true });
	privateResponse(
		await wrong.request(
			"providers/provider-1/dashscope/hotwords",
			"POST",
			native
		),
		404
	);
	assert.equal(requests.length, 0);
	for (const status of [200, 429]) {
		upstreamStatus = status;
		const response = await f.request(
			"providers/provider-1/dashscope/hotwords",
			"POST",
			native,
			{
				[EXPECTED_CONSOLE_SUBJECT_HEADER]: "operator%25one",
			}
		);
		privateResponse(response, status);
		assert.deepEqual(await json(response), {
			request_id: "synthetic",
			output: { items: [] },
		});
		assert.deepEqual(requests.at(-1)?.body, native);
		const ack = response.headers.get("X-CinaToken-Acknowledgement");
		assert.deepEqual(
			ack && JSON.parse(ack),
			status === 200
				? {
						domain: "providers",
						operation: "resource",
						id: "provider-1",
						related_id: "hotwords",
				  }
				: null
		);
	}
});
test("partial imports acknowledge handled operation but preserve per-item failed/skipped results", async () => {
	for (const domain of ["providers", "models"]) {
		const f = fixture();
		const response = await f.request(`${domain}/import`, "POST", {
			ids: ["not-a-real-catalog-entry"],
		});
		privateResponse(response, 200);
		const body = await json(response);
		assert.deepEqual(body.acknowledgement, { domain, operation: "import" });
		assert.equal(body.data.created, 0);
		assert.deepEqual(body.data.skipped_existing, []);
		assert.equal(body.data.failed.length, 1);
		assert.equal(body.data.failed[0].id, "not-a-real-catalog-entry");
	}
});

test("shared domain middleware does not shorten legacy 600-character Provider/Model identities", async () => {
	for (const domain of ["providers", "models"]) {
		const id = domain + "x".repeat(600 - domain.length);
		const f = fixture({ providerId: id, modelId: id });
		const response = await f.request(
			`${domain}/${encodeURIComponent(id)}`,
			"DELETE"
		);
		privateResponse(response, 200);
		assert.deepEqual((await json(response)).acknowledgement, {
			domain,
			operation: "delete",
			id,
		});
	}
});

test("Provider/Model create actual Hono: normalized URL dot IDs reject before repository or external calls and never ACK", async (t) => {
	let externalCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		externalCalls++;
		throw new Error("No external call is allowed for invalid IDs");
	});
	for (const domain of ["providers", "models"]) {
		for (const principal of [consolePrincipal(), named()]) {
			for (const id of [".", "..", " . ", " .. "]) {
				const f = fixture({ principal });
				const body =
					domain === "providers"
						? { id, name: "Synthetic clone", api_key: "synthetic-only" }
						: {
								id,
								pricing_profile: {
									tiers: [{ upto: null, input_price: 1, output_price: 2 }],
								},
								tags: ["synthetic"],
						  };
				const response = await f.request(domain, "POST", body);
				privateResponse(response, 400);
				assert.equal((await json(response)).acknowledgement, undefined);
				assert.deepEqual(f.calls, []);
			}
		}
	}
	assert.equal(externalCalls, 0);
});

test("Provider/Model create actual Hono: ordinary slash, Unicode and existing ID capacity keep exact ACK and insert identity", async () => {
	for (const domain of ["providers", "models"]) {
		for (const id of ["vendor/model", "供应商/模型", "x".repeat(600)]) {
			const f = fixture();
			const body =
				domain === "providers"
					? { id, name: "Synthetic clone", api_key: "synthetic-only" }
					: {
							id,
							pricing_profile: {
								tiers: [{ upto: null, input_price: 1, output_price: 2 }],
							},
							tags: ["synthetic"],
					  };
			const response = await f.request(domain, "POST", body);
			privateResponse(response, 200);
			assert.deepEqual((await json(response)).acknowledgement, {
				domain,
				operation: "create",
				id,
			});
			const inserted = f.calls.find(
				(call) =>
					call.kind ===
					`${domain === "providers" ? "provider" : "model"}.insert`
			);
			assert.equal((inserted?.args[0] as { id: string }).id, id);
			assert.equal(
				f.calls.filter((call) => call.kind.endsWith(".insert")).length,
				1
			);
			if (domain === "models")
				assert.deepEqual(
					f.calls.find((call) => call.kind === "model.tags")?.args,
					[id, ["synthetic"]]
				);
		}
	}
});

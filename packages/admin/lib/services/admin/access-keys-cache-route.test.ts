import assert from "node:assert/strict";
import test from "node:test";
import type { AdminApiKeyRow, GatewayRepositories } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";

const SECRET = `sk-admin-${"a".repeat(64)}`;
const KEY: AdminApiKeyRow = {
	id: "integration-key-1",
	name: "Billing portal",
	description: "Reads usage",
	secretKey: SECRET,
	keyPrefix: SECRET.slice(0, 12),
	permissionsJson: '["analytics.read"]',
	status: "active",
	lastUsedAt: null,
	createdAt: "2026-09-29T00:00:00.000Z",
	updatedAt: "2026-09-29T00:00:00.000Z",
	revokedAt: null,
};

const CONSOLE: AdminPrincipal = {
	type: "console",
	id: "console:cache-test",
	username: "operator",
};
const BEARER_ALL: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:cache-test",
	keyId: "cache-test",
	permissions: ["*"],
};

function fixture(
	principal: AdminPrincipal | undefined,
	failList = false,
	keyRow = KEY
) {
	let reads = 0;
	const read = () => {
		reads++;
		return keyRow;
	};
	const repositories = {
		adminAccess: {
			listApiKeys: async () => {
				if (failList) throw new Error("injected storage failure");
				return [read()];
			},
			getApiKeyById: async () => read(),
			revealApiKeyWithAudit: async () => read(),
			listApiKeyAudit: async () => [],
			insertApiKey: async () => undefined,
			updateApiKey: async () => true,
			rotateApiKey: async () => true,
			revokeApiKey: async () => true,
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string, method = "GET", body?: unknown) => {
			const serialized = body === undefined ? undefined : JSON.stringify(body);
			return app.request(
				path,
				{
					method,
					...(serialized === undefined
						? {}
						: {
								headers: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(serialized)),
								},
								body: serialized,
						  }),
				},
				bindings
			);
		},
		reads: () => reads,
	};
}

const ROUTES = [
	{ method: "GET", path: "/admin/access-keys" },
	{
		method: "POST",
		path: "/admin/access-keys",
		body: { name: "New portal", permissions: ["analytics.read"] },
	},
	{ method: "GET", path: `/admin/access-keys/${KEY.id}` },
	{
		method: "PATCH",
		path: `/admin/access-keys/${KEY.id}`,
		body: { name: "Renamed portal" },
	},
	{ method: "GET", path: `/admin/access-keys/${KEY.id}/secret` },
	{ method: "GET", path: `/admin/access-keys/${KEY.id}/audit` },
	{ method: "POST", path: `/admin/access-keys/${KEY.id}/rotate` },
	{ method: "POST", path: `/admin/access-keys/${KEY.id}/revoke` },
] as const;

test("each integration-key route keeps successful console responses private", async () => {
	for (const route of ROUTES) {
		const subject = fixture(CONSOLE);
		const response = await subject.request(
			route.path,
			route.method,
			"body" in route ? route.body : undefined
		);
		assert.ok(response.ok, `${route.method} ${route.path}: ${response.status}`);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			route.path
		);
	}
	for (const path of [
		"/admin/access-keys/",
		"/admin/access-keys/missing/unknown",
	]) {
		const response = await fixture(CONSOLE).request(path);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			path
		);
	}
});

test("masked list and detail never expose the secret; explicit reveal is private", async () => {
	const subject = fixture(CONSOLE);
	for (const path of ["/admin/access-keys", `/admin/access-keys/${KEY.id}`]) {
		const response = await subject.request(path);
		const body = await response.text();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.ok(body.includes(KEY.keyPrefix));
		assert.ok(!body.includes(SECRET));
	}
	const reveal = await subject.request(`/admin/access-keys/${KEY.id}/secret`);
	assert.equal(reveal.status, 200);
	assert.equal(reveal.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await reveal.json(), {
		success: true,
		data: { id: KEY.id, key: SECRET },
	});
});

test("legacy and malformed stored prefixes keep at least four trailing secret characters hidden", async () => {
	for (const length of [1, 4, 5, 12, 16, 32]) {
		const secret = "Ω".repeat(length);
		const subject = fixture(CONSOLE, false, {
			...KEY,
			secretKey: secret,
			keyPrefix: secret,
		});
		for (const path of ["/admin/access-keys", `/admin/access-keys/${KEY.id}`]) {
			const response = await subject.request(path);
			const json = (await response.json()) as {
				data:
					| { key: string; key_prefix: string }
					| { key: string; key_prefix: string }[];
			};
			const row = Array.isArray(json.data) ? json.data[0]! : json.data;
			assert.equal(
				row.key_prefix,
				secret.slice(0, Math.min(12, Math.max(0, length - 4)))
			);
			assert.equal(row.key, `${row.key_prefix}••••••••`);
			assert.ok(
				!JSON.stringify(json).includes(secret),
				`${path}: secret length ${length}`
			);
		}
	}
});

test("Bearer wildcard and anonymous principals cannot read any integration-key route", async () => {
	for (const route of ROUTES) {
		const bearer = fixture(BEARER_ALL);
		const forbidden = await bearer.request(
			route.path,
			route.method,
			"body" in route ? route.body : undefined
		);
		assert.equal(forbidden.status, 403, route.path);
		assert.equal(
			forbidden.headers.get("cache-control"),
			"private, no-store",
			route.path
		);
		assert.deepEqual(await forbidden.json(), {
			success: false,
			message: "Forbidden",
			required_permission: "console_session",
		});
		assert.equal(bearer.reads(), 0, route.path);

		const anonymous = fixture(undefined);
		const unauthorized = await anonymous.request(
			route.path,
			route.method,
			"body" in route ? route.body : undefined
		);
		assert.equal(unauthorized.status, 401, route.path);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store",
			route.path
		);
		assert.equal(anonymous.reads(), 0, route.path);
	}
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", `/admin/access-keys/${KEY.id}/secret`),
		{
			kind: "console_only",
		}
	);
});

test("integration-key storage failures are private inside Hono", async () => {
	const response = await fixture(CONSOLE, true).request("/admin/access-keys");
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("internal preflight and body-limit early returns stay private", async () => {
	const subject = fixture(CONSOLE);
	const preflight = await subject.request(
		`/admin/access-keys/${KEY.id}/secret`,
		"OPTIONS"
	);
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get("cache-control"), "private, no-store");

	const tooLarge = await subject.request("/admin/access-keys", "POST", {
		name: "x".repeat(2 * 1024 * 1024),
		permissions: ["analytics.read"],
	});
	assert.equal(tooLarge.status, 413);
	assert.equal(tooLarge.headers.get("cache-control"), "private, no-store");
	assert.equal(subject.reads(), 0);
});

test("outer policy protects pre-Hono responses for all key children without matching adjacent paths", () => {
	for (const route of ROUTES) {
		for (const path of [route.path, `${route.path}/`]) {
			for (const status of [200, 201, 400, 401, 403, 404, 500, 503]) {
				const response = protectAdminConfigResponse(
					new Request(`https://admin.example.test/api${path}?view=full`, {
						method: route.method,
					}),
					Response.json(
						{ success: status < 400 },
						{ status, headers: { "Cache-Control": "public, max-age=600" } }
					)
				);
				assert.equal(
					response.headers.get("cache-control"),
					"private, no-store",
					`${route.method} ${path}`
				);
			}
		}
	}
	for (const path of [
		"/api/admin/access-keys-extra",
		"/api/admin/access-key",
		"/api/admin/access-keys-v2/secret",
		"/api/admin/other/access-keys",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			Response.json(
				{ success: false },
				{ status: 503, headers: { "Cache-Control": "public, max-age=600" } }
			)
		);
		assert.equal(
			response.headers.get("cache-control"),
			"public, max-age=600",
			path
		);
	}
});

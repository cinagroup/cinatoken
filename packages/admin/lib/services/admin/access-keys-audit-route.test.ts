import assert from "node:assert/strict";
import test from "node:test";
import type {
	AdminApiKeyAuditContext,
	AdminApiKeyAuditRow,
	AdminApiKeyRow,
	GatewayRepositories,
} from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";

const SECRET = `sk-admin-${"f".repeat(64)}`;
const key: AdminApiKeyRow = {
	id: "integration-key",
	name: "portal",
	description: null,
	secretKey: SECRET,
	keyPrefix: SECRET.slice(0, 12),
	permissionsJson: '["logs.read"]',
	status: "active",
	lastUsedAt: null,
	createdAt: "2026-09-30T00:00:00.000Z",
	updatedAt: "2026-09-30T00:00:00.000Z",
	revokedAt: null,
};
const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:alice",
	username: "alice",
};
const entries: AdminApiKeyAuditRow[] = [3, 2, 1].map((number) => ({
	id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
	keyId: key.id,
	action: "revealed",
	changeMask: 0,
	actorKind: "console",
	actorId: "console:alice",
	beforePermissions: ["logs.read"],
	afterPermissions: ["logs.read"],
	beforeStatus: "active",
	afterStatus: "active",
	createdAt: "2026-09-30T00:00:00.000123Z",
}));
function fixture(
	options: {
		fail?: boolean;
		principal?: AdminPrincipal | null;
		missing?: boolean;
	} = {}
) {
	const actors: AdminApiKeyAuditContext[] = [];
	const reads: unknown[] = [];
	const audited = (audit: AdminApiKeyAuditContext) => {
		actors.push(audit);
		if (options.fail) throw new Error("injected audit storage failure");
	};
	const repository = {
		getApiKeyById: async () => (options.missing ? null : key),
		listApiKeys: async () => [key],
		insertApiKey: async (_params: unknown, audit: AdminApiKeyAuditContext) =>
			audited(audit),
		updateApiKey: async (
			_id: string,
			_patch: unknown,
			audit: AdminApiKeyAuditContext
		) => {
			audited(audit);
			return true;
		},
		rotateApiKey: async (
			_id: string,
			_secret: string,
			audit: AdminApiKeyAuditContext
		) => {
			audited(audit);
			return true;
		},
		revokeApiKey: async (_id: string, audit: AdminApiKeyAuditContext) => {
			audited(audit);
			return true;
		},
		revealApiKeyWithAudit: async (
			_id: string,
			audit: AdminApiKeyAuditContext
		) => {
			audited(audit);
			return key;
		},
		listApiKeyAudit: async (
			id: string,
			query: { limit: number; before?: { id: string; createdAt: string } }
		) => {
			reads.push({ id, ...query });
			if (options.fail) throw new Error("injected audit storage failure");
			return entries
				.filter((row) => !query.before || row.id < query.before.id)
				.slice(0, query.limit);
		},
	};
	const app = createAdminApp();
	const bindings = {
		STORAGE_CONTEXT: {
			repositories: {
				adminAccess: repository,
			} as unknown as GatewayRepositories,
		},
		ADMIN_PRINCIPAL:
			options.principal === null
				? undefined
				: options.principal ?? consolePrincipal,
	} as unknown as AdminBindings;
	return {
		actors,
		reads,
		request: (path: string, method = "GET", body?: unknown) =>
			app.request(
				`/admin/access-keys${path}`,
				{
					method,
					...(body === undefined
						? {}
						: {
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify(body),
						  }),
				},
				bindings
			),
	};
}

test("all lifecycle and explicit reveal operations pass the authenticated console actor", async () => {
	const subject = fixture();
	for (const [path, method, body] of [
		["", "POST", { name: "portal", permissions: ["logs.read"] }],
		[`/${key.id}`, "PATCH", { permissions: ["*"], status: "revoked" }],
		[`/${key.id}/rotate`, "POST", undefined],
		[`/${key.id}/revoke`, "POST", undefined],
		[`/${key.id}/secret`, "GET", undefined],
	] as const) {
		const response = await subject.request(path, method, body);
		assert.ok(response.ok);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(subject.actors.length, 5);
	assert.equal(new Set(subject.actors.map((actor) => actor.auditId)).size, 5);
	for (const actor of subject.actors) {
		assert.equal(actor.actorId, "console:alice");
		assert.match(actor.auditId, /^[0-9a-f-]{36}$/u);
		assert.equal(new Date(actor.nowIso).toISOString(), actor.nowIso);
	}
});

test("audit write failure fails every lifecycle response closed and never returns a secret", async () => {
	for (const [path, method, body] of [
		[
			"",
			"POST",
			{ name: "portal", permissions: ["logs.read"], secret_key: SECRET },
		],
		[`/${key.id}`, "PATCH", { secret_key: SECRET }],
		[`/${key.id}/rotate`, "POST", undefined],
		[`/${key.id}/revoke`, "POST", undefined],
		[`/${key.id}/secret`, "GET", undefined],
	] as const) {
		const response = await fixture({ fail: true }).request(path, method, body);
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.ok(!(await response.text()).includes(SECRET));
	}
});

test("audit read uses bounded stable keyset cursors, scoped to this key, and no secret fields", async () => {
	const subject = fixture();
	const response = await subject.request(`/${key.id}/audit?page_size=2`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = (await response.json()) as {
		data: { entries: unknown[]; next_cursor: string };
	};
	assert.equal(body.data.entries.length, 2);
	assert.equal(typeof body.data.next_cursor, "string");
	assert.deepEqual(subject.reads[0], { id: key.id, limit: 3 });
	assert.ok(!JSON.stringify(body).includes(SECRET));
	assert.ok(!JSON.stringify(body).includes("key_prefix"));
	const next = await subject.request(
		`/${key.id}/audit?page_size=2&cursor=${body.data.next_cursor}`
	);
	assert.equal(next.status, 200);
	assert.deepEqual(subject.reads[1], {
		id: key.id,
		limit: 3,
		before: { id: entries[1]!.id, createdAt: entries[1]!.createdAt },
	});
	const nextBody = (await next.json()) as {
		data: { entries: { id: string }[]; next_cursor: null };
	};
	assert.deepEqual(
		nextBody.data.entries.map((row) => row.id),
		[entries[2]!.id]
	);
	assert.equal(nextBody.data.next_cursor, null);
	assert.equal(
		(
			await subject.request(
				`/different-key/audit?cursor=${body.data.next_cursor}`
			)
		).status,
		400
	);
});

test("invalid audit query is rejected before storage, with private errors and no permissive widening", async () => {
	for (const query of [
		"page_size=0",
		"page_size=101",
		"page_size=1.5",
		"page_size=01",
		"page_size=2&page_size=3",
		"cursor=",
		"cursor=invalid",
		"cursor=x&cursor=y",
		"unknown=x",
	]) {
		const subject = fixture();
		const response = await subject.request(`/${key.id}/audit?${query}`);
		assert.equal(response.status, 400, query);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(subject.reads.length, 0);
	}
	assert.equal(
		(await fixture({ missing: true }).request(`/${key.id}/audit`)).status,
		404
	);
	const failed = await fixture({ fail: true }).request(`/${key.id}/audit`);
	assert.equal(failed.status, 500);
	assert.equal(failed.headers.get("cache-control"), "private, no-store");
});

test("audit remains console-only even for a wildcard bearer principal", async () => {
	for (const [principal, expected] of [
		[
			{
				type: "api_key",
				id: "admin_key:all",
				keyId: "all",
				permissions: ["*"],
			},
			403,
		],
		[null, 401],
	] as const) {
		const subject = fixture({ principal: principal as AdminPrincipal | null });
		const response = await subject.request(`/${key.id}/audit`);
		assert.equal(response.status, expected);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(subject.reads.length, 0);
	}
});

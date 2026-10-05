/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from "node:assert/strict";
import test from "node:test";
import {
	hashLookupKey,
	type ApiKeyRow,
	type GatewayRepositories,
} from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import { EXPECTED_CONSOLE_SUBJECT_HEADER } from "./expected-console-subject";

const SECRET = "sk-synthetic-secret-for-binding";
const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: "console:cinaauth:operator",
	username: "cinaauth:operator",
};
const reader: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:reader",
	keyId: "reader",
	permissions: ["user_keys.read"],
};

async function fixture(
	options: {
		principal?: AdminPrincipal | null;
		missing?: boolean;
		legacy?: boolean;
		fail?: boolean;
		corrupted?: boolean;
	} = {}
) {
	const storageKey = "hashref:" + (await hashLookupKey(SECRET));
	const row: ApiKeyRow = {
		id: "key-1",
		user_id: "owner-1",
		workspace_id: "personal:owner-1",
		key: options.legacy ? SECRET : storageKey,
		name: null,
		status: "disabled",
		metadata: '{"token":"private-metadata"}',
		expires_at: null,
		limit_micros: 0,
		limit_reset: null,
		include_byok_in_limit: false,
		limit_epoch: 0,
		last_used_at: null,
		created_at: "2026-10-01T00:00:00Z",
		updated_at: "2026-10-01T00:00:00Z",
	};
	if (options.corrupted) row.key = "hashref:invalid";
	const reads: string[] = [];
	const repositories = {
		client: { driver: "d1", raw: {} },
		apiKeys: {
			getApiKeyById: async (id: string) => {
				reads.push(id);
				if (options.fail) throw new Error(SECRET);
				return options.missing ? null : { ...row };
			},
			getApiKeyWithUserByKey: () =>
				assert.fail(
					"Verification must not authenticate, recover or scrub secrets"
				),
			insertKey: () => assert.fail("Verification must not create a Key"),
			updateKey: () => assert.fail("Verification must not mutate a Key"),
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === null
				? undefined
				: options.principal ?? consolePrincipal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		reads,
		row,
		request: (
			body: unknown = { secret: SECRET },
			subject: string | null = "operator",
			path = "/admin/keys/key-1/verify-secret",
			method = "POST"
		) => {
			const headers = new Headers({ "content-type": "application/json" });
			if (subject !== null)
				headers.set(
					EXPECTED_CONSOLE_SUBJECT_HEADER,
					encodeURIComponent(subject)
				);
			return app.request(
				path,
				{
					method,
					headers,
					...(method === "GET" || method === "HEAD"
						? {}
						: { body: JSON.stringify(body) }),
				},
				bindings
			);
		},
	};
}

test("hash-only and legacy rows bind immutable identity without revealing, mutation or Proxy admission", async () => {
	for (const legacy of [false, true]) {
		const subject = await fixture({ legacy });
		const before = JSON.stringify(subject.row);
		const response = await subject.request();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await response.json(), {
			success: true,
			data: {
				id: "key-1",
				user_id: "owner-1",
				workspace_id: "personal:owner-1",
				verified: true,
			},
		});
		assert.equal(JSON.stringify(subject.row), before);
		assert.deepEqual(subject.reads, ["key-1"]);
	}
});

test("read capability is sufficient for named Bearer, Console requires the current canonical subject", async () => {
	assert.equal(
		(
			await (
				await fixture({ principal: reader })
			).request({ secret: SECRET }, null)
		).status,
		200
	);
	for (const principal of [
		null,
		{ ...reader, permissions: ["playground.execute"] } as AdminPrincipal,
	]) {
		const subject = await fixture({ principal });
		const response = await subject.request({ secret: SECRET }, null);
		assert.equal(response.status, principal === null ? 401 : 403);
		assert.equal(subject.reads.length, 0);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	for (const [subjectHeader, status] of [
		[null, 428],
		["different-subject", 403],
	] as const) {
		const subject = await fixture();
		assert.equal(
			(await subject.request({ secret: SECRET }, subjectHeader)).status,
			status
		);
		assert.equal(subject.reads.length, 0);
	}
	const bearer = await fixture({ principal: reader });
	assert.equal((await bearer.request()).status, 400);
	assert.equal(bearer.reads.length, 0);
});

test("masked, malformed, oversized and unknown-field inputs are rejected without echo or storage reads", async () => {
	for (const body of [
		null,
		[],
		{},
		{ secret: "sk-…" },
		{ secret: "sk-abc...abcd" },
		{ secret: "sk-***" },
		{ secret: " " + SECRET },
		{ secret: SECRET + "\n" },
		{ secret: "sk-" + "a".repeat(4096) },
		{ secret: SECRET, [SECRET]: true },
	]) {
		const subject = await fixture();
		const response = await subject.request(body);
		assert.equal(response.status, 400);
		assert.equal(subject.reads.length, 0);
		assert.equal((await response.text()).includes(SECRET), false);
	}
	for (const path of [
		"/admin/keys/sk-unsafe-url-secret/verify-secret",
		"/admin/keys/key-1/verify-secret?secret=" + SECRET,
	]) {
		const subject = await fixture();
		const response = await subject.request(
			{ secret: SECRET },
			"operator",
			path
		);
		assert.equal(response.status, 400);
		assert.equal(subject.reads.length, 0);
	}
});

test("mismatch, missing and storage failures stay private and never disclose request or row secrets", async () => {
	for (const [options, secret, expected] of [
		[{}, "sk-different-secret", 422],
		[{ missing: true }, SECRET, 404],
		[{ fail: true }, SECRET, 503],
		[{ corrupted: true }, SECRET, 503],
	] as const) {
		const subject = await fixture(options);
		const response = await subject.request({ secret });
		assert.equal(response.status, expected);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = await response.text();
		for (const value of [SECRET, "private-metadata", "hashref:", secret])
			assert.equal(body.includes(value), false);
	}
	for (const method of ["GET", "HEAD", "PUT", "DELETE"])
		assert.deepEqual(
			getAdminAuthorizationDecision(method, "/admin/keys/key-1/verify-secret"),
			{ kind: "deny" }
		);
	assert.deepEqual(
		getAdminAuthorizationDecision("POST", "/admin/keys/key-1/verify-secret"),
		{ kind: "permission", permission: "user_keys.read" }
	);
});

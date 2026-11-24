// Node 24 fixture: real SQLite runs only in tests; Admin production retains Node 20 types.
import assert from "node:assert/strict";
import test from "node:test";
import adminApp from "@/lib/admin-app";
import { createSqliteD1 } from "../../../../proxy/src/test-support/sqlite-d1";
import { createD1DatabaseClient } from "../../../../core/src/storage/database-client";
import { createD1Repositories } from "../../../../core/src/storage/repositories-d1";
const { createAdminApp } = adminApp;
const id = "f2b74bc0-32f3-4613-aea7-96f723d08e12";
const base = `/admin/users/${id}/wallet/credit`;
const input = {
	amount: 5.000001,
	kind: "topup",
	external_ref: "QA_é😀%\\ /+",
	reason: "Synthetic route check",
	require_receipt_version: 1,
};
const key = (permissions) => ({
	type: "api_key",
	id: "admin_key:qa",
	keyId: "qa",
	permissions: permissions,
});
function fixture() {
	const sqlite = createSqliteD1(),
		repositories = createD1Repositories(createD1DatabaseClient(sqlite.binding));
	sqlite.sqlite
		.prepare(
			"INSERT INTO users(id,email,wallet_granted,wallet_spent) VALUES(?,?,20,3)",
		)
		.run(id, "synthetic@example.invalid");
	const principal = key(["users.read", "users.write"]);
	return {
		...sqlite,
		repositories,
		request: (suffix, method = "GET", body, who = principal, subject) => {
			const headers = {};
			if (body !== undefined) headers["Content-Type"] = "application/json";
			if (subject !== undefined)
				headers["X-CinaToken-Expected-Console-Subject"] =
					encodeURIComponent(subject);
			return createAdminApp().request(
				base + suffix,
				{
					method,
					headers,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
				{
					STORAGE_CONTEXT: { repositories },
					ADMIN_PRINCIPAL: who ?? undefined,
				},
			);
		},
		state: () => ({
			user: sqlite.sqlite
				.prepare("SELECT wallet_granted,wallet_spent FROM users WHERE id=?")
				.get(id),
			count: sqlite.sqlite
				.prepare("SELECT count(*) AS n FROM user_audit_logs")
				.get().n,
		}),
	};
}
test("actual Admin route and migrated SQLite commit one credit and return its original receipt after later spend", async () => {
	const f = fixture();
	try {
		const missing = await f.request(
			"/receipt?" + new URLSearchParams({ external_ref: input.external_ref }),
		);
		assert.deepEqual(await missing.json(), {
			success: true,
			data: { version: 1, status: "not_found" },
		});
		const first = await f.request("/verified", "POST", input);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get("Cache-Control"), "private, no-store");
		const applied = await first.json();
		assert.equal(applied.status, "applied");
		assert.equal(applied.data.receipt.externalRef, input.external_ref);
		assert.equal(applied.data.receipt.after.walletGranted, 25.000001);
		f.sqlite.prepare("UPDATE users SET wallet_spent=4 WHERE id=?").run(id);
		const duplicate = await f.request("/verified", "POST", input);
		assert.equal(duplicate.status, 200);
		const repeated = await duplicate.json();
		assert.equal(repeated.status, "duplicate");
		assert.deepEqual(repeated.data.receipt, applied.data.receipt);
		const read = await f.request(
			"/receipt?" + new URLSearchParams({ external_ref: input.external_ref }),
		);
		assert.deepEqual(await read.json(), {
			success: true,
			data: { version: 1, status: "recorded", receipt: applied.data.receipt },
		});
		assert.equal(f.state().count, 1);
		assert.equal(f.state().user.wallet_spent, 4);
	} finally {
		f.sqlite.close();
	}
});
test("same reference with different payload is 409 with zero additional wallet or audit effects", async () => {
	const f = fixture();
	try {
		assert.equal((await f.request("/verified", "POST", input)).status, 200);
		const state = f.state();
		for (const patch of [{ amount: 9 }, { kind: "refund" }])
			assert.equal(
				(await f.request("/verified", "POST", { ...input, ...patch })).status,
				409,
			);
		assert.deepEqual(f.state(), state);
	} finally {
		f.sqlite.close();
	}
});
test("verified endpoint rejects invalid inputs, versions and duplicate reference queries before any write", async () => {
	const f = fixture();
	try {
		for (const value of [
			null,
			[],
			{ ...input, amount: true },
			{ ...input, amount: "5" },
			{ ...input, amount: 1e-7 },
			{ ...input, amount: 0 },
			{ ...input, require_receipt_version: undefined },
			{ ...input, extra: "forged" },
		])
			assert.equal((await f.request("/verified", "POST", value)).status, 400);
		for (const query of [
			"",
			"?external_ref=a&external_ref=b",
			"?external_ref=",
		])
			assert.equal((await f.request("/receipt" + query)).status, 400);
		assert.equal(f.state().count, 0);
		assert.equal(f.state().user.wallet_granted, 20);
	} finally {
		f.sqlite.close();
	}
});
test("route permission domains and Console subject preconditions deny before credit", async () => {
	const f = fixture();
	try {
		assert.equal(
			(await f.request("/verified", "POST", input, key(["users.read"]))).status,
			403,
		);
		assert.equal(
			(
				await f.request(
					"/receipt?external_ref=x",
					"GET",
					undefined,
					key(["logs.read"]),
				)
			).status,
			403,
		);
		assert.equal(
			(
				await f.request(
					"/receipt?external_ref=x",
					"GET",
					undefined,
					key(["users.write"]),
				)
			).status,
			200,
		);
		assert.equal(
			(await f.request("/verified", "POST", input, null)).status,
			401,
		);
		const console = {
			type: "console",
			id: "console:cinaauth:qa-subject",
			username: "cinaauth:qa-subject",
		};
		assert.equal(
			(await f.request("/verified", "POST", input, console)).status,
			428,
		);
		assert.equal(
			(await f.request("/verified", "POST", input, console, "wrong-subject"))
				.status,
			403,
		);
		assert.equal(f.state().count, 0);
		assert.equal(
			(await f.request("/verified", "POST", input, console, "qa-subject"))
				.status,
			200,
		);
	} finally {
		f.sqlite.close();
	}
});
test("legacy POST keeps optional-version shape and invalid/historical evidence never receives another credit", async () => {
	const f = fixture();
	try {
		const { require_receipt_version: _version, ...legacyInput } = input;
		assert.equal((await f.request("", "POST", legacyInput)).status, 200);
		f.sqlite.prepare("UPDATE user_audit_logs SET change_payload=?").run(
			JSON.stringify({
				amount: input.amount,
				kind: input.kind,
				external_ref: input.external_ref,
			}),
		);
		const state = f.state();
		const read = await f.request(
			"/receipt?" + new URLSearchParams({ external_ref: input.external_ref }),
		);
		assert.deepEqual(await read.json(), {
			success: true,
			data: { version: 1, status: "legacy_unverified" },
		});
		assert.equal((await f.request("/verified", "POST", input)).status, 409);
		assert.deepEqual(f.state(), state);
	} finally {
		f.sqlite.close();
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as register } from "../../app/api/auth/cinaauth/register/route";
import { GET as callback } from "../../app/api/auth/cinaauth/callback/route";

test("registration keeps the public origin and popup transaction query", () => {
	const request = new NextRequest(
		"http://localhost:8789/api/auth/cinaauth/register?intent=portal&presentation=popup&request=fixture-id&callbackURL=%2Faccount%2Fkeys",
		{
			headers: {
				host: "127.0.0.1:8791",
				"x-forwarded-host": "attacker.example",
			},
		}
	);
	const response = register(request);
	assert.equal(response.status, 302);
	const location = new URL(response.headers.get("location")!);
	assert.equal(location.origin, "http://127.0.0.1:8791");
	assert.equal(location.pathname, "/api/auth/cinaauth/login");
	assert.equal(location.searchParams.get("mode"), "register");
	assert.equal(location.searchParams.get("intent"), "portal");
	assert.equal(location.searchParams.get("presentation"), "popup");
	assert.equal(location.searchParams.get("request"), "fixture-id");
	assert.equal(location.searchParams.get("callbackURL"), "/account/keys");
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("an invalid callback returns to the public origin without identity or transaction cookies", async () => {
	const names = [
		"CINATOKEN_OIDC_CLIENT_SECRET",
		"CINATOKEN_OIDC_BRIDGE_SECRET",
		"CINATOKEN_OIDC_TRANSACTION_SECRET",
	] as const;
	const previous = names.map((name) => process.env[name]);
	try {
		for (const name of names) process.env[name] = "a".repeat(32);
		const response = await callback(
			new NextRequest(
				"https://localhost:8789/api/auth/cinaauth/callback?state=invalid",
				{
					headers: {
						host: "cinatoken.com",
						"x-forwarded-host": "attacker.example",
					},
				}
			)
		);
		assert.equal(response.status, 302);
		const location = new URL(response.headers.get("location")!);
		assert.equal(location.origin, "https://cinatoken.com");
		assert.equal(location.pathname, "/");
		assert.equal(
			location.searchParams.get("auth_error"),
			"invalid_transaction"
		);
		assert.equal(response.headers.getSetCookie().length, 0);
		assert.equal(response.headers.get("cache-control"), "no-store");
	} finally {
		names.forEach((name, index) => {
			if (previous[index] === undefined) delete process.env[name];
			else process.env[name] = previous[index];
		});
	}
});

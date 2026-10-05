import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import { GET as startLogin } from "@/app/api/auth/cinaauth/login/route";
import { GET as finishLogin } from "@/app/api/auth/cinaauth/callback/route";
import {
	cinaAuthTransactionCookieName,
	openCinaAuthTransaction,
} from "./transaction";

const secret = "test-transaction-secret-that-is-long-enough-1234";
const issuer = "https://auth.cinaseek.si";
function request(url: string, cookie?: string, upstreamPaths: string[] = []) {
	return Object.assign(
		new NextRequest(url, { headers: cookie ? { cookie } : undefined }),
		{
			env: {
				CINATOKEN_OIDC_CLIENT_SECRET: secret,
				CINATOKEN_OIDC_BRIDGE_SECRET: secret,
				CINATOKEN_OIDC_TRANSACTION_SECRET: secret,
				CINAAUTH_AUTH_SERVICE: {
					fetch: async (input: Request) => {
						upstreamPaths.push(new URL(input.url).pathname);
						assert.equal(
							new URL(input.url).pathname,
							"/.well-known/openid-configuration"
						);
						return Response.json({
							issuer,
							authorization_endpoint: `${issuer}/authorize`,
							token_endpoint: `${issuer}/token`,
						});
					},
				},
			},
		}
	);
}

describe("CinaAuth concurrent authorization HTTP routes", () => {
	it("issues distinct protected cookies and clears only the matching tab when login is denied", async () => {
		const [first, second] = await Promise.all(
			["portal", "admin"].map((intent) =>
				startLogin(
					request(
						`https://cinatoken.com/api/auth/cinaauth/login?intent=${intent}&presentation=popup&request=${crypto.randomUUID()}`
					)
				)
			)
		);
		const responses = [first, second];
		const states = responses.map(
			(response) =>
				new URL(response.headers.get("location")!).searchParams.get("state")!
		);
		const issued = responses.map((response) => response.cookies.getAll()[0]);
		assert.notEqual(issued[0].name, issued[1].name);
		for (let index = 0; index < responses.length; index += 1) {
			assert.equal(responses[index].status, 302);
			assert.equal(
				issued[index].name,
				cinaAuthTransactionCookieName(states[index])
			);
			assert.equal(issued[index].httpOnly, true);
			assert.equal(issued[index].secure, true);
			assert.equal(issued[index].sameSite, "lax");
			assert.equal(issued[index].path, "/");
			assert.equal(issued[index].maxAge, 600);
			const transaction = await openCinaAuthTransaction(
				issued[index].value,
				secret
			);
			assert.ok(transaction);
			const authorization = new URL(responses[index].headers.get("location")!);
			assert.equal(transaction.state, states[index]);
			assert.equal(authorization.searchParams.get("nonce"), transaction.nonce);
			assert.equal(
				authorization.searchParams.get("code_challenge_method"),
				"S256"
			);
			assert.equal(
				authorization.searchParams.get("code_challenge"),
				await calculatePKCECodeChallenge(transaction.codeVerifier)
			);
			assert.equal(
				authorization.searchParams.get("redirect_uri"),
				"https://cinatoken.com/api/auth/cinaauth/callback"
			);
			assert.equal(
				authorization.searchParams.get("resource"),
				"https://cinatoken.com"
			);
			assert.equal(responses[index].headers.get("cache-control"), "no-store");
			assert.equal(
				responses[index].headers.get("referrer-policy"),
				"no-referrer"
			);
		}
		const jar = issued
			.map((cookie) => `${cookie.name}=${cookie.value}`)
			.join("; ");
		for (let index = 0; index < states.length; index += 1) {
			const response = await finishLogin(
				request(
					`https://cinatoken.com/api/auth/cinaauth/callback?error=access_denied&state=${states[index]}`,
					jar
				)
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.deepEqual(
				response.cookies.getAll().map((cookie) => [cookie.name, cookie.maxAge]),
				[[issued[index].name, 0]]
			);
			const transaction = await openCinaAuthTransaction(
				issued[index].value,
				secret
			);
			assert.ok(transaction);
			assertFailedPopup(
				await response.text(),
				response.headers,
				transaction.popupRequestId!
			);
		}
	});
	it("does not clear another tab when the callback state is unknown", async () => {
		const started = await startLogin(
			request("https://cinatoken.com/api/auth/cinaauth/login?intent=portal")
		);
		const cookie = started.cookies.getAll()[0];
		const response = await finishLogin(
			request(
				`https://cinatoken.com/api/auth/cinaauth/callback?state=${"z".repeat(
					43
				)}&error=access_denied`,
				`${cookie.name}=${cookie.value}`
			)
		);
		assert.equal(response.status, 302);
		assert.match(
			response.headers.get("location")!,
			/auth_error=invalid_transaction/u
		);
		assert.deepEqual(response.cookies.getAll(), []);
	});

	it("does not clear either tab when a matching scoped transaction signature was changed", async () => {
		const [first, second] = await Promise.all(
			["portal", "admin"].map((intent) =>
				startLogin(
					request(
						`https://cinatoken.com/api/auth/cinaauth/login?intent=${intent}&presentation=popup&request=${crypto.randomUUID()}`
					)
				)
			)
		);
		const cookies = [first.cookies.getAll()[0], second.cookies.getAll()[0]];
		const state = new URL(first.headers.get("location")!).searchParams.get(
			"state"
		);
		const [payload, signature] = cookies[0].value.split(".");
		const changed = `${payload}.${
			signature[0] === "A" ? "B" : "A"
		}${signature.slice(1)}`;
		const paths: string[] = [];
		const response = await finishLogin(
			request(
				`https://cinatoken.com/api/auth/cinaauth/callback?state=${state}&error=access_denied`,
				`${cookies[0].name}=${changed}; ${cookies[1].name}=${cookies[1].value}`,
				paths
			)
		);
		assert.equal(response.status, 302);
		assert.equal(
			new URL(response.headers.get("location")!).searchParams.get("auth_error"),
			"invalid_transaction"
		);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(response.cookies.getAll(), []);
		assert.deepEqual(paths, []);
	});

	for (const callback of [
		{
			name: "wrong response issuer",
			parameters: "code=not-exchanged&iss=https%3A%2F%2Fforeign.example",
		},
		{ name: "missing authorization code", parameters: "" },
		{
			name: "denied authorization with an error and code",
			parameters: "error=access_denied&code=not-exchanged",
		},
	]) {
		it(`rejects ${callback.name} before token exchange and clears only its verified transaction`, async () => {
			const requestId = crypto.randomUUID();
			const started = await startLogin(
				request(
					`https://cinatoken.com/api/auth/cinaauth/login?intent=portal&presentation=popup&request=${requestId}`
				)
			);
			const cookie = started.cookies.getAll()[0];
			const state = new URL(started.headers.get("location")!).searchParams.get(
				"state"
			);
			const paths: string[] = [];
			const response = await finishLogin(
				request(
					`https://cinatoken.com/api/auth/cinaauth/callback?state=${state}&${callback.parameters}`,
					`${cookie.name}=${cookie.value}`,
					paths
				)
			);
			assert.equal(response.status, 200);
			assert.deepEqual(paths, ["/.well-known/openid-configuration"]);
			assert.deepEqual(
				response.cookies.getAll().map((value) => [value.name, value.maxAge]),
				[[cookie.name, 0]]
			);
			assertFailedPopup(await response.text(), response.headers, requestId);
		});
	}
});

function assertFailedPopup(
	html: string,
	headers: Headers,
	requestId: string
): void {
	assert.equal(headers.get("cache-control"), "no-store");
	assert.equal(headers.get("referrer-policy"), "no-referrer");
	const nonce = /script-src 'nonce-([a-f0-9]{32})'/u.exec(
		headers.get("content-security-policy") ?? ""
	)?.[1];
	assert.ok(nonce);
	assert.match(html, new RegExp(`<script nonce="${nonce}">`, "u"));
	const serialized = /const result = (\{[^\n]+\});/u.exec(html)?.[1];
	assert.ok(serialized);
	assert.deepEqual(JSON.parse(serialized), {
		type: "cinatoken:cinaauth-popup-complete",
		requestId,
		ok: false,
		error: "oidc_failed",
	});
	assert.equal(html.includes(secret), false);
}

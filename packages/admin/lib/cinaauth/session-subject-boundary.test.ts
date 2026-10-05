import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { GET as startLogin } from "@/app/api/auth/cinaauth/login/route";
import { GET as finishLogin } from "@/app/api/auth/cinaauth/callback/route";
import { GET as checkLogin } from "@/app/api/auth/check/route";
import { authenticateAdminRequest, hashSessionToken } from "@/lib/auth";
import { resolveAdminRequestRuntime } from "@/lib/admin-request-runtime";
import { authenticateUserRequest } from "@/lib/user-auth";
import { cinaAuthSubjectFromPrincipal } from "./principal";
import {
	openCinaAuthTransaction,
	type CinatokenOidcTransaction,
} from "./transaction";

const issuer = "https://auth.cinaseek.si";
const origin = "https://cinatoken.com";
const secret = "session-width-contract-secret-at-least-32-characters";
const email = "session-width@example.test";
const userId = "44f5ee87-1b25-49b2-90ed-2d2760b504ff";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const signingKey = {
	...publicKey.export({ format: "jwk" }),
	kid: "width-contract",
	alg: "RS256",
	use: "sig",
};

type SqlRow = Record<string, string | number | null>;
type Query = string | { sql: string; rowsAsArray?: boolean };
type Failure =
	| "nonce"
	| "signature"
	| "bridge"
	| "state"
	| "pkce"
	| "issuer"
	| "code"
	| "role"
	| "userinfo";

/** A strict wire fixture, not a MySQL server: real repositories and Drizzle produce every SQL/parameter. */
class SessionWire {
	readonly statements: { sql: string; values: unknown[] }[] = [];
	readonly adminSessions = new Map<string, SqlRow>();
	readonly portalSessions = new Map<string, SqlRow>();
	transaction: CinatokenOidcTransaction | null = null;
	authorizationUrl: URL | null = null;
	verifySubject: string;
	bridgeRequests = 0;
	verifyRequests = 0;
	userinfoRequests = 0;
	idToken: string | null = null;
	readonly diagnostics: string[] = [];
	readonly upstreamPaths: string[] = [];
	constructor(
		readonly subject: string,
		readonly usernameWidth = 264,
		readonly failure?: Failure
	) {
		this.verifySubject = subject;
	}
	async query(
		input: Query,
		values: unknown[] = []
	): Promise<[unknown, unknown[]]> {
		const sql = (typeof input === "string" ? input : input.sql)
			.replace(/\s+/gu, " ")
			.trim();
		this.statements.push({ sql, values: [...values] });
		if (/^insert into `admin_sessions`/iu.test(sql)) {
			const columns = /\(([^)]+)\) values/iu
				.exec(sql)?.[1]
				.split(",")
				.map((column) => column.trim().replaceAll("`", ""));
			assert.ok(columns, "actual Drizzle session INSERT must declare columns");
			const row = Object.fromEntries(
				columns.map((column, index) => [column, values[index]])
			) as SqlRow;
			assert.equal(typeof row.username, "string");
			if (String(row.username).length > this.usernameWidth)
				throw Object.assign(new Error("Data too long for username"), {
					code: "ER_DATA_TOO_LONG",
				});
			this.adminSessions.set(String(row.token_hash), row);
			return [{ affectedRows: 1, insertId: 0 }, []];
		}
		if (/^INSERT INTO portal_sessions /u.test(sql)) {
			const [token_hash, subject, portalEmail, created_at, expires_at] = values;
			assert.equal(subject, this.subject);
			this.portalSessions.set(String(token_hash), {
				token_hash: String(token_hash),
				subject: String(subject),
				email: String(portalEmail),
				created_at: String(created_at),
				expires_at: String(expires_at),
			});
			return [{ affectedRows: 1 }, []];
		}
		if (/^select /iu.test(sql)) {
			let row: SqlRow | undefined;
			if (/from `admin_sessions`/u.test(sql)) {
				assert.match(sql, /`token_hash` = \?.*`expires_at` > \?/u);
				row = this.adminSessions.get(String(values[0]));
			} else if (/FROM portal_sessions /u.test(sql)) {
				assert.match(sql, /token_hash = \? AND expires_at > \? LIMIT 1/u);
				row = this.portalSessions.get(String(values[0]));
			} else if (/from `users`/u.test(sql)) {
				assert.deepEqual(values.slice(0, 2), ["cinaauth", this.subject]);
				row = {
					id: userId,
					email,
					external_system: "cinaauth",
					external_user_id: this.subject,
					status: "active",
					budget_base: "0",
					budget_spent: "0",
					budget_period: "monthly",
					budget_epoch: 0,
					budget_reserved_micros: 0,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
			} else assert.fail(`Unexpected SELECT: ${sql}`);
			if (row?.expires_at && String(row.expires_at) <= String(values[1]))
				row = undefined;
			if (!row) return [[], []];
			if (typeof input !== "string" && input.rowsAsArray) {
				const columns = /^select (.+) from /iu
					.exec(sql)![1]
					.split(",")
					.map(
						(column) => column.trim().replaceAll("`", "").split(".").at(-1)!
					);
				return [[columns.map((column) => row![column] ?? null)], []];
			}
			return [[row], []];
		}
		if (
			/^delete from `admin_sessions` where `admin_sessions`.`expires_at` <= \?/u.test(
				sql
			) ||
			/^DELETE FROM portal_sessions WHERE expires_at <= \?/u.test(sql)
		)
			return [{ affectedRows: 0 }, []];
		if (/^UPDATE organization_memberships /u.test(sql)) {
			assert.equal(values[2], this.subject);
			assert.equal(values[0], userId);
			return [{ affectedRows: 0 }, []];
		}
		if (/^INSERT IGNORE INTO user_earnings /u.test(sql)) {
			assert.deepEqual(values, [userId]);
			return [{ affectedRows: 0 }, []];
		}
		assert.fail(`Unexpected SQL: ${sql}`);
	}
	async execute(input: Query, values?: unknown[]) {
		return this.query(input, values);
	}
	async fetch(request: Request): Promise<Response> {
		this.upstreamPaths.push(new URL(request.url).pathname);
		try {
			return await this.upstream(request);
		} catch (error) {
			this.diagnostics.push(
				error instanceof Error ? error.stack ?? error.message : String(error)
			);
			throw error;
		}
	}
	private async upstream(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/.well-known/openid-configuration")
			return Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				token_endpoint_auth_methods_supported: ["client_secret_basic"],
				id_token_signing_alg_values_supported: ["RS256"],
			});
		if (path === "/jwks") return Response.json({ keys: [signingKey] });
		if (path === "/token") {
			assert.equal(request.method, "POST");
			assert.ok(this.transaction);
			const body = new URLSearchParams(await request.text());
			assert.equal(
				body.get("code"),
				this.failure === "code" ? "wrong-code" : "width-code"
			);
			assert.equal(body.get("grant_type"), "authorization_code");
			assert.equal(
				body.get("redirect_uri"),
				`${origin}/api/auth/cinaauth/callback`
			);
			assert.equal(body.get("resource"), origin);
			assert.equal(body.get("code_verifier"), this.transaction.codeVerifier);
			const basic = request.headers.get("authorization")!;
			assert.match(basic, /^Basic /u);
			assert.deepEqual(
				Buffer.from(basic.slice(6), "base64")
					.toString()
					.split(":")
					.map(decodeURIComponent),
				["cinatoken-admin", secret]
			);
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(body.get("code_verifier")!)
			);
			assert.equal(
				Buffer.from(digest).toString("base64url"),
				this.authorizationUrl?.searchParams.get("code_challenge")
			);
			if (this.failure === "pkce" || this.failure === "code")
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			const now = Math.floor(Date.now() / 1000);
			const encode = (value: unknown) =>
				Buffer.from(JSON.stringify(value)).toString("base64url");
			const unsigned = `${encode({
				alg: "RS256",
				kid: signingKey.kid,
			})}.${encode({
				iss: this.failure === "issuer" ? "https://foreign.example" : issuer,
				aud: "cinatoken-admin",
				sub: this.subject,
				nonce:
					this.failure === "nonce" ? "wrong-nonce" : this.transaction.nonce,
				iat: now,
				exp: now + 300,
			})}`;
			const signature =
				this.failure === "signature"
					? Buffer.alloc(256)
					: sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
			this.idToken = `${unsigned}.${signature.toString("base64url")}`;
			return Response.json({
				access_token: "width-access",
				token_type: "Bearer",
				expires_in: 300,
				id_token: this.idToken,
			});
		}
		if (path === "/api/auth/cinatoken-oidc/session") {
			this.bridgeRequests++;
			assert.equal(request.headers.get("authorization"), "Bearer width-access");
			assert.equal(request.headers.get("x-cinatoken-bridge-secret"), secret);
			return Response.json({
				ok: true,
				user: {
					id:
						this.failure === "bridge"
							? this.subject.toLowerCase()
							: this.subject,
					email,
					role: this.failure === "role" ? "user" : "super_admin",
				},
			});
		}
		if (path === "/api/auth/oauth2/userinfo") {
			this.userinfoRequests++;
			assert.equal(request.method, "GET");
			assert.equal(request.headers.get("authorization"), "Bearer width-access");
			assert.equal(request.headers.get("origin"), origin);
			assert.equal(request.cache, "no-store");
			return Response.json({
				sub: this.failure === "userinfo" ? "different-subject" : this.subject,
				email,
			});
		}
		if (path === "/api/auth/cinatoken-oidc/verify") {
			this.verifyRequests++;
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("x-cinatoken-bridge-secret"), secret);
			assert.deepEqual(await request.json(), { subject: this.subject });
			assert.equal(request.cache, "no-store");
			return Response.json({
				ok: true,
				user: { id: this.verifySubject, email, role: "super_admin" },
			});
		}
		assert.fail(`Unexpected OIDC request: ${path}`);
	}
}

let wire: SessionWire;
const requireDriver = createRequire(
	`${process.cwd()}/session-width-contract.cjs`
);
const mysqlDriver = requireDriver("mysql2/promise") as {
	createPool: (...args: unknown[]) => unknown;
};
const environment = [
	"DATABASE_DRIVER",
	"DATABASE_URL",
	"SHARED_KEY_ENCRYPTION_SECRET",
] as const;
const savedEnvironment = new Map(
	environment.map((key) => [key, process.env[key]])
);

function request(path: string, cookie?: string): NextRequest {
	return Object.assign(
		new NextRequest(`${origin}${path}`, {
			headers: cookie ? { cookie } : undefined,
		}),
		{
			env: {
				CINAAUTH_ISSUER: issuer,
				CINATOKEN_APP_ORIGIN: origin,
				CINATOKEN_OIDC_CLIENT_ID: "cinatoken-admin",
				CINATOKEN_REQUIRED_ROLES: "super_admin",
				CINATOKEN_OIDC_CLIENT_SECRET: secret,
				CINATOKEN_OIDC_BRIDGE_SECRET: secret,
				CINATOKEN_OIDC_TRANSACTION_SECRET: secret,
				SHARED_KEY_ENCRYPTION_SECRET: secret,
				CINAAUTH_AUTH_SERVICE: {
					fetch: (upstream: Request) => wire.fetch(upstream),
				},
			},
		}
	);
}

async function callback(
	fixture: SessionWire,
	options: {
		intent?: "portal" | "admin";
		requestId?: string;
		callbackPath?: string;
		extraCookie?: string;
	} = {}
) {
	wire = fixture;
	const parameters = new URLSearchParams({ intent: options.intent ?? "admin" });
	if (options.requestId) {
		parameters.set("presentation", "popup");
		parameters.set("request", options.requestId);
	}
	if (options.callbackPath) parameters.set("callbackURL", options.callbackPath);
	const started = await startLogin(
		request(`/api/auth/cinaauth/login?${parameters}`)
	);
	assert.equal(started.status, 302);
	wire.authorizationUrl = new URL(started.headers.get("location")!);
	assert.equal(
		wire.authorizationUrl.searchParams.get("code_challenge_method"),
		"S256"
	);
	const transactionCookie = started.cookies.getAll()[0];
	wire.transaction = await openCinaAuthTransaction(
		transactionCookie.value,
		secret
	);
	assert.ok(wire.transaction);
	assert.equal(
		wire.authorizationUrl.searchParams.get("nonce"),
		wire.transaction.nonce
	);
	const state =
		wire.failure === "state" ? "q".repeat(43) : wire.transaction.state;
	const code = wire.failure === "code" ? "wrong-code" : "width-code";
	return finishLogin(
		request(
			`/api/auth/cinaauth/callback?code=${code}&state=${state}`,
			`${transactionCookie.name}=${transactionCookie.value}${
				options.extraCookie ? `; ${options.extraCookie}` : ""
			}`
		)
	);
}

describe("standard OIDC subject across callback, MySQL session wire and live verification", () => {
	before(() => {
		process.env.DATABASE_DRIVER = "mysql";
		process.env.DATABASE_URL =
			"mysql://fixture@127.0.0.1:1/session_width_contract";
		process.env.SHARED_KEY_ENCRYPTION_SECRET = secret;
		// The production Node storage factory still builds the actual MySQL repositories/Drizzle.
		// Only mysql2's network transport is replaced; every unexpected SQL fails the contract.
		mock.method(mysqlDriver, "createPool", () => ({
			query: (query: Query, values?: unknown[]) => wire.query(query, values),
			execute: (query: Query, values?: unknown[]) =>
				wire.execute(query, values),
		}));
		mock.method(console, "log", () => undefined);
		mock.method(console, "warn", () => undefined);
		mock.method(console, "error", () => undefined);
	});
	after(() => {
		mock.restoreAll();
		for (const [key, value] of savedEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	for (const length of [246, 247, 248, 255]) {
		it(`preserves subject ${length} and username ${
			length + 9
		} through signed login, SQL readback, Console and portal`, async () => {
			const subject = `MixedCase%2F/${"X".repeat(length - 13)}`;
			assert.equal(subject.length, length);
			const fixture = new SessionWire(subject);
			const completed = await callback(fixture);
			assert.equal(completed.status, 302);
			assert.equal(
				completed.headers.get("location"),
				`${origin}/dashboard`,
				JSON.stringify({
					diagnostics: fixture.diagnostics,
					upstreamPaths: fixture.upstreamPaths,
				})
			);
			assert.equal(completed.headers.get("cache-control"), "no-store");
			const cookie = completed.cookies.get("cinatoken_session");
			assert.ok(cookie);
			assert.equal(cookie.httpOnly, true);
			assert.equal(cookie.secure, true);
			const hash = await hashSessionToken(cookie.value);
			assert.equal(
				fixture.adminSessions.get(hash)?.username,
				`cinaauth:${subject}`
			);
			assert.equal(
				String(fixture.adminSessions.get(hash)?.username).length,
				length + 9
			);
			assert.equal(fixture.portalSessions.get(hash)?.subject, subject);
			assert.equal(fixture.bridgeRequests, 1);
			assert.ok(
				fixture.upstreamPaths.includes("/jwks"),
				"the successful callback must validate the real signed ID token"
			);
			const authenticatedRequest = request(
				"/api/auth/check?subject=untrusted",
				`cinatoken_session=${cookie.value}`
			);
			const { storage } = await resolveAdminRequestRuntime(
				authenticatedRequest
			);
			assert.equal(storage.client.driver, "mysql");
			const principal = await authenticateAdminRequest(
				authenticatedRequest,
				storage.repositories
			);
			assert.deepEqual(principal, {
				type: "console",
				id: `console:cinaauth:${subject}`,
				username: `cinaauth:${subject}`,
			});
			assert.equal(cinaAuthSubjectFromPrincipal(principal!), subject);
			const verified = await checkLogin(authenticatedRequest);
			assert.deepEqual(await verified.json(), {
				authenticated: true,
				principalType: "console",
				verification: "verified",
				subject,
			});
			assert.equal(verified.headers.get("cache-control"), "no-store");
			const portal = await authenticateUserRequest(
				authenticatedRequest,
				storage.repositories
			);
			assert.equal(portal?.subject, subject);
			assert.equal(portal?.userId, userId);
			assert.equal(portal?.isAdmin, false);
			fixture.verifySubject = subject.toLowerCase();
			assert.deepEqual(await (await checkLogin(authenticatedRequest)).json(), {
				authenticated: false,
				verification: "rejected",
			});
			assert.equal(
				fixture.verifyRequests,
				2,
				"a previous proof must not replace the new live subject check"
			);
			assert.ok(
				fixture.statements.some(
					({ sql, values }) =>
						/^insert into `admin_sessions`/iu.test(sql) &&
						values.includes(`cinaauth:${subject}`)
				)
			);
		});
	}
	it("retains the old 255-column failure as a negative control instead of truncating or issuing a usable session", async () => {
		const fixture = new SessionWire(`MixedCase${"Z".repeat(238)}`, 255);
		assert.equal(fixture.subject.length, 247);
		const completed = await callback(fixture);
		assert.match(completed.headers.get("location")!, /auth_error=oidc_failed/u);
		assert.equal(completed.cookies.has("cinatoken_session"), false);
		assert.equal(fixture.adminSessions.size, 0);
		assert.equal(fixture.portalSessions.size, 0);
		assert.equal(fixture.bridgeRequests, 1);
	});
	for (const failure of [
		"state",
		"pkce",
		"nonce",
		"signature",
		"bridge",
		"issuer",
		"code",
		"role",
	] as const) {
		it(`rejects ${failure} failure before any SQL session write`, async () => {
			const fixture = new SessionWire(
				`MixedCase${"Z".repeat(246)}`,
				264,
				failure
			);
			const completed = await callback(fixture);
			assert.equal(completed.cookies.has("cinatoken_session"), false);
			const rejection =
				failure === "state"
					? "invalid_transaction"
					: failure === "bridge" || failure === "role"
					? "admin_forbidden"
					: "oidc_failed";
			assert.equal(
				new URL(completed.headers.get("location")!).searchParams.get(
					"auth_error"
				),
				rejection
			);
			assert.equal(fixture.adminSessions.size, 0);
			assert.equal(fixture.portalSessions.size, 0);
			assert.equal(fixture.statements.length, 0);
			assert.deepEqual(
				fixture.diagnostics,
				[],
				"the fixture must reach the intended rejection, not fail an unrelated assertion"
			);
			assert.equal(
				fixture.upstreamPaths.filter((path) => path === "/token").length,
				failure === "state" ? 0 : 1
			);
			assert.equal(
				fixture.bridgeRequests,
				failure === "bridge" || failure === "role" ? 1 : 0
			);
			if (failure === "signature")
				assert.ok(fixture.upstreamPaths.includes("/jwks"));
		});
	}

	for (const intent of ["portal", "admin"] as const) {
		it(`successful ${intent} popup sets a real unified session and emits only safe completion fields`, async () => {
			const subject = `MixedCase%2F/${"X".repeat(242)}`;
			assert.equal(subject.length, 255);
			const fixture = new SessionWire(subject);
			wire = fixture;
			const unrelated = await startLogin(
				request(
					`/api/auth/cinaauth/login?intent=${intent}&presentation=popup&request=${crypto.randomUUID()}`
				)
			);
			const unrelatedCookie = unrelated.cookies.getAll()[0];
			const requestId = crypto.randomUUID();
			const completed = await callback(fixture, {
				intent,
				requestId,
				callbackPath: "/account?resume=conversation%2Fone",
				extraCookie: `${unrelatedCookie.name}=${unrelatedCookie.value}`,
			});
			assert.equal(completed.status, 200);
			const html = await completed.text();
			assertPopupResult(completed.headers, html, {
				type: "cinatoken:cinaauth-popup-complete",
				requestId,
				ok: true,
			});
			for (const sensitive of [
				subject,
				email,
				secret,
				"width-access",
				fixture.idToken!,
				fixture.transaction!.codeVerifier,
				fixture.transaction!.nonce,
				unrelatedCookie.value,
			])
				assert.equal(
					html.includes(sensitive),
					false,
					"No identity, token or OIDC secret may cross the popup signal"
				);
			const cookie = completed.cookies.get("cinatoken_session");
			assert.ok(cookie);
			assert.equal(html.includes(cookie.value), false);
			assert.equal(cookie.httpOnly, true);
			assert.equal(cookie.secure, true);
			assert.equal(cookie.sameSite, "lax");
			assert.equal(cookie.path, "/");
			assert.ok(cookie.expires instanceof Date);
			assert.equal(completed.cookies.get("user_session")?.value, "");
			assert.equal(completed.cookies.get("admin_session")?.value, "");
			assert.equal(completed.cookies.has(unrelatedCookie.name), false);
			const transactions = completed.cookies
				.getAll()
				.filter((value) => value.name.startsWith("__Host-cinatoken_oidc_tx"));
			assert.deepEqual(
				transactions.map((value) => [value.name, value.maxAge]),
				[[`__Host-cinatoken_oidc_tx_${fixture.transaction!.state}`, 0]]
			);
			const hash = await hashSessionToken(cookie.value);
			assert.equal(fixture.portalSessions.get(hash)?.subject, subject);
			assert.equal(fixture.portalSessions.get(hash)?.email, email);
			assert.equal(fixture.portalSessions.size, 1);
			assert.equal(fixture.adminSessions.size, intent === "admin" ? 1 : 0);
			assert.equal(fixture.bridgeRequests, intent === "admin" ? 1 : 0);
			assert.equal(fixture.userinfoRequests, intent === "portal" ? 1 : 0);
			assert.ok(fixture.upstreamPaths.includes("/jwks"));
			assert.deepEqual(fixture.diagnostics, []);
			const signedIn = request(
				"/api/auth/check",
				`cinatoken_session=${cookie.value}`
			);
			const { storage } = await resolveAdminRequestRuntime(signedIn);
			assert.equal(
				(await authenticateUserRequest(signedIn, storage.repositories))
					?.subject,
				subject
			);
			const principal = await authenticateAdminRequest(
				signedIn,
				storage.repositories
			);
			if (intent === "admin") {
				assert.equal(
					fixture.adminSessions.get(hash)?.username,
					`cinaauth:${subject}`
				);
				assert.equal(
					String(fixture.adminSessions.get(hash)?.username).length,
					264
				);
				assert.ok(principal);
				assert.equal(cinaAuthSubjectFromPrincipal(principal), subject);
				assert.deepEqual(await (await checkLogin(signedIn)).json(), {
					authenticated: true,
					principalType: "console",
					verification: "verified",
					subject,
				});
			} else {
				assert.equal(principal, null);
				assert.deepEqual(await (await checkLogin(signedIn)).json(), {
					authenticated: false,
					verification: "none",
				});
				assert.equal(fixture.verifyRequests, 0);
			}
		});
	}

	it("a portal popup rejects a different userinfo subject before any session SQL or privileged bridge request", async () => {
		const fixture = new SessionWire("MixedCaseSubject", 264, "userinfo");
		const requestId = crypto.randomUUID();
		const completed = await callback(fixture, { intent: "portal", requestId });
		assert.equal(completed.status, 200);
		assertPopupResult(completed.headers, await completed.text(), {
			type: "cinatoken:cinaauth-popup-complete",
			requestId,
			ok: false,
			error: "portal_userinfo_failed",
		});
		assert.equal(completed.cookies.has("cinatoken_session"), false);
		assert.equal(fixture.adminSessions.size, 0);
		assert.equal(fixture.portalSessions.size, 0);
		assert.equal(fixture.statements.length, 0);
		assert.equal(fixture.userinfoRequests, 1);
		assert.equal(fixture.bridgeRequests, 0);
		assert.deepEqual(fixture.diagnostics, []);
	});
});

function assertPopupResult(
	headers: Headers,
	html: string,
	result: Record<string, unknown>
): void {
	assert.equal(headers.get("cache-control"), "no-store");
	assert.equal(headers.get("referrer-policy"), "no-referrer");
	assert.equal(headers.get("x-content-type-options"), "nosniff");
	const csp = headers.get("content-security-policy") ?? "";
	assert.match(
		csp,
		/default-src 'none'; script-src 'nonce-[a-f0-9]{32}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'/u
	);
	const nonce = /script-src 'nonce-([a-f0-9]{32})'/u.exec(csp)?.[1];
	assert.ok(nonce);
	assert.equal((html.match(/<script\b/gu) ?? []).length, 1);
	assert.match(html, new RegExp(`<script nonce="${nonce}">`, "u"));
	const serialized = /const result = (\{[^\n]+\});/u.exec(html)?.[1];
	assert.ok(serialized);
	assert.deepEqual(JSON.parse(serialized), result);
	assert.match(
		html,
		/window\.opener\?\.postMessage\(result, "https:\/\/cinatoken\.com"\)/u
	);
}

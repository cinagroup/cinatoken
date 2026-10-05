import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import type { D1Database } from "@cloudflare/workers-types";
import * as wrapper from "@/app/api/user/[...path]/route";
import { hashSessionToken } from "@/lib/auth";

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlStatement = {
	run(...values: SqlValue[]): unknown;
	all(...values: SqlValue[]): Record<string, SqlValue>[];
	setReturnArrays(value: boolean): void;
};
type SqliteDatabase = {
	close(): void;
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
};
type SqliteFixture = {
	binding: D1Database;
	sqlite: SqliteDatabase;
};
// Admin's installed Node declarations predate node:sqlite. The file-local
// adapter executes formal Core migrations and native SQLite transactions;
// it does not replace authentication or Hono, or prove native Cloudflare D1.
const requireFixture = createRequire(import.meta.url);
const { DatabaseSync } = requireFixture("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabase;
};
function createSqliteD1(beforeStatement: (sql: string) => void): SqliteFixture {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys = ON");
		const migrations = new URL(
			"../../../../core/migrations-d1/",
			import.meta.url
		);
		for (const file of readdirSync(migrations)
			.filter((file) => file.endsWith(".sql"))
			.sort())
			sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
	} catch (error) {
		sqlite.close();
		throw error;
	}
	class Statement {
		constructor(readonly query: string, readonly values: SqlValue[] = []) {}
		bind(...values: SqlValue[]) {
			return new Statement(this.query, values);
		}
		execute() {
			beforeStatement(this.query);
			const results = sqlite.prepare(this.query).all(...this.values);
			const counts = sqlite
				.prepare("SELECT changes() AS changes, last_insert_rowid() AS id")
				.all()[0];
			const changes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(this.query)
				? Number(counts.changes)
				: 0;
			return {
				success: true,
				results,
				meta: {
					changes,
					changed_db: changes > 0,
					last_row_id: Number(counts.id),
					duration: 0,
					size_after: 0,
					rows_read: results.length,
					rows_written: changes,
				},
			};
		}
		async all() {
			return this.execute();
		}
		async run() {
			return this.execute();
		}
		async first(column?: string) {
			const row = this.execute().results[0];
			return row == null
				? null
				: column === undefined
				? row
				: row[column] ?? null;
		}
		async raw() {
			beforeStatement(this.query);
			const statement = sqlite.prepare(this.query);
			statement.setReturnArrays(true);
			return statement.all(...this.values);
		}
	}
	const binding = {
		prepare: (query: string) => new Statement(query),
		async batch(statements: Statement[]) {
			sqlite.exec("BEGIN");
			try {
				const results = statements.map((statement) => statement.execute());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
		async exec(query: string) {
			sqlite.exec(query);
			return { count: 1, duration: 0 };
		},
		withSession() {
			throw new Error("D1 sessions are not emulated");
		},
		async dump() {
			throw new Error("D1 dump is not emulated");
		},
	} as unknown as D1Database;
	return { binding, sqlite };
}
const contextKey = Symbol.for("__cloudflare-context__");
const fixtureGlobals = globalThis as unknown as Record<symbol, unknown>;

async function fixture(userBId = "wrapper-user-b") {
	const sql: string[] = [];
	const idp: string[] = [];
	const queue: unknown[] = [];
	let databaseFailure = false;
	let roleMode: "verified" | "revoked" | "degraded" = "verified";
	const database = createSqliteD1((query) => {
		sql.push(query);
		if (databaseFailure) throw new Error("Controlled database failure");
	});
	const users = {
		a: {
			id: "wrapper-user-a",
			subject: "wrapper-sub-a",
			email: "a@example.test",
		},
		b: { id: userBId, subject: "wrapper-sub-b", email: "b@example.test" },
	};
	const tokens = {
		a: "synthetic-wrapper-session-a",
		b: "synthetic-wrapper-session-b",
	};
	for (const id of ["a", "b"] as const) {
		const user = users[id];
		const hash = await hashSessionToken(tokens[id]);
		database.sqlite
			.prepare(
				"INSERT INTO users (id,email,external_system,external_user_id,status) VALUES (?,?,'cinaauth',?,'active')"
			)
			.run(user.id, user.email, user.subject);
		database.sqlite
			.prepare(
				"INSERT INTO portal_sessions (token_hash,subject,email,expires_at) VALUES (?,?,?,'2099-01-01T00:00:00.000Z')"
			)
			.run(hash, user.subject, user.email);
		database.sqlite
			.prepare(
				"INSERT INTO admin_sessions (token_hash,username,expires_at) VALUES (?,?,'2099-01-01T00:00:00.000Z')"
			)
			.run(hash, "cinaauth:" + user.subject);
	}
	database.sqlite
		.prepare(
			"INSERT INTO organizations (id,source,name,slug,status,source_updated_at) VALUES ('org-wrapper','cinaauth','Shared','shared','active','2026-10-04T00:00:00Z')"
		)
		.run();
	for (const user of Object.values(users))
		database.sqlite
			.prepare(
				"INSERT INTO organization_memberships (organization_id,subject,user_id,email,roles_json,status,source_updated_at) VALUES ('org-wrapper',?,?,?,'[\"member\"]','active','2026-10-04T00:00:00Z')"
			)
			.run(user.subject, user.id, user.email);
	const previousContext = fixtureGlobals[contextKey];
	fixtureGlobals[contextKey] = {
		env: {
			DB: database.binding,
			SHARED_KEY_ENCRYPTION_SECRET:
				"synthetic-wrapper-encryption-only-over-32-characters",
			CINATOKEN_OIDC_BRIDGE_SECRET:
				"synthetic-wrapper-bridge-only-over-32-characters",
			CINATOKEN_REQUIRED_ROLES: "fixture-admin",
			CINAAUTH_AUTH_SERVICE: {
				async fetch(request: Request) {
					const body = (await request.json()) as { subject: string };
					assert.equal(
						new URL(request.url).pathname,
						"/api/auth/cinatoken-oidc/verify"
					);
					idp.push(body.subject);
					if (roleMode !== "verified")
						return Response.json(
							{ ok: false },
							{ status: roleMode === "revoked" ? 403 : 503 }
						);
					return Response.json({
						ok: true,
						user: { id: body.subject, role: "fixture-admin" },
					});
				},
			},
			CHAIN_JOBS: {
				async send(item: unknown) {
					queue.push(item);
				},
			},
		},
		ctx: { waitUntil() {}, passThroughOnException() {} },
	};
	const origin = "https://wrapper-fixture.example.test";
	function request(
		path: string,
		options: {
			method?: string;
			cookie?: "a" | "b" | "mixed" | "admin-only" | null;
			expectedUser?: string;
			rawExpected?: string;
			headers?: HeadersInit;
			body?: string;
			withOrigin?: boolean;
		} = {}
	) {
		const method = options.method ?? "GET";
		const headers = new Headers(options.headers);
		const identity = options.cookie === undefined ? "b" : options.cookie;
		if (identity === "mixed")
			headers.set(
				"Cookie",
				`user_session=${tokens.b}; admin_session=${tokens.a}`
			);
		else if (identity === "admin-only")
			headers.set("Cookie", `admin_session=${tokens.a}`);
		else if (identity)
			headers.set("Cookie", `cinatoken_session=${tokens[identity]}`);
		if (headers.has("Cookie"))
			headers.set(
				"Cookie",
				headers.get("Cookie") +
					"; cinatoken_workspace=organization%3Aorg-wrapper"
			);
		if (options.expectedUser !== undefined)
			headers.set(
				"X-CinaToken-Expected-User-Id",
				encodeURIComponent(options.expectedUser)
			);
		if (options.rawExpected !== undefined)
			headers.set("X-CinaToken-Expected-User-Id", options.rawExpected);
		if (
			options.withOrigin !== false &&
			!["GET", "HEAD", "OPTIONS"].includes(method) &&
			!headers.has("Origin")
		)
			headers.set("Origin", origin);
		return new Request(origin + path, {
			method,
			headers,
			...(options.body !== undefined ? { body: options.body } : {}),
		});
	}
	function snapshot() {
		return Object.fromEntries(
			[
				"portal_sessions",
				"admin_sessions",
				"workspaces",
				"api_keys",
				"nft_mints",
				"user_earnings",
			].map((table) => [
				table,
				database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
			])
		);
	}
	function close() {
		fixtureGlobals[contextKey] = previousContext;
		database.sqlite.close();
	}
	return {
		users,
		tokens,
		request,
		snapshot,
		sql,
		idp,
		queue,
		close,
		failDatabase: () => {
			databaseFailure = true;
		},
		setRoleMode: (mode: typeof roleMode) => {
			roleMode = mode;
		},
	};
}

async function reject(response: Response, status: number, code?: string) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as { success: boolean; code?: string };
	assert.equal(body.success, false);
	assert.equal(body.code, code);
}

test("ordinary user wrapper authentication failures are private and cannot authenticate by the expected header", async () => {
	const f = await fixture();
	try {
		for (const path of [
			"/api/user/me",
			"/api/user/nft/tiers",
			"/api/user/gateway-keys",
			"/api/user/presets",
		])
			await reject(
				await wrapper.GET(
					f.request(path, { cookie: null, expectedUser: f.users.a.id })
				),
				401
			);
		await reject(
			await wrapper.GET(
				f.request("/api/user/me", {
					cookie: "admin-only",
					expectedUser: f.users.a.id,
				})
			),
			401
		);
		assert.equal(f.idp.length, 0);
	} finally {
		f.close();
	}
});

test("all user reads reject a stale principal before workspace SQL or secondary role verification and do not retry 409", async () => {
	const f = await fixture();
	try {
		const before = f.snapshot();
		for (const path of [
			"/api/user/me",
			"/api/user/workspaces",
			"/api/user/nft/tiers",
			"/api/user/gateway-keys",
			"/api/user/presets",
			"/api/user/shared-keys",
			"/api/user/earnings/summary",
		]) {
			const start = f.sql.length;
			await reject(
				await wrapper.GET(f.request(path, { expectedUser: f.users.a.id })),
				409,
				"user_mismatch"
			);
			const queries = f.sql.slice(start);
			assert.equal(
				queries.filter((query) => /FROM portal_sessions/u.test(query)).length,
				1
			);
			assert.ok(
				queries.every((query) =>
					/FROM (?:portal_sessions|users)\b/u.test(query)
				),
				path
			);
		}
		assert.deepEqual(f.snapshot(), before);
		assert.equal(f.idp.length, 0);
		assert.equal(f.queue.length, 0);
	} finally {
		f.close();
	}
});

for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)
	test(`${method} stale user is refused before parsing or any domain write`, async () => {
		const f = await fixture();
		try {
			const before = f.snapshot();
			await reject(
				await wrapper[method](
					f.request("/api/user/nft/mint", {
						method,
						expectedUser: f.users.a.id,
						body: "{invalid JSON",
					})
				),
				409,
				"user_mismatch"
			);
			assert.deepEqual(f.snapshot(), before);
			assert.ok(
				f.sql.every((query) => /FROM (?:portal_sessions|users)\b/u.test(query))
			);
			assert.equal(f.idp.length, 0);
			assert.equal(f.queue.length, 0);
		} finally {
			f.close();
		}
	});

test("malformed, oversize, control and duplicate principal headers are private 400 before role verification", async () => {
	const f = await fixture();
	try {
		for (const rawExpected of [
			"",
			"%invalid",
			"%77rapper-user-b",
			"a,b",
			"a%2cb",
			"a%C2%85b",
			"a%00b",
			"a%20",
			"a".repeat(601),
		])
			await reject(
				await wrapper.GET(f.request("/api/user/me", { rawExpected })),
				400,
				"invalid_user_precondition"
			);
		const headers = new Headers();
		headers.append("X-CinaToken-Expected-User-Id", f.users.b.id);
		headers.append("X-CinaToken-Expected-User-Id", f.users.b.id);
		await reject(
			await wrapper.GET(f.request("/api/user/me", { headers })),
			400,
			"invalid_user_precondition"
		);
		assert.equal(f.idp.length, 0);
		assert.ok(
			f.sql.every((query) => /FROM (?:portal_sessions|users)\b/u.test(query))
		);
	} finally {
		f.close();
	}
});

test("a different legacy admin subject cannot promote the authenticated Portal user", async () => {
	const f = await fixture();
	try {
		for (const expectedUser of [f.users.b.id, undefined]) {
			const response = await wrapper.GET(
				f.request("/api/user/me", { cookie: "mixed", expectedUser })
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Cache-Control"), "private, no-store");
			const body = (await response.json()) as {
				data: {
					userId: string;
					subject: string;
					isAdmin: boolean;
					capabilities: string[];
				};
			};
			assert.equal(body.data.userId, f.users.b.id);
			assert.equal(body.data.subject, f.users.b.subject);
			assert.equal(body.data.isAdmin, false);
			assert.equal(body.data.capabilities.includes("admin.console"), false);
		}
		assert.equal(f.idp.length, 0);
	} finally {
		f.close();
	}
});

test("the same trusted admin subject retains actual verified Console capability", async () => {
	const f = await fixture();
	try {
		const response = await wrapper.GET(
			f.request("/api/user/me", { expectedUser: f.users.b.id })
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		const body = (await response.json()) as {
			data: { userId: string; isAdmin: boolean; capabilities: string[] };
		};
		assert.equal(body.data.userId, f.users.b.id);
		assert.equal(body.data.isAdmin, true);
		assert.ok(body.data.capabilities.includes("admin.console"));
		assert.deepEqual(f.idp, [f.users.b.subject]);
	} finally {
		f.close();
	}
});

for (const mode of ["revoked", "degraded"] as const)
	test(`a ${mode} same-subject Console role does not terminate the independent Portal session`, async () => {
		const f = await fixture();
		try {
			const before = f.snapshot();
			f.setRoleMode(mode);
			const response = await wrapper.GET(
				f.request("/api/user/me", { expectedUser: f.users.b.id })
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Cache-Control"), "private, no-store");
			const body = (await response.json()) as {
				data: {
					userId: string;
					subject: string;
					isAdmin: boolean;
					capabilities: string[];
				};
			};
			assert.equal(body.data.userId, f.users.b.id);
			assert.equal(body.data.subject, f.users.b.subject);
			assert.equal(body.data.isAdmin, false);
			assert.equal(body.data.capabilities.includes("admin.console"), false);
			assert.deepEqual(f.idp, [f.users.b.subject]);
			const after = f.snapshot();
			assert.deepEqual(after.portal_sessions, before.portal_sessions);
			assert.deepEqual(after.admin_sessions, before.admin_sessions);
		} finally {
			f.close();
		}
	});

test("canonical Unicode and encoded comma reach actual NFT reads through the rewritten request", async () => {
	const f = await fixture("用户,B🙂");
	try {
		const response = await wrapper.GET(
			f.request("/api/user/nft/tiers", {
				expectedUser: f.users.b.id,
				headers: { "X-CinaToken-Workspace": "organization%3Aorg-wrapper" },
			})
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		const body = (await response.json()) as {
			sellerUserId: string;
			workspaceId: string;
		};
		assert.equal(body.sellerUserId, f.users.b.id);
		assert.equal(body.workspaceId, "organization:org-wrapper");
	} finally {
		f.close();
	}
});

test("Origin rejection remains before authentication and all user wrapper failures stay private", async () => {
	const f = await fixture();
	try {
		const invalidOrigins: Parameters<typeof f.request>[1][] = [
			{ headers: { Origin: "https://foreign.example.test" } },
			{ withOrigin: false },
			{ headers: { "Sec-Fetch-Site": "cross-site" } },
		];
		for (const options of invalidOrigins)
			await reject(
				await wrapper.POST(
					f.request("/api/user/nft/mint", {
						method: "POST",
						expectedUser: f.users.b.id,
						...options,
					})
				),
				403
			);
		assert.equal(f.sql.length, 0);
		assert.equal(f.idp.length, 0);
		assert.equal(f.queue.length, 0);
		f.failDatabase();
		await reject(await wrapper.GET(f.request("/api/user/me")), 500);
	} finally {
		f.close();
	}
});

test("direct user logout checks the user, ignores lost workspace and revokes only its authenticated token", async () => {
	const f = await fixture();
	try {
		const before = f.snapshot();
		await reject(
			await wrapper.POST(
				f.request("/api/user/auth/logout", {
					method: "POST",
					expectedUser: f.users.a.id,
				})
			),
			409,
			"user_mismatch"
		);
		assert.deepEqual(f.snapshot(), before);
		const response = await wrapper.POST(
			f.request("/api/user/auth/logout", {
				method: "POST",
				expectedUser: f.users.b.id,
				headers: { "X-CinaToken-Workspace": "workspace%3Alost" },
			})
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		assert.equal(response.headers.getSetCookie().length, 4);
		const after = f.snapshot();
		assert.equal(after.portal_sessions.length, 1);
		assert.equal(after.admin_sessions.length, 1);
		assert.deepEqual(after.workspaces, before.workspaces);
		assert.equal(f.idp.length, 0);
	} finally {
		f.close();
	}
});

test("unified logout without a principal header revokes all carried sessions through the actual Next cookie store", async () => {
	const f = await fixture();
	try {
		// Initialize Next's native Node environment and request stores; this calls
		// the actual source handler, not the full compiled HTTP dispatcher.
		requireFixture("next/dist/server/node-environment-baseline");
		const { POST } = requireFixture(
			"../../../app/api/auth/logout/route.ts"
		) as { POST(request: Request): Promise<Response> };
		type Store = { run<T>(store: unknown, action: () => T): T };
		const { workAsyncStorage } = requireFixture(
			"next/dist/server/app-render/work-async-storage.external"
		) as { workAsyncStorage: Store };
		const { workUnitAsyncStorage } = requireFixture(
			"next/dist/server/app-render/work-unit-async-storage.external"
		) as { workUnitAsyncStorage: Store };
		const { createRequestStoreForAPI } = requireFixture(
			"next/dist/server/async-storage/request-store"
		) as {
			createRequestStoreForAPI(
				request: Request,
				url: URL,
				tags: unknown,
				onUpdate: (cookies: string[]) => void,
				preview: unknown
			): unknown;
		};
		const request = f.request("/api/auth/logout", {
			method: "POST",
			cookie: "mixed",
		});
		assert.equal(request.headers.has("X-CinaToken-Expected-User-Id"), false);
		const cookieUpdates: string[][] = [];
		const store = createRequestStoreForAPI(
			request,
			new URL(request.url),
			{ tags: [], expirationsByTag: new Map() },
			(cookies) => cookieUpdates.push(cookies),
			undefined
		);
		const response = await workAsyncStorage.run(
			{ route: "/api/auth/logout", isStaticGeneration: false },
			() => workUnitAsyncStorage.run(store, () => POST(request))
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		const after = f.snapshot();
		assert.equal(after.portal_sessions.length, 0);
		assert.equal(after.admin_sessions.length, 0);
		assert.equal(after.workspaces.length, 0);
		for (const name of [
			"cinatoken_session",
			"admin_session",
			"user_session",
			"cinatoken_workspace",
		])
			assert.ok(
				cookieUpdates
					.at(-1)
					?.some(
						(cookie) =>
							cookie.startsWith(name + "=") && cookie.includes("Expires=")
					),
				name
			);
		assert.equal(f.idp.length, 0);
		assert.equal(f.queue.length, 0);
	} finally {
		f.close();
	}
});

test("actual Next header rules preserve the private user contract without changing other API policies", async () => {
	const { default: config } = await import("../../../next.config.mjs");
	assert.ok(config.headers);
	const rules = await config.headers();
	const { getPathMatch } = requireFixture(
		"next/dist/shared/lib/router/utils/path-match"
	) as {
		getPathMatch(
			source: string,
			options: { strict: boolean }
		): (pathname: string) => false | Record<string, unknown>;
	};
	function effectiveHeaders(pathname: string) {
		const headers = new Headers();
		for (const rule of rules) {
			if (!getPathMatch(rule.source, { strict: true })(pathname)) continue;
			for (const header of rule.headers) headers.set(header.key, header.value);
		}
		return headers;
	}
	const otherApis = [
		"/api/public/catalog",
		"/api/admin/config",
		"/api/auth/check",
		"/api/auth/login",
		"/api/userish/me",
		"/api/auth/logout/extra",
	];
	const protectedApis = [
		"/api/user",
		"/api/user/me",
		"/api/user/nft/tiers",
		"/api/user/nft/mint",
		"/api/user/auth/logout",
		"/api/user/foo/deeper",
		"/api/auth/logout",
	];
	const publicHeaders = effectiveHeaders(otherApis[0]);
	for (const pathname of [...otherApis, ...protectedApis]) {
		const headers = effectiveHeaders(pathname);
		assert.equal(
			headers.get("Cache-Control"),
			protectedApis.includes(pathname) ? "private, no-store" : "no-store",
			pathname
		);
		// The previous global no-store already prohibited caching; the new rules
		// restore the framework's private contract, not evidence of an actual leak.
		assert.ok(
			headers
				.get("Cache-Control")
				?.split(",")
				.map((value) => value.trim())
				.includes("no-store")
		);
		for (const [name, value] of publicHeaders)
			if (name !== "cache-control")
				assert.equal(headers.get(name), value, pathname + " " + name);
	}
});

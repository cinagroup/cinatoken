import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Hono } from "hono";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type {
	D1DatabaseClient,
	GatewayRepositories,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import { createUserApp } from "@/lib/user-app";
import type { UserPrincipal } from "@/lib/user-auth";
import type { UserBindings, UserEnv } from "@/lib/user-env";
import {
	rejectUserPrincipalPrecondition,
	userPrincipalPrecondition,
	USER_PRINCIPAL_PRECONDITION_HEADER,
} from "./user-principal-precondition";

const ALICE: UserPrincipal = {
	userId: "user-alice",
	subject: "subject-alice",
	email: "alice@example.test",
	isAdmin: false,
	capabilities: [],
};
const BOB: UserPrincipal = {
	userId: "user-bob",
	subject: "subject-bob",
	email: "bob@example.test",
	isAdmin: false,
	capabilities: [],
};
const workspace: WorkspaceAccessProjection = {
	id: "organization:org-1",
	name: "Shared",
	slug: "shared",
	description: null,
	scopeType: "organization",
	organizationId: "org-1",
	organizationName: "Team",
	organizationSlug: "team",
	personalOwnerUserId: null,
	isDefault: true,
	status: "active",
	role: "member",
	accessSource: "organization_default",
	createdAt: "",
	updatedAt: "",
};

function fixture(principal: UserPrincipal | null = BOB) {
	const state = {
		operations: 0,
		writes: 0,
		workspaceResolutions: 0,
		logout: 0,
	};
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		if (principal) c.set("principal", principal);
		await next();
	});
	app.use("*", userPrincipalPrecondition);
	app.use("*", async (c, next) => {
		if (c.req.path !== "/user/auth/logout") {
			state.workspaceResolutions += 1;
			c.set("workspaceContext", {
				workspaces: [workspace],
				currentWorkspace: workspace,
				preferredWorkspaceAvailable: true,
			});
		}
		await next();
	});
	app.all("/user/operation", (c) => {
		state.operations += 1;
		if (c.req.method !== "GET" && c.req.method !== "HEAD") state.writes += 1;
		return c.json({
			success: true,
			userId: c.get("principal").userId,
			workspaceId: c.get("workspaceContext").currentWorkspace.id,
		});
	});
	app.post("/user/auth/logout", (c) => {
		state.logout += 1;
		return c.json({ success: true });
	});
	return { app, state };
}

function expected(userId: string): Record<string, string> {
	return { [USER_PRINCIPAL_PRECONDITION_HEADER]: encodeURIComponent(userId) };
}

async function rejection(
	response: Response,
	status: number,
	code?: string
): Promise<void> {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as {
		success: boolean;
		code?: string;
		message: string;
	};
	assert.equal(body.success, false);
	assert.equal(body.code, code);
	assert.deepEqual(
		Object.keys(body).sort(),
		code ? ["code", "message", "success"] : ["message", "success"]
	);
	assert.equal(JSON.stringify(body).includes(ALICE.userId), false);
	assert.equal(JSON.stringify(body).includes(BOB.userId), false);
}

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
	test(`${method} rejects another trusted user even with the same organization workspace`, async () => {
		for (const principal of [ALICE, BOB]) {
			const f = fixture(principal);
			const previous = principal === ALICE ? BOB : ALICE;
			await rejection(
				await f.app.request("/user/operation", {
					method,
					headers: expected(previous.userId),
				}),
				409,
				"user_mismatch"
			);
			assert.deepEqual(f.state, {
				operations: 0,
				writes: 0,
				workspaceResolutions: 0,
				logout: 0,
			});
		}
	});
}

test("matching and headerless requests keep the trusted user and authorized workspace", async () => {
	for (const principal of [ALICE, BOB]) {
		for (const headers of [undefined, expected(principal.userId)]) {
			const f = fixture(principal);
			const response = await f.app.request("/user/operation", {
				method: "POST",
				headers,
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), {
				success: true,
				userId: principal.userId,
				workspaceId: workspace.id,
			});
			assert.equal(f.state.operations, 1);
			assert.equal(f.state.writes, 1);
		}
	}
});

test("canonical opaque Unicode, encoded comma and internal spaces round-trip", async () => {
	for (const id of ["用户:团队/100% 😀", "team,user", "opaque user"]) {
		const f = fixture({ ...BOB, userId: id });
		const response = await f.app.request("/user/operation", {
			headers: expected(id),
		});
		assert.equal(response.status, 200, id);
		assert.equal(((await response.json()) as { userId: string }).userId, id);
		assert.equal(f.state.operations, 1);
	}
});

const invalidHeaders = [
	"",
	"%invalid",
	"%",
	"%2",
	"%GG",
	"%C0%AF",
	"%ED%A0%80",
	"%00",
	"%0A",
	"%1F",
	"%7F",
	"%C2%80",
	"%C2%9F",
	"%20user-alice",
	"user-alice%20",
	"%E3%80%80user-alice",
	"user-alice,user-bob",
	"team,user",
	"team%2cuser",
	"user%2falice",
	"%75ser-bob",
	"opaque+user",
	"x".repeat(601),
	encodeURIComponent("用".repeat(601)),
	"x".repeat(599) + encodeURIComponent("😀"),
];
test("malformed, noncanonical, oversized and control-bearing headers reject before any operation", async () => {
	for (const raw of invalidHeaders) {
		const f = fixture();
		await rejection(
			await f.app.request("/user/operation", {
				method: "POST",
				headers: {
					[USER_PRINCIPAL_PRECONDITION_HEADER]: raw,
				},
			}),
			400,
			"invalid_user_precondition"
		);
		assert.deepEqual(
			f.state,
			{ operations: 0, writes: 0, workspaceResolutions: 0, logout: 0 },
			raw
		);
	}
});

test("duplicates reject even when both values match the authenticated user", async () => {
	const headers = new Headers();
	headers.append(
		USER_PRINCIPAL_PRECONDITION_HEADER,
		encodeURIComponent(BOB.userId)
	);
	headers.append(
		USER_PRINCIPAL_PRECONDITION_HEADER,
		encodeURIComponent(BOB.userId)
	);
	const f = fixture();
	await rejection(
		await f.app.request("/user/operation", { headers }),
		400,
		"invalid_user_precondition"
	);
	assert.equal(f.state.operations, 0);
	assert.equal(f.state.workspaceResolutions, 0);
});

test("decoded 600-unit boundary is accepted without truncating identity", async () => {
	for (const id of ["x".repeat(600), "用".repeat(600), "😀".repeat(300)]) {
		const f = fixture({ ...BOB, userId: id });
		assert.equal(
			(await f.app.request("/user/operation", { headers: expected(id) }))
				.status,
			200
		);
		assert.equal(f.state.operations, 1);
		const other = new Request("https://gateway.example.test/user/operation", {
			headers: expected(id),
		});
		assert.equal(
			rejectUserPrincipalPrecondition(other, ALICE.userId)?.status,
			409
		);
	}
});

test("authentication wins over missing, valid and malformed identity headers", async () => {
	for (const headers of [
		undefined,
		expected(ALICE.userId),
		{ [USER_PRINCIPAL_PRECONDITION_HEADER]: "%invalid" },
	]) {
		const f = fixture(null);
		await rejection(
			await f.app.request("/user/operation", { method: "POST", headers }),
			401
		);
		assert.deepEqual(f.state, {
			operations: 0,
			writes: 0,
			workspaceResolutions: 0,
			logout: 0,
		});
	}
});

test("logout compares identity while still bypassing workspace resolution", async () => {
	for (const headers of [undefined, expected(BOB.userId)]) {
		const f = fixture();
		assert.equal(
			(await f.app.request("/user/auth/logout", { method: "POST", headers }))
				.status,
			200
		);
		assert.equal(f.state.logout, 1);
		assert.equal(f.state.workspaceResolutions, 0);
	}
	for (const [raw, status, code] of [
		[encodeURIComponent(ALICE.userId), 409, "user_mismatch"],
		["%invalid", 400, "invalid_user_precondition"],
	] as const) {
		const f = fixture();
		await rejection(
			await f.app.request("/user/auth/logout", {
				method: "POST",
				headers: {
					[USER_PRINCIPAL_PRECONDITION_HEADER]: raw,
				},
			}),
			status,
			code
		);
		assert.equal(f.state.logout, 0);
		assert.equal(f.state.workspaceResolutions, 0);
	}
});

// Use the installed Node SQLite runtime, with a local type boundary because
// Admin's Node declarations predate node:sqlite. No external database is used.
type SQLValue = string | number | bigint | null | Uint8Array;
type SqliteDatabase = {
	exec(sql: string): void;
	close(): void;
	prepare(sql: string): {
		get(...values: SQLValue[]): Record<string, SQLValue> | undefined;
		all(...values: SQLValue[]): Record<string, SQLValue>[];
		run(...values: SQLValue[]): { changes: number | bigint };
	};
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabase;
};

function fullAppFixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(`PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, external_system TEXT,
			external_user_id TEXT, status TEXT NOT NULL DEFAULT 'active');`);
	database.exec(
		readFileSync(
			new URL(
				"../../core/migrations-d1/0038_organization_identity_projection.sql",
				import.meta.url
			),
			"utf8"
		)
	);
	for (const user of [ALICE, BOB]) {
		database
			.prepare("INSERT INTO users VALUES (?, ?, 'cinaauth', ?, 'active')")
			.run(user.userId, user.email, user.subject);
	}
	database
		.prepare(
			"INSERT INTO organizations (id, source, name, slug, status, source_updated_at) VALUES ('org-1', 'cinaauth', 'Team', 'team', 'active', ?)"
		)
		.run("2026-10-04T00:00:00.000Z");
	for (const user of [ALICE, BOB]) {
		database
			.prepare(
				"INSERT INTO organization_memberships (organization_id, subject, user_id, roles_json, status, source_updated_at) VALUES ('org-1', ?, ?, '[\"member\"]', 'active', ?)"
			)
			.run(user.subject, user.userId, "2026-10-04T00:00:00.000Z");
	}
	database.exec(
		readFileSync(
			new URL("../../core/migrations-d1/0042_workspaces.sql", import.meta.url),
			"utf8"
		)
	);
	database.exec(`CREATE TABLE guardrails (
		id TEXT PRIMARY KEY, workspace_id TEXT, owner_user_id TEXT, name TEXT,
		description TEXT, status TEXT, designated_version INTEGER, latest_version INTEGER,
		created_at TEXT, updated_at TEXT, is_workspace_default INTEGER,
		is_account_default INTEGER NOT NULL DEFAULT 0, account_scope_key TEXT);
		CREATE TABLE guardrail_versions (id TEXT PRIMARY KEY, guardrail_id TEXT,
			version INTEGER, config_json TEXT, created_by_user_id TEXT, created_at TEXT);`);
	const state = {
		prepares: 0,
		sqlWrites: 0,
		domainOperations: 0,
		sessionDeletes: 0,
		workspaceUnavailable: false,
	};
	const statement = (
		sql: string,
		values: SQLValue[] = []
	): D1PreparedStatement =>
		({
			bind: (...bound: SQLValue[]) => statement(sql, bound),
			all: () => ({
				success: true,
				results: database.prepare(sql).all(...values),
				meta: {},
			}),
			run: () => {
				state.sqlWrites += 1;
				return {
					success: true,
					meta: {
						changes: Number(database.prepare(sql).run(...values).changes),
					},
				};
			},
		} as unknown as D1PreparedStatement);
	const raw = {
		prepare: (sql: string) => {
			state.prepares += 1;
			if (state.workspaceUnavailable)
				throw new Error("workspace unavailable in fixture");
			return statement(sql);
		},
		batch: async (statements: D1PreparedStatement[]) => {
			database.exec("BEGIN");
			try {
				const results = await Promise.all(
					statements.map((value) => value.run())
				);
				database.exec("COMMIT");
				return results as D1Result[];
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	const client: D1DatabaseClient = {
		driver: "d1",
		raw,
		drizzle: {} as D1DatabaseClient["drizzle"],
	};
	const repositories = {
		client,
		sharedKeys: new Proxy(
			{},
			{
				get: () => () => {
					state.domainOperations += 1;
					throw new Error("unexpected domain operation");
				},
			}
		),
		portalAccess: {
			deleteSession: async () => {
				state.sessionDeletes += 1;
			},
		},
		adminAccess: {
			deleteSession: async () => {
				state.sessionDeletes += 1;
			},
		},
	} as unknown as GatewayRepositories;
	const app = createUserApp();
	const bindings = (principal: UserPrincipal | null): UserBindings => ({
		STORAGE_CONTEXT: { repositories } as UserBindings["STORAGE_CONTEXT"],
		USER_PRINCIPAL: principal ?? undefined,
	});
	const snapshot = () =>
		database.prepare("SELECT * FROM workspaces ORDER BY id").all();
	return { app, bindings, state, snapshot, database };
}

test("actual createUserApp keeps a shared organization but rejects a stale user before workspace SQL", async () => {
	const f = fullAppFixture();
	try {
		const cookie = "cinatoken_workspace=" + encodeURIComponent(workspace.id);
		const alice = await f.app.request(
			"/user/workspaces",
			{ headers: { ...expected(ALICE.userId), Cookie: cookie } },
			f.bindings(ALICE)
		);
		assert.equal(alice.status, 200);
		assert.equal(
			((await alice.json()) as { data: { currentWorkspace: { id: string } } })
				.data.currentWorkspace.id,
			workspace.id
		);
		const before = { ...f.state };
		const snapshot = f.snapshot();
		await rejection(
			await f.app.request(
				"/user/workspaces",
				{ headers: { ...expected(ALICE.userId), Cookie: cookie } },
				f.bindings(BOB)
			),
			409,
			"user_mismatch"
		);
		assert.deepEqual(f.state, before);
		assert.deepEqual(f.snapshot(), snapshot);
		const bob = await f.app.request(
			"/user/me",
			{ headers: { ...expected(BOB.userId), Cookie: cookie } },
			f.bindings(BOB)
		);
		assert.equal(bob.status, 200);
		const identity = (await bob.json()) as {
			data: { userId: string; organizations: { organizationId: string }[] };
		};
		assert.equal(identity.data.userId, BOB.userId);
		assert.equal(identity.data.organizations[0]?.organizationId, "org-1");
	} finally {
		f.database.close();
	}
});

test("actual application rejects stale identity before every domain method and any workspace write", async () => {
	const f = fullAppFixture();
	try {
		const snapshot = f.snapshot();
		for (const [method, route] of [
			["GET", "/user/me"],
			["POST", "/user/shared-keys"],
			["PUT", "/user/workspaces/current"],
			["PATCH", "/user/shared-keys/key-1"],
			["DELETE", "/user/shared-keys/key-1"],
		]) {
			await rejection(
				await f.app.request(
					route,
					{ method, headers: expected(ALICE.userId) },
					f.bindings(BOB)
				),
				409,
				"user_mismatch"
			);
		}
		assert.deepEqual(f.state, {
			prepares: 0,
			sqlWrites: 0,
			domainOperations: 0,
			sessionDeletes: 0,
			workspaceUnavailable: false,
		});
		assert.deepEqual(f.snapshot(), snapshot);
	} finally {
		f.database.close();
	}
});

test("actual application preserves headerless compatibility and original membership authorization", async () => {
	const f = fullAppFixture();
	try {
		const headerless = await f.app.request("/user/me", {}, f.bindings(BOB));
		assert.equal(headerless.status, 200);
		assert.equal(
			((await headerless.json()) as { data: { userId: string } }).data.userId,
			BOB.userId
		);
		const forgedSubject = { ...BOB, subject: "subject-not-a-member" };
		const before = f.state.domainOperations;
		assert.equal(
			(
				await f.app.request(
					"/user/shared-keys",
					{ headers: expected(BOB.userId) },
					f.bindings(forgedSubject)
				)
			).status,
			500
		);
		assert.equal(f.state.domainOperations, before);
	} finally {
		f.database.close();
	}
});

test("actual application returns cached-safe 401 before parsing malformed header", async () => {
	const f = fullAppFixture();
	try {
		await rejection(
			await f.app.request(
				"/user/me",
				{ headers: { [USER_PRINCIPAL_PRECONDITION_HEADER]: "%invalid" } },
				f.bindings(null)
			),
			401
		);
		assert.equal(f.state.prepares, 0);
	} finally {
		f.database.close();
	}
});

test("actual application rejects malformed and repeated authenticated headers before workspace SQL", async () => {
	const f = fullAppFixture();
	try {
		const duplicate = new Headers(expected(BOB.userId));
		duplicate.append(
			USER_PRINCIPAL_PRECONDITION_HEADER,
			encodeURIComponent(BOB.userId)
		);
		for (const headers of [
			{ [USER_PRINCIPAL_PRECONDITION_HEADER]: "%invalid" },
			duplicate,
		]) {
			await rejection(
				await f.app.request("/user/me", { headers }, f.bindings(BOB)),
				400,
				"invalid_user_precondition"
			);
		}
		assert.equal(f.state.prepares, 0);
		assert.equal(f.state.sqlWrites, 0);
		assert.equal(f.state.domainOperations, 0);
	} finally {
		f.database.close();
	}
});

test("actual logout rejects stale or malformed identity and skips unavailable workspace for matching and legacy users", async () => {
	const f = fullAppFixture();
	try {
		f.state.workspaceUnavailable = true;
		const cookie =
			"user_session=synthetic-session; cinatoken_workspace=missing-workspace";
		for (const [raw, status, code] of [
			[encodeURIComponent(ALICE.userId), 409, "user_mismatch"],
			["%invalid", 400, "invalid_user_precondition"],
		] as const) {
			const response = await f.app.request(
				"/user/auth/logout",
				{
					method: "POST",
					headers: {
						[USER_PRINCIPAL_PRECONDITION_HEADER]: raw,
						Cookie: cookie,
					},
				},
				f.bindings(BOB)
			);
			assert.equal(response.headers.get("Set-Cookie"), null);
			await rejection(response, status, code);
			assert.equal(f.state.sessionDeletes, 0);
		}
		for (const headers of [undefined, expected(BOB.userId)]) {
			const response = await f.app.request(
				"/user/auth/logout",
				{
					method: "POST",
					headers: {
						...headers,
						"X-CinaToken-Workspace": "%invalid",
						Cookie: cookie,
					},
				},
				f.bindings(BOB)
			);
			assert.equal(response.status, 200);
			assert.equal(
				response.headers.get("Set-Cookie")?.includes("Max-Age=0"),
				true
			);
		}
		assert.equal(f.state.sessionDeletes, 4);
		assert.equal(f.state.prepares, 0);
		assert.equal(f.state.domainOperations, 0);
	} finally {
		f.database.close();
	}
});

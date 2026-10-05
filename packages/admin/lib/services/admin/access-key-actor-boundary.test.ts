import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type { GatewayRepositories } from "@octafuse/core";
import { createD1AdminAccessRepository } from "../../../../core/src/db/d1/admin-access.impl";
import type { D1DatabaseClient } from "../../../../core/src/storage/database-client";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { authenticateAdminRequest, hashSessionToken } from "@/lib/auth";

const SECRET = `sk-admin-${"a".repeat(64)}`;
const REPLACEMENT = `sk-admin-${"b".repeat(64)}`;
const NOW = "2026-09-30T00:00:00.000Z";
const auditFields = [
	"id",
	"key_id",
	"action",
	"change_mask",
	"actor_kind",
	"actor_id",
	"before_permissions",
	"after_permissions",
	"before_status",
	"after_status",
	"created_at",
].sort();
const repositoryRoot = resolve(
	process.cwd(),
	process.cwd().replaceAll("\\", "/").endsWith("/packages/admin")
		? "../.."
		: "."
);

// Admin intentionally retains Node 20 typings; the contract runs on the already
// available Node SQLite runtime without installing or widening production types.
type SQLInputValue = string | number | bigint | null | Uint8Array;
type SqliteDatabase = {
	exec(sql: string): void;
	close(): void;
	prepare(sql: string): {
		run(...values: SQLInputValue[]): { changes: number | bigint };
		get(...values: SQLInputValue[]): Record<string, unknown> | undefined;
		all(...values: SQLInputValue[]): Record<string, unknown>[];
	};
};
const { DatabaseSync } = createRequire(
	`${repositoryRoot}/access-key-actor-contract.cjs`
)("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabase;
};

type AuditEntry = {
	id: string;
	key_id: string;
	action: string;
	change_mask: number;
	actor_kind: string;
	actor_id: string;
	before_permissions: string[] | null;
	after_permissions: string[] | null;
	before_status: string | null;
	after_status: string | null;
	created_at: string;
};
type AuditBody = {
	success: boolean;
	data: { entries: AuditEntry[]; next_cursor: string | null };
};
type KeyBody = {
	success: boolean;
	data: { id: string; key: string; permissions: string[]; status: string };
};

/** Only the D1 transport is adapted: all production repository SQL executes in SQLite transactions. */
class SqliteStatement {
	constructor(
		private readonly database: SqliteDatabase,
		private readonly reads: string[],
		private readonly sql: string,
		private readonly values: SQLInputValue[] = []
	) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteStatement(
			this.database,
			this.reads,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		this.reads.push(this.sql);
		const result = this.database.prepare(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}
	first<T>(): T | null {
		this.reads.push(this.sql);
		return (this.database.prepare(this.sql).get(...this.values) ??
			null) as T | null;
	}
	all<T>(): D1Result<T> {
		this.reads.push(this.sql);
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
	executeBatch(): D1Result {
		return /^\s*SELECT\b/iu.test(this.sql) ? this.all() : this.run();
	}
}

async function fixture(
	subject: string,
	principalOverride?: AdminPrincipal | null
) {
	const database = new DatabaseSync(":memory:");
	database.exec(
		"CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT);"
	);
	const migration = (name: string) =>
		readFileSync(
			resolve(repositoryRoot, "packages/core/migrations-d1", name),
			"utf8"
		);
	database.exec(migration("0023_admin_access_identity.sql"));
	const hashMigration = migration("0032_key_hash_lookup.sql")
		.split(/\r?\n/u)
		.filter((line) =>
			/^ALTER TABLE admin_api_keys|^CREATE INDEX idx_admin_api_keys_secret_hash/u.test(
				line
			)
		)
		.join("\n");
	assert.match(hashMigration, /ADD COLUMN secret_key_hash TEXT/u);
	database.exec(hashMigration);
	database.exec(migration("0072_admin_access_key_audit.sql"));
	const statements: string[] = [];
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteStatement(
				database,
				statements,
				sql
			) as unknown as D1PreparedStatement;
		},
		async batch(prepared: SqliteStatement[]): Promise<D1Result[]> {
			database.exec("BEGIN");
			try {
				const results = prepared.map((statement) => statement.executeBatch());
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	const repository = createD1AdminAccessRepository({
		driver: "d1",
		raw,
		drizzle: {},
	} as D1DatabaseClient);
	const repositories = {
		adminAccess: repository,
	} as unknown as GatewayRepositories;
	const token = "actor-boundary-session-token";
	await repository.insertSession({
		tokenHash: await hashSessionToken(token),
		username: `cinaauth:${subject}`,
		createdAt: NOW,
		expiresAt: "2099-09-30T00:00:00.000Z",
	});
	// The real outer entry point injects an authenticated principal into Hono. Obtain
	// that principal from the actual stored session instead of accepting the JSON actor.
	const storedPrincipal = await authenticateAdminRequest(
		new Request("https://cinatoken.com/api/admin/access-keys", {
			headers: { cookie: `cinatoken_session=${token}` },
		}),
		repositories
	);
	assert.ok(storedPrincipal);
	const principal =
		principalOverride === undefined ? storedPrincipal : principalOverride;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal ?? undefined,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	const request = (path = "", method = "GET", body?: unknown) =>
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
		);
	const snapshot = () => ({
		keys: database.prepare("SELECT * FROM admin_api_keys ORDER BY id").all(),
		audit: database
			.prepare("SELECT * FROM admin_access_key_audit ORDER BY id")
			.all(),
	});
	const seed = async (revoked = false) => {
		await repository.insertApiKey(
			{
				id: "seed-key",
				name: "seed",
				secretKey: SECRET,
				keyPrefix: SECRET.slice(0, 12),
				permissionsJson: '["logs.read"]',
			},
			{ auditId: crypto.randomUUID(), actorId: "console:seed", nowIso: NOW }
		);
		if (revoked)
			database.exec(
				"UPDATE admin_api_keys SET status = 'revoked', revoked_at = '2026-09-30T00:00:00.000Z' WHERE id = 'seed-key'"
			);
	};
	return {
		database,
		repository,
		principal: storedPrincipal,
		statements,
		request,
		snapshot,
		seed,
		close: () => database.close(),
	};
}

function privateResponse(response: Response, status: number) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
}
async function lifecycleRequest(
	subject: Awaited<ReturnType<typeof fixture>>,
	operation: "create" | "update" | "rotate" | "revoke" | "activate" | "reveal"
) {
	if (operation === "create")
		return subject.request("", "POST", {
			name: "new-key",
			permissions: ["*"],
			secret_key: REPLACEMENT,
		});
	if (operation === "update")
		return subject.request("/seed-key", "PATCH", {
			name: "changed",
			permissions: ["*"],
			secret_key: REPLACEMENT,
		});
	if (operation === "activate")
		return subject.request("/seed-key", "PATCH", { status: "active" });
	if (operation === "reveal") return subject.request("/seed-key/secret");
	return subject.request(`/seed-key/${operation}`, "POST");
}
async function auditPages(
	subject: Awaited<ReturnType<typeof fixture>>,
	id: string
) {
	const entries: AuditEntry[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 10; page++) {
		const response = await subject.request(
			`/${id}/audit?page_size=2${
				cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
			}`
		);
		privateResponse(response, 200);
		const body = (await response.json()) as AuditBody;
		assert.equal(body.success, true);
		for (const row of body.data.entries)
			assert.deepEqual(Object.keys(row).sort(), auditFields);
		entries.push(...body.data.entries);
		cursor = body.data.next_cursor;
		if (cursor === null) return entries;
	}
	assert.fail("bounded audit cursor failed to terminate");
}

describe("Access Keys routes with stored Console actor boundaries and real SQLite auditing", () => {
	before(() => {
		mock.method(console, "log", () => undefined);
		mock.method(console, "error", () => undefined);
	});
	after(() => mock.restoreAll());
	for (const length of [238, 239, 255]) {
		it(`preserves raw subject ${length} / trusted actor ${
			length + 17
		} through all lifecycle operations and safe audit pagination`, async () => {
			const rawSubject = `MixedCase%2F/${"X".repeat(length - 13)}`;
			const subject = await fixture(rawSubject);
			try {
				assert.deepEqual(subject.principal, {
					type: "console",
					id: `console:cinaauth:${rawSubject}`,
					username: `cinaauth:${rawSubject}`,
				});
				const create = await subject.request("", "POST", {
					name: "integration",
					description: "Initial integration",
					permissions: ["logs.read"],
					secret_key: SECRET,
					actor_id: "console:forged",
					actor: { id: "console:forged" },
				});
				privateResponse(create, 201);
				const created = (await create.json()) as KeyBody;
				const id = created.data.id;
				assert.equal(created.data.key, SECRET);
				assert.deepEqual(created.data.permissions, ["logs.read"]);
				const update = await subject.request(`/${id}`, "PATCH", {
					name: "renamed",
					permissions: ["analytics.read", "logs.read"],
					actor_id: "console:forged",
					actor_kind: "api_key",
				});
				privateResponse(update, 200);
				const updated = (await update.json()) as KeyBody;
				assert.equal(updated.data.key, `${SECRET.slice(0, 12)}••••••••`);
				assert.deepEqual(updated.data.permissions, [
					"analytics.read",
					"logs.read",
				]);
				const rotate = await subject.request(`/${id}/rotate`, "POST", {
					actor_id: "console:forged",
				});
				privateResponse(rotate, 200);
				const rotated = (await rotate.json()) as KeyBody;
				assert.match(rotated.data.key, /^sk-admin-[a-f0-9]{64}$/u);
				assert.notEqual(rotated.data.key, SECRET);
				assert.equal(
					(await subject.repository.getApiKeyById(id))?.secretKey,
					rotated.data.key
				);
				privateResponse(
					await subject.request(`/${id}/revoke`, "POST", {
						actor_id: "console:forged",
					}),
					200
				);
				assert.equal(
					(await subject.repository.getApiKeyById(id))?.status,
					"revoked"
				);
				const activate = await subject.request(`/${id}`, "PATCH", {
					status: "active",
					actor_id: "console:forged",
				});
				privateResponse(activate, 200);
				assert.equal(
					((await activate.json()) as KeyBody).data.status,
					"active"
				);
				const reveal = await subject.request(`/${id}/secret`);
				privateResponse(reveal, 200);
				assert.deepEqual(await reveal.json(), {
					success: true,
					data: { id, key: rotated.data.key },
				});
				for (const path of ["", `/${id}`]) {
					const response = await subject.request(path);
					privateResponse(response, 200);
					const json = await response.text();
					assert.ok(!json.includes(SECRET));
					assert.ok(!json.includes(rotated.data.key));
					assert.ok(json.includes("••••••••"));
				}
				// Equal timestamps force pagination to exercise its secondary ID boundary.
				subject.database
					.prepare(
						"UPDATE admin_access_key_audit SET created_at = ? WHERE key_id = ?"
					)
					.run(NOW, id);
				const rows = await auditPages(subject, id);
				assert.equal(rows.length, 6);
				assert.equal(new Set(rows.map((row) => row.id)).size, 6);
				assert.deepEqual(
					rows.map((row) => row.id),
					subject.database
						.prepare(
							"SELECT id FROM admin_access_key_audit WHERE key_id = ? ORDER BY created_at DESC, id DESC"
						)
						.all(id)
						.map((row) => row.id)
				);
				assert.deepEqual(rows.map((row) => row.action).sort(), [
					"activated",
					"created",
					"revealed",
					"revoked",
					"rotated",
					"updated",
				]);
				for (const row of rows) {
					assert.equal(row.actor_id, subject.principal.id);
					assert.equal(row.actor_id.length, length + 17);
					assert.equal(row.actor_kind, "console");
					assert.equal(row.key_id, id);
				}
				const rowFor = (action: string) =>
					rows.find((row) => row.action === action)!;
				assert.equal(rowFor("created").before_permissions, null);
				assert.deepEqual(rowFor("created").after_permissions, ["logs.read"]);
				assert.deepEqual(rowFor("updated").before_permissions, ["logs.read"]);
				assert.deepEqual(rowFor("updated").after_permissions, [
					"analytics.read",
					"logs.read",
				]);
				assert.equal(rowFor("updated").change_mask, 5);
				assert.equal(rowFor("rotated").change_mask, 8);
				assert.equal(rowFor("revoked").after_status, "revoked");
				assert.equal(rowFor("activated").before_status, "revoked");
				assert.equal(rowFor("activated").after_status, "active");
				assert.equal(rowFor("revealed").change_mask, 0);
				const auditJson = JSON.stringify({
					wire: rows,
					stored: subject.snapshot().audit,
				});
				for (const forbidden of [
					SECRET,
					rotated.data.key,
					"console:forged",
					"secret_key",
					"key_prefix",
					"secret_key_hash",
					"fingerprint",
				])
					assert.ok(!auditJson.includes(forbidden));
			} finally {
				subject.close();
			}
		});
	}
	it("unsafe legacy permissions are not copied into stored or returned audit, even when they contain key material", async () => {
		const subject = await fixture("X".repeat(255));
		try {
			await subject.seed();
			subject.database
				.prepare("UPDATE admin_api_keys SET permissions_json = ? WHERE id = ?")
				.run(JSON.stringify(["logs.read", SECRET]), "seed-key");
			privateResponse(await subject.request("/seed-key/secret"), 200);
			const rows = await auditPages(subject, "seed-key");
			const revealed = rows.find((row) => row.action === "revealed")!;
			assert.equal(
				rows.find((row) => row.action === "created")?.actor_id,
				"console:seed"
			);
			assert.equal(revealed.before_permissions, null);
			assert.equal(revealed.after_permissions, null);
			assert.equal(revealed.actor_id, subject.principal.id);
			assert.ok(
				!JSON.stringify({
					wire: rows,
					stored: subject.snapshot().audit,
				}).includes(SECRET)
			);
		} finally {
			subject.close();
		}
	});
	it("stored overlimit, control-bearing and non-Console audit actors fail the private read without echoing credentials", async () => {
		const credentialActor = `console:cinaauth:${SECRET}`;
		for (const invalid of [
			{ actor: credentialActor.padEnd(273, "X"), kind: "console" },
			{ actor: `${credentialActor}\n`, kind: "console" },
			{ actor: `${credentialActor}\u007f`, kind: "console" },
			{ actor: credentialActor, kind: "api_key" },
		]) {
			const subject = await fixture("X".repeat(255));
			try {
				await subject.seed();
				// Model malformed legacy/corrupted storage; normal DDL rejects the wrong kind.
				subject.database.exec("PRAGMA ignore_check_constraints = ON");
				subject.database
					.prepare(
						"UPDATE admin_access_key_audit SET actor_id = ?, actor_kind = ?"
					)
					.run(invalid.actor, invalid.kind);
				subject.database.exec("PRAGMA ignore_check_constraints = OFF");
				const before = subject.snapshot();
				const response = await subject.request("/seed-key/audit");
				privateResponse(response, 500);
				const text = await response.text();
				assert.ok(!text.includes(SECRET));
				assert.ok(!text.includes(invalid.actor));
				assert.ok(!text.includes('"entries"'));
				assert.deepEqual(subject.snapshot(), before);
			} finally {
				subject.close();
			}
		}
	});
	const operations = [
		"create",
		"update",
		"rotate",
		"revoke",
		"activate",
		"reveal",
	] as const;
	for (const mode of ["ABORT", "IGNORE"] as const)
		for (const operation of operations) {
			it(`audit ${mode} during ${operation} produces no partial writes and cannot release a secret`, async () => {
				const subject = await fixture("X".repeat(255));
				try {
					await subject.seed(operation === "activate");
					const before = subject.snapshot();
					subject.database.exec(
						`CREATE TRIGGER fail_audit BEFORE INSERT ON admin_access_key_audit BEGIN SELECT RAISE(${mode}${
							mode === "ABORT" ? ", 'audit injected failure'" : ""
						}); END;`
					);
					const sqlBefore = subject.statements.length;
					const response = await lifecycleRequest(subject, operation);
					privateResponse(
						response,
						mode === "ABORT" || operation === "create" || operation === "reveal"
							? 500
							: 404
					);
					const text = await response.text();
					assert.ok(!text.includes(SECRET));
					assert.ok(!text.includes(REPLACEMENT));
					assert.ok(!text.includes('"key"'));
					assert.ok(
						subject.statements.length > sqlBefore,
						"the test must reach the real SQLite failure, not fail actor validation first"
					);
					assert.deepEqual(subject.snapshot(), before);
				} finally {
					subject.close();
				}
			});
		}
	for (const mode of ["ABORT", "IGNORE"] as const)
		for (const operation of [
			"create",
			"update",
			"rotate",
			"revoke",
			"activate",
		] as const) {
			it(`key target ${mode} during ${operation} rolls back its audit and key together without fake success or secret`, async () => {
				const subject = await fixture("X".repeat(255));
				try {
					await subject.seed(operation === "activate");
					const before = subject.snapshot();
					const event = operation === "create" ? "INSERT" : "UPDATE";
					subject.database.exec(
						`CREATE TRIGGER fail_key_target BEFORE ${event} ON admin_api_keys BEGIN SELECT RAISE(${mode}${
							mode === "ABORT" ? ", 'key target injected failure'" : ""
						}); END;`
					);
					const sqlBefore = subject.statements.length;
					const response = await lifecycleRequest(subject, operation);
					privateResponse(response, 500);
					const text = await response.text();
					for (const forbidden of [SECRET, REPLACEMENT, '"key"', '"data"'])
						assert.ok(!text.includes(forbidden));
					assert.ok(
						subject.statements
							.slice(sqlBefore)
							.some((sql) =>
								operation === "create"
									? /^\s*INSERT INTO admin_api_keys\b/iu.test(sql)
									: /^\s*UPDATE admin_api_keys\b/iu.test(sql)
							),
						"the request must execute the real target INSERT/UPDATE with its fault trigger"
					);
					assert.deepEqual(subject.snapshot(), before);
				} finally {
					subject.close();
				}
			});
		}
	it("wildcard Bearer and missing Console cannot access any Access Keys path or touch repository SQL", async () => {
		for (const principal of [
			{
				type: "api_key",
				id: "admin_key:wildcard",
				keyId: "wildcard",
				permissions: ["*"],
			} as AdminPrincipal,
			null,
		]) {
			const subject = await fixture("X".repeat(255), principal);
			try {
				await subject.seed();
				const before = subject.snapshot();
				const sqlBefore = subject.statements.length;
				for (const [path, method, body] of [
					["", "GET", undefined],
					["", "POST", { name: "new", permissions: ["*"] }],
					["/seed-key", "GET", undefined],
					["/seed-key", "PATCH", { status: "active" }],
					["/seed-key/rotate", "POST", undefined],
					["/seed-key/revoke", "POST", undefined],
					["/seed-key/secret", "GET", undefined],
					["/seed-key/audit", "GET", undefined],
				] as const)
					privateResponse(
						await subject.request(path, method, body),
						principal === null ? 401 : 403
					);
				assert.equal(subject.statements.length, sqlBefore);
				assert.deepEqual(subject.snapshot(), before);
			} finally {
				subject.close();
			}
		}
	});
	it("Core-invalid overlimit and control-bearing actors fail before audit or mutation SQL without truncation", async () => {
		for (const rawSubject of [
			"X".repeat(256),
			"before\u0000after",
			"before\u001fafter",
			"before\u007fafter",
		]) {
			// Node's SQLite text reader truncates embedded NUL. Supply the original
			// invalid principal at Hono's trusted entry boundary so the Core validator
			// receives every raw character; never obtain this actor from request JSON.
			const subject = await fixture(rawSubject, {
				type: "console",
				id: `console:cinaauth:${rawSubject}`,
				username: `cinaauth:${rawSubject}`,
			});
			try {
				await subject.seed();
				const before = subject.snapshot();
				const sqlBefore = subject.statements.length;
				for (const [path, method, body] of [
					[
						"",
						"POST",
						{ name: "new", permissions: ["*"], secret_key: REPLACEMENT },
					],
					["/seed-key", "PATCH", { permissions: ["*"] }],
					["/seed-key", "PATCH", { status: "active" }],
					["/seed-key/rotate", "POST", undefined],
					["/seed-key/revoke", "POST", undefined],
					["/seed-key/secret", "GET", undefined],
				] as const) {
					const response = await subject.request(path, method, body);
					privateResponse(response, 500);
					assert.ok(!(await response.text()).includes(SECRET));
				}
				assert.equal(subject.statements.length, sqlBefore);
				assert.deepEqual(subject.snapshot(), before);
			} finally {
				subject.close();
			}
		}
	});
});

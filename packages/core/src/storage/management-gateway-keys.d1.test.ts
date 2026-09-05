import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import { createD1ApiKeysRepository } from "../db/d1/api-keys.impl";
import type { D1DatabaseClient } from "./database-client";

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = []
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(
			this.database,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}

	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}

	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ??
			null) as T | null;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function client(database: DatabaseSync): D1DatabaseClient {
	return {
		driver: "d1",
		raw: {
			prepare: (sql: string) =>
				new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement,
		} as unknown as D1Database,
		drizzle: {} as D1DatabaseClient["drizzle"],
	};
}

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			personal_owner_user_id TEXT,
			organization_id TEXT,
			status TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			key TEXT NOT NULL,
			key_hash TEXT UNIQUE,
			key_preview TEXT,
			user_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			name TEXT,
			status TEXT NOT NULL,
			expires_at TEXT,
			limit_micros INTEGER,
			limit_reset TEXT,
			include_byok_in_limit INTEGER NOT NULL DEFAULT 0,
			limit_epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE api_key_request_logs (
			api_key_id TEXT,
			charged_cost REAL NOT NULL,
			standard_cost REAL NOT NULL,
			is_byok INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE user_budget_reservations (
			id TEXT PRIMARY KEY,
			api_key_id TEXT NOT NULL,
			state TEXT NOT NULL
		);
		CREATE TABLE guardrail_budget_windows (
			workspace_id TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			period TEXT NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			unreserved_micros INTEGER NOT NULL,
			settled_micros INTEGER NOT NULL,
			reserved_micros INTEGER NOT NULL,
			PRIMARY KEY (workspace_id, scope_type, scope_id, period, period_start)
		);
		CREATE TABLE guardrail_budget_reservations (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			state TEXT NOT NULL
		);

		INSERT INTO workspaces VALUES
			('personal:user-1', 'personal', 'user-1', NULL, 'active'),
			('personal:user-2', 'personal', 'user-2', NULL, 'active');
		INSERT INTO api_keys (
			id, key, key_hash, key_preview, user_id, workspace_id, name, status,
			expires_at, created_at, updated_at
		) VALUES
			('key-1', 'sha256:stored', 'sha256:${"a".repeat(
				64
			)}', 'sk-one…1111', 'user-1', 'personal:user-1', 'Primary', 'active', NULL, datetime('now', '-1 day'), datetime('now', '-1 day')),
			('key-2', 'sha256:stored', 'sha256:${"b".repeat(
				64
			)}', 'sk-two…2222', 'user-1', 'personal:user-1', 'Disabled', 'disabled', NULL, datetime('now', '-2 day'), datetime('now', '-2 day')),
			('key-3', 'sha256:stored', 'sha256:${"c".repeat(
				64
			)}', 'sk-other…3333', 'user-2', 'personal:user-2', 'Other tenant', 'active', NULL, datetime('now'), datetime('now'));
		INSERT INTO api_key_request_logs VALUES
			('key-1', 1.25, 1.25, 0, datetime('now')),
			('key-1', 2.00, 2.00, 0, datetime('now', '-2 day')),
			('key-1', 2.75, 2.75, 0, datetime('now', '-40 day')),
			('key-1', 0.00, 0.75, 1, datetime('now')),
			('key-1', 0.00, 1.25, 1, datetime('now', '-2 day')),
			('key-1', 0.00, 2.00, 1, datetime('now', '-40 day'));
		INSERT INTO guardrail_budget_windows VALUES (
			'personal:user-1', 'api_key', 'key-1', 'lifetime',
			datetime('now', '-1 day'), '9999-12-31T23:59:59.999Z',
			250000, 1000000, 125000
		);
	`);
	return { database, repository: createD1ApiKeysRepository(client(database)) };
}

const account = {
	accountType: "personal" as const,
	personalOwnerUserId: "user-1",
	organizationId: null,
};

test("D1 Management API list is workspace-scoped and reports charged usage", async () => {
	const { database, repository } = setup();
	try {
		const active = await repository.listForManagement({
			...account,
			workspaceId: "personal:user-1",
			includeDisabled: false,
			offset: 0,
		});
		assert.equal(active.length, 1);
		assert.equal(active[0]?.id, "key-1");
		assert.equal(active[0]?.usage, 6);
		assert.equal(active[0]?.usage_daily, 1.25);
		assert.ok((active[0]?.usage_weekly ?? 0) >= 1.25);
		assert.ok((active[0]?.usage_monthly ?? 0) >= 1.25);
		assert.equal(active[0]?.byok_usage, 4);
		assert.equal(active[0]?.limit_consumed_micros, 1_250_000);
		assert.equal(active[0]?.byok_usage_daily, 0.75);
		assert.ok((active[0]?.byok_usage_weekly ?? 0) >= 0.75);
		assert.ok((active[0]?.byok_usage_monthly ?? 0) >= 0.75);
		assert.deepEqual(await repository.getCurrentById("key-1"), active[0]);
		assert.equal(await repository.getCurrentById("key-2"), null);

		const withDisabled = await repository.listForManagement({
			...account,
			workspaceId: "personal:user-1",
			includeDisabled: true,
			offset: 0,
		});
		assert.deepEqual(
			new Set(withDisabled.map((row) => row.id)),
			new Set(["key-1", "key-2"])
		);

		const crossTenant = await repository.getByHashForManagement({
			...account,
			keyHash: `sha256:${"c".repeat(64)}`,
		});
		assert.equal(crossTenant, null);
	} finally {
		database.close();
	}
});

test("D1 Management API mutations cannot cross accounts and protect in-flight requests", async () => {
	const { database, repository } = setup();
	try {
		assert.equal(
			await repository.updateByHashForManagement(
				{ ...account, keyHash: `sha256:${"c".repeat(64)}` },
				{ status: "disabled" }
			),
			false
		);
		assert.equal(
			await repository.updateByHashForManagement(
				{ ...account, keyHash: `sha256:${"a".repeat(64)}` },
				{ name: "Renamed", status: "disabled", limitMicros: 10_000_000, limitReset: "daily" }
			),
			true
		);
		const updated = await repository.getByHashForManagement({
			...account,
			keyHash: `sha256:${"a".repeat(64)}`,
		});
		assert.equal(updated?.name, "Renamed");
		assert.equal(updated?.status, "disabled");
		assert.equal(updated?.limit_micros, 10_000_000);
		assert.equal(updated?.limit_reset, "daily");
		assert.equal(updated?.limit_epoch, 1);

		database
			.prepare("INSERT INTO user_budget_reservations VALUES (?, ?, ?)")
			.run("reservation-1", "key-1", "dispatched");
		assert.equal(
			await repository.deleteByHashForManagement({
				...account,
				keyHash: `sha256:${"a".repeat(64)}`,
			}),
			false
		);
		database
			.prepare("UPDATE user_budget_reservations SET state = 'settled'")
			.run();
		database.prepare("INSERT INTO guardrail_budget_reservations VALUES (?, ?, ?, ?)")
			.run("guardrail-reservation-1", "api_key", "key-1", "dispatched");
		assert.equal(
			await repository.deleteByHashForManagement({
				...account,
				keyHash: `sha256:${"a".repeat(64)}`,
			}),
			false
		);
		database.prepare("UPDATE guardrail_budget_reservations SET state = 'settled'").run();
		database.prepare("INSERT INTO api_key_request_logs VALUES (?, ?, ?, ?, ?)")
			.run("key-1", 1.25, 1.25, 0, "2026-08-31T01:00:00.000Z");
		assert.equal(
			await repository.deleteByHashForManagement({
				...account,
				keyHash: `sha256:${"a".repeat(64)}`,
			}),
			false
		);
		database.prepare("DELETE FROM api_key_request_logs").run();
		assert.equal(
			await repository.deleteByHashForManagement({
				...account,
				keyHash: `sha256:${"a".repeat(64)}`,
			}),
			true
		);
		assert.equal(
			await repository.getByHashForManagement({
				...account,
				keyHash: `sha256:${"a".repeat(64)}`,
			}),
			null
		);
	} finally {
		database.close();
	}
});

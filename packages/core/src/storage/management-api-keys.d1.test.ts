import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import { hashLookupKey, previewGatewayApiKey } from "../lib/key-hash";
import type { D1DatabaseClient } from "./database-client";
import { createManagementApiKeysRepository } from "./management-api-keys";

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

function createClient(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(
				database,
				sql
			) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]) {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results: D1Result[] = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	return {
		driver: "d1",
		raw,
		drizzle: {} as D1DatabaseClient["drizzle"],
	};
}

function setupDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE organizations (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			api_key_id TEXT,
			event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL,
			change_payload TEXT,
			source TEXT,
			actor_id TEXT,
			reason_code TEXT,
			reason_text TEXT,
			created_at TEXT NOT NULL
		);
	`);
	database.exec(
		readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				"../../migrations-d1/0051_management_api_keys.sql"
			),
			"utf8"
		)
	);
	database
		.prepare(
			"INSERT INTO users (id, status) VALUES (?, 'active'), (?, 'active')"
		)
		.run("user-1", "user-2");
	database
		.prepare("INSERT INTO organizations (id, status) VALUES (?, 'active')")
		.run("org-1");
	return database;
}

test("D1 Management API key lifecycle is hash-only and account-scoped", async () => {
	const database = setupDatabase();
	try {
		const repository = createManagementApiKeysRepository(
			createClient(database)
		);
		const secret = `sk-cina-mgmt-${"a".repeat(64)}`;
		const account = {
			accountType: "personal" as const,
			personalOwnerUserId: "user-1",
			organizationId: null,
		};
		await repository.insert({
			id: "management-1",
			keyHash: await hashLookupKey(secret),
			keyPreview: previewGatewayApiKey(secret),
			...account,
			name: "Automation",
			expiresAt: null,
			createdByUserId: "user-1",
			nowIso: "2026-08-31T00:00:00.000Z",
		});

		const stored = database
			.prepare(
				"SELECT key_hash, key_preview, last_used_at FROM management_api_keys WHERE id = ?"
			)
			.get("management-1") as {
			key_hash: string;
			key_preview: string;
			last_used_at: string | null;
		};
		assert.notEqual(stored.key_hash, secret);
		assert.equal(stored.key_hash, await hashLookupKey(secret));
		assert.ok(!stored.key_preview.includes("a".repeat(32)));
		assert.equal(stored.last_used_at, null);
		const creationAudit = database
			.prepare(
				"SELECT event_type, actor_id, source, reason_code, change_payload FROM user_audit_logs WHERE reason_code = 'management_key_create'"
			)
			.get() as Record<string, string>;
		assert.equal(creationAudit.event_type, "key_created");
		assert.equal(creationAudit.actor_id, "portal:user-1");
		assert.equal(creationAudit.source, "portal_management_keys");
		assert.equal(
			JSON.parse(creationAudit.change_payload).management_key_id,
			"management-1"
		);
		assert.equal(creationAudit.change_payload.includes(secret), false);

		assert.equal(
			(await repository.getActiveBySecret(secret))?.id,
			"management-1"
		);
		assert.ok(
			database
				.prepare("SELECT last_used_at FROM management_api_keys WHERE id = ?")
				.get("management-1")?.last_used_at
		);
		assert.equal((await repository.listByAccount(account)).length, 1);
		assert.equal(
			(
				await repository.listByAccount({
					accountType: "personal",
					personalOwnerUserId: "user-2",
					organizationId: null,
				})
			).length,
			0
		);

		assert.equal(
			await repository.revokeByIdInAccount(
				"management-1",
				{
					accountType: "personal",
					personalOwnerUserId: "user-2",
					organizationId: null,
				},
				"2026-08-31T01:00:00.000Z",
				"user-2"
			),
			false
		);
		assert.equal(
			await repository.revokeByIdInAccount(
				"management-1",
				account,
				"2026-08-31T01:00:00.000Z",
				"user-1"
			),
			true
		);
		assert.equal(await repository.getActiveBySecret(secret), null);
		assert.equal(
			database
				.prepare(
					"SELECT COUNT(*) AS total FROM user_audit_logs WHERE reason_code = 'management_key_revoke'"
				)
				.get()?.total,
			1
		);
		assert.equal(
			(await repository.listByAccount(account, { includeRevoked: true }))[0]
				?.status,
			"revoked"
		);
	} finally {
		database.close();
	}
});

test("D1 Management API authentication fails closed for expiry and inactive owners", async () => {
	const database = setupDatabase();
	try {
		const repository = createManagementApiKeysRepository(
			createClient(database)
		);
		const expiredSecret = `sk-cina-mgmt-${"b".repeat(64)}`;
		await repository.insert({
			id: "management-expired",
			keyHash: await hashLookupKey(expiredSecret),
			keyPreview: previewGatewayApiKey(expiredSecret),
			accountType: "personal",
			personalOwnerUserId: "user-1",
			organizationId: null,
			name: "Expired",
			expiresAt: "2020-01-01T00:00:00.000Z",
			createdByUserId: "user-1",
			nowIso: "2020-01-01T00:00:00.000Z",
		});
		assert.equal(await repository.getActiveBySecret(expiredSecret), null);

		const activeSecret = `sk-cina-mgmt-${"c".repeat(64)}`;
		await repository.insert({
			id: "management-inactive-owner",
			keyHash: await hashLookupKey(activeSecret),
			keyPreview: previewGatewayApiKey(activeSecret),
			accountType: "personal",
			personalOwnerUserId: "user-1",
			organizationId: null,
			name: "Owner lifecycle",
			expiresAt: null,
			createdByUserId: "user-1",
			nowIso: "2026-08-31T00:00:00.000Z",
		});
		assert.equal(
			(await repository.getActiveBySecret(activeSecret))?.id,
			"management-inactive-owner"
		);
		database
			.prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
			.run("user-1");
		assert.equal(await repository.getActiveBySecret(activeSecret), null);
	} finally {
		database.close();
	}
});

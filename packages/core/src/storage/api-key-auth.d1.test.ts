import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from './database-client';
import { createD1Repositories } from './repositories-d1';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
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
		return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function repositories(database: DatabaseSync) {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
	const client: D1DatabaseClient = {
		driver: 'd1',
		raw,
		drizzle: {} as D1DatabaseClient['drizzle'],
	};
	return createD1Repositories(client);
}

function setupDatabase(userStatus: 'active' | 'disabled'): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			external_system TEXT,
			external_user_id TEXT,
			budget_max REAL,
			budget_base REAL NOT NULL DEFAULT 0,
			budget_spent REAL NOT NULL DEFAULT 0,
			budget_period TEXT NOT NULL DEFAULT 'none',
			budget_reset_at TEXT,
			budget_epoch INTEGER NOT NULL DEFAULT 0,
			budget_reserved_micros INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			metadata TEXT,
			charged_cost_factors TEXT
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			key TEXT NOT NULL,
			key_hash TEXT,
			key_preview TEXT,
			user_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			name TEXT,
			status TEXT NOT NULL,
			metadata TEXT,
			expires_at TEXT,
			limit_micros INTEGER,
			limit_reset TEXT,
			include_byok_in_limit INTEGER NOT NULL DEFAULT 0,
			limit_epoch INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL
		);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			organization_id TEXT,
			personal_owner_user_id TEXT,
			is_default INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL
		);
		CREATE TABLE organization_memberships (
			organization_id TEXT NOT NULL,
			subject TEXT NOT NULL,
			status TEXT NOT NULL,
			PRIMARY KEY (organization_id, subject)
		);
		CREATE TABLE workspace_memberships (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			subject TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE user_budget_reservations (
			request_id TEXT PRIMARY KEY,
			api_key_id TEXT NOT NULL,
			state TEXT NOT NULL
		);
		CREATE TABLE guardrail_budget_reservations (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			state TEXT NOT NULL
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY,
			api_key_id TEXT
		);
	`);
	database.prepare(`INSERT INTO users (
		id, email, external_system, external_user_id, budget_max, budget_base, budget_spent, budget_period,
		budget_reset_at, budget_epoch, budget_reserved_micros, status
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run('user-1', 'user@example.com', 'cinaauth', 'subject-1', 10, 10, 0, 'none', null, 0, 0, userStatus);
	database.prepare(`INSERT INTO workspaces (id, scope_type, organization_id, personal_owner_user_id, is_default, status)
		VALUES (?, 'personal', NULL, ?, 1, 'active')`).run('personal:user-1', 'user-1');
	database.prepare(`INSERT INTO api_keys (
		id, key, key_hash, key_preview, user_id, workspace_id, name, status, metadata, expires_at,
		last_used_at, created_at, updated_at
	) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`)
		.run(
			'key-1',
			'sk-disabled-user-test',
			'user-1',
			'personal:user-1',
			'Test key',
			'2026-08-29T00:00:00.000Z',
			'2026-08-29T00:00:00.000Z',
		);
	return database;
}

test('D1 gateway authentication requires both an active key and an active user', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	const active = await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test');
	assert.equal(active?.id, 'key-1');

	database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run('user-1');
	assert.equal(
		await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'),
		null,
	);
	// Administrator lookup by id remains available for remediation and audit.
	assert.equal((await repos.apiKeys.getApiKeyWithUserById('key-1'))?.id, 'key-1');
});

test('D1 gateway authentication fails closed after the key expiry boundary', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	database.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?')
		.run('2099-01-01T00:00:00.000Z', 'key-1');
	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.id, 'key-1');
	database.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?')
		.run('2000-01-01T00:00:00.000Z', 'key-1');
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	assert.equal(await repos.apiKeys.getApiKeyByKey('sk-disabled-user-test'), null);
	assert.equal((await repos.apiKeys.getApiKeyWithUserById('key-1'))?.expires_at, '2000-01-01T00:00:00.000Z');
});

test('D1 gateway authentication fails closed when the owning workspace is archived', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.workspace_id, 'personal:user-1');
	database.prepare("UPDATE workspaces SET status = 'archived' WHERE id = ?").run('personal:user-1');
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	assert.equal(await repos.apiKeys.getApiKeyByKey('sk-disabled-user-test'), null);
	assert.equal((await repos.apiKeys.getApiKeyWithUserById('key-1'))?.workspace_id, 'personal:user-1');
});

test('D1 personal workspace authentication requires the key creator to be the owner', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.id, 'key-1');
	database.prepare('UPDATE workspaces SET personal_owner_user_id = ? WHERE id = ?')
		.run('different-user', 'personal:user-1');
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	assert.equal((await repos.apiKeys.getApiKeyWithUserById('key-1'))?.id, 'key-1');
});

test('D1 organization Default workspace authentication follows active CinaAuth membership', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	database.prepare(`INSERT INTO organizations (id, status) VALUES (?, 'pending')`).run('org-1');
	database.prepare(`INSERT INTO workspaces (id, scope_type, organization_id, personal_owner_user_id, is_default, status)
		VALUES (?, 'organization', ?, NULL, 1, 'active')`).run('organization:org-1', 'org-1');
	database.prepare(`INSERT INTO organization_memberships (organization_id, subject, status)
		VALUES (?, ?, 'active')`).run('org-1', 'subject-1');
	database.prepare(`UPDATE api_keys SET workspace_id = ? WHERE id = ?`)
		.run('organization:org-1', 'key-1');

	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.id, 'key-1');
	database.prepare(`UPDATE organization_memberships SET status = 'removed' WHERE organization_id = ? AND subject = ?`)
		.run('org-1', 'subject-1');
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	database.prepare(`UPDATE organization_memberships SET status = 'active' WHERE organization_id = ? AND subject = ?`)
		.run('org-1', 'subject-1');
	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.id, 'key-1');
});

test('D1 non-Default organization workspace requires both organization and workspace membership', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	database.prepare(`INSERT INTO organizations (id, status) VALUES (?, 'active')`).run('org-1');
	database.prepare(`INSERT INTO workspaces (id, scope_type, organization_id, personal_owner_user_id, is_default, status)
		VALUES (?, 'organization', ?, NULL, 0, 'active')`).run('workspace:org-1:custom', 'org-1');
	database.prepare(`INSERT INTO organization_memberships (organization_id, subject, status)
		VALUES (?, ?, 'active')`).run('org-1', 'subject-1');
	database.prepare(`UPDATE api_keys SET workspace_id = ? WHERE id = ?`)
		.run('workspace:org-1:custom', 'key-1');

	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	database.prepare(`INSERT INTO workspace_memberships (id, workspace_id, subject, status)
		VALUES (?, ?, ?, 'active')`).run('membership-1', 'workspace:org-1:custom', 'subject-1');
	assert.equal((await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'))?.id, 'key-1');
	database.prepare(`UPDATE workspace_memberships SET status = 'removed' WHERE id = ?`).run('membership-1');
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
});

test('D1 workspace-scoped key management never crosses workspace or creator boundaries', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	database.prepare(`INSERT INTO organizations (id, status) VALUES (?, 'active')`).run('org-1');
	database.prepare(`INSERT INTO workspaces (id, scope_type, organization_id, personal_owner_user_id, is_default, status)
		VALUES (?, 'organization', ?, NULL, 1, 'active')`).run('organization:org-1', 'org-1');
	database.prepare(`UPDATE api_keys SET workspace_id = ? WHERE id = ?`)
		.run('organization:org-1', 'key-1');

	assert.equal((await repos.apiKeys.listKeysByWorkspaceId('organization:org-1', {
		creatorUserId: 'user-1',
	}))[0]?.id, 'key-1');
	assert.deepEqual(await repos.apiKeys.listKeysByWorkspaceId('personal:user-1'), []);
	assert.equal(await repos.apiKeys.getApiKeyByIdInWorkspace('key-1', 'personal:user-1'), null);
	assert.equal(
		await repos.apiKeys.revokeApiKeyInWorkspace('key-1', 'organization:org-1', 'different-user'),
		false,
	);
	assert.equal(
		await repos.apiKeys.revokeApiKeyInWorkspace('key-1', 'organization:org-1', 'user-1'),
		true,
	);
});

test('D1 does not lazily migrate a disabled user credential during rejected authentication', async () => {
	const database = setupDatabase('disabled');
	const repos = repositories(database);
	assert.equal(await repos.apiKeys.getApiKeyWithUserByKey('sk-disabled-user-test'), null);
	const stored = database.prepare('SELECT key_hash FROM api_keys WHERE id = ?')
		.get('key-1') as { key_hash: string | null };
	assert.equal(stored.key_hash, null);
});

test('D1 hard delete cannot orphan an active ordinary-budget reservation', async () => {
	const database = setupDatabase('active');
	const repos = repositories(database);
	database.prepare(`INSERT INTO user_budget_reservations (request_id, api_key_id, state)
		VALUES (?, ?, ?)`)
		.run('request-in-flight', 'key-1', 'dispatched');

	assert.equal(await repos.apiKeys.deleteApiKeyHard('key-1', 'unused'), false);
	assert.equal(
		Number(database.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE id = ?')
			.get('key-1')?.count),
		1,
	);

	database.prepare("UPDATE user_budget_reservations SET state = 'settled' WHERE request_id = ?")
		.run('request-in-flight');
	database.prepare('INSERT INTO api_key_request_logs (id, api_key_id) VALUES (?, ?)')
		.run('request-history', 'key-1');
	assert.equal(await repos.apiKeys.deleteApiKeyHard('key-1', 'unused'), false);
	database.prepare('DELETE FROM api_key_request_logs WHERE id = ?').run('request-history');
	assert.equal(await repos.apiKeys.deleteApiKeyHard('key-1', 'unused'), true);
	assert.equal(
		Number(database.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE id = ?')
			.get('key-1')?.count),
		0,
	);
});

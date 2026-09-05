import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from './database-client';
import {
	getAccessibleWorkspaceForSubject,
	listAccessibleWorkspacesForSubject,
	resolveWorkspaceContextForSubject,
} from './workspaces';
import { workspaceMembershipKey } from '../workspaces';
import { createD1UsersRepository } from '../db/d1/users.impl';

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
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as D1Result;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function d1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'] };
}

function migrate(database: DatabaseSync): void {
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL DEFAULT '',
			budget_max REAL,
			budget_base REAL NOT NULL DEFAULT 0,
			budget_spent REAL NOT NULL DEFAULT 0,
			budget_spent_micros INTEGER NOT NULL DEFAULT 0,
			budget_period TEXT NOT NULL DEFAULT 'none',
			budget_reset_at TEXT,
			budget_epoch INTEGER NOT NULL DEFAULT 0,
			budget_reserved_micros INTEGER NOT NULL DEFAULT 0,
			external_system TEXT,
			external_user_id TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			metadata TEXT,
			charged_cost_factors TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
	database.exec(readFileSync(
		new URL('../../migrations-d1/0038_organization_identity_projection.sql', import.meta.url),
		'utf8',
	));
	database.prepare(`
		INSERT INTO users (id, external_system, external_user_id, status)
		VALUES (?, 'cinaauth', ?, 'active')
	`).run('user-1', 'subject-1');
	database.prepare(`
		INSERT INTO organizations (id, source, name, slug, status, source_updated_at)
		VALUES (?, 'cinaauth', ?, ?, 'active', ?)
	`).run('org-1', 'Cina Group', 'cina-group', '2026-08-30T00:00:00.000Z');
	database.prepare(`
		INSERT INTO organization_memberships (
			organization_id, subject, user_id, roles_json, status, source_updated_at
		) VALUES (?, ?, ?, ?, 'active', ?)
	`).run('org-1', 'subject-1', 'user-1', '["member"]', '2026-08-30T00:00:00.000Z');
	database.exec(readFileSync(
		new URL('../../migrations-d1/0042_workspaces.sql', import.meta.url),
		'utf8',
	));
	database.exec(`
		CREATE TABLE guardrails (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			designated_version INTEGER NOT NULL, latest_version INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			is_workspace_default INTEGER NOT NULL DEFAULT 0,
			is_account_default INTEGER NOT NULL DEFAULT 0,
			account_scope_key TEXT
		);
		CREATE UNIQUE INDEX uk_guardrails_workspace_default
			ON guardrails(workspace_id) WHERE is_workspace_default = 1;
		CREATE UNIQUE INDEX uk_guardrails_account_default
			ON guardrails(account_scope_key) WHERE is_account_default = 1;
		CREATE TABLE guardrail_versions (
			id TEXT PRIMARY KEY,
			guardrail_id TEXT NOT NULL REFERENCES guardrails(id) ON DELETE CASCADE,
			version INTEGER NOT NULL, config_json TEXT NOT NULL,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (guardrail_id, version)
		);
	`);
}

test('D1 user creation atomically provisions the personal Default Workspace', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		migrate(database);
		const client = d1Client(database);
		const users = createD1UsersRepository(client);
		await users.createUser({
			id: 'user-new',
			email: 'new@example.com',
			externalSystem: 'cinaauth',
			externalUserId: 'subject-new',
		});
		assert.deepEqual(
			{ ...database.prepare(`SELECT id, scope_type, personal_owner_user_id, is_default
				FROM workspaces WHERE id = ?`).get('personal:user-new') },
			{
				id: 'personal:user-new',
				scope_type: 'personal',
				personal_owner_user_id: 'user-new',
				is_default: 1,
			},
		);
		const defaultGuardrail = database.prepare(`SELECT guardrail.id,
			guardrail.is_workspace_default, version.version, version.config_json
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.workspace_id = ? AND guardrail.is_workspace_default = 1`)
			.get('personal:user-new') as Record<string, unknown>;
		assert.deepEqual({ ...defaultGuardrail }, {
			id: defaultGuardrail.id,
			is_workspace_default: 1,
			version: 1,
			config_json: '{}',
		});
		const accountDefault = database.prepare(`SELECT guardrail.name,
			guardrail.is_account_default, guardrail.account_scope_key,
			version.version, version.config_json
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.account_scope_key = ? AND guardrail.is_account_default = 1`)
			.get('personal:user-new') as Record<string, unknown>;
		assert.deepEqual({ ...accountDefault }, {
			name: 'Account Default',
			is_account_default: 1,
			account_scope_key: 'personal:user-new',
			version: 1,
			config_json: '{}',
		});
		assert.equal(await users.deleteUserHard('user-new'), false,
			'a default Guardrail owner cannot be hard-deleted');
		assert.equal(database.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
			.get('user-new')?.total, 1);
	} finally {
		database.close();
	}
});

test('D1 Workspace migration backfills defaults and enforces subject-scoped access', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		migrate(database);
		const client = d1Client(database);
		const initial = await listAccessibleWorkspacesForSubject(client, {
			userId: 'user-1',
			subject: 'subject-1',
		});
		assert.deepEqual(initial.map((workspace) => [
			workspace.id,
			workspace.role,
			workspace.accessSource,
		]), [
			['personal:user-1', 'owner', 'personal_owner'],
			['organization:org-1', 'member', 'organization_default'],
		]);

		database.prepare(`
			INSERT INTO workspaces (
				id, scope_type, organization_id, name, slug, is_default, status
			) VALUES (?, 'organization', ?, ?, ?, 0, 'active')
		`).run('workspace:production', 'org-1', 'Production', 'production');
		assert.equal((await listAccessibleWorkspacesForSubject(client, {
			userId: 'user-1', subject: 'subject-1',
		})).length, 2, 'custom organization workspaces require an explicit assignment');

		const membershipKey = await workspaceMembershipKey('workspace:production', 'subject-1');
		database.prepare(`
			INSERT INTO workspace_memberships (
				id, membership_key, workspace_id, subject, role, status
			) VALUES (?, ?, ?, ?, 'admin', 'active')
		`).run('membership-1', membershipKey, 'workspace:production', 'subject-1');
		const assigned = await listAccessibleWorkspacesForSubject(client, {
			userId: 'user-1', subject: 'subject-1',
		});
		assert.equal(assigned.length, 3);
		const production = assigned.find((workspace) => workspace.id === 'workspace:production');
		assert.ok(production);
		assert.deepEqual({
			id: production.id,
			scopeType: production.scopeType,
			organizationId: production.organizationId,
			organizationName: production.organizationName,
			role: production.role,
			accessSource: production.accessSource,
			isDefault: production.isDefault,
		}, {
			id: 'workspace:production',
			scopeType: 'organization',
			organizationId: 'org-1',
			organizationName: 'Cina Group',
			role: 'admin',
			accessSource: 'workspace_membership',
			isDefault: false,
		});

		const selected = await resolveWorkspaceContextForSubject(client, {
			userId: 'user-1', subject: 'subject-1', preferredWorkspaceId: 'workspace:production',
		});
		assert.equal(selected.currentWorkspace.id, 'workspace:production');
		assert.equal(selected.preferredWorkspaceAvailable, true);

		assert.equal(await getAccessibleWorkspaceForSubject(client, {
			userId: 'user-1', subject: 'attacker-subject', workspaceId: 'workspace:production',
		}), null, 'a caller cannot combine another local user id with its own subject');

		database.prepare(`
			UPDATE organization_memberships SET status = 'removed'
			WHERE organization_id = ? AND subject = ?
		`).run('org-1', 'subject-1');
		assert.deepEqual(
			(await listAccessibleWorkspacesForSubject(client, {
				userId: 'user-1', subject: 'subject-1',
			})).map((workspace) => workspace.id),
			['personal:user-1'],
			'workspace access is revoked with the authoritative organization membership',
		);
		const revokedSelection = await resolveWorkspaceContextForSubject(client, {
			userId: 'user-1', subject: 'subject-1', preferredWorkspaceId: 'workspace:production',
		});
		assert.equal(revokedSelection.currentWorkspace.id, 'personal:user-1');
		assert.equal(revokedSelection.preferredWorkspaceAvailable, false);
	} finally {
		database.close();
	}
});

test('D1 lazily provisions a newly projected organization Default workspace', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		migrate(database);
		database.prepare(`
			INSERT INTO organizations (id, source, name, status, source_updated_at)
			VALUES (?, 'cinaauth', ?, 'active', ?)
		`).run('org-2', 'Second Org', '2026-08-30T01:00:00.000Z');
		database.prepare(`
			INSERT INTO organization_memberships (
				organization_id, subject, user_id, roles_json, status, source_updated_at
			) VALUES (?, ?, ?, ?, 'active', ?)
		`).run('org-2', 'subject-1', 'user-1', '["member"]', '2026-08-30T01:00:00.000Z');

		const rows = await listAccessibleWorkspacesForSubject(d1Client(database), {
			userId: 'user-1', subject: 'subject-1',
		});
		assert.ok(rows.some((workspace) => workspace.id === 'organization:org-2'));
		assert.equal(
			(database.prepare('SELECT default_scope_key FROM workspaces WHERE id = ?')
				.get('organization:org-2') as { default_scope_key: string }).default_scope_key,
			'organization:org-2',
		);
		const defaultGuardrail = database.prepare(`SELECT guardrail.name,
			guardrail.is_workspace_default, version.version, version.config_json
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.workspace_id = ? AND guardrail.is_workspace_default = 1`)
			.get('organization:org-2') as Record<string, unknown>;
		assert.deepEqual({ ...defaultGuardrail }, {
			name: 'Workspace organization:org-2 Default',
			is_workspace_default: 1,
			version: 1,
			config_json: '{}',
		});
		const accountDefault = database.prepare(`SELECT guardrail.name,
			guardrail.is_account_default, guardrail.account_scope_key,
			version.version, version.config_json
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.account_scope_key = ? AND guardrail.is_account_default = 1`)
			.get('organization:org-2') as Record<string, unknown>;
		assert.deepEqual({ ...accountDefault }, {
			name: 'Account Default',
			is_account_default: 1,
			account_scope_key: 'organization:org-2',
			version: 1,
			config_json: '{}',
		});
		await listAccessibleWorkspacesForSubject(d1Client(database), {
			userId: 'user-1', subject: 'subject-1',
		});
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM guardrails
			WHERE workspace_id = ? AND is_workspace_default = 1`)
			.get('organization:org-2')?.total, 1, 'default provisioning is idempotent');
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM guardrails
			WHERE account_scope_key = ? AND is_account_default = 1`)
			.get('organization:org-2')?.total, 1, 'account default provisioning is idempotent');
	} finally {
		database.close();
	}
});

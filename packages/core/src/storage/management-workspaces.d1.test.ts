import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	normalizeManagementWorkspaceCreate,
	normalizeManagementWorkspacePatch,
	parseManagementWorkspaceSettings,
	type ManagementWorkspaceMutationPrincipal,
} from '../management-workspaces';
import { ensureDefaultWorkspacesForSubject } from './workspaces';
import type { D1DatabaseClient } from './database-client';
import {
	createManagementWorkspace,
	deleteManagementWorkspace,
	getManagementWorkspace,
	listManagementWorkspaces,
	updateManagementWorkspace,
} from './management-workspaces';
import {
	addManagementWorkspaceMembers,
	listManagementWorkspaceMembers,
	removeManagementWorkspaceMembers,
} from './management-workspace-members';

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

function client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]) {
			database.exec('BEGIN IMMEDIATE');
			try {
				const results: D1Result[] = [];
				for (const statement of statements) results.push(await statement.run());
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

function setup(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			external_system TEXT,
			external_user_id TEXT,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE organization_memberships (
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			subject TEXT NOT NULL,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			roles_json TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (organization_id, subject)
		);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			description TEXT,
			is_default INTEGER NOT NULL,
			default_scope_key TEXT UNIQUE,
			status TEXT NOT NULL,
			settings_json TEXT,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uk_workspaces_personal_slug
			ON workspaces(personal_owner_user_id, slug) WHERE personal_owner_user_id IS NOT NULL;
		CREATE UNIQUE INDEX uk_workspaces_organization_slug
			ON workspaces(organization_id, slug) WHERE organization_id IS NOT NULL;
		CREATE TABLE guardrails (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			designated_version INTEGER NOT NULL, latest_version INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
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
			created_at TEXT NOT NULL,
			UNIQUE (guardrail_id, version)
		);
		CREATE TABLE workspace_memberships (
			id TEXT PRIMARY KEY,
			membership_key TEXT NOT NULL UNIQUE,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			subject TEXT NOT NULL,
			role TEXT NOT NULL,
			status TEXT NOT NULL,
			granted_by_subject TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
			status TEXT NOT NULL
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			expires_at TEXT,
			account_type TEXT NOT NULL,
			personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
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
	const now = '2026-09-01T00:00:00.000Z';
	for (const [id, subject] of [
		['user-owner', 'subject-owner'],
		['user-admin', 'subject-admin'],
		['user-member', 'subject-member'],
		['user-outsider', 'subject-outsider'],
	]) {
		database.prepare(`INSERT INTO users (
			id, external_system, external_user_id, status, created_at, updated_at
		) VALUES (?, 'cinaauth', ?, 'active', ?, ?)`).run(id, subject, now, now);
	}
	database.prepare(`INSERT INTO organizations (id, status, created_at, updated_at)
		VALUES ('org-1', 'active', ?, ?), ('org-2', 'active', ?, ?)`)
		.run(now, now, now, now);
	database.prepare(`INSERT INTO organization_memberships (
		organization_id, subject, user_id, roles_json, status, created_at, updated_at
	) VALUES
		('org-1', 'subject-admin', 'user-admin', '["org-admin"]', 'active', ?, ?),
		('org-1', 'subject-member', 'user-member', '["member"]', 'active', ?, ?)`)
		.run(now, now, now, now);
	database.prepare(`INSERT INTO workspaces (
		id, scope_type, organization_id, personal_owner_user_id, name, slug,
		description, is_default, default_scope_key, status, settings_json,
		created_by_user_id, created_at, updated_at
	) VALUES
		('personal:user-owner', 'personal', NULL, 'user-owner', 'Default', 'default', NULL, 1,
		 'personal:user-owner', 'active', NULL, 'user-owner', ?, ?),
		('organization:org-1', 'organization', 'org-1', NULL, 'Default', 'default', NULL, 1,
		 'organization:org-1', 'active', NULL, NULL, ?, ?),
		('organization:org-2', 'organization', 'org-2', NULL, 'Default', 'default', NULL, 1,
		 'organization:org-2', 'active', NULL, NULL, ?, ?)`)
		.run(now, now, now, now, now, now);
	database.prepare(`INSERT INTO management_api_keys (
		id, status, expires_at, account_type, personal_owner_user_id, organization_id, created_by_user_id
	) VALUES
		('management-personal', 'active', NULL, 'personal', 'user-owner', NULL, 'user-owner'),
		('management-org', 'active', NULL, 'organization', NULL, 'org-1', 'user-admin')`).run();
	return database;
}

const orgPrincipal: ManagementWorkspaceMutationPrincipal = {
	keyId: 'management-org',
	createdByUserId: 'user-admin',
	account: { accountType: 'organization', personalOwnerUserId: null, organizationId: 'org-1' },
};

test('Workspace settings parsing preserves safe fields while failing corrupt legacy fields closed', () => {
	const settings = parseManagementWorkspaceSettings(JSON.stringify({
		default_text_model: 'deepseek/deepseek-chat',
		is_observability_io_logging_enabled: true,
		unknown_legacy_field: 'ignored',
	}));
	assert.equal(settings.defaultTextModel, 'deepseek/deepseek-chat');
	assert.equal(settings.isObservabilityIoLoggingEnabled, false);
});

test('D1 Workspace Management CRUD is account-scoped and protects active/default workspaces', async () => {
	const database = setup();
	try {
		const db = client(database);
		assert.deepEqual(
			(await listManagementWorkspaces(db, orgPrincipal.account, { offset: 0, limit: 50 })).data.map((row) => row.id),
			['organization:org-1'],
		);
		assert.equal(await getManagementWorkspace(db, orgPrincipal.account, 'organization:org-2'), null);

		const created = await createManagementWorkspace(db, orgPrincipal, normalizeManagementWorkspaceCreate({
			name: 'Production',
			slug: 'production',
			description: 'Primary traffic',
			default_text_model: 'deepseek/deepseek-chat',
			default_provider_sort: 'price',
		}), { id: 'workspace-production', nowIso: '2026-09-01T01:00:00.000Z' });
		assert.equal(created?.created_by, 'subject-admin');
		assert.equal(created?.settings.defaultTextModel, 'deepseek/deepseek-chat');
		assert.equal(created?.settings.isObservabilityIoLoggingEnabled, false);
		const workspaceDefault = (database.prepare(`SELECT guardrail.id, guardrail.name,
			guardrail.is_workspace_default, version.version, version.config_json
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.workspace_id = ? AND guardrail.is_workspace_default = 1`).get('workspace-production')) as Record<string, unknown>;
		assert.deepEqual({ ...workspaceDefault }, {
			id: workspaceDefault.id,
			name: 'Workspace workspace-production Default',
			is_workspace_default: 1,
			version: 1,
			config_json: '{}',
		});
		assert.equal(typeof workspaceDefault.id, 'string');

		const updated = await updateManagementWorkspace(db, orgPrincipal, 'production', normalizeManagementWorkspacePatch({
			name: 'Production EU',
			slug: 'production-eu',
			io_logging_sampling_rate: 0.25,
		}), { nowIso: '2026-09-01T02:00:00.000Z' });
		assert.equal(updated?.name, 'Production EU');
		assert.equal(updated?.settings.ioLoggingSamplingRate, 0.25);
		assert.equal(await getManagementWorkspace(db, orgPrincipal.account, 'production'), null);

		await assert.rejects(
			createManagementWorkspace(db, orgPrincipal, normalizeManagementWorkspaceCreate({
				name: 'Duplicate', slug: 'production-eu',
			}), { id: 'workspace-duplicate', nowIso: '2026-09-01T02:30:00.000Z' }),
			/Workspace slug already exists/u,
		);
		database.prepare(`INSERT INTO guardrails (
			id, workspace_id, owner_user_id, name, description, status,
			designated_version, latest_version, created_at, updated_at,
			is_workspace_default, is_account_default, account_scope_key
		) VALUES ('account-default-org-1', 'workspace-production', 'user-admin',
			'Account Default', NULL, 'active', 1, 1, ?, ?, 0, 1, 'organization:org-1')`)
			.run('2026-09-01T02:45:00.000Z', '2026-09-01T02:45:00.000Z');
		database.prepare(`INSERT INTO guardrail_versions (
			id, guardrail_id, version, config_json, created_by_user_id, created_at
		) VALUES ('account-default-org-1-v1', 'account-default-org-1', 1, '{}',
			'user-admin', '2026-09-01T02:45:00.000Z')`).run();

		database.prepare(`INSERT INTO api_keys (id, user_id, workspace_id, status)
			VALUES ('key-active', 'user-member', 'workspace-production', 'active')`).run();
		assert.equal(
			await deleteManagementWorkspace(db, orgPrincipal, 'production-eu', false),
			'active_keys',
		);
		database.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = 'key-active'`).run();
		assert.equal(
			await deleteManagementWorkspace(db, orgPrincipal, 'production-eu', false),
			'deleted',
		);
		assert.equal(await getManagementWorkspace(db, orgPrincipal.account, 'production-eu'), null);
		assert.equal(database.prepare(`SELECT workspace_id FROM guardrails
			WHERE id = 'account-default-org-1'`).get()?.workspace_id, 'organization:org-1');

		assert.equal(
			await deleteManagementWorkspace(db, orgPrincipal, 'default', false),
			'confirmation_required',
		);
		assert.equal(
			await deleteManagementWorkspace(db, orgPrincipal, 'default', true),
			'account_default_anchor',
		);
		const retainedDefault = database.prepare(`SELECT status, is_default, default_scope_key
			FROM workspaces WHERE id = 'organization:org-1'`).get() as Record<string, unknown>;
		assert.deepEqual({ ...retainedDefault }, {
			status: 'active', is_default: 1, default_scope_key: 'organization:org-1',
		});
		await ensureDefaultWorkspacesForSubject(db, { userId: 'user-admin', subject: 'subject-admin' });
		assert.equal(database.prepare(`SELECT status FROM workspaces
			WHERE id = 'organization:org-1'`).get()?.status, 'active');
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM user_audit_logs`).get()?.total, 3);
	} finally {
		database.close();
	}
});

test('D1 Workspace membership mutations project current organization roles and are atomic', async () => {
	const database = setup();
	try {
		const db = client(database);
		await createManagementWorkspace(db, orgPrincipal, normalizeManagementWorkspaceCreate({
			name: 'Production', slug: 'production',
		}), { id: 'workspace-production', nowIso: '2026-09-01T01:00:00.000Z' });

		const unknown = await addManagementWorkspaceMembers(
			db, orgPrincipal, 'production', ['subject-admin', 'subject-outsider'], new Set(['org-admin']),
		);
		assert.deepEqual(unknown, { ok: false, reason: 'unknown_members' });
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM workspace_memberships`).get()?.total, 0);

		const added = await addManagementWorkspaceMembers(
			db, orgPrincipal, 'production', ['subject-admin', 'subject-member'], new Set(['org-admin']),
			{ nowIso: '2026-09-01T02:00:00.000Z' },
		);
		assert.equal(added.ok, true);
		if (!added.ok) assert.fail(added.reason);
		assert.equal(added.changedCount, 2);
		assert.deepEqual(added.data.map((row) => [row.user_id, row.role]), [
			['subject-admin', 'admin'],
			['subject-member', 'member'],
		]);

		const listed = await listManagementWorkspaceMembers(
			db, orgPrincipal.account, 'production', { offset: 0, limit: 50 }, new Set(['org-admin']),
		);
		assert.deepEqual(listed?.data.map((row) => [row.user_id, row.role]), [
			['subject-admin', 'admin'],
			['subject-member', 'member'],
		]);
		const defaults = await listManagementWorkspaceMembers(
			db, orgPrincipal.account, 'default', { offset: 0, limit: 50 }, new Set(['org-admin']),
		);
		assert.equal(defaults?.totalCount, 2);

		database.prepare(`INSERT INTO api_keys (id, user_id, workspace_id, status)
			VALUES ('member-key', 'user-member', 'workspace-production', 'active')`).run();
		assert.deepEqual(
			await removeManagementWorkspaceMembers(
				db, orgPrincipal, 'production', ['subject-admin', 'subject-member'],
			),
			{ ok: false, reason: 'active_keys' },
		);
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM workspace_memberships
			WHERE status = 'active'`).get()?.total, 2);
		database.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = 'member-key'`).run();
		const removed = await removeManagementWorkspaceMembers(
			db, orgPrincipal, 'production', ['subject-admin', 'subject-member'],
			{ nowIso: '2026-09-01T03:00:00.000Z' },
		);
		assert.equal(removed.ok, true);
		if (!removed.ok) assert.fail(removed.reason);
		assert.equal(removed.changedCount, 2);
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM user_audit_logs
			WHERE event_type = 'workspace_members_added'`).get()?.total, 1);
		assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM user_audit_logs
			WHERE event_type = 'workspace_members_removed'`).get()?.total, 1);
		database.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = 'org-1'`).run();
		assert.deepEqual(
			await addManagementWorkspaceMembers(
				db, orgPrincipal, 'production', ['subject-member'], new Set(['org-admin']),
			),
			{ ok: false, reason: 'not_found' },
		);
		assert.deepEqual(
			await removeManagementWorkspaceMembers(db, orgPrincipal, 'default', ['subject-member']),
			{ ok: false, reason: 'default_workspace' },
		);
	} finally {
		database.close();
	}
});

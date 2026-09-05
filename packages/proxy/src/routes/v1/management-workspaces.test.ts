import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type {
	D1DatabaseClient,
	GatewayRepositories,
	ManagementApiKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';

const secret = `sk-cina-mgmt-${'d'.repeat(64)}`;
const managementRow: ManagementApiKeyRow = {
	id: 'management-org',
	key_hash: `sha256:${'d'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-dddd…dddd',
	account_type: 'organization',
	personal_owner_user_id: null,
	organization_id: 'org-1',
	name: 'Workspace automation',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-admin',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
};

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
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
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

function fixture() {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (
			id TEXT PRIMARY KEY, external_system TEXT, external_user_id TEXT,
			status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE organization_memberships (
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			subject TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			roles_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			PRIMARY KEY (organization_id, subject)
		);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY, scope_type TEXT NOT NULL,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, is_default INTEGER NOT NULL,
			default_scope_key TEXT UNIQUE, status TEXT NOT NULL, settings_json TEXT,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uk_workspaces_organization_slug ON workspaces(organization_id, slug);
		CREATE TABLE guardrails (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			is_workspace_default INTEGER NOT NULL DEFAULT 0,
			is_account_default INTEGER NOT NULL DEFAULT 0,
			account_scope_key TEXT,
			designated_version INTEGER NOT NULL, latest_version INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
			created_at TEXT NOT NULL, UNIQUE (guardrail_id, version)
		);
		CREATE TABLE workspace_memberships (
			id TEXT PRIMARY KEY, membership_key TEXT NOT NULL UNIQUE,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			subject TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
			granted_by_subject TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, status TEXT NOT NULL
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT,
			account_type TEXT NOT NULL, personal_owner_user_id TEXT,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL, event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL, change_payload TEXT, source TEXT, actor_id TEXT,
			reason_code TEXT, reason_text TEXT, created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES
			('user-admin', 'cinaauth', 'subject-admin', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('user-member', 'cinaauth', 'subject-member', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO organizations VALUES
			('org-1', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO organization_memberships VALUES
			('org-1', 'subject-admin', 'user-admin', '["org-admin"]', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('org-1', 'subject-member', 'user-member', '["member"]', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO workspaces VALUES (
			'organization:org-1', 'organization', 'org-1', NULL, 'Default', 'default', NULL, 1,
			'organization:org-1', 'active', NULL, NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
		);
		INSERT INTO management_api_keys VALUES
			('management-org', 'active', NULL, 'organization', NULL, 'org-1', 'user-admin');
		INSERT INTO guardrails VALUES (
			'guardrail-default-org-1', 'organization:org-1', 'user-admin',
			'Workspace organization:org-1 Default', NULL, 'active', 1, 0, NULL, 1, 1,
			'2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
		);
		INSERT INTO guardrail_versions VALUES (
			'guardrail-version-default-org-1', 'guardrail-default-org-1', 1, '{}',
			'user-admin', '2026-09-01T00:00:00.000Z'
		);
	`);
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
	const dbClient: D1DatabaseClient = {
		driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'],
	};
	const repositories = {
		client: dbClient,
		managementApiKeys: {
			getActiveBySecret: async (candidate: string) => candidate === secret ? managementRow : null,
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(
		async () => ({ repositories } as StorageContext),
		{ organizationAdminRoles: 'org-admin' },
	);
	return {
		database,
		request: (path: string, init?: RequestInit) => app.request(path, init, { REQUEST_BODY_LOGGING: 'off' }),
	};
}

function authorized(method = 'GET', body?: unknown): RequestInit {
	return {
		method,
		headers: {
			Authorization: `Bearer ${secret}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('Workspace Management routes implement the OpenRouter CRUD contract with bounded inputs', async () => {
	const { database, request } = fixture();
	try {
		assert.equal((await request('/api/v1/workspaces')).status, 401);
		const initial = await request('/api/v1/workspaces?offset=0&limit=50', authorized());
		assert.equal(initial.status, 200);
		assert.equal(initial.headers.get('Cache-Control'), 'private, no-store');
		assert.equal((await initial.json() as { total_count: number }).total_count, 1);

		const unsafe = await request('/api/v1/workspaces', authorized('POST', {
			name: 'Unsafe', slug: 'unsafe', is_observability_io_logging_enabled: true,
		}));
		assert.equal(unsafe.status, 400);

		const created = await request('/api/v1/workspaces', authorized('POST', {
			name: 'Production', slug: 'production', default_text_model: 'deepseek/deepseek-chat',
		}));
		assert.equal(created.status, 201);
		const createdBody = await created.json() as { data: Record<string, unknown> };
		assert.equal(createdBody.data.slug, 'production');
		assert.equal(createdBody.data.default_text_model, 'deepseek/deepseek-chat');
		assert.equal(createdBody.data.is_observability_io_logging_enabled, false);
		const workspaceId = String(createdBody.data.id);
		assert.deepEqual({ ...database.prepare(`SELECT guardrail.is_workspace_default,
			version.version, version.config_json FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			WHERE guardrail.workspace_id = ?`).get(workspaceId) }, {
			is_workspace_default: 1,
			version: 1,
			config_json: '{}',
		});

		const patched = await request('/api/v1/workspaces/production', authorized('PATCH', {
			name: 'Production EU', slug: 'production-eu',
		}));
		assert.equal(patched.status, 200);
		assert.equal((await patched.json() as { data: { slug: string } }).data.slug, 'production-eu');
		assert.equal((await request('/api/v1/workspaces?offset=-1', authorized())).status, 400);

		database.prepare(`INSERT INTO api_keys (id, user_id, workspace_id, status)
			VALUES ('active-key', 'user-member', ?, 'active')`).run(workspaceId);
		assert.equal((await request(`/api/v1/workspaces/${workspaceId}`, authorized('DELETE'))).status, 400);
		database.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = 'active-key'`).run();
		assert.equal((await request(`/api/v1/workspaces/${workspaceId}`, authorized('DELETE'))).status, 200);
		assert.equal((await request(`/api/v1/workspaces/${workspaceId}`, authorized())).status, 404);
	} finally {
		database.close();
	}
});

test('Workspace member routes project organization roles and enforce mutation protections', async () => {
	const { database, request } = fixture();
	try {
		const created = await request('/api/v1/workspaces', authorized('POST', {
			name: 'Production', slug: 'production',
		}));
		const workspaceId = String((await created.json() as { data: { id: string } }).data.id);
		const added = await request(`/api/v1/workspaces/${workspaceId}/members/add`, authorized('POST', {
			user_ids: ['subject-admin', 'subject-member'],
		}));
		assert.equal(added.status, 200);
		const addedBody = await added.json() as { added_count: number; data: Array<{ role: string }> };
		assert.equal(addedBody.added_count, 2);
		assert.deepEqual(addedBody.data.map((row) => row.role), ['admin', 'member']);

		const listed = await request(`/api/v1/workspaces/${workspaceId}/members`, authorized());
		assert.equal(listed.status, 200);
		assert.equal((await listed.json() as { total_count: number }).total_count, 2);
		assert.equal((await request(`/api/v1/workspaces/${workspaceId}/members/add`, authorized('POST', {
			user_ids: [],
		}))).status, 400);

		database.prepare(`INSERT INTO api_keys (id, user_id, workspace_id, status)
			VALUES ('active-key', 'user-member', ?, 'active')`).run(workspaceId);
		assert.equal((await request(`/api/v1/workspaces/${workspaceId}/members/remove`, authorized('POST', {
			user_ids: ['subject-member'],
		}))).status, 400);
		database.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = 'active-key'`).run();
		const removed = await request(`/api/v1/workspaces/${workspaceId}/members/remove`, authorized('POST', {
			user_ids: ['subject-member'],
		}));
		assert.equal(removed.status, 200);
		assert.deepEqual(await removed.json(), { removed_count: 1 });

		assert.equal((await request('/api/v1/workspaces/default/members/remove', authorized('POST', {
			user_ids: ['subject-member'],
		}))).status, 400);
	} finally {
		database.close();
	}
});

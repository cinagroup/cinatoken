import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type {
	D1DatabaseClient,
	GatewayRepositories,
	ManagementApiKeyRow,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';

const managementSecret = `sk-cina-mgmt-${'f'.repeat(64)}`;
const gatewaySecret = 'sk-gateway-guardrail-test';
const managementRow: ManagementApiKeyRow = {
	id: 'management-org',
	key_hash: `sha256:${'f'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-ffff…ffff',
	account_type: 'organization',
	personal_owner_user_id: null,
	organization_id: 'org-1',
	name: 'Guardrail automation',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-admin',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
};

const gatewayRow: ResolvedGatewayKeyRow = {
	id: 'gateway-key',
	key: gatewaySecret,
	user_id: 'user-admin',
	workspace_id: 'organization:org-1',
	name: 'Ordinary key',
	status: 'active',
	metadata: null,
	last_used_at: null,
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
	user_email: 'admin@example.com',
	user_metadata: null,
	user_charged_cost_factors: null,
	budget_max: null,
	budget_base: 0,
	budget_spent: 0,
	budget_period: 'none',
	budget_reset_at: null,
	budget_epoch: 0,
	budget_reserved_micros: 0,
	limit_type: 'none',
	limit_value: null,
	limit_consumed: 0,
	limit_reset_at: null,
	limit_epoch: 0,
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
			id TEXT PRIMARY KEY, external_user_id TEXT, status TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY, status TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE organization_memberships (
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			subject TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			status TEXT NOT NULL, PRIMARY KEY (organization_id, subject)
		);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY, scope_type TEXT NOT NULL,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
			is_default INTEGER NOT NULL, default_scope_key TEXT UNIQUE,
			status TEXT NOT NULL, settings_json TEXT,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
			key_hash TEXT, key_preview TEXT, name TEXT, status TEXT NOT NULL
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT,
			account_type TEXT NOT NULL, personal_owner_user_id TEXT,
			organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
		);
		CREATE TABLE guardrails (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			is_workspace_default INTEGER NOT NULL DEFAULT 0,
			is_account_default INTEGER NOT NULL DEFAULT 0,
			account_scope_key TEXT,
			designated_version INTEGER NOT NULL, latest_version INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE (id, workspace_id)
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
		CREATE TABLE guardrail_assignments (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			guardrail_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
			created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			management_source TEXT,
			assigned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (guardrail_id, workspace_id) REFERENCES guardrails(id, workspace_id) ON DELETE CASCADE,
			UNIQUE (workspace_id, scope_type, scope_id)
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
			event_type TEXT NOT NULL, actor_type TEXT NOT NULL, change_payload TEXT,
			source TEXT, actor_id TEXT, reason_code TEXT, reason_text TEXT,
			created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES
			('user-admin', 'subject-admin', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('user-member', 'subject-member', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('user-foreign', 'subject-foreign', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO organizations VALUES
			('org-1', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('org-2', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO workspaces VALUES
			('organization:org-1', 'organization', 'org-1', NULL, 'Default', 'default', NULL, 1,
			 'organization:org-1', 'active', NULL, 'user-admin', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('organization:org-2', 'organization', 'org-2', NULL, 'Foreign', 'default', NULL, 1,
			 'organization:org-2', 'active', NULL, NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO management_api_keys VALUES
			('management-org', 'active', NULL, 'organization', NULL, 'org-1', 'user-admin');
		INSERT INTO organization_memberships VALUES
			('org-1', 'subject-admin', 'user-admin', 'active'),
			('org-1', 'subject-member', 'user-member', 'active'),
			('org-2', 'subject-foreign', 'user-foreign', 'active');
		INSERT INTO api_keys VALUES
			('key-local', 'user-member', 'organization:org-1', 'sha256:${'1'.repeat(64)}', 'sk-cina-1111…1111', 'Production Key', 'active'),
			('key-foreign', 'user-foreign', 'organization:org-2', 'sha256:${'2'.repeat(64)}', 'sk-cina-2222…2222', 'Foreign Key', 'active');
		INSERT INTO guardrails VALUES
			('guardrail-account-default-org-1', 'organization:org-1', 'user-admin',
			 'Account Default', NULL, 'active', 0, 1, 'organization:org-1', 1, 1,
			 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('guardrail-workspace-default-org-1', 'organization:org-1', 'user-admin',
			 'Workspace organization:org-1 Default', NULL, 'active', 1, 0, NULL, 1, 1,
			 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('guardrail-workspace-default-org-2', 'organization:org-2', 'user-foreign',
			 'Workspace organization:org-2 Default', NULL, 'active', 1, 0, NULL, 1, 1,
			 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO guardrail_versions VALUES
			('guardrail-version-account-default-org-1', 'guardrail-account-default-org-1', 1, '{}',
			 'user-admin', '2026-09-01T00:00:00.000Z'),
			('guardrail-version-default-org-1', 'guardrail-workspace-default-org-1', 1, '{}',
			 'user-admin', '2026-09-01T00:00:00.000Z'),
			('guardrail-version-default-org-2', 'guardrail-workspace-default-org-2', 1, '{}',
			 'user-foreign', '2026-09-01T00:00:00.000Z');
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
			getActiveBySecret: async (candidate: string) => candidate === managementSecret ? managementRow : null,
		},
		apiKeys: {
			getApiKeyWithUserByKey: async (candidate: string) => candidate === gatewaySecret ? gatewayRow : null,
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories } as StorageContext));
	return {
		database,
		request: (path: string, init?: RequestInit) => app.request(path, init, { REQUEST_BODY_LOGGING: 'off' }),
	};
}

function authorized(method = 'GET', body?: unknown, secret = managementSecret): RequestInit {
	return {
		method,
		headers: {
			Authorization: `Bearer ${secret}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('Guardrail Management routes implement isolated CRUD and reject unenforced policy fields', async () => {
	const { database, request } = fixture();
	try {
		assert.equal((await request('/api/v1/guardrails')).status, 401);
		assert.equal((await request('/api/v1/guardrails', authorized('GET', undefined, gatewaySecret))).status, 403);
		assert.equal((await request('/api/v1/guardrails?workspace_id=organization:org-2', authorized())).status, 404);

		const initial = await request('/api/v1/guardrails?offset=0&limit=50', authorized());
		assert.equal(initial.status, 200);
		assert.equal(initial.headers.get('Cache-Control'), 'private, no-store');
		const initialBody = await initial.json() as { data: Array<Record<string, unknown>>; total_count: number };
		assert.equal(initialBody.total_count, 2);
		assert.ok(initialBody.data.some((row) => row.id === 'guardrail-workspace-default-org-1'
			&& row.name === 'Workspace organization:org-1 Default'));
		assert.ok(initialBody.data.some((row) => row.id === 'guardrail-account-default-org-1'
			&& row.is_account_default === true && row.account_scope_key === 'organization:org-1'));
		database.prepare(`INSERT INTO workspaces (
			id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
			is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
		) VALUES (?, 'organization', 'org-1', NULL, 'Production', 'production', NULL,
			0, NULL, 'active', NULL, 'user-admin', ?, ?)`)
			.run('workspace-org-1-production', '2026-09-01T00:30:00.000Z', '2026-09-01T00:30:00.000Z');
		const inherited = await request(
			'/api/v1/guardrails?workspace_id=workspace-org-1-production', authorized(),
		);
		assert.equal(inherited.status, 200, await inherited.clone().text());
		const inheritedBody = await inherited.json() as { data: Array<Record<string, unknown>>; total_count: number };
		assert.equal(inheritedBody.total_count, 1);
		assert.equal(inheritedBody.data[0]?.id, 'guardrail-account-default-org-1');

		const accountPatched = await request('/api/v1/guardrails/guardrail-account-default-org-1',
			authorized('PATCH', { allowed_providers: ['DeepSeek'], data_collection: 'deny' }));
		assert.equal(accountPatched.status, 200, await accountPatched.clone().text());
		const accountPatchedBody = await accountPatched.json() as { data: Record<string, unknown> };
		assert.equal(accountPatchedBody.data.data_collection, 'deny');
		assert.equal(accountPatchedBody.data.is_account_default, true);
		assert.equal((await request('/api/v1/guardrails/guardrail-account-default-org-1',
			authorized('PATCH', { limit_usd: 25, reset_interval: 'monthly' }))).status, 400);
		assert.equal((await request('/api/v1/guardrails/guardrail-account-default-org-1',
			authorized('PATCH', { name: 'Renamed account default' }))).status, 400);
		assert.equal((await request('/api/v1/guardrails/guardrail-account-default-org-1',
			authorized('DELETE'))).status, 404);

		const defaultPatched = await request('/api/v1/guardrails/guardrail-workspace-default-org-1',
			authorized('PATCH', { allowed_models: ['deepseek/deepseek-chat'], limit_usd: 25, reset_interval: 'monthly' }));
		assert.equal(defaultPatched.status, 200, await defaultPatched.clone().text());
		assert.equal((await defaultPatched.json() as { data: Record<string, unknown> }).data.limit_usd, 25);
		assert.equal((await request('/api/v1/guardrails/guardrail-workspace-default-org-1',
			authorized('PATCH', { name: 'Renamed default' }))).status, 400);
		assert.equal((await request('/api/v1/guardrails/guardrail-workspace-default-org-1',
			authorized('DELETE'))).status, 404);

		for (const body of [
			{ name: 'Built-in', content_filter_builtins: [{ id: 'ssn', action: 'block' }] },
			{ name: 'Unavailable NLP', content_filter_builtins: [{ slug: 'person-name', action: 'redact' }] },
			{ name: 'Invalid PII action', content_filter_builtins: [{ slug: 'email', action: 'flag' }] },
			{ name: 'Invalid secrets action', content_filter_builtins: [{ slug: 'secrets', action: 'flag' }] },
			{ name: 'BYOK', include_byok_in_budgets: true },
			{ name: 'Training', enable_paid_model_training: false },
			{ name: 'Null workspace', workspace_id: null },
		]) {
			assert.equal((await request('/api/v1/guardrails', authorized('POST', body))).status, 400);
		}

		const created = await request('/api/v1/guardrails', authorized('POST', {
			name: 'Production safety',
			description: 'Bound to production traffic',
			allowed_models: ['deepseek/deepseek-chat', 'openai/gpt-5'],
			ignored_models: ['openai/gpt-5'],
			ignored_providers: ['unsafe-provider'],
			content_filters: [{ pattern: 'sk-[A-Za-z0-9]{8,64}', action: 'redact', label: '[API_KEY]' }],
			content_filter_builtins: [
				{ slug: 'secrets', action: 'block' },
				{ slug: 'email', action: 'redact' },
				{ slug: 'regex-prompt-injection', action: 'flag' },
			],
			enforce_zdr: true,
			limit_usd: 50,
			reset_interval: 'monthly',
		}));
		assert.equal(created.status, 201, await created.clone().text());
		const createdBody = await created.json() as { data: Record<string, unknown> };
		assert.equal(createdBody.data.name, 'Production safety');
		assert.equal(createdBody.data.workspace_id, 'organization:org-1');
		assert.equal(createdBody.data.enforce_zdr_openai, true);
		assert.equal(createdBody.data.include_byok_in_budgets, false);
		assert.deepEqual(createdBody.data.content_filter_builtins, [
			{ slug: 'secrets', action: 'block' },
			{ slug: 'email', action: 'redact' },
			{ slug: 'regex-prompt-injection', action: 'flag' },
		]);
		assert.equal(createdBody.data.updated_at, null);
		const id = String(createdBody.data.id);

		const fetched = await request(`/api/v1/guardrails/${id}`, authorized());
		assert.equal(fetched.status, 200);
		const listed = await request('/api/v1/guardrails', authorized());
		assert.equal((await listed.json() as { total_count: number }).total_count, 3);

		const patched = await request(`/api/v1/guardrails/${id}`, authorized('PATCH', {
			name: 'Production safety v2',
			limit_usd: null,
			reset_interval: null,
		}));
		assert.equal(patched.status, 200);
		const patchedBody = await patched.json() as { data: Record<string, unknown> };
		assert.equal(patchedBody.data.name, 'Production safety v2');
		assert.equal(patchedBody.data.limit_usd, null);
		assert.equal(database.prepare('SELECT COUNT(*) AS total FROM guardrail_versions WHERE guardrail_id = ?').get(id)?.total, 2);

		const deleted = await request(`/api/v1/guardrails/${id}`, authorized('DELETE'));
		assert.equal(deleted.status, 200);
		assert.deepEqual(await deleted.json(), { deleted: true });
		assert.equal((await request(`/api/v1/guardrails/${id}`, authorized())).status, 404);
		assert.deepEqual(
			database.prepare('SELECT event_type FROM user_audit_logs ORDER BY created_at, rowid').all().map((row) => row.event_type),
			['guardrail_updated', 'guardrail_updated', 'guardrail_created', 'guardrail_updated', 'guardrail_deleted'],
		);
	} finally {
		database.close();
	}
});

test('Guardrail Management routes validate pagination, workspace references, and body bounds', async () => {
	const { database, request } = fixture();
	try {
		assert.equal((await request('/api/v1/guardrails?offset=-1', authorized())).status, 400);
		assert.equal((await request('/api/v1/guardrails?limit=101', authorized())).status, 400);
		assert.equal((await request('/api/v1/guardrails?workspace_id=', authorized())).status, 400);
		const oversized = 'x'.repeat(96 * 1024 + 1);
		assert.equal((await request('/api/v1/guardrails', authorized('POST', { name: oversized }))).status, 413);
	} finally {
		database.close();
	}
});

test('Guardrail Management assignment routes isolate accounts and replace bindings atomically', async () => {
	const { database, request } = fixture();
	try {
		const create = async (name: string) => {
			const response = await request('/api/v1/guardrails', authorized('POST', { name }));
			assert.equal(response.status, 201);
			return String((await response.json() as { data: { id: string } }).data.id);
		};
		const firstId = await create('First assignment target');
		const secondId = await create('Second assignment target');
		const localHash = '1'.repeat(64);
		const foreignHash = '2'.repeat(64);
		const unknownHash = '3'.repeat(64);
		assert.equal((await request('/api/v1/guardrails/guardrail-workspace-default-org-1/assignments/keys',
			authorized('POST', { key_hashes: [localHash] }))).status, 404);
		assert.equal((await request('/api/v1/guardrails/guardrail-workspace-default-org-1/assignments/members',
			authorized('POST', { member_user_ids: ['subject-member'] }))).status, 404);
		assert.equal((await request('/api/v1/guardrails/guardrail-account-default-org-1/assignments/keys',
			authorized('POST', { key_hashes: [localHash] }))).status, 404);

		const keyAssign = await request(`/api/v1/guardrails/${firstId}/assignments/keys`,
			authorized('POST', { key_hashes: [localHash, foreignHash, unknownHash] }));
		assert.equal(keyAssign.status, 200);
		assert.deepEqual(await keyAssign.json(), { assigned_count: 1 });
		const firstAssignmentId = String(database.prepare(
			`SELECT id FROM guardrail_assignments WHERE scope_type = 'api_key' AND scope_id = 'key-local'`
		).get()?.id);

		const keyList = await request('/api/v1/guardrails/assignments/keys', authorized());
		assert.equal(keyList.status, 200);
		const keyListBody = await keyList.json() as {
			data: Array<Record<string, unknown>>;
			total_count: number;
		};
		assert.equal(keyListBody.total_count, 1);
		assert.deepEqual({ ...keyListBody.data[0], created_at: undefined }, {
			id: firstAssignmentId,
			guardrail_id: firstId,
			key_hash: localHash,
			key_label: 'sk-cina-1111…1111',
			key_name: 'Production Key',
			assigned_by: 'subject-admin',
			created_at: undefined,
		});
		assert.match(String(keyListBody.data[0]?.created_at), /^2026-/u);

		const replacement = await request(`/api/v1/guardrails/${secondId}/assignments/keys`,
			authorized('POST', { key_hashes: [localHash, localHash.toUpperCase()] }));
		assert.equal(replacement.status, 200);
		assert.deepEqual(await replacement.json(), { assigned_count: 1 });
		const replaced = database.prepare(
			`SELECT id, guardrail_id, management_source, assigned_by_user_id, created_by_user_id
			 FROM guardrail_assignments WHERE scope_type = 'api_key' AND scope_id = 'key-local'`
		).get();
		assert.equal(replaced?.id, firstAssignmentId);
		assert.equal(replaced?.guardrail_id, secondId);
		assert.equal(replaced?.management_source, 'management_api');
		assert.equal(replaced?.assigned_by_user_id, 'user-admin');
		assert.equal(replaced?.created_by_user_id, null);
		assert.deepEqual(await (await request(`/api/v1/guardrails/${firstId}/assignments/keys`, authorized())).json(),
			{ data: [], total_count: 0 });

		const memberAssign = await request(`/api/v1/guardrails/${firstId}/assignments/members`,
			authorized('POST', { member_user_ids: ['subject-member', 'subject-foreign', 'missing'] }));
		assert.equal(memberAssign.status, 200);
		assert.deepEqual(await memberAssign.json(), { assigned_count: 1 });
		const members = await request('/api/v1/guardrails/assignments/members', authorized());
		assert.equal(members.status, 200);
		const membersBody = await members.json() as { data: Array<Record<string, unknown>>; total_count: number };
		assert.equal(membersBody.total_count, 1);
		assert.equal(membersBody.data[0]?.organization_id, 'org-1');
		assert.equal(membersBody.data[0]?.user_id, 'subject-member');
		assert.equal(membersBody.data[0]?.assigned_by, 'subject-admin');

		assert.deepEqual(await (await request(`/api/v1/guardrails/${firstId}/assignments/keys/remove`,
			authorized('POST', { key_hashes: [localHash] }))).json(), { unassigned_count: 0 });
		assert.deepEqual(await (await request(`/api/v1/guardrails/${secondId}/assignments/keys/remove`,
			authorized('POST', { key_hashes: [localHash] }))).json(), { unassigned_count: 1 });
		assert.deepEqual(await (await request(`/api/v1/guardrails/${firstId}/assignments/members/remove`,
			authorized('POST', { member_user_ids: ['subject-member'] }))).json(), { unassigned_count: 1 });
		assert.equal((await request(`/api/v1/guardrails/${firstId}/assignments/keys`,
			authorized('POST', { key_hashes: ['invalid'] }))).status, 400);
		assert.equal((await request(`/api/v1/guardrails/missing/assignments/keys`, authorized())).status, 404);

		const assignmentAudits = database.prepare(`SELECT event_type, change_payload FROM user_audit_logs
			WHERE event_type LIKE 'guardrail_%_assignments_updated' ORDER BY rowid`).all();
		assert.equal(assignmentAudits.length, 5);
		assert.deepEqual(assignmentAudits.map((row) => row.event_type), [
			'guardrail_key_assignments_updated',
			'guardrail_key_assignments_updated',
			'guardrail_member_assignments_updated',
			'guardrail_key_assignments_updated',
			'guardrail_member_assignments_updated',
		]);
		for (const row of assignmentAudits) {
			assert.equal((JSON.parse(String(row.change_payload)) as { affected_count: number }).affected_count, 1);
		}
	} finally {
		database.close();
	}
});

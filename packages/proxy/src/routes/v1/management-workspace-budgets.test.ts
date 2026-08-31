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

const managementSecret = `sk-cina-mgmt-${'c'.repeat(64)}`;
const managementRow: ManagementApiKeyRow = {
	id: 'management-workspace-budget',
	key_hash: `sha256:${'c'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-cccc…cccc',
	account_type: 'personal',
	personal_owner_user_id: 'user-1',
	organization_id: null,
	name: 'Budget automation',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-1',
	created_at: '2026-08-31T00:00:00.000Z',
	updated_at: '2026-08-31T00:00:00.000Z',
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
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as D1Result;
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
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			personal_owner_user_id TEXT,
			organization_id TEXT,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE workspace_budgets (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			reset_interval TEXT NOT NULL,
			limit_micros INTEGER NOT NULL,
			config_epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (workspace_id, reset_interval)
		);
		INSERT INTO workspaces VALUES (
			'workspace-1', 'personal', 'user-1', NULL, 'Production', 'production', 'active',
			'2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'
		);
		INSERT INTO workspaces VALUES (
			'workspace-foreign', 'personal', 'user-2', NULL, 'Foreign', 'foreign', 'active',
			'2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'
		);
	`);
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
	const repositories = {
		client,
		managementApiKeys: {
			getActiveBySecret: async (secret: string) => secret === managementSecret ? managementRow : null,
			workspaceBelongsToAccount: async (workspaceId: string) => workspaceId === 'workspace-1',
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories } as StorageContext));
	return (path: string, init?: RequestInit) => app.request(path, init, { REQUEST_BODY_LOGGING: 'off' });
}

function requestWithKey(method = 'GET', body?: unknown): RequestInit {
	return {
		method,
		headers: {
			Authorization: `Bearer ${managementSecret}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('Management API configures strictly ordered Workspace budgets by slug or id', async () => {
	const request = fixture();
	assert.equal((await request('/api/v1/workspaces/production/budgets')).status, 401);

	const daily = await request('/api/v1/workspaces/production/budgets/daily', requestWithKey('PUT', { limit_usd: 10 }));
	assert.equal(daily.status, 200);
	const dailyBody = await daily.json() as { data: Record<string, unknown> };
	assert.equal(dailyBody.data.workspace_id, 'workspace-1');
	assert.equal(dailyBody.data.limit_usd, 10);
	assert.equal(dailyBody.data.reset_interval, 'daily');
	assert.equal('config_epoch' in dailyBody.data, false);

	assert.equal((await request('/api/v1/workspaces/workspace-1/budgets/monthly', requestWithKey('PUT', { limit_usd: 100 }))).status, 200);
	const invalidOrder = await request('/api/v1/workspaces/workspace-1/budgets/weekly', requestWithKey('PUT', { limit_usd: 5 }));
	assert.equal(invalidOrder.status, 400);

	const listed = await request('/api/v1/workspaces/workspace-1/budgets', requestWithKey());
	assert.equal(listed.status, 200);
	assert.equal(listed.headers.get('Cache-Control'), 'private, no-store');
	const listedBody = await listed.json() as { data: Array<Record<string, unknown>> };
	assert.deepEqual(listedBody.data.map((row) => row.reset_interval), ['daily', 'monthly']);
	assert.equal((await request('/api/v1/workspaces/foreign/budgets', requestWithKey())).status, 404);
});

test('Management API Workspace budget deletion is idempotent', async () => {
	const request = fixture();
	await request('/api/v1/workspaces/workspace-1/budgets/daily', requestWithKey('PUT', { limit_usd: 10 }));
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await request('/api/v1/workspaces/workspace-1/budgets/daily', requestWithKey('DELETE'));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { deleted: true });
	}
});

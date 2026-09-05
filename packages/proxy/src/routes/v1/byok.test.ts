import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from '@cloudflare/workers-types';
import {
	createByokKeysRepository,
	createD1DatabaseClient,
	createEncryptedByokKeysRepository,
	type GatewayRepositories,
	type ManagementApiKeyRow,
	type StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';

const secret = `sk-cina-mgmt-${'d'.repeat(64)}`;
const gatewayKeyHash = 'a'.repeat(64);
const encryptionSecret = 'route-byok-encryption-secret-that-is-long-enough';
const managementRow: ManagementApiKeyRow = {
	id: 'management-1',
	key_hash: `sha256:${'d'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-dddd...dddd',
	account_type: 'personal',
	personal_owner_user_id: 'user-1',
	organization_id: null,
	name: 'BYOK automation',
	status: 'active',
	expires_at: null,
	last_used_at: null,
	created_by_user_id: 'user-1',
	created_at: '2026-09-03T00:00:00.000Z',
	updated_at: '2026-09-03T00:00:00.000Z',
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
		CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE organizations (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, organization_id TEXT,
			personal_owner_user_id TEXT, status TEXT NOT NULL
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT,
			account_type TEXT NOT NULL, personal_owner_user_id TEXT,
			organization_id TEXT, created_by_user_id TEXT
		);
		CREATE TABLE api_keys (id TEXT PRIMARY KEY);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL, change_payload TEXT, source TEXT, actor_id TEXT,
			reason_code TEXT, reason_text TEXT, created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES ('user-1', 'active');
		INSERT INTO workspaces VALUES ('personal:user-1', 'personal', NULL, 'user-1', 'active');
		INSERT INTO workspaces VALUES ('workspace-secondary', 'personal', NULL, 'user-1', 'active');
		INSERT INTO management_api_keys VALUES
			('management-1', 'active', NULL, 'personal', 'user-1', NULL, 'user-1');
	`);
	database.exec(readFileSync(
		new URL('../../../../core/migrations-d1/0064_private_byok.sql', import.meta.url),
		'utf8',
	));
	database.exec(readFileSync(
		new URL('../../../../core/migrations-d1/0065_byok_always_use_for_provider.sql', import.meta.url),
		'utf8',
	));
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
	const client = createD1DatabaseClient(raw);
	const byokKeys = createEncryptedByokKeysRepository(
		createByokKeysRepository(client),
		encryptionSecret,
	);
	const repositories = {
		client,
		byokKeys,
		managementApiKeys: {
			getActiveBySecret: async (candidate: string) => candidate === secret ? managementRow : null,
			workspaceBelongsToAccount: async (workspaceId: string) =>
				workspaceId === 'personal:user-1' || workspaceId === 'workspace-secondary',
		},
		apiKeys: {
			getByHashForManagement: async ({ keyHash }: { keyHash: string }) =>
				keyHash === `sha256:${gatewayKeyHash}` ? { id: 'gateway-1' } : null,
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ client, repositories } as StorageContext));
	return {
		database,
		request: (path: string, init?: RequestInit) => app.request(path, init, {
			REQUEST_BODY_LOGGING: 'off',
		}),
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

test('BYOK Management routes keep credentials write-only across CRUD', async () => {
	const { database, request } = fixture();
	try {
		assert.equal((await request('/api/v1/byok')).status, 401);
		const created = await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek',
			key: 'deepseek-production-secret',
			name: 'Production',
			allowed_models: ['deepseek/deepseek-chat'],
			allowed_user_ids: ['user-1'],
			allowed_api_key_hashes: [gatewayKeyHash],
			always_use_for_provider: true,
		}));
		assert.equal(created.status, 201);
		assert.equal(created.headers.get('Cache-Control'), 'private, no-store');
		const createdText = await created.text();
		assert.equal(createdText.includes('deepseek-production-secret'), false);
		const createdBody = JSON.parse(createdText) as {
			data: {
				id: string;
				label: string;
				always_use_for_provider: boolean;
				always_use_for_matching_models: boolean;
			};
		};
		assert.match(createdBody.data.id, /^[0-9a-f-]{36}$/u);
		assert.equal(createdBody.data.label, '...cret');
		assert.equal(createdBody.data.always_use_for_provider, true);
		assert.equal(createdBody.data.always_use_for_matching_models, false);

		const matchingPolicy = await request('/api/v1/byok', authorized('POST', {
			provider: 'openai',
			key: 'openai-matching-secret',
			allowed_models: ['openai/gpt-5-mini'],
			always_use_for_matching_models: true,
		}));
		assert.equal(matchingPolicy.status, 201);
		const matchingPolicyBody = await matchingPolicy.json() as {
			data: { id: string; always_use_for_matching_models: boolean };
		};
		assert.equal(matchingPolicyBody.data.always_use_for_matching_models, true);
		assert.equal((await request(
			`/api/v1/byok/${matchingPolicyBody.data.id}`,
			authorized('DELETE'),
		)).status, 200);

		const stored = database.prepare(
			'SELECT api_key_encrypted FROM byok_keys WHERE id = ?',
		).get(createdBody.data.id) as { api_key_encrypted: string };
		assert.match(stored.api_key_encrypted, /^enc:v2:/u);
		assert.equal(stored.api_key_encrypted.includes('deepseek-production-secret'), false);

		const listed = await request(
			'/api/v1/byok?provider=deepseek&workspace_id=personal%3Auser-1&limit=50&offset=0',
			authorized(),
		);
		assert.equal(listed.status, 200);
		const listBody = await listed.json() as { data: Array<Record<string, unknown>>; total_count: number };
		assert.equal(listBody.total_count, 1);
		assert.equal('key' in listBody.data[0]!, false);

		const fallback = await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek',
			key: 'deepseek-fallback-secret',
			name: 'Fallback',
			is_fallback: true,
		}));
		assert.equal(fallback.status, 201);
		const fallbackBody = await fallback.json() as { data: { id: string } };
		const reorderBody = {
			provider: 'deepseek',
			keys: [
				{ id: fallbackBody.data.id, is_fallback: false },
				{ id: createdBody.data.id, is_fallback: true },
			],
		};
		const alwaysUseConflict = await request(
			'/api/v1/byok/reorder',
			authorized('POST', reorderBody),
		);
		assert.equal(alwaysUseConflict.status, 409, await alwaysUseConflict.text());
		const clearedAlwaysUse = await request(
			`/api/v1/byok/${createdBody.data.id}`,
			authorized('PATCH', { always_use_for_provider: false }),
		);
		assert.equal(clearedAlwaysUse.status, 200);
		const reordered = await request('/api/v1/byok/reorder', authorized('POST', reorderBody));
		assert.equal(reordered.status, 200);
		assert.deepEqual((await reordered.json() as {
			data: { keys: Array<{ id: string; is_fallback: boolean; sort_order: number }> };
		}).data.keys, [
			{ id: fallbackBody.data.id, is_fallback: false, sort_order: 0 },
			{ id: createdBody.data.id, is_fallback: true, sort_order: 1 },
		]);
		const staleReorder = await request('/api/v1/byok/reorder', authorized('POST', {
			provider: 'deepseek',
			keys: [{ id: createdBody.data.id, is_fallback: false }],
		}));
		assert.equal(staleReorder.status, 409, await staleReorder.text());
		assert.deepEqual(database.prepare(
			`SELECT id, is_fallback, sort_order FROM byok_keys
			WHERE workspace_id = 'personal:user-1' AND provider = 'deepseek'
			ORDER BY sort_order`,
		).all().map((row) => ({ ...row })), [
			{ id: fallbackBody.data.id, is_fallback: 0, sort_order: 0 },
			{ id: createdBody.data.id, is_fallback: 1, sort_order: 1 },
		]);
		assert.equal((await request(
			`/api/v1/byok/${createdBody.data.id}`,
			authorized('PATCH', { always_use_for_provider: true }),
		)).status, 400);

		const secondary = await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek',
			key: 'deepseek-secondary-secret',
			workspace_id: 'workspace-secondary',
		}));
		assert.equal(secondary.status, 201);
		const defaultList = await request('/api/v1/byok', authorized());
		assert.equal(defaultList.status, 200);
		assert.equal((await defaultList.json() as { total_count: number }).total_count, 2);
		const secondaryList = await request(
			'/api/v1/byok?workspace_id=workspace-secondary',
			authorized(),
		);
		assert.equal(secondaryList.status, 200);
		assert.equal((await secondaryList.json() as { total_count: number }).total_count, 1);
		assert.equal(
			(await request('/api/v1/byok?workspace_id=foreign', authorized())).status,
			404,
		);

		const patched = await request(`/api/v1/byok/${createdBody.data.id}`, authorized('PATCH', {
			key: 'deepseek-rotated-secret',
			disabled: true,
			allowed_models: null,
		}));
		assert.equal(patched.status, 200);
		const patchText = await patched.text();
		assert.equal(patchText.includes('deepseek-rotated-secret'), false);
		assert.equal((JSON.parse(patchText) as { data: { disabled: boolean } }).data.disabled, true);

		assert.equal((await request(`/api/v1/byok/${createdBody.data.id}`, authorized())).status, 200);
		assert.equal((await request(`/api/v1/byok/${createdBody.data.id}`, authorized('DELETE'))).status, 200);
		const deletedRow = database.prepare(
			'SELECT api_key_encrypted, deleted_at FROM byok_keys WHERE id = ?',
		).get(createdBody.data.id) as { api_key_encrypted: string; deleted_at: string | null };
		assert.equal(deletedRow.api_key_encrypted, '');
		assert.ok(deletedRow.deleted_at);
		assert.equal((await request(`/api/v1/byok/${createdBody.data.id}`, authorized())).status, 404);
	} finally {
		database.close();
	}
});

test('BYOK Management routes reject malformed, foreign, and oversized inputs', async () => {
	const { database, request } = fixture();
	try {
		assert.equal((await request('/api/v1/byok?limit=101', authorized())).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'DeepSeek', key: 'secret',
		}))).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek', key: 'secret', allowed_api_key_hashes: ['b'.repeat(64)],
		}))).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek', key: 'secret', unexpected: true,
		}))).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek', key: 'secret', is_fallback: true,
			always_use_for_provider: true,
		}))).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek', key: 'secret', is_fallback: true,
			always_use_for_matching_models: true,
		}))).status, 400);
		assert.equal((await request('/api/v1/byok', authorized('POST', {
			provider: 'deepseek', key: 'secret',
			always_use_for_provider: true,
			always_use_for_matching_models: true,
		}))).status, 400);
		assert.equal((await request('/api/v1/byok/reorder', authorized('POST', {
			provider: 'deepseek',
			keys: [
				{ id: '11111111-1111-4111-8111-111111111111', is_fallback: true },
				{ id: '22222222-2222-4222-8222-222222222222', is_fallback: false },
			],
		}))).status, 400);
		assert.equal((await request('/api/v1/byok/reorder', authorized('POST', {
			workspace_id: 'foreign',
			provider: 'deepseek',
			keys: [{ id: '11111111-1111-4111-8111-111111111111', is_fallback: false }],
		}))).status, 404);
		const oversized = await request('/api/v1/byok', {
			...authorized('POST'),
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ provider: 'deepseek', key: 'x'.repeat(193 * 1024) }),
		});
		assert.equal(oversized.status, 413);
	} finally {
		database.close();
	}
});

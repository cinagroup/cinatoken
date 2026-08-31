import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { AdminApiKeyRow } from './admin-access-types';
import type {
	D1DatabaseClient,
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from '../storage/database-client';
import { createD1AdminAccessRepository } from './d1/admin-access.impl';
import { createMySqlAdminAccessRepository } from './mysql/admin-access.impl';
import { createPostgresAdminAccessRepository } from './postgres/admin-access.impl';
import { hashLookupKey } from '../lib/key-hash';

const ORIGINAL_KEY = `sk-admin-${'1'.repeat(64)}`;
const ROTATED_KEY = `sk-admin-${'2'.repeat(64)}`;
const REPLACEMENT_KEY = `sk-admin-${'3'.repeat(64)}`;

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

function createD1Harness() {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE admin_api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			secret_key TEXT NOT NULL UNIQUE,
			secret_key_hash TEXT,
			key_prefix TEXT NOT NULL,
			permissions_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			last_used_at TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			revoked_at TEXT
		);
	`);
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
	const client = {
		driver: 'd1',
		raw,
		drizzle: {} as D1DatabaseClient['drizzle'],
	} satisfies D1DatabaseClient;
	return { database, repository: createD1AdminAccessRepository(client) };
}

const ACTIVE_ROW: AdminApiKeyRow = {
	id: 'admin-key-1',
	name: 'automation',
	description: null,
	secretKey: ORIGINAL_KEY,
	keyPrefix: ORIGINAL_KEY.slice(0, 12),
	permissionsJson: '["routes.read"]',
	status: 'active',
	lastUsedAt: null,
	createdAt: '2026-08-31T00:00:00.000Z',
	updatedAt: '2026-08-31T00:00:00.000Z',
	revokedAt: null,
};

function createDrizzleMutationProbe(selectResults?: AdminApiKeyRow[][]) {
	const writes: Array<Record<string, unknown>> = [];
	let selectIndex = 0;
	const drizzle = {
		select() {
			return {
				from(_table: unknown) {
					return {
						where(_condition: unknown) {
							return {
								limit: async (_limit: number) => selectResults
									? (selectResults[selectIndex++] ?? [])
									: [ACTIVE_ROW],
							};
						},
					};
				},
			};
		},
		update(_table: unknown) {
			return {
				set(values: Record<string, unknown>) {
					writes.push(values);
					return {
						where(_condition: unknown) {
							return { returning: async (_selection: unknown) => [{ id: ACTIVE_ROW.id }] };
						},
					};
				},
			};
		},
	};
	return { drizzle, writes };
}

describe('Admin API key mutation hash invariants', () => {
	it('D1 creates correctly mapped rows and invalidates replaced secrets immediately', async () => {
		const { database, repository } = createD1Harness();
		await repository.insertApiKey({
			id: ACTIVE_ROW.id,
			name: ACTIVE_ROW.name,
			description: 'integration key',
			secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12),
			permissionsJson: ACTIVE_ROW.permissionsJson,
		});

		const inserted = database.prepare(`SELECT key_prefix, permissions_json, secret_key_hash
			FROM admin_api_keys WHERE id = ?`).get(ACTIVE_ROW.id) as {
			key_prefix: string;
			permissions_json: string;
			secret_key_hash: string;
		};
		assert.deepEqual({ ...inserted }, {
			key_prefix: ORIGINAL_KEY.slice(0, 12),
			permissions_json: ACTIVE_ROW.permissionsJson,
			secret_key_hash: await hashLookupKey(ORIGINAL_KEY),
		});
		assert.equal((await repository.getActiveApiKeyBySecret(ORIGINAL_KEY))?.id, ACTIVE_ROW.id);

		assert.equal(await repository.rotateApiKey(
			ACTIVE_ROW.id,
			ROTATED_KEY,
		), true);
		assert.equal(await repository.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
		assert.equal((await repository.getActiveApiKeyBySecret(ROTATED_KEY))?.id, ACTIVE_ROW.id);

		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			name: 'renamed automation',
			secretKey: REPLACEMENT_KEY,
		}), true);
		assert.equal(await repository.getActiveApiKeyBySecret(ROTATED_KEY), null);
		assert.equal((await repository.getActiveApiKeyBySecret(REPLACEMENT_KEY))?.name, 'renamed automation');
		assert.equal(
			database.prepare('SELECT secret_key_hash FROM admin_api_keys WHERE id = ?')
				.get(ACTIVE_ROW.id)?.secret_key_hash,
			await hashLookupKey(REPLACEMENT_KEY),
		);
		assert.equal(
			database.prepare('SELECT key_prefix FROM admin_api_keys WHERE id = ?')
				.get(ACTIVE_ROW.id)?.key_prefix,
			REPLACEMENT_KEY.slice(0, 12),
		);
	});

	it('D1 rejects a stale non-null hash left by an earlier rotation and repairs the current secret', async () => {
		const { database, repository } = createD1Harness();
		database.prepare(`INSERT INTO admin_api_keys (
			id, name, secret_key, secret_key_hash, key_prefix, permissions_json, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(
			ACTIVE_ROW.id,
			ACTIVE_ROW.name,
			ROTATED_KEY,
			await hashLookupKey(ORIGINAL_KEY),
			ROTATED_KEY.slice(0, 12),
			ACTIVE_ROW.permissionsJson,
		);

		assert.equal(await repository.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
		assert.equal((await repository.getActiveApiKeyBySecret(ROTATED_KEY))?.id, ACTIVE_ROW.id);
		assert.equal(
			database.prepare('SELECT secret_key_hash FROM admin_api_keys WHERE id = ?')
				.get(ACTIVE_ROW.id)?.secret_key_hash,
			await hashLookupKey(ROTATED_KEY),
		);
	});

	it('D1 preserves plaintext fallback for legacy rows but rejects revoked rows', async () => {
		const { database, repository } = createD1Harness();
		database.prepare(`INSERT INTO admin_api_keys (
			id, name, secret_key, secret_key_hash, key_prefix, permissions_json, status
		) VALUES (?, ?, ?, NULL, ?, ?, 'active')`).run(
			ACTIVE_ROW.id,
			ACTIVE_ROW.name,
			ORIGINAL_KEY,
			ORIGINAL_KEY.slice(0, 12),
			ACTIVE_ROW.permissionsJson,
		);

		assert.equal((await repository.getActiveApiKeyBySecret(ORIGINAL_KEY))?.id, ACTIVE_ROW.id);
		assert.equal(
			database.prepare('SELECT secret_key_hash FROM admin_api_keys WHERE id = ?')
				.get(ACTIVE_ROW.id)?.secret_key_hash,
			await hashLookupKey(ORIGINAL_KEY),
		);
		assert.equal(await repository.revokeApiKey(ACTIVE_ROW.id), true);
		assert.equal(await repository.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
	});

	it('PostgreSQL writes a fresh hash for rotate and manual replacement', async () => {
		const probe = createDrizzleMutationProbe();
		const repository = createPostgresAdminAccessRepository({
			driver: 'postgres',
			raw: {} as PostgresDatabaseClient['raw'],
			drizzle: probe.drizzle as unknown as PostgresDatabaseClient['drizzle'],
		});

		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY), true);
		assert.equal(probe.writes[0]?.secretKey, ROTATED_KEY);
		assert.equal(probe.writes[0]?.secretKeyHash, await hashLookupKey(ROTATED_KEY));
		assert.equal(probe.writes[0]?.keyPrefix, ROTATED_KEY.slice(0, 12));
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			secretKey: REPLACEMENT_KEY,
		}), true);
		assert.equal(probe.writes[1]?.secretKeyHash, await hashLookupKey(REPLACEMENT_KEY));
		assert.equal(probe.writes[1]?.keyPrefix, REPLACEMENT_KEY.slice(0, 12));
	});

	it('MySQL writes a fresh hash for rotate and manual replacement', async () => {
		const probe = createDrizzleMutationProbe();
		const repository = createMySqlAdminAccessRepository({
			driver: 'mysql',
			raw: {} as MySqlDatabaseClient['raw'],
			drizzle: probe.drizzle as unknown as MySqlDatabaseClient['drizzle'],
		});

		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY), true);
		assert.equal(probe.writes[0]?.secretKey, ROTATED_KEY);
		assert.equal(probe.writes[0]?.secretKeyHash, await hashLookupKey(ROTATED_KEY));
		assert.equal(probe.writes[0]?.keyPrefix, ROTATED_KEY.slice(0, 12));
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			secretKey: REPLACEMENT_KEY,
		}), true);
		assert.equal(probe.writes[1]?.secretKeyHash, await hashLookupKey(REPLACEMENT_KEY));
		assert.equal(probe.writes[1]?.keyPrefix, REPLACEMENT_KEY.slice(0, 12));
	});

	it('PostgreSQL and MySQL reject stale non-null hash hits before plaintext fallback', async () => {
		const staleRow = { ...ACTIVE_ROW, secretKey: ROTATED_KEY };
		const postgresProbe = createDrizzleMutationProbe([[staleRow], []]);
		const postgres = createPostgresAdminAccessRepository({
			driver: 'postgres',
			raw: {} as PostgresDatabaseClient['raw'],
			drizzle: postgresProbe.drizzle as unknown as PostgresDatabaseClient['drizzle'],
		});
		assert.equal(await postgres.getActiveApiKeyBySecret(ORIGINAL_KEY), null);

		const mysqlProbe = createDrizzleMutationProbe([[staleRow], []]);
		const mysql = createMySqlAdminAccessRepository({
			driver: 'mysql',
			raw: {} as MySqlDatabaseClient['raw'],
			drizzle: mysqlProbe.drizzle as unknown as MySqlDatabaseClient['drizzle'],
		});
		assert.equal(await mysql.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
	});
});

import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
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
import type { AdminApiKeyAuditContext, AdminApiKeyAuditSqlRow } from './admin-access-audit';
import { mapAdminApiKeyAuditRow, validateAdminApiKeyAuditContext } from './admin-access-audit';
import { adminAccessKeyAuditTable as mysqlAccessAudit } from '../storage/drizzle/schema.mysql';
import { adminAccessKeyAuditTable as pgAccessAudit } from '../storage/drizzle/schema.pg';
import { adminAccessKeyAuditTable as d1AccessAudit } from '../storage/drizzle/schema.d1';
import type { AdminAccessRepository } from '../storage/gateway-repository-interfaces';

const OIDC255_ACTOR = `console:cinaauth:${'A'.repeat(255)}`;
const audit = (actorId = OIDC255_ACTOR): AdminApiKeyAuditContext => ({ auditId: crypto.randomUUID(), actorId, nowIso: '2026-09-30T01:00:00.000Z' });

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
	executeBatch(): D1Result {
		return /^\s*SELECT\b/iu.test(this.sql) ? this.all() : this.run();
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
	database.exec(readFileSync(new NodeURL('../../migrations-d1/0072_admin_access_key_audit.sql', import.meta.url), 'utf8'));
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: SqliteD1Statement[]) {
			database.exec('BEGIN');
			try {
				const results = statements.map((statement) => statement.executeBatch());
				database.exec('COMMIT'); return results;
			} catch (error) { database.exec('ROLLBACK'); throw error; }
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

function createDrizzleMutationProbe(selectResults?: AdminApiKeyRow[][], targetOptions: {
	result?: unknown; readBack?: Record<string, unknown>[]; before?: Record<string, unknown>;
} = {}) {
	const writes: Array<Record<string, unknown>> = [];
	const queries: Array<{ sql: string; values: unknown[] }> = [];
	let commits = 0; let rollbacks = 0; let failAudit = false; let suppressAudit = false;
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
	const execute = async (sql: string, values: unknown[] = []) => {
		queries.push({ sql, values });
		if (sql.startsWith('SELECT') && (sql.includes('AS target_updated_at_exact') || sql.includes(', secret_key_hash FROM'))) return targetOptions.readBack ?? [];
		if (sql.startsWith('SELECT')) return [targetOptions.before ?? { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, description: null,
			secret_key: ACTIVE_ROW.secretKey, key_prefix: ACTIVE_ROW.keyPrefix, permissions_json: ACTIVE_ROW.permissionsJson,
			status: ACTIVE_ROW.status, last_used_at: null, created_at: ACTIVE_ROW.createdAt, updated_at: ACTIVE_ROW.updatedAt, revoked_at: null }];
		if (sql.includes('INSERT INTO') && sql.includes('admin_access_key_audit')) {
			if (failAudit) throw new Error('injected audit failure');
			if (suppressAudit) return sql.includes('RETURNING id') ? [] : { affectedRows: 0 };
			if (sql.includes('RETURNING id')) return [{ id: values[0] }];
		}
		if (sql.startsWith('UPDATE')) {
			const result: Record<string, unknown> = {};
			const mapping: Record<string, string> = { secret_key: 'secretKey', secret_key_hash: 'secretKeyHash', key_prefix: 'keyPrefix' };
			const matches = [...sql.matchAll(/\b(secret_key|secret_key_hash|key_prefix) = (?:\?|\$(\d+))/gu)];
			matches.forEach((match, index) => { result[mapping[match[1]!]!] = values[match[2] ? Number(match[2]) - 1 : index]; });
			writes.push(result);
		}
		if (/^(?:INSERT INTO|UPDATE) (?:cinatoken_gateway\.)?admin_api_keys\b/u.test(sql)) {
			if (Object.prototype.hasOwnProperty.call(targetOptions, 'result')) return targetOptions.result;
			if (sql.endsWith('RETURNING id')) return [{ id: sql.startsWith('INSERT') ? values[0] : values.at(-1) }];
		}
		return { affectedRows: 1 };
	};
	const mysqlConnection = { execute: async (sql: string, values: unknown[]) => [await execute(sql, values), []],
		beginTransaction: async () => undefined, commit: async () => { commits++; }, rollback: async () => { rollbacks++; }, release: () => undefined };
	const mysqlRaw = { getConnection: async () => mysqlConnection, execute: mysqlConnection.execute };
	const postgresRaw = { begin: async (fn: (tx: unknown) => Promise<unknown>) => {
		try { const result = await fn({ unsafe: execute }); commits++; return result; }
		catch (error) { rollbacks++; throw error; }
	}, unsafe: execute };
	return { drizzle, writes, queries, mysqlRaw, postgresRaw, commits: () => commits, rollbacks: () => rollbacks,
		failAudit: () => { failAudit = true; }, suppressAudit: () => { suppressAudit = true; } };
}

function createSqlRepository(driver: 'mysql' | 'postgres', probe: ReturnType<typeof createDrizzleMutationProbe>): AdminAccessRepository {
	return driver === 'mysql'
		? createMySqlAdminAccessRepository({ driver, raw: probe.mysqlRaw as unknown as MySqlDatabaseClient['raw'], drizzle: probe.drizzle as unknown as MySqlDatabaseClient['drizzle'] })
		: createPostgresAdminAccessRepository({ driver, raw: probe.postgresRaw as unknown as PostgresDatabaseClient['raw'], drizzle: probe.drizzle as unknown as PostgresDatabaseClient['drizzle'] });
}

function lifecycleOperations(repository: AdminAccessRepository, actorId: string) {
	return [
		() => repository.insertApiKey({ id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12), permissionsJson: ACTIVE_ROW.permissionsJson }, audit(actorId)),
		() => repository.updateApiKey(ACTIVE_ROW.id, { name: 'reviewed name', permissionsJson: '["logs.read"]' }, audit(actorId)),
		() => repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit(actorId)),
		() => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit(actorId)),
		() => repository.revokeApiKey(ACTIVE_ROW.id, audit(actorId)),
		() => repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit(actorId)),
	];
}

describe('Admin API key standard OIDC Console actor capacity', () => {
	it('formal MySQL0073 is one widening ALTER preserving0068 actor storage contract', () => {
		const original = readFileSync(new NodeURL('../../migrations-mysql/0068_admin_access_key_audit.sql', import.meta.url), 'utf8');
		assert.match(original, /actor_id VARCHAR\(255\) NOT NULL,/u);
		assert.match(original, /DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/u);
		assert.doesNotMatch(original, /actor_id[^\r\n]*DEFAULT/u);
		const migration = readFileSync(new NodeURL('../../migrations-mysql/0073_admin_access_key_actor_oidc_capacity.sql', import.meta.url), 'utf8');
		const executable = migration.replace(/--[^\r\n]*/gu, '').replace(/\s+/gu, ' ').trim();
		assert.equal(executable, 'ALTER TABLE admin_access_key_audit MODIFY COLUMN actor_id VARCHAR(272) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;');
		assert.equal(mysqlAccessAudit.actorId.getSQLType(), 'varchar(272)');
		assert.equal(mysqlAccessAudit.actorId.notNull, true);
		assert.equal(mysqlAccessAudit.actorId.hasDefault, false);
	});
	it('D1/PostgreSQL existing formal audit schemas and Drizzle actor TEXT impose no255 storage bound', () => {
		for (const [driver, file, table] of [
			['d1', '../../migrations-d1/0072_admin_access_key_audit.sql', d1AccessAudit],
			['postgres', '../../migrations-postgres/0077_admin_access_key_audit.sql', pgAccessAudit],
		] as const) {
			const sql = readFileSync(new NodeURL(file, import.meta.url), 'utf8');
			assert.match(sql, /actor_id TEXT NOT NULL,/u, driver);
			assert.doesNotMatch(sql, /(?:length|char_length)\s*\(\s*actor_id\s*\)/iu, driver);
			assert.equal(table.actorId.getSQLType(), 'text', driver);
			assert.equal(table.actorId.notNull, true, driver);
		}
	});
	it('retains existing Unicode code-point and control-character semantics without a UTF16 cap', () => {
		for (const suffix of ['😀'.repeat(247), '😀'.repeat(264), 'operator\u200d', 'operator\u0085']) {
			assert.doesNotThrow(() => validateAdminApiKeyAuditContext(audit(`console:${suffix}`)));
		}
		assert.ok(`console:${'😀'.repeat(264)}`.length > 272);
		assert.throws(() => validateAdminApiKeyAuditContext(audit(`console:${'😀'.repeat(265)}`)), TypeError);
	});
	it('audit mapper preserves legal old/standard-boundary actors and rejects raw invalid identity generically', () => {
		const row: AdminApiKeyAuditSqlRow = { id: crypto.randomUUID(), key_id: ACTIVE_ROW.id, action: 'revealed', change_mask: 0,
			actor_kind: 'console', actor_id: 'console:operator', before_permissions_json: '["logs.read"]',
			after_permissions_json: null, before_status: 'active', after_status: 'active', created_at: audit().nowIso };
		for (const actor of ['console:operator', OIDC255_ACTOR, `console:${'😀'.repeat(264)}`]) {
			assert.equal(mapAdminApiKeyAuditRow({ ...row, actor_id: actor }).actorId, actor);
		}
		for (const invalid of [
			{ actor_kind: 'api_key', actor_id: 'console:operator' },
			{ actor_kind: 'console', actor_id: `console:cinaauth:${'A'.repeat(256)}` },
			{ actor_kind: 'console', actor_id: 'admin_key:operator' },
			{ actor_kind: 'console', actor_id: 'console:operator\u0000' },
			{ actor_kind: 'console', actor_id: 'console:operator\u001f' },
			{ actor_kind: 'console', actor_id: 'console:operator\u007f' },
		]) {
			assert.throws(() => mapAdminApiKeyAuditRow({ ...row, ...invalid } as AdminApiKeyAuditSqlRow),
				error => error instanceof TypeError && error.message === 'Invalid Admin API key audit actor');
		}
	});

	for (const length of [238, 239, 255]) {
		it(`D1 actual SQLite lifecycle and audit reads preserve raw subject${length} exactly`, async () => {
			const actorId = `console:cinaauth:${'Aa'.repeat(128).slice(0, length)}`;
			const { database, repository } = createD1Harness();
			try {
				const results = [];
				for (const operation of lifecycleOperations(repository, actorId)) results.push(await operation());
				assert.equal((results[2] as AdminApiKeyRow).secretKey, ORIGINAL_KEY);
				for (const index of [1, 3, 4, 5]) assert.equal(results[index], true);
				const rows = database.prepare('SELECT * FROM admin_access_key_audit ORDER BY rowid').all();
				assert.deepEqual(rows.map(row => row.action), ['created', 'updated', 'revealed', 'rotated', 'revoked', 'activated']);
				assert.ok(rows.every(row => row.actor_id === actorId && row.actor_kind === 'console'));
				const read = await repository.listApiKeyAudit(ACTIVE_ROW.id, { limit: 100 });
				assert.equal(read.length, 6);
				assert.ok(read.every(row => row.actorId === actorId));
				const serialized = JSON.stringify(rows);
				for (const material of [ORIGINAL_KEY, ROTATED_KEY, ORIGINAL_KEY.slice(0, 12), await hashLookupKey(ORIGINAL_KEY)]) assert.ok(!serialized.includes(material));
				assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.status, 'active');
			} finally { database.close(); }
		});

		for (const driver of ['mysql', 'postgres'] as const) {
			it(`${driver} actual repository lifecycle SQL binds raw subject${length} actor unchanged`, async () => {
				const actorId = `console:cinaauth:${'Aa'.repeat(128).slice(0, length)}`;
				const probe = createDrizzleMutationProbe();
				const repository = createSqlRepository(driver, probe);
				for (const operation of lifecycleOperations(repository, actorId)) await operation();
				const auditQueries = probe.queries.filter(query => query.sql.includes('INSERT INTO') && query.sql.includes('admin_access_key_audit'));
				assert.deepEqual(auditQueries.map(query => query.values[2]), ['created', 'updated', 'revealed', 'rotated', 'revoked', 'activated']);
				assert.ok(auditQueries.every(query => query.values[4] === 'console' && query.values[5] === actorId && !query.sql.includes(actorId)));
				assert.equal(probe.commits(), 6); assert.equal(probe.rollbacks(), 0);
				const serialized = JSON.stringify(auditQueries);
				for (const material of [ORIGINAL_KEY, ROTATED_KEY, ORIGINAL_KEY.slice(0, 12), await hashLookupKey(ORIGINAL_KEY)]) assert.ok(!serialized.includes(material));
			});
		}
	}

	for (const driver of ['d1', 'mysql', 'postgres'] as const) {
		it(`${driver} invalid actors reject every lifecycle/reveal before any database call`, async () => {
			let calls = 0;
			const unexpected = () => { calls++; throw new Error('Unexpected database call'); };
			const raw = { prepare: unexpected, batch: unexpected, execute: unexpected, getConnection: unexpected, begin: unexpected, unsafe: unexpected };
			const drizzle = { select: unexpected, insert: unexpected, update: unexpected };
			const repository = driver === 'd1'
				? createD1AdminAccessRepository({ driver, raw: raw as unknown as D1DatabaseClient['raw'], drizzle: drizzle as unknown as D1DatabaseClient['drizzle'] })
				: driver === 'mysql'
					? createMySqlAdminAccessRepository({ driver, raw: raw as unknown as MySqlDatabaseClient['raw'], drizzle: drizzle as unknown as MySqlDatabaseClient['drizzle'] })
					: createPostgresAdminAccessRepository({ driver, raw: raw as unknown as PostgresDatabaseClient['raw'], drizzle: drizzle as unknown as PostgresDatabaseClient['drizzle'] });
			for (const actorId of [`console:cinaauth:${'A'.repeat(256)}`, `console:${'A'.repeat(265)}`, 'admin_key:operator', 'console:', 'console:operator\u0000', 'console:operator\u001f', 'console:operator\u007f']) {
				for (const operation of lifecycleOperations(repository, actorId)) await assert.rejects(operation, TypeError);
			}
			assert.equal(calls, 0);
		});
	}
});

describe('D1 audit and actual target write stay atomic', () => {
	for (const fault of ['IGNORE', 'ABORT'] as const) {
		for (const operation of ['created', 'updated', 'rotated', 'revoked', 'activated'] as const) {
			it(`SQLite target ${operation} RAISE(${fault}) rolls back actor272 audit and every key field`, async () => {
				const { database, repository } = createD1Harness();
				try {
					await lifecycleOperations(repository, OIDC255_ACTOR)[0]!();
					if (operation === 'activated') await repository.revokeApiKey(ACTIVE_ROW.id, audit());
					const keysBefore = database.prepare('SELECT * FROM admin_api_keys ORDER BY id').all();
					const auditsBefore = database.prepare('SELECT * FROM admin_access_key_audit ORDER BY id').all();
					const event = operation === 'created' ? 'INSERT' : 'UPDATE';
					const raise = fault === 'IGNORE' ? 'IGNORE' : "ABORT, 'injected key write failure'";
					database.exec(`CREATE TRIGGER reject_target BEFORE ${event} ON admin_api_keys BEGIN SELECT RAISE(${raise}); END;`);
					const mutate = operation === 'created'
						? () => repository.insertApiKey({ id: 'blocked-key', name: 'blocked key', secretKey: ROTATED_KEY,
							keyPrefix: ROTATED_KEY.slice(0, 12), permissionsJson: '["*"]' }, audit())
						: operation === 'updated'
							? () => repository.updateApiKey(ACTIVE_ROW.id, { name: 'never committed', permissionsJson: '["*"]' }, audit())
							: operation === 'rotated'
								? () => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit())
								: operation === 'revoked'
									? () => repository.revokeApiKey(ACTIVE_ROW.id, audit())
									: () => repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit());
					await assert.rejects(mutate, error => error instanceof Error &&
						/integer overflow|injected key write failure/u.test(error.message) && !error.message.includes(ROTATED_KEY));
					assert.deepEqual(database.prepare('SELECT * FROM admin_api_keys ORDER BY id').all(), keysBefore);
					assert.deepEqual(database.prepare('SELECT * FROM admin_access_key_audit ORDER BY id').all(), auditsBefore);
					assert.equal(await repository.getApiKeyById('blocked-key'), null);
				} finally { database.close(); }
			});
		}
	}
	it('missing or inactive target retains false/null without a ghost audit; same-value matching target still writes once', async () => {
		const { database, repository } = createD1Harness();
		try {
			assert.equal(await repository.updateApiKey('missing', { name: 'missing' }, audit()), false);
			assert.equal(await repository.rotateApiKey('missing', ROTATED_KEY, audit()), false);
			assert.equal(await repository.revokeApiKey('missing', audit()), false);
			assert.equal(await repository.revealApiKeyWithAudit('missing', audit()), null);
			assert.equal(database.prepare('SELECT COUNT(*) AS n FROM admin_access_key_audit').get()?.n, 0);
			await lifecycleOperations(repository, OIDC255_ACTOR)[0]!();
			assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, { name: ACTIVE_ROW.name }, audit()), true);
			await repository.revokeApiKey(ACTIVE_ROW.id, audit());
			const before = database.prepare('SELECT * FROM admin_access_key_audit ORDER BY id').all();
			assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), false);
			assert.equal(await repository.revokeApiKey(ACTIVE_ROW.id, audit()), false);
			assert.deepEqual(database.prepare('SELECT * FROM admin_access_key_audit ORDER BY id').all(), before);
		} finally { database.close(); }
	});
});

describe('MySQL/PostgreSQL actual target result and same-value compatibility', () => {
	const writeIndexes = [0, 1, 3, 4, 5];
	const noAuditOrCommit = (probe: ReturnType<typeof createDrizzleMutationProbe>) => {
		assert.equal(probe.commits(), 0); assert.equal(probe.rollbacks(), 1);
		assert.ok(!probe.queries.some(query => query.sql.includes('INSERT INTO') && query.sql.includes('admin_access_key_audit')));
	};
	for (const driver of ['mysql', 'postgres'] as const) {
		it(`${driver} zero target across every write rejects before audit/commit without a secret response`, async () => {
			for (const index of writeIndexes) {
				const unchangedRow = { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, description: null, secret_key: ORIGINAL_KEY,
					key_prefix: ACTIVE_ROW.keyPrefix, permissions_json: ACTIVE_ROW.permissionsJson, status: ACTIVE_ROW.status,
					updated_at: ACTIVE_ROW.updatedAt, revoked_at: null,
					target_updated_at_exact: '2026-08-31T00:00:00.000000Z', target_revoked_at_exact: null };
				const probe = createDrizzleMutationProbe(undefined, { result: driver === 'mysql' ? { affectedRows: 0 } : [], readBack: [unchangedRow] });
				const repository = createSqlRepository(driver, probe);
				await assert.rejects(lifecycleOperations(repository, OIDC255_ACTOR)[index]!,
					error => error instanceof Error && error.message === 'Admin API key target did not commit');
				noAuditOrCommit(probe);
				if (driver === 'postgres') assert.ok(probe.queries.filter(query => /^(?:INSERT INTO|UPDATE) /u.test(query.sql)).every(query => query.sql.endsWith('RETURNING id')));
			}
		});
		it(`${driver} reveal has no target mutation and still requires its successful audit`, async () => {
			const probe = createDrizzleMutationProbe(undefined, { result: driver === 'mysql' ? { affectedRows: 0 } : [] });
			const repository = createSqlRepository(driver, probe);
			assert.equal((await repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()))?.secretKey, ORIGINAL_KEY);
			assert.equal(probe.commits(), 1); assert.equal(probe.rollbacks(), 0);
			assert.ok(!probe.queries.some(query => /^(?:INSERT INTO|UPDATE) (?:cinatoken_gateway\.)?admin_api_keys\b/u.test(query.sql)));
		});
	}
	it('MySQL negative/nonfinite/string/multirow/malformed target metadata cannot authorize any write audit', async () => {
		for (const result of [null, {}, { affectedRows: -1 }, { affectedRows: Number.NaN }, { affectedRows: Number.POSITIVE_INFINITY }, { affectedRows: '1' }, { affectedRows: 2 }, [{ affectedRows: 1 }]]) {
			for (const index of writeIndexes) {
				const probe = createDrizzleMutationProbe(undefined, { result });
				await assert.rejects(lifecycleOperations(createSqlRepository('mysql', probe), OIDC255_ACTOR)[index]!,
					error => error instanceof Error && error.message === 'Admin API key target did not commit');
				noAuditOrCommit(probe);
			}
		}
	});
	it('PostgreSQL missing/multiple/wrong-id/malformed RETURNING cannot authorize any write audit', async () => {
		for (const result of [null, {}, [], [{ id: 'wrong-target' }], [{ id: ACTIVE_ROW.id }, { id: ACTIVE_ROW.id }]]) {
			for (const index of writeIndexes) {
				const probe = createDrizzleMutationProbe(undefined, { result });
				await assert.rejects(lifecycleOperations(createSqlRepository('postgres', probe), OIDC255_ACTOR)[index]!,
					error => error instanceof Error && error.message === 'Admin API key target did not commit');
				noAuditOrCommit(probe);
			}
		}
	});
	it('MySQL matched-row1 needs no fallback; changed-row0 accepts a locked complete same-value profile', async () => {
		const hash = await hashLookupKey(ROTATED_KEY);
		const patch = { name: 'already reviewed', description: 'already reviewed description', permissionsJson: '["logs.read"]',
			secretKey: ROTATED_KEY, status: 'active' as const, revokedAt: null };
		for (const updatedAt of ['2026-09-30 01:00:00.000000', new Date(audit().nowIso), audit().nowIso]) {
			const row = { id: ACTIVE_ROW.id, name: patch.name, description: patch.description, permissions_json: patch.permissionsJson,
				secret_key: ROTATED_KEY, secret_key_hash: hash, key_prefix: ROTATED_KEY.slice(0, 12), status: 'active',
				updated_at: updatedAt, revoked_at: null, created_at: ACTIVE_ROW.createdAt, last_used_at: null,
				target_updated_at_exact: '2026-09-30T01:00:00.000000Z', target_revoked_at_exact: null };
			for (const affectedRows of [1, 0]) {
				const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows }, before: row, readBack: [row] });
				const repository = createSqlRepository('mysql', probe);
				assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, patch, audit()), true);
				assert.equal(probe.commits(), 1); assert.equal(probe.rollbacks(), 0);
				const fallback = probe.queries.filter(query => query.sql.includes('AS target_updated_at_exact'));
				assert.equal(fallback.length, affectedRows === 0 ? 1 : 0);
				if (fallback.length) {
					assert.match(fallback[0]!.sql, /WHERE id = \? FOR UPDATE/u); assert.deepEqual(fallback[0]!.values, [ACTIVE_ROW.id]);
					for (const column of ['updated_at', 'revoked_at']) assert.ok(fallback[0]!.sql.includes(`DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ') AS target_${column}_exact`));
				}
				const serialized = JSON.stringify(probe.queries.filter(query => query.sql.includes('INSERT INTO admin_access_key_audit')));
				for (const material of [ROTATED_KEY, hash, ROTATED_KEY.slice(0, 12)]) assert.ok(!serialized.includes(material));
			}
		}
	});
	it('MySQL changed-row0 rejects every mismatched assignment, malformed timestamp, missing or substituted row', async () => {
		const hash = await hashLookupKey(ROTATED_KEY);
		const patch = { name: 'already reviewed', description: 'already reviewed description', permissionsJson: '["logs.read"]',
			secretKey: ROTATED_KEY, status: 'active' as const, revokedAt: null };
		const expected = { id: ACTIVE_ROW.id, name: patch.name, description: patch.description, permissions_json: patch.permissionsJson,
			secret_key: ROTATED_KEY, secret_key_hash: hash, key_prefix: ROTATED_KEY.slice(0, 12), status: 'active',
			updated_at: audit().nowIso, revoked_at: null, created_at: ACTIVE_ROW.createdAt, last_used_at: null,
			target_updated_at_exact: '2026-09-30T01:00:00.000000Z', target_revoked_at_exact: null };
		for (const rows of [[], [{ ...expected, id: 'wrong-key' }], [expected, expected],
			...Object.keys(patch).map(field => {
				const column = ({ permissionsJson: 'permissions_json', secretKey: 'secret_key', revokedAt: 'target_revoked_at_exact' } as Record<string, string>)[field] ?? field;
				return [{ ...expected, [column]: 'mismatched' }];
			}), [{ ...expected, secret_key_hash: 'wrong hash' }], [{ ...expected, key_prefix: 'wrong prefix' }],
			[{ ...expected, target_updated_at_exact: ACTIVE_ROW.updatedAt }], [{ ...expected, target_updated_at_exact: 'invalid-time' }], [{ ...expected, target_updated_at_exact: 0 }]]) {
			const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, before: expected, readBack: rows });
			await assert.rejects(() => createSqlRepository('mysql', probe).updateApiKey(ACTIVE_ROW.id, patch, audit()),
				error => error instanceof Error && error.message === 'Admin API key target did not commit');
			noAuditOrCommit(probe);
		}
	});
	it('MySQL zero changed rows preserve UTC same-value revocation and reject a missed revocation stamp', async () => {
		const row = { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, description: null, permissions_json: ACTIVE_ROW.permissionsJson,
			status: 'revoked', updated_at: '2026-09-30 01:00:00.000000', revoked_at: new Date(audit().nowIso),
			target_updated_at_exact: '2026-09-30T01:00:00.000000Z', target_revoked_at_exact: '2026-09-30T01:00:00.000000Z' };
		const patch = { status: 'revoked' as const, revokedAt: audit().nowIso };
		const valid = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, before: row, readBack: [row] });
		assert.equal(await createSqlRepository('mysql', valid).updateApiKey(ACTIVE_ROW.id, patch, audit()), true);
		assert.equal(valid.commits(), 1); assert.equal(valid.rollbacks(), 0);
		for (const revokedAt of [null, ACTIVE_ROW.updatedAt, 'bad-time', new Date(Number.NaN)]) {
			const invalid = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, before: row, readBack: [{ ...row, target_revoked_at_exact: revokedAt }] });
			await assert.rejects(() => createSqlRepository('mysql', invalid).updateApiKey(ACTIVE_ROW.id, patch, audit()),
				error => error instanceof Error && error.message === 'Admin API key target did not commit');
			noAuditOrCommit(invalid);
		}
	});
	it('MySQL changed-row0 rejects hidden updatedAt microseconds for update, rotate, revoke and activation', async () => {
		const hash = await hashLookupKey(ROTATED_KEY);
		for (const action of ['update', 'rotate', 'revoke', 'activate'] as const) {
			const row = { id: ACTIVE_ROW.id, name: 'reviewed name', description: null, permissions_json: '["logs.read"]',
				secret_key: ROTATED_KEY, secret_key_hash: hash, key_prefix: ROTATED_KEY.slice(0, 12),
				status: action === 'revoke' ? 'revoked' : 'active', revoked_at: action === 'revoke' ? new Date(audit().nowIso) : null,
				updated_at: new Date(audit().nowIso), target_updated_at_exact: '2026-09-30T01:00:00.000123Z',
				target_revoked_at_exact: action === 'revoke' ? '2026-09-30T01:00:00.000000Z' : null };
			const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, readBack: [row] });
			const repository = createSqlRepository('mysql', probe);
			const run = action === 'rotate' ? () => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit())
				: action === 'revoke' ? () => repository.revokeApiKey(ACTIVE_ROW.id, audit())
					: action === 'activate' ? () => repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit())
						: () => repository.updateApiKey(ACTIVE_ROW.id, { name: 'reviewed name', permissionsJson: '["logs.read"]' }, audit());
			await assert.rejects(run, error => error instanceof Error && error.message === 'Admin API key target did not commit');
			noAuditOrCommit(probe);
			const target = probe.queries.find(query => query.sql.startsWith('UPDATE'))!;
			assert.ok(target.values.includes('2026-09-30 01:00:00.000000'));
		}
	});
	it('MySQL changed-row0 rejects hidden revokedAt microseconds independently of updatedAt', async () => {
		for (const action of ['update', 'revoke'] as const) {
			const row = { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, permissions_json: ACTIVE_ROW.permissionsJson, status: 'revoked',
				updated_at: new Date(audit().nowIso), revoked_at: new Date(audit().nowIso),
				target_updated_at_exact: '2026-09-30T01:00:00.000000Z', target_revoked_at_exact: '2026-09-30T01:00:00.000123Z' };
			const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, readBack: [row] });
			const repository = createSqlRepository('mysql', probe);
			await assert.rejects(action === 'revoke' ? () => repository.revokeApiKey(ACTIVE_ROW.id, audit())
				: () => repository.updateApiKey(ACTIVE_ROW.id, { status: 'revoked', revokedAt: audit().nowIso }, audit()),
				error => error instanceof Error && error.message === 'Admin API key target did not commit');
			noAuditOrCommit(probe);
		}
	});
	it('MySQL changed-row0 accepts exactly the six-digit timestamp actually assigned, including nullable activation', async () => {
		const context = { ...audit(), nowIso: '2026-09-30T01:00:00.123Z' };
		for (const status of ['active', 'revoked'] as const) {
			const revokedAt = status === 'revoked' ? '2026-09-30T01:00:00.123987Z' : null;
			const row = { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, permissions_json: ACTIVE_ROW.permissionsJson, status,
				updated_at: new Date(context.nowIso), revoked_at: revokedAt === null ? null : new Date(revokedAt),
				target_updated_at_exact: '2026-09-30T01:00:00.123000Z', target_revoked_at_exact: revokedAt === null ? null : '2026-09-30T01:00:00.123000Z' };
			const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, readBack: [row] });
			assert.equal(await createSqlRepository('mysql', probe).updateApiKey(ACTIVE_ROW.id, { status, revokedAt }, context), true);
			assert.equal(probe.commits(), 1); assert.equal(probe.rollbacks(), 0);
			const target = probe.queries.find(query => query.sql.startsWith('UPDATE'))!;
			assert.deepEqual(target.values, [status, revokedAt === null ? null : '2026-09-30 01:00:00.123000', '2026-09-30 01:00:00.123000', ACTIVE_ROW.id]);
		}
	});
	it('MySQL changed-row0 requires the exact SQL string alias and never falls back to a truncated Date', async () => {
		const row = { id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, permissions_json: ACTIVE_ROW.permissionsJson, status: 'active',
			updated_at: new Date(audit().nowIso), revoked_at: null, target_revoked_at_exact: null };
		for (const actual of [undefined, null, new Date(audit().nowIso), '2026-09-30T01:00:00.000Z', '2026-09-30T01:00:00.000000Z\n', 0]) {
			const probe = createDrizzleMutationProbe(undefined, { result: { affectedRows: 0 }, readBack: [{ ...row, target_updated_at_exact: actual }] });
			await assert.rejects(() => createSqlRepository('mysql', probe).updateApiKey(ACTIVE_ROW.id, { name: ACTIVE_ROW.name }, audit()),
				error => error instanceof Error && error.message === 'Admin API key target did not commit');
			noAuditOrCommit(probe);
		}
	});
});

describe('Admin API key mutation hash invariants', () => {
	it('D1 skipped audit inserts cannot authorize any key mutation or reveal', async () => {
		const { database, repository } = createD1Harness();
		await repository.insertApiKey({ id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12), permissionsJson: ACTIVE_ROW.permissionsJson }, audit());
		database.exec('CREATE TRIGGER skip_admin_key_audit BEFORE INSERT ON admin_access_key_audit BEGIN SELECT RAISE(IGNORE); END;');
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, { permissionsJson: '["*"]' }, audit()), false);
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit()), false);
		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), false);
		assert.equal(await repository.revokeApiKey(ACTIVE_ROW.id, audit()), false);
		await assert.rejects(() => repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()), /audit did not commit/u);
		await assert.rejects(() => repository.insertApiKey({ id: 'no-audit-key', name: 'no-audit', secretKey: ROTATED_KEY,
			keyPrefix: ROTATED_KEY.slice(0, 12), permissionsJson: '["*"]' }, audit()), /audit did not commit/u);
		assert.equal(await repository.getApiKeyById('no-audit-key'), null);
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.secretKey, ORIGINAL_KEY);
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.permissionsJson, ACTIVE_ROW.permissionsJson);
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.status, 'active');
		assert.equal(database.prepare('SELECT COUNT(*) AS n FROM admin_access_key_audit').get()?.n, 1);
	});

	it('MySQL/PG withheld audit inserts roll back mutation and never reveal a key', async () => {
		for (const driver of ['mysql', 'postgres'] as const) {
			const probe = createDrizzleMutationProbe(); probe.suppressAudit();
			const repository = driver === 'mysql'
				? createMySqlAdminAccessRepository({ driver, raw: probe.mysqlRaw as unknown as MySqlDatabaseClient['raw'], drizzle: probe.drizzle as unknown as MySqlDatabaseClient['drizzle'] })
				: createPostgresAdminAccessRepository({ driver, raw: probe.postgresRaw as unknown as PostgresDatabaseClient['raw'], drizzle: probe.drizzle as unknown as PostgresDatabaseClient['drizzle'] });
			for (const operation of lifecycleOperations(repository, OIDC255_ACTOR)) await assert.rejects(operation, /audit did not commit/u);
			assert.equal(probe.commits(), 0); assert.equal(probe.rollbacks(), 6);
		}
	});

	it('MySQL/PG audit page SQL preserves UTC microsecond cursor precision and bounded index order', async () => {
		const timestamp = '2026-09-30T00:00:00.000123Z';
		const cursor = { createdAt: timestamp, id: '00000000-0000-4000-8000-000000000002' };
		const rows = [{ id: '00000000-0000-4000-8000-000000000001', key_id: ACTIVE_ROW.id, action: 'revealed', change_mask: 0,
			actor_kind: 'console', actor_id: 'console:operator', before_permissions_json: '["logs.read"]',
			after_permissions_json: `["${ORIGINAL_KEY}"]`, before_status: 'active', after_status: 'active', created_at: timestamp }];
		const queries: Array<{ sql: string; values: unknown[] }> = [];
		const execute = async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return rows; };
		const mysql = createMySqlAdminAccessRepository({ driver: 'mysql', raw: { execute: async (sql: string, values: unknown[]) => [await execute(sql, values), []] } as unknown as MySqlDatabaseClient['raw'], drizzle: {} as MySqlDatabaseClient['drizzle'] });
		const postgres = createPostgresAdminAccessRepository({ driver: 'postgres', raw: { unsafe: execute } as unknown as PostgresDatabaseClient['raw'], drizzle: {} as PostgresDatabaseClient['drizzle'] });
		const myRows = await mysql.listApiKeyAudit(ACTIVE_ROW.id, { limit: 100, before: cursor });
		const pgRows = await postgres.listApiKeyAudit(ACTIVE_ROW.id, { limit: 100, before: cursor });
		assert.equal(myRows[0]?.createdAt, timestamp); assert.equal(pgRows[0]?.createdAt, timestamp);
		assert.equal(myRows[0]?.afterPermissions, null); assert.equal(pgRows[0]?.afterPermissions, null);
		assert.deepEqual(queries[0]?.values, [ACTIVE_ROW.id, '2026-09-30 00:00:00.000123', '2026-09-30 00:00:00.000123', cursor.id]);
		assert.deepEqual(queries[1]?.values, [ACTIVE_ROW.id, timestamp, cursor.id]);
		for (const query of queries) { assert.match(query.sql, /ORDER BY admin_access_key_audit\.created_at DESC, id DESC LIMIT 100/u); assert.doesNotMatch(query.sql, /OFFSET/u); }
		await assert.rejects(() => mysql.listApiKeyAudit(ACTIVE_ROW.id, { limit: 102 }), RangeError);
		await assert.rejects(() => postgres.listApiKeyAudit(ACTIVE_ROW.id, { limit: 102 }), RangeError);
	});

	it('D1 commits lifecycle/reveal audit, orders same-time cursors, and stores no key material', async () => {
		const { database, repository } = createD1Harness();
		await repository.insertApiKey({ id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12), permissionsJson: ACTIVE_ROW.permissionsJson }, audit());
		await repository.updateApiKey(ACTIVE_ROW.id, { permissionsJson: '["users.read","logs.read"]', description: 'Do not copy this text into audit' }, audit());
		assert.equal((await repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()))?.secretKey, ORIGINAL_KEY);
		await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit());
		await repository.revokeApiKey(ACTIVE_ROW.id, audit());
		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, REPLACEMENT_KEY, audit()), false);
		assert.equal(await repository.revokeApiKey(ACTIVE_ROW.id, audit()), false);
		await repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit());
		const rows = database.prepare('SELECT * FROM admin_access_key_audit ORDER BY rowid').all();
		assert.equal(rows.length, 6);
		assert.deepEqual(rows.map((row) => row.action), ['created', 'updated', 'revealed', 'rotated', 'revoked', 'activated']);
		assert.equal(rows[1]?.before_permissions_json, ACTIVE_ROW.permissionsJson);
		assert.equal(rows[1]?.after_permissions_json, '["logs.read","users.read"]');
		assert.equal(rows[4]?.before_status, 'active'); assert.equal(rows[4]?.after_status, 'revoked');
		assert.equal(rows[5]?.before_status, 'revoked'); assert.equal(rows[5]?.after_status, 'active');
		const serialized = JSON.stringify(rows);
		for (const forbidden of [ORIGINAL_KEY, ROTATED_KEY, await hashLookupKey(ORIGINAL_KEY), ORIGINAL_KEY.slice(0, 12), 'Do not copy this text']) assert.ok(!serialized.includes(forbidden));
		const first = await repository.listApiKeyAudit(ACTIVE_ROW.id, { limit: 2 });
		const second = await repository.listApiKeyAudit(ACTIVE_ROW.id, { limit: 101, before: first[1] });
		assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 6);
		assert.ok(first[0]!.id > first[1]!.id);
		assert.ok(second.every((row) => row.id < first[1]!.id));
		assert.match(JSON.stringify(database.prepare('EXPLAIN QUERY PLAN SELECT * FROM admin_access_key_audit WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT 2').all(ACTIVE_ROW.id)), /idx_admin_access_key_audit_key_created/u);
		assert.equal(await repository.revealApiKeyWithAudit('missing', audit()), null);
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM admin_access_key_audit').get()?.count, 6);
	});

	it('D1 missing/failing audit storage rolls back every mutation and withholds reveal', async () => {
		const { database, repository } = createD1Harness();
		await repository.insertApiKey({ id: ACTIVE_ROW.id, name: ACTIVE_ROW.name, secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12), permissionsJson: ACTIVE_ROW.permissionsJson }, audit());
		database.exec(`CREATE TRIGGER reject_admin_key_audit BEFORE INSERT ON admin_access_key_audit BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
		for (const operation of [() => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()),
			() => repository.revokeApiKey(ACTIVE_ROW.id, audit()),
			() => repository.updateApiKey(ACTIVE_ROW.id, { name: 'never committed', permissionsJson: '["*"]' }, audit()),
			() => repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit()),
			() => repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()),
			() => repository.insertApiKey({ id: 'new-key', name: 'new-key', secretKey: ROTATED_KEY, keyPrefix: ROTATED_KEY.slice(0, 12), permissionsJson: '["*"]' }, audit())]) {
			await assert.rejects(operation, /injected audit failure/u);
		}
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.secretKey, ORIGINAL_KEY);
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.status, 'active');
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.name, ACTIVE_ROW.name);
		assert.equal(await repository.getApiKeyById('new-key'), null);
		assert.equal(database.prepare('SELECT COUNT(*) AS n FROM admin_access_key_audit').get()?.n, 1);
		database.exec('DROP TABLE admin_access_key_audit');
		await assert.rejects(() => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), /no such table/u);
		await assert.rejects(() => repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()), /no such table/u);
		assert.equal((await repository.getApiKeyById(ACTIVE_ROW.id))?.secretKey, ORIGINAL_KEY);
	});

	it('MySQL and PostgreSQL lock the key, commit matching audit, and roll back on audit failure', async () => {
		for (const driver of ['mysql', 'postgres'] as const) {
			const probe = createDrizzleMutationProbe();
			const repository = driver === 'mysql'
				? createMySqlAdminAccessRepository({ driver, raw: probe.mysqlRaw as unknown as MySqlDatabaseClient['raw'], drizzle: probe.drizzle as unknown as MySqlDatabaseClient['drizzle'] })
				: createPostgresAdminAccessRepository({ driver, raw: probe.postgresRaw as unknown as PostgresDatabaseClient['raw'], drizzle: probe.drizzle as unknown as PostgresDatabaseClient['drizzle'] });
			await repository.updateApiKey(ACTIVE_ROW.id, { permissionsJson: '["*"]', status: 'revoked' }, audit());
			assert.ok(probe.queries[0]!.sql.includes('FOR UPDATE'));
			const auditQuery = probe.queries.find((query) => query.sql.includes('INSERT INTO') && query.sql.includes('admin_access_key_audit'))!;
			assert.equal(auditQuery.values[6], ACTIVE_ROW.permissionsJson); assert.equal(auditQuery.values[7], '["*"]');
			assert.equal(auditQuery.values[8], 'active'); assert.equal(auditQuery.values[9], 'revoked');
			assert.equal(probe.commits(), 1);
			probe.failAudit();
			for (const operation of [() => repository.revealApiKeyWithAudit(ACTIVE_ROW.id, audit()),
				() => repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), () => repository.revokeApiKey(ACTIVE_ROW.id, audit()),
				() => repository.updateApiKey(ACTIVE_ROW.id, { name: 'changed' }, audit()),
				() => repository.updateApiKey(ACTIVE_ROW.id, { status: 'active', revokedAt: null }, audit()),
				() => repository.insertApiKey({ id: 'new-key', name: 'new', secretKey: ROTATED_KEY, keyPrefix: ROTATED_KEY.slice(0, 12), permissionsJson: '["*"]' }, audit())]) await assert.rejects(operation, /injected audit failure/u);
			assert.equal(probe.commits(), 1); assert.equal(probe.rollbacks(), 6);
			assert.ok(!JSON.stringify(probe.queries.filter((query) => query.sql.includes('INSERT INTO') && query.sql.includes('admin_access_key_audit'))).includes(ORIGINAL_KEY));
		}
	});

	it('D1 creates correctly mapped rows and invalidates replaced secrets immediately', async () => {
		const { database, repository } = createD1Harness();
		await repository.insertApiKey({
			id: ACTIVE_ROW.id,
			name: ACTIVE_ROW.name,
			description: 'integration key',
			secretKey: ORIGINAL_KEY,
			keyPrefix: ORIGINAL_KEY.slice(0, 12),
			permissionsJson: ACTIVE_ROW.permissionsJson,
		}, audit());

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
			audit(),
		), true);
		assert.equal(await repository.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
		assert.equal((await repository.getActiveApiKeyBySecret(ROTATED_KEY))?.id, ACTIVE_ROW.id);

		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			name: 'renamed automation',
			secretKey: REPLACEMENT_KEY,
		}, audit()), true);
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
		assert.equal(await repository.revokeApiKey(ACTIVE_ROW.id, audit()), true);
		assert.equal(await repository.getActiveApiKeyBySecret(ORIGINAL_KEY), null);
	});

	it('PostgreSQL writes a fresh hash for rotate and manual replacement', async () => {
		const probe = createDrizzleMutationProbe();
		const repository = createPostgresAdminAccessRepository({
			driver: 'postgres',
			raw: probe.postgresRaw as unknown as PostgresDatabaseClient['raw'],
			drizzle: probe.drizzle as unknown as PostgresDatabaseClient['drizzle'],
		});

		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), true);
		assert.equal(probe.writes[0]?.secretKey, ROTATED_KEY);
		assert.equal(probe.writes[0]?.secretKeyHash, await hashLookupKey(ROTATED_KEY));
		assert.equal(probe.writes[0]?.keyPrefix, ROTATED_KEY.slice(0, 12));
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			secretKey: REPLACEMENT_KEY,
		}, audit()), true);
		assert.equal(probe.writes[1]?.secretKeyHash, await hashLookupKey(REPLACEMENT_KEY));
		assert.equal(probe.writes[1]?.keyPrefix, REPLACEMENT_KEY.slice(0, 12));
	});

	it('MySQL writes a fresh hash for rotate and manual replacement', async () => {
		const probe = createDrizzleMutationProbe();
		const repository = createMySqlAdminAccessRepository({
			driver: 'mysql',
			raw: probe.mysqlRaw as unknown as MySqlDatabaseClient['raw'],
			drizzle: probe.drizzle as unknown as MySqlDatabaseClient['drizzle'],
		});

		assert.equal(await repository.rotateApiKey(ACTIVE_ROW.id, ROTATED_KEY, audit()), true);
		assert.equal(probe.writes[0]?.secretKey, ROTATED_KEY);
		assert.equal(probe.writes[0]?.secretKeyHash, await hashLookupKey(ROTATED_KEY));
		assert.equal(probe.writes[0]?.keyPrefix, ROTATED_KEY.slice(0, 12));
		assert.equal(await repository.updateApiKey(ACTIVE_ROW.id, {
			secretKey: REPLACEMENT_KEY,
		}, audit()), true);
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

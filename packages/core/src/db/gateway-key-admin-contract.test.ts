import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { sql } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createD1ApiKeysRepository } from './d1/api-keys.impl';
import { createMySqlApiKeysRepository } from './mysql/api-keys.impl';
import { createPostgresApiKeysRepository } from './postgres/api-keys.impl';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import type { AdminKeyMutationWithAudit } from '../storage/gateway-repository-interfaces';
import { snapshotToJson, userRowToSnapshot } from './user-audit-snapshot';
import { API_KEY_LIST_SORT_FIELDS } from './api-keys-list-sort';

function sqliteFixture() {
	const database = new DatabaseSync(':memory:');
	database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, budget_max REAL, budget_base REAL, budget_spent REAL,
		budget_period TEXT, budget_reset_at TEXT, budget_epoch INTEGER, budget_reserved_micros INTEGER, status TEXT,
		metadata TEXT, charged_cost_factors TEXT, external_system TEXT, external_user_id TEXT);
		INSERT INTO users VALUES ('u1','user@example.test',10,10,3,'none',NULL,0,0,'active',NULL,NULL,NULL,NULL);
		CREATE TABLE api_keys (id TEXT PRIMARY KEY, key TEXT, key_hash TEXT, key_preview TEXT, user_id TEXT, workspace_id TEXT,
		name TEXT, status TEXT, metadata TEXT, expires_at TEXT, limit_micros INTEGER, limit_reset TEXT, include_byok_in_limit INTEGER,
		limit_epoch INTEGER, last_used_at TEXT, created_at TEXT, updated_at TEXT);
		INSERT INTO api_keys(id,key,user_id,workspace_id,name,status,metadata,created_at,updated_at) VALUES
		('a','sk-legacy','u1','w1','before','active','{}','2026-09-30','2026-09-30'),
		('b','sk-legacy2','u1','w1','before','active','{}','2026-09-30','2026-09-30'),
		('c','sk-legacy3','u1','w1','before','active','{}','2026-09-30','2026-09-30');
		CREATE TABLE user_audit_logs (id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, event_type TEXT, actor_type TEXT,
		request_log_id TEXT, change_payload TEXT, before_user_snapshot TEXT, after_user_snapshot TEXT, changed_fields TEXT,
		correlation_id TEXT, source TEXT, actor_id TEXT, reason_code TEXT, reason_text TEXT);`);
	class Statement {
		constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
		bind(...values: SQLInputValue[]) { return new Statement(this.query, values) as unknown as D1PreparedStatement; }
		async first() { return database.prepare(this.query).get(...this.values) ?? null; }
		async all() { return { success: true, results: database.prepare(this.query).all(...this.values), meta: {} }; }
		run() { return { success: true, results: [], meta: { changes: Number(database.prepare(this.query).run(...this.values).changes) } }; }
	}
	const raw = { prepare: (query: string) => new Statement(query), batch: async (statements: Statement[]) => {
		database.exec('BEGIN');
		try { const result = statements.map(statement => statement.run()); database.exec('COMMIT'); return result; }
		catch (error) { database.exec('ROLLBACK'); throw error; }
	} } as unknown as D1Database;
	return { database, repo: createD1ApiKeysRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient) };
}

test('D1 real SQL pagination uses ID ties for every primary field and direction', async () => {
	const { database, repo } = sqliteFixture();
	try {
		for (const sort of API_KEY_LIST_SORT_FIELDS) for (const order of ['asc', 'desc'] as const) {
			const ids = [];
			for (let page = 1; page <= 3; page++) {
				const result = await repo.getAllApiKeys({ sort, order, page, pageSize: 1, userId: 'u1', email: 'user@example' });
				assert.equal(result.total, 3); ids.push(result.keys[0].id);
			}
			assert.deepEqual(ids, order === 'asc' ? ['a', 'b', 'c'] : ['c', 'b', 'a']);
		}
	} finally { database.close(); }
});

test('D1 atomic profile mutation rejects workspace races and rolls back missing/failing/ignored audit storage', async () => {
	const { database, repo } = sqliteFixture();
	const snapshot = userRowToSnapshot({ id: 'u1', email: 'user@example.test', budget_max: 10, budget_base: 10, budget_spent: 3,
		budget_period: 'none', budget_reset_at: null, budget_epoch: 0, budget_reserved_micros: 0, status: 'active', metadata: null,
		charged_cost_factors: null, external_system: null, external_user_id: null, created_at: '', updated_at: '' });
	const mutation: AdminKeyMutationWithAudit = { id: 'a', expected: { userId: 'u1', workspaceId: 'w1', name: 'before', status: 'active', metadata: '{}' },
		patch: { name: 'after', status: 'revoked' }, expectedUserSnapshot: snapshot,
		audit: { id: 'audit-1', userId: 'u1', apiKeyId: 'a', eventType: 'key_revoked', actorType: 'admin', actorId: 'console:test',
			reasonCode: 'admin_key_revoked', source: 'admin_keys', beforeUserSnapshot: snapshotToJson(snapshot), afterUserSnapshot: snapshotToJson(snapshot) } };
	const mutate = repo.applyAdminKeyMutationWithAudit!;
	const unchanged = () => assert.deepEqual({ ...database.prepare('SELECT name,status FROM api_keys WHERE id=\'a\'').get() }, { name: 'before', status: 'active' });
	try {
		database.exec("UPDATE api_keys SET workspace_id='moved' WHERE id='a'");
		assert.equal(await mutate(mutation), 'conflict'); unchanged();
		database.exec("UPDATE api_keys SET workspace_id='w1' WHERE id='a'");
		database.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON user_audit_logs BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
		await assert.rejects(() => mutate(mutation), /injected audit failure/u); unchanged();
		database.exec('DROP TRIGGER audit_fail');
		database.exec('CREATE TRIGGER audit_ignore BEFORE INSERT ON user_audit_logs BEGIN SELECT RAISE(IGNORE); END');
		assert.equal(await mutate(mutation), 'conflict'); unchanged();
		assert.equal(database.prepare('SELECT COUNT(*) AS n FROM user_audit_logs').get()!.n, 0);
		database.exec('DROP TRIGGER audit_ignore');
		database.exec('CREATE TRIGGER key_ignore BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(IGNORE); END');
		await assert.rejects(() => mutate(mutation), /malformed JSON/u); unchanged();
		assert.equal(database.prepare('SELECT COUNT(*) AS n FROM user_audit_logs').get()!.n, 0);
		database.exec('DROP TRIGGER key_ignore');
		assert.equal(await mutate(mutation), 'applied');
		assert.equal(database.prepare('SELECT status FROM api_keys WHERE id=\'a\'').get()!.status, 'revoked');
		assert.equal(database.prepare('SELECT COUNT(*) AS n FROM user_audit_logs').get()!.n, 1);
		database.exec('DROP TABLE user_audit_logs');
		await assert.rejects(() => mutate({ ...mutation, id: 'b', audit: { ...mutation.audit!, id: 'audit-2', apiKeyId: 'b' } }), /no such table/u);
		assert.equal(database.prepare('SELECT name FROM api_keys WHERE id=\'b\'').get()!.name, 'before');
	} finally { database.close(); }
});

for (const driver of ['mysql', 'postgres'] as const) test(`${driver} list compiles all sort orders with a stable ID tie and bound pagination/filter values`, async () => {
	const dialect = driver === 'mysql' ? new MySqlDialect() : new PgDialect();
	const orders: string[] = []; const filters: unknown[] = []; const limits: number[] = []; const offsets: number[] = [];
	const drizzle = { select: (projection: { total?: unknown }) => {
		const query = { from: () => query, innerJoin: () => query, where: (value: unknown) => { filters.push(value); return query; },
			orderBy: (...values: Parameters<typeof sql.join>[0]) => { orders.push(dialect.sqlToQuery(sql.join(values, sql`, `)).sql); return query; },
			limit: (value: number) => { limits.push(value); return query; }, offset: (value: number) => { offsets.push(value); return query; },
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(projection.total ? [{ total: 0 }] : []).then(resolve) };
		return query;
	} };
	const repo = driver === 'mysql' ? createMySqlApiKeysRepository({ driver, drizzle, raw: {} } as unknown as MySqlDatabaseClient)
		: createPostgresApiKeysRepository({ driver, drizzle, raw: {} } as unknown as PostgresDatabaseClient);
	for (const sort of API_KEY_LIST_SORT_FIELDS) for (const order of ['asc', 'desc'] as const) {
		await repo.getAllApiKeys({ sort, order, email: "x' OR 1=1 --", userId: 'owner', page: 3, pageSize: 2 });
		assert.equal(orders.at(-1)!.replace(/["`]/gu, '').toLowerCase().endsWith(`api_keys.id ${order}`), true, orders.at(-1));
	}
	assert.deepEqual(limits, [2, 2, 2, 2, 2, 2]); assert.deepEqual(offsets, [4, 4, 4, 4, 4, 4]);
	for (const filter of filters) {
		const compiled = dialect.sqlToQuery(filter as Parameters<typeof dialect.sqlToQuery>[0]);
		assert.equal(compiled.sql.includes("x' OR"), false); assert.deepEqual(compiled.params, ["%x' OR 1=1 --%", 'owner']);
	}
});

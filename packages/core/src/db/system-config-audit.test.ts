import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1SystemConfigRepository } from './d1/system-config.impl';
import { createMySqlSystemConfigRepository } from './mysql/system-config.impl';
import { createPostgresSystemConfigRepository } from './postgres/system-config.impl';
import { configAuditMetadata } from './system-config-audit';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import type { SystemConfigAuditWrite } from '../storage/gateway-repository-interfaces';

const secret = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-webhook-token';
const nowIso = '2026-09-28T01:02:03.000Z';
const write: SystemConfigAuditWrite = {
	auditId: '75a8e019-8bfe-4427-9ad7-a6a7f59485b9',
	key: 'ALERT_WEBHOOK_WECOM_URL', value: secret,
	actorKind: 'console', actorId: 'console:operator', nowIso,
};

class SqliteD1Statement {
	constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}
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
		return { success: true, results: this.database.prepare(this.sql).all(...this.values) as T[], meta: {} } as unknown as D1Result<T>;
	}
}

function d1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
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

test('D1 migration and repository commit only metadata and roll back config when audit insert fails', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE system_config (
			key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT
		)`);
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0069_config_change_audit.sql', import.meta.url)), 'utf8'));
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0070_system_config_revision.sql', import.meta.url)), 'utf8'));
		const repo = createD1SystemConfigRepository(d1Client(database));
		await repo.upsertSystemConfigValueWithAudit(write);
		assert.equal((database.prepare('SELECT value FROM system_config WHERE key = ?').get(write.key) as { value: string }).value, secret);
		const rows = database.prepare('SELECT * FROM config_change_audit').all() as unknown as Array<Record<string, unknown>>;
		assert.deepEqual(rows.map((row) => ({ ...row })), [{
			id: write.auditId, config_key: write.key, channel: 'wecom', action: 'set',
			actor_kind: 'console', actor_id: write.actorId, outcome: 'committed', created_at: nowIso,
		}]);
		assert.equal(JSON.stringify(rows).includes(secret), false);
		database.exec(`CREATE TRIGGER reject_config_audit BEFORE INSERT ON config_change_audit
			BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END`);
		await assert.rejects(repo.upsertSystemConfigValueWithAudit({
			...write, auditId: crypto.randomUUID(), value: 'new private value',
		}), /audit insert failed/);
		assert.equal((database.prepare('SELECT value FROM system_config WHERE key = ?').get(write.key) as { value: string }).value, secret);
		assert.equal((database.prepare('SELECT count(*) AS n FROM config_change_audit').get() as { n: number }).n, 1);
	} finally {
		database.close();
	}
});

test('D1 revision CAS accepts one stale-tab writer, rejects the other without audit, and generic writes advance revision', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE system_config (
			key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT
		)`);
		database.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run(write.key, 'old secret');
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0069_config_change_audit.sql', import.meta.url)), 'utf8'));
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0070_system_config_revision.sql', import.meta.url)), 'utf8'));
		const repo = createD1SystemConfigRepository(d1Client(database));
		const initial = await repo.getConfigSnapshot(write.key);
		assert.deepEqual(initial, { value: 'old secret', revision: 'legacy' });
		assert.deepEqual(await repo.getConfigSnapshot('MISSING'), { value: null, revision: null });

		const first = await repo.upsertSystemConfigValueWithAuditIfRevision({ ...write, expectedRevision: initial.revision });
		assert.equal(first.committed, true);
		assert.match(first.revision ?? '', /^[0-9a-f-]{36}$/u);
		const stale = await repo.upsertSystemConfigValueWithAuditIfRevision({
			...write, auditId: crypto.randomUUID(), value: 'stale-tab overwrite', expectedRevision: initial.revision,
		});
		assert.deepEqual(stale, { committed: false, revision: null });
		assert.deepEqual(await repo.getConfigSnapshot(write.key), { value: secret, revision: first.revision });
		assert.equal((database.prepare('SELECT count(*) AS n FROM config_change_audit').get() as { n: number }).n, 1);

		await repo.upsertSystemConfigValueWithAudit({ ...write, auditId: crypto.randomUUID(), value: 'legacy edit' });
		const afterLegacy = await repo.getConfigSnapshot(write.key);
		assert.equal(afterLegacy.value, 'legacy edit');
		assert.notEqual(afterLegacy.revision, first.revision);
		assert.deepEqual(await repo.upsertSystemConfigValueWithAuditIfRevision({
			...write, auditId: crypto.randomUUID(), expectedRevision: first.revision,
		}), { committed: false, revision: null });
		assert.equal((database.prepare('SELECT count(*) AS n FROM config_change_audit').get() as { n: number }).n, 2);

		const create = await repo.upsertSystemConfigValueWithAuditIfRevision({
			...write, auditId: crypto.randomUUID(), key: 'NEW_CONFIG', value: 'new', expectedRevision: null,
		});
		assert.equal(create.committed, true);
		assert.deepEqual(await repo.upsertSystemConfigValueWithAuditIfRevision({
			...write, auditId: crypto.randomUUID(), key: 'NEW_CONFIG', value: 'duplicate', expectedRevision: null,
		}), { committed: false, revision: null });
		assert.deepEqual(await repo.getConfigSnapshot('NEW_CONFIG'), { value: 'new', revision: create.revision });
		assert.equal((database.prepare('SELECT count(*) AS n FROM config_change_audit').get() as { n: number }).n, 3);

		database.exec(`CREATE TRIGGER reject_config_audit BEFORE INSERT ON config_change_audit
			BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END`);
		await assert.rejects(repo.upsertSystemConfigValueWithAuditIfRevision({
			...write, auditId: crypto.randomUUID(), value: 'must roll back', expectedRevision: afterLegacy.revision,
		}), /audit insert failed/u);
		assert.deepEqual(await repo.getConfigSnapshot(write.key), afterLegacy);
	} finally {
		database.close();
	}
});

test('D1 redacts nonstandard legacy config keys and derives clear without storing a value', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT)');
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0069_config_change_audit.sql', import.meta.url)), 'utf8'));
		database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0070_system_config_revision.sql', import.meta.url)), 'utf8'));
		const repo = createD1SystemConfigRepository(d1Client(database));
		await repo.upsertSystemConfigValueWithAudit({
			...write, key: 'https://private.example.test/hook?key=secret', value: ' ',
		});
		const row = database.prepare('SELECT config_key, channel, action FROM config_change_audit').get() as {
			config_key: string; channel: string | null; action: string;
		};
		assert.deepEqual({ ...row }, { config_key: '[nonstandard]', channel: null, action: 'clear' });
		assert.equal(JSON.stringify(row).includes('private.example.test'), false);
	} finally {
		database.close();
	}
});

test('audit preserves only known config keys, including five Web keys and tool catalogs', () => {
	for (const key of [
		'BUSINESS_TIMEZONE', 'BILLING_CURRENCY', 'ROUTE_STRATEGY',
		'ALERT_WEBHOOK_WECOM_URL', 'ALERT_WEBHOOK_FEISHU_URL',
		'WEB_SEARCH_CATALOG', 'WEB_FETCH_CATALOG', 'WEB_DEEP_SEARCH_CATALOG', 'AI_DETECTION_CATALOG',
		'SHARED_KEY_COMMISSION_RATE',
	]) {
		assert.equal(configAuditMetadata({ ...write, key }).configKey, key);
	}
	for (const key of ['CUSTOM_SETTING', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', 'https://private.example/hook']) {
		assert.equal(configAuditMetadata({ ...write, key }).configKey, '[nonstandard]');
	}
});

test('MySQL audited upsert uses one connection and rolls back on audit failure without binding secret in audit', async () => {
	for (const failAudit of [false, true]) {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const lifecycle: string[] = [];
		const connection = {
			async beginTransaction() { lifecycle.push('begin'); },
			async execute(sql: string, values: unknown[]) {
				calls.push({ sql, values });
				assert.equal((sql.match(/\?/gu) ?? []).length, values.length);
				if (sql.includes('system_config_write_mutex')) return [[{ id: 1 }], []];
				if (failAudit && sql.includes('INSERT INTO config_change_audit')) throw new Error('audit insert failed');
				return [{ affectedRows: 1 }, []];
			},
			async commit() { lifecycle.push('commit'); },
			async rollback() { lifecycle.push('rollback'); },
			release() { lifecycle.push('release'); },
		};
		const client = {
			driver: 'mysql', raw: { async getConnection() { return connection; } }, drizzle: {},
		} as unknown as MySqlDatabaseClient;
		const operation = createMySqlSystemConfigRepository(client).upsertSystemConfigValueWithAudit(write);
		if (failAudit) await assert.rejects(operation, /audit insert failed/);
		else await operation;
		assert.deepEqual(lifecycle, failAudit ? ['begin', 'rollback', 'release'] : ['begin', 'commit', 'release']);
		assert.equal(calls.length, 3);
		assert.match(calls[0]!.sql, /system_config_write_mutex WHERE id = 1 FOR UPDATE/u);
		assert.match(calls[1]!.sql, /INSERT INTO system_config/u);
		assert.deepEqual(calls[1]!.values.slice(0, 2), [write.key, secret]);
		assert.match(calls[2]!.sql, /INSERT INTO config_change_audit/u);
		assert.equal(JSON.stringify(calls[2]!.values).includes(secret), false);
		assert.deepEqual(calls[2]!.values.slice(0, 6), [
			write.auditId, write.key, 'wecom', 'set', 'console', write.actorId,
		]);
	}
});

test('MySQL conditional config write audits only the winning revision and rolls back on audit failure', async () => {
	for (const scenario of [
		{ expectedRevision: 'legacy', affected: 1, auditFails: false, duplicate: false, committed: true },
		{ expectedRevision: 'legacy', affected: 0, auditFails: false, duplicate: false, committed: false },
		{ expectedRevision: null, affected: 1, auditFails: false, duplicate: false, committed: true },
		{ expectedRevision: null, affected: 0, auditFails: false, duplicate: true, committed: false },
		{ expectedRevision: 'legacy', affected: 1, auditFails: true, duplicate: false, committed: false },
	] as const) {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const lifecycle: string[] = [];
		const connection = {
			async beginTransaction() { lifecycle.push('begin'); },
			async execute(sql: string, values: unknown[]) {
				calls.push({ sql, values });
				if (sql.includes('system_config_write_mutex')) return [[{ id: 1 }], []];
				if (scenario.duplicate && sql.includes('INSERT INTO system_config')) {
					throw Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' });
				}
				if (scenario.auditFails && sql.includes('INSERT INTO config_change_audit')) throw new Error('audit failed');
				return [{ affectedRows: scenario.affected }, []];
			},
			async commit() { lifecycle.push('commit'); },
			async rollback() { lifecycle.push('rollback'); },
			release() { lifecycle.push('release'); },
		};
		const client = {
			driver: 'mysql', raw: { async getConnection() { return connection; } }, drizzle: {},
		} as unknown as MySqlDatabaseClient;
		const operation = createMySqlSystemConfigRepository(client).upsertSystemConfigValueWithAuditIfRevision({
			...write, expectedRevision: scenario.expectedRevision,
		});
		if (scenario.auditFails) await assert.rejects(operation, /audit failed/u);
		else {
			const result = await operation;
			assert.equal(result.committed, scenario.committed);
			assert.equal(result.revision === null, !scenario.committed);
		}
		assert.deepEqual(lifecycle, scenario.committed
			? ['begin', 'commit', 'release'] : ['begin', 'rollback', 'release']);
		assert.match(calls[0]!.sql, /system_config_write_mutex WHERE id = 1 FOR UPDATE/u);
		assert.match(calls[1]!.sql, scenario.expectedRevision === null
			? /INSERT INTO system_config/u : /UPDATE system_config SET/u);
		assert.match(calls[1]!.sql, /revision/u);
		if (scenario.expectedRevision !== null) assert.match(calls[1]!.sql, /WHERE `key` = \? AND revision = \?/u);
		assert.equal(calls.length, scenario.committed || scenario.auditFails ? 3 : 2);
		if (calls[2]) {
			assert.match(calls[2].sql, /INSERT INTO config_change_audit/u);
			assert.equal(JSON.stringify(calls[2].values).includes(secret), false);
		}
	}
});

test('Postgres audited upsert schema-qualifies both writes in one transaction and rolls back on audit failure', async () => {
	for (const failAudit of [false, true]) {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const lifecycle: string[] = [];
		const tx = {
			async unsafe(sql: string, values: unknown[]) {
				calls.push({ sql, values });
				if (sql.includes('system_config_write_mutex')) return [{ id: 1 }];
				if (failAudit && sql.includes('INSERT INTO cinatoken_gateway.config_change_audit')) throw new Error('audit insert failed');
				return sql.includes('INSERT INTO cinatoken_gateway.system_config') ? [{ revision: values[3] }] : [{ inserted: 1 }];
			},
		};
		const raw = { async begin(callback: (transaction: typeof tx) => Promise<void>) {
			lifecycle.push('begin');
			try { await callback(tx); lifecycle.push('commit'); }
			catch (error) { lifecycle.push('rollback'); throw error; }
		} };
		const client = { driver: 'postgres', raw, drizzle: {} } as unknown as PostgresDatabaseClient;
		const operation = createPostgresSystemConfigRepository(client).upsertSystemConfigValueWithAudit(write);
		if (failAudit) await assert.rejects(operation, /audit insert failed/);
		else await operation;
		assert.deepEqual(lifecycle, failAudit ? ['begin', 'rollback'] : ['begin', 'commit']);
		assert.equal(calls.length, 3);
		assert.match(calls[0]!.sql, /cinatoken_gateway\.system_config_write_mutex WHERE id = 1 FOR UPDATE/u);
		assert.match(calls[1]!.sql, /INSERT INTO cinatoken_gateway\.system_config/u);
		assert.match(calls[2]!.sql, /INSERT INTO cinatoken_gateway\.config_change_audit/u);
		assert.deepEqual(calls[1]!.values.slice(0, 2), [write.key, secret]);
		assert.equal(JSON.stringify(calls[2]!.values).includes(secret), false);
		assert.deepEqual(calls[2]!.values.slice(0, 6), [
			write.auditId, write.key, 'wecom', 'set', 'console', write.actorId,
		]);
	}
});

test('Postgres conditional config write returns conflict without audit and rolls back audit failure', async () => {
	for (const scenario of [
		{ expectedRevision: 'legacy', winner: true, auditFails: false },
		{ expectedRevision: 'legacy', winner: false, auditFails: false },
		{ expectedRevision: null, winner: true, auditFails: false },
		{ expectedRevision: null, winner: false, auditFails: false },
		{ expectedRevision: 'legacy', winner: true, auditFails: true },
	] as const) {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const lifecycle: string[] = [];
		const tx = {
			async unsafe(sql: string, values: unknown[]) {
				calls.push({ sql, values });
				if (sql.includes('system_config_write_mutex')) return [{ id: 1 }];
				if (scenario.auditFails && sql.includes('INSERT INTO cinatoken_gateway.config_change_audit')) throw new Error('audit failed');
				return sql.includes('system_config') && !sql.includes('config_change_audit') ? (scenario.winner ? [{ revision: 'new' }] : []) : [{ inserted: 1 }];
			},
		};
		const raw = { async begin(callback: (transaction: typeof tx) => Promise<unknown>) {
			lifecycle.push('begin');
			try {
				const result = await callback(tx);
				lifecycle.push('commit');
				return result;
			} catch (error) {
				lifecycle.push('rollback');
				throw error;
			}
		} };
		const client = { driver: 'postgres', raw, drizzle: {} } as unknown as PostgresDatabaseClient;
		const operation = createPostgresSystemConfigRepository(client).upsertSystemConfigValueWithAuditIfRevision({
			...write, expectedRevision: scenario.expectedRevision,
		});
		if (scenario.auditFails) await assert.rejects(operation, /audit failed/u);
		else {
			const result = await operation;
			assert.equal(result.committed, scenario.winner);
			assert.equal(result.revision === null, !scenario.winner);
		}
		assert.deepEqual(lifecycle, scenario.auditFails ? ['begin', 'rollback'] : ['begin', 'commit']);
		assert.match(calls[0]!.sql, /cinatoken_gateway\.system_config_write_mutex WHERE id = 1 FOR UPDATE/u);
		assert.match(calls[1]!.sql, scenario.expectedRevision === null
			? /INSERT INTO cinatoken_gateway\.system_config/u : /UPDATE cinatoken_gateway\.system_config/u);
		assert.match(calls[1]!.sql, /RETURNING revision/u);
		if (scenario.expectedRevision !== null) assert.match(calls[1]!.sql, /WHERE key = \$4 AND revision = \$5/u);
		assert.equal(calls.length, scenario.winner ? 3 : 2);
		if (calls[2]) {
			assert.match(calls[2].sql, /INSERT INTO cinatoken_gateway\.config_change_audit/u);
			assert.equal(JSON.stringify(calls[2].values).includes(secret), false);
		}
	}
});

test('three migration schemas contain only bounded metadata, not config values or fingerprints', () => {
	for (const path of [
		'../../migrations-d1/0069_config_change_audit.sql',
		'../../migrations-mysql/0065_config_change_audit.sql',
		'../../migrations-postgres/0074_config_change_audit.sql',
	]) {
		const migration = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
		assert.match(migration, /CREATE TABLE (?:cinatoken_gateway\.)?config_change_audit/u);
		assert.match(migration, /outcome[^\n]*committed/u);
		assert.doesNotMatch(migration, /\b(?:webhook_url|value_hash|value_fingerprint|request_body|config_value)\b/u);
	}
});

test('three revision migrations add an opaque non-secret initial token', () => {
	for (const path of [
		'../../migrations-d1/0070_system_config_revision.sql',
		'../../migrations-mysql/0066_system_config_revision.sql',
		'../../migrations-postgres/0075_system_config_revision.sql',
	]) {
		const migration = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
		assert.match(migration, /ALTER TABLE (?:cinatoken_gateway\.)?system_config ADD COLUMN revision/u);
		assert.match(migration, /NOT NULL DEFAULT 'legacy'/u);
		assert.doesNotMatch(migration, /\b(?:webhook_url|value_hash|value_fingerprint|request_body|config_value)\b/u);
	}
});


type AuditedWriteMode = 'generic_create' | 'generic_update' | 'conditional_create' | 'conditional_update';

function configFixture() {
	const database = new DatabaseSync(':memory:');
	database.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT)');
	database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0069_config_change_audit.sql', import.meta.url)), 'utf8'));
	database.exec(readFileSync(fileURLToPath(new URL('../../migrations-d1/0070_system_config_revision.sql', import.meta.url)), 'utf8'));
	database.exec('CREATE TABLE system_config_write_mutex (id INTEGER PRIMARY KEY CHECK(id = 1)); INSERT INTO system_config_write_mutex VALUES (1)');
	database.prepare('INSERT INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)')
		.run(write.key, 'original private value', 'preserve existing description', nowIso);
	const state = () => JSON.stringify({
		config: database.prepare('SELECT * FROM system_config ORDER BY key').all(),
		audit: database.prepare('SELECT * FROM config_change_audit ORDER BY id').all(),
	});
	return { database, state };
}

function writeByMode(mode: AuditedWriteMode) {
	return { ...write, auditId: crypto.randomUUID(),
		key: mode.endsWith('_create') ? 'NEW_CONFIG' : write.key,
		value: 'replacement-private-config-value',
		expectedRevision: mode.endsWith('_create') ? null : 'legacy',
	};
}

const configModes: AuditedWriteMode[] = ['generic_create', 'generic_update', 'conditional_create', 'conditional_update'];

test('D1 ignored audit inserts fail inside the batch and preserve value, revision and audit on every write mode', async () => {
	for (const mode of configModes) {
		const { database, state } = configFixture();
		try {
			const repository = createD1SystemConfigRepository(d1Client(database));
			const before = state();
			database.exec('CREATE TRIGGER skip_config_audit BEFORE INSERT ON config_change_audit BEGIN SELECT RAISE(IGNORE); END');
			const input = writeByMode(mode);
			await assert.rejects(mode.startsWith('generic')
				? repository.upsertSystemConfigValueWithAudit(input)
				: repository.upsertSystemConfigValueWithAuditIfRevision(input));
			assert.equal(state(), before, mode + ' must roll back before batch commit');
			database.exec('DROP TRIGGER skip_config_audit');
			if (mode.startsWith('generic')) await repository.upsertSystemConfigValueWithAudit(input);
			else assert.equal((await repository.upsertSystemConfigValueWithAuditIfRevision(input)).committed, true);
			assert.equal((await repository.getConfigSnapshot(input.key)).value, input.value);
			const audits = database.prepare('SELECT * FROM config_change_audit').all();
			assert.equal(audits.length, 1);
			assert.equal(JSON.stringify(audits).includes(input.value), false);
		} finally { database.close(); }
	}
});

test('D1 ignored generic config writes cannot commit a ghost audit; ignored CAS writes remain non-winning', async () => {
	for (const mode of configModes) {
		const { database, state } = configFixture();
		try {
			const repository = createD1SystemConfigRepository(d1Client(database));
			const before = state();
			const event = mode.endsWith('_create') ? 'INSERT' : 'UPDATE';
			database.exec('CREATE TRIGGER skip_config_write BEFORE ' + event + ' ON system_config BEGIN SELECT RAISE(IGNORE); END');
			const input = writeByMode(mode);
			if (mode.startsWith('generic')) await assert.rejects(repository.upsertSystemConfigValueWithAudit(input));
			else assert.deepEqual(await repository.upsertSystemConfigValueWithAuditIfRevision(input), { committed: false, revision: null });
			assert.equal(state(), before, mode);
		} finally { database.close(); }
	}
});

/** Real repository SQL and bound values execute in a SQLite transaction wire.
 * MySQL upsert and PG schema/numbered parameters are translated for the fixture;
 * this proves observed rollback and parameter flow, not native engine semantics. */
function transactionalConfigWire(driver: 'mysql' | 'postgres', database: DatabaseSync) {
	const calls: { sql: string; values: unknown[] }[] = [];
	const lifecycle: string[] = [];
	const execute = (sql: string, values: unknown[]) => {
		calls.push({ sql, values: [...values] });
		assert.equal(/config_change_audit/u.test(sql) && JSON.stringify(values).includes('replacement-private-config-value'), false);
		let executable = sql.replace(/cinatoken_gateway\./gu, '').replace(/\$(\d+)/gu, '?').replace(/ FOR UPDATE/gu, '');
		if (driver === 'mysql' && sql.includes('ON DUPLICATE KEY UPDATE')) {
			executable = executable.replace(/ON DUPLICATE KEY UPDATE[\s\S]*/u,
				'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, revision = excluded.revision');
		}
		const existed = sql.includes('ON DUPLICATE KEY UPDATE') && !!database.prepare('SELECT key FROM system_config WHERE key = ?').get(values[0] as string);
		if (driver === 'postgres' || /^SELECT /u.test(executable)) return database.prepare(executable).all(...values as SQLInputValue[]);
		const result = database.prepare(executable).run(...values as SQLInputValue[]);
		return { affectedRows: result.changes ? (existed ? 2 : 1) : 0 };
	};
	if (driver === 'mysql') {
		const connection = {
			async beginTransaction() { lifecycle.push('begin'); database.exec('BEGIN IMMEDIATE'); },
			async execute(sql: string, values: unknown[]) { return [execute(sql, values), []]; },
			async commit() { lifecycle.push('commit'); database.exec('COMMIT'); },
			async rollback() { lifecycle.push('rollback'); database.exec('ROLLBACK'); },
			release() { lifecycle.push('release'); },
		};
		const client = { driver, raw: { async getConnection() { return connection; } }, drizzle: {} } as unknown as MySqlDatabaseClient;
		return { repository: createMySqlSystemConfigRepository(client), calls, lifecycle };
	}
	const client = { driver, raw: {
		async begin(callback: (tx: { unsafe(sql: string, values: unknown[]): Promise<unknown> }) => Promise<unknown>) {
			lifecycle.push('begin'); database.exec('BEGIN IMMEDIATE');
			try {
				const result = await callback({ async unsafe(sql, values) { return execute(sql, values); } });
				lifecycle.push('commit'); database.exec('COMMIT'); return result;
			} catch (error) { lifecycle.push('rollback'); database.exec('ROLLBACK'); throw error; }
		},
	}, drizzle: {} } as unknown as PostgresDatabaseClient;
	return { repository: createPostgresSystemConfigRepository(client), calls, lifecycle };
}

for (const driver of ['mysql', 'postgres'] as const) {
	test(driver + ' ignored audit result rolls back actual captured SQL state for all config write modes', async () => {
		for (const mode of configModes) {
			const { database, state } = configFixture();
			try {
				const wire = transactionalConfigWire(driver, database), input = writeByMode(mode), before = state();
				database.exec('CREATE TRIGGER skip_config_audit BEFORE INSERT ON config_change_audit BEGIN SELECT RAISE(IGNORE); END');
				await assert.rejects(mode.startsWith('generic')
					? wire.repository.upsertSystemConfigValueWithAudit(input)
					: wire.repository.upsertSystemConfigValueWithAuditIfRevision(input), /Config audit did not commit/u);
				assert.equal(state(), before, mode);
				assert.deepEqual(wire.lifecycle, driver === 'mysql' ? ['begin', 'rollback', 'release'] : ['begin', 'rollback']);
				assert.equal(wire.calls.length, 3);
				assert.match(wire.calls[0]!.sql, /system_config_write_mutex.*FOR UPDATE/u);
				database.exec('DROP TRIGGER skip_config_audit');
				if (mode.startsWith('generic')) await wire.repository.upsertSystemConfigValueWithAudit(input);
				else assert.equal((await wire.repository.upsertSystemConfigValueWithAuditIfRevision(input)).committed, true);
				assert.equal((database.prepare('SELECT value FROM system_config WHERE key = ?').get(input.key) as { value: string }).value, input.value);
				assert.equal(database.prepare('SELECT id FROM config_change_audit').all().length, 1);
			} finally { database.close(); }
		}
	});
	test(driver + ' ignored config result cannot commit a ghost audit; CAS conflict has no audit call', async () => {
		for (const mode of configModes) {
			const { database, state } = configFixture();
			try {
				const wire = transactionalConfigWire(driver, database), input = writeByMode(mode), before = state();
				const event = mode.endsWith('_create') ? 'INSERT' : 'UPDATE';
				database.exec('CREATE TRIGGER skip_config_write BEFORE ' + event + ' ON system_config BEGIN SELECT RAISE(IGNORE); END');
				if (mode.startsWith('generic')) await assert.rejects(wire.repository.upsertSystemConfigValueWithAudit(input), /Config write did not commit/u);
				else assert.deepEqual(await wire.repository.upsertSystemConfigValueWithAuditIfRevision(input), { committed: false, revision: null });
				assert.equal(state(), before, mode);
				assert.equal(wire.calls.length, 2);
			} finally { database.close(); }
		}
	});
}

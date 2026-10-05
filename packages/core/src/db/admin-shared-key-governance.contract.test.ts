import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import type { SharedKeysRepository } from '../storage/gateway-repository-interfaces';
import { createEncryptedSharedKeysRepository, encryptSharedKeySecret } from '../lib/shared-key-encryption';
import { createD1SharedKeyAdminRepository, createMySqlSharedKeyAdminRepository, createPostgresSharedKeyAdminRepository } from './admin-shared-key-repository';
import { sharedKeyStateExpectation, type SharedKeyStateExpectation } from './shared-keys-types';
import { assertAdminSharedKeyAudit, sharedKeyAdminInstant, sharedKeyAdminRevision, type AdminSharedKeyAuditContext, type AdminSharedKeyUpdate } from './admin-shared-key-governance';
import { SHARED_KEY_STATE_COLUMNS, sharedKeyStateValues } from './shared-key-state';

const stamp = '2026-09-30T00:00:00.000123Z'; const now = '2026-09-30T01:00:00.000Z';
const secret = 'sk-private-material-12345678901234567890'; const fingerprint = 'raw-fingerprint-private-1234567890';
const expected: SharedKeyStateExpectation = { sellerUserId: 'seller-1', channelType: 'openai', keyFingerprint: fingerprint,
	status: 'active', validatedAt: stamp, label: 'private-label', sellerPriority: 3, weight: 10, inputPrice: 1.5, outputPrice: 2, cacheReadPrice: null, cacheWritePrice: 0.5 };
const audit = (overrides: Partial<AdminSharedKeyAuditContext> = {}): AdminSharedKeyAuditContext => ({ auditId: crypto.randomUUID(),
	actorKind: 'console', actorId: 'console:operator', source: 'admin_api', reason: 'Support requested a governance adjustment', nowIso: now, ...overrides });

const actorBoundsSql = () => readFileSync(new NodeURL('../../migrations-d1/0075_admin_shared_key_actor_bounds.sql', import.meta.url), 'utf8');
const actorBoundsStatements = () => actorBoundsSql().replace(/^--.*$/gmu, '').split(';').map(statement => statement.trim()).filter(Boolean);
function historicalAuditFixture() {
	const f = fixture('d1', false);
	f.database.exec('PRAGMA foreign_keys = ON');
	const base: Record<string, SQLInputValue> = {
		id: crypto.randomUUID(), key_id: 'key-1', action: 'updated', change_mask: 4,
		actor_kind: 'console', actor_id: 'console:cinaauth:' + 'a'.repeat(583), source: 'legacy_admin', reason: 'r'.repeat(600),
		before_status: 'active', before_seller_priority: -3, before_weight: 10, before_validated: 1,
		after_status: 'active', after_seller_priority: -3, after_weight: 20, after_validated: 1,
		before_revision: 'sha256:' + 'a'.repeat(64), after_revision: 'sha256:' + 'b'.repeat(64), created_at: stamp,
	};
	const columns = Object.keys(base);
	const insert = (changes: Record<string, SQLInputValue> = {}) => {
		const row: Record<string, SQLInputValue> = { ...base, id: crypto.randomUUID(), ...changes };
		f.database.prepare(`INSERT INTO admin_shared_key_audit (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => row[column]!));
	};
	insert();
	insert({ key_id: 'historical-deleted-key', action: 'deleted', change_mask: 8, actor_kind: 'api_key', actor_id: 'a'.repeat(600),
		before_status: 'invalid', before_validated: 0, after_status: null, after_seller_priority: null, after_weight: null, after_validated: null, after_revision: null,
		created_at: '2026-09-29T23:59:59.999999Z' });
	return { ...f, columns, insert, history: () => f.database.prepare('SELECT * FROM admin_shared_key_audit ORDER BY id').all(),
		schema: () => f.database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() };
}

test('trusted Console actor accommodates raw subjects 583/584/600 without widening API-key or reason bounds', () => {
	for (const length of [583, 584, 600]) {
		const actorId = 'console:cinaauth:' + 'x'.repeat(length);
		assert.equal(actorId.length, length + 17);
		assert.doesNotThrow(() => assertAdminSharedKeyAudit(audit({ actorId, reason: 'r'.repeat(600) })));
	}
	for (const actorId of ['x', 'x'.repeat(600)]) assert.doesNotThrow(() => assertAdminSharedKeyAudit(audit({ actorKind: 'api_key', actorId })));
	for (const context of [audit({ actorId: 'x'.repeat(618) }), audit({ actorKind: 'api_key', actorId: 'x'.repeat(601) }),
		audit({ actorId: '' }), audit({ actorId: 'actor\ncontrol' }), audit({ reason: 'r'.repeat(601) }), audit({ reason: 'unsafe\nreason' }),
		audit({ actorKind: 'invalid' as 'console' })]) assert.throws(() => assertAdminSharedKeyAudit(context), TypeError);
});

test('formal D1 actor upgrade preserves all 19 columns, existing CHECKs, deleted history, microseconds and indexes with foreign keys on', () => {
	const f = historicalAuditFixture();
	try {
		const history = f.history(); const info = f.database.prepare('PRAGMA table_info(admin_shared_key_audit)').all();
		const auditIndex = f.database.prepare('PRAGMA index_xinfo(idx_admin_shared_key_audit_key_created)').all();
		const sharedIndex = f.database.prepare("SELECT sql FROM sqlite_master WHERE name='idx_shared_keys_admin_order'").get();
		assert.equal(info.length, 19);
		assert.throws(() => f.insert({ actor_id: 'x'.repeat(601) }), /CHECK/u);
		const sql = actorBoundsSql(); const executable = sql.replace(/^--.*$/gmu, '');
		assert.doesNotMatch(executable, /\b(?:BEGIN|COMMIT|PRAGMA|REFERENCES)\b/iu);
		const original = readFileSync(new NodeURL('../../migrations-d1/0074_admin_shared_key_audit.sql', import.meta.url), 'utf8');
		const oldDefinition = original.slice(original.indexOf('CREATE TABLE'), original.indexOf('\n);') + 3)
			.replace('CREATE TABLE admin_shared_key_audit (', 'CREATE TABLE admin_shared_key_audit_actor_bound_upgrade (')
			.replace('CHECK (length(actor_id) BETWEEN 1 AND 600)', "CHECK ((actor_kind = 'console' AND length(actor_id) BETWEEN 1 AND 617) OR (actor_kind = 'api_key' AND length(actor_id) BETWEEN 1 AND 600))");
		assert.equal(actorBoundsStatements()[0]!.replace(/\s+/gu, ''), oldDefinition.slice(0, -1).replace(/\s+/gu, ''));
		f.database.exec('BEGIN IMMEDIATE'); f.database.exec(sql); f.database.exec('COMMIT');
		assert.deepEqual(f.history(), history);
		assert.deepEqual(f.database.prepare('PRAGMA table_info(admin_shared_key_audit)').all(), info);
		assert.deepEqual(f.database.prepare('PRAGMA index_xinfo(idx_admin_shared_key_audit_key_created)').all(), auditIndex);
		assert.deepEqual(f.database.prepare("SELECT sql FROM sqlite_master WHERE name='idx_shared_keys_admin_order'").get(), sharedIndex);
		assert.deepEqual(f.database.prepare('PRAGMA foreign_key_list(admin_shared_key_audit)').all(), []);
		assert.equal(f.database.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
		assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
		assert.equal(f.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='admin_shared_key_audit_actor_bound_upgrade'").get()!.n, 0);
		for (const length of [600, 601, 617]) f.insert({ actor_id: 'x'.repeat(length) });
		f.insert({ actor_kind: 'api_key', actor_id: 'x'.repeat(600) });
		const oversizedActors: Record<string, SQLInputValue>[] = [{ actor_id: 'x'.repeat(618) }, { actor_kind: 'api_key', actor_id: 'x'.repeat(601) }];
		for (const changes of oversizedActors) assert.throws(() => f.insert(changes), /CHECK/u);
	} finally { f.database.close(); }
});

test('formal D1 actor upgrade retains all prior non-actor rejection contracts and primary/required columns', () => {
	const f = historicalAuditFixture();
	try {
		f.database.exec('BEGIN IMMEDIATE'); f.database.exec(actorBoundsSql()); f.database.exec('COMMIT');
		const invalid: Record<string, SQLInputValue>[] = [
			{ action: 'invalid-action' }, { change_mask: 0 }, { change_mask: 16 }, { actor_kind: 'other' }, { actor_id: '' },
			{ source: 'web' }, { reason: '' }, { reason: 'r'.repeat(601) }, { before_status: 'other' }, { before_validated: 2 },
			{ after_status: 'other' }, { after_validated: 2 }, { action: 'deleted' }, { after_status: null }, { after_seller_priority: null },
			{ after_weight: null }, { after_validated: null }, { after_revision: null }, { key_id: null }, { before_revision: null }, { created_at: null },
		];
		for (const changes of invalid) assert.throws(() => f.insert(changes), /(?:CHECK|NOT NULL)/u, JSON.stringify(Object.keys(changes)));
		assert.throws(() => f.insert({ id: f.history()[0]!.id! }), /UNIQUE/u);
	} finally { f.database.close(); }
});

for (const stage of ['create', 'copy', 'drop', 'rename', 'index'] as const) {
	test(`formal D1 actor upgrade rolls back an injected failure after ${stage} without losing original history/schema`, () => {
		const f = historicalAuditFixture();
		try {
			const history = f.history(); const schema = f.schema(); const statements = actorBoundsStatements();
			assert.equal(statements.length, 5);
			f.database.exec('BEGIN IMMEDIATE');
			assert.throws(() => {
				for (let i = 0; i <= ['create', 'copy', 'drop', 'rename', 'index'].indexOf(stage); i++) f.database.exec(statements[i]!);
				f.database.exec('SELECT missing_actor_migration_column FROM shared_keys');
			}, /no such column/u);
			f.database.exec('ROLLBACK');
			assert.deepEqual(f.history(), history); assert.deepEqual(f.schema(), schema);
			assert.throws(() => f.insert({ actor_id: 'x'.repeat(601) }), /CHECK/u);
		} finally { f.database.close(); }
	});
}

test('formal D1 actor migration copy failure rolls back the created replacement and retains deleted history', () => {
	const f = historicalAuditFixture();
	try {
		const history = f.history(); const schema = f.schema(); const statements = actorBoundsStatements();
		f.database.exec('BEGIN IMMEDIATE'); f.database.exec(statements[0]!);
		f.database.exec("CREATE TRIGGER actor_migration_copy_fault BEFORE INSERT ON admin_shared_key_audit_actor_bound_upgrade BEGIN SELECT RAISE(ABORT, 'actor-copy-injected-failure'); END");
		assert.throws(() => f.database.exec(statements[1]!), /actor-copy-injected-failure/u);
		f.database.exec('ROLLBACK');
		assert.deepEqual(f.history(), history); assert.deepEqual(f.schema(), schema);
	} finally { f.database.close(); }
});

test('pre-upgrade D1 schema rejects a new long actor atomically instead of committing an unaudited governance change', async () => {
	const f = fixture('d1', false);
	try {
		const before = f.current();
		await assert.rejects(() => f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' }, audit: audit({ actorId: 'console:cinaauth:' + 'x'.repeat(600) }) }), /CHECK/u);
		assert.deepEqual(f.current(), before); assert.equal(f.audits().length, 0); assert.equal(f.commits(), 0); assert.equal(f.rollbacks(), 1);
	} finally { f.database.close(); }
});

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	test(`${driver} repository preserves exact trusted Console actors and rejects API-key/reason excess before IO`, async () => {
		const f = fixture(driver);
		try {
			let profile = { ...expected };
			for (const length of [583, 584, 600]) {
				const actorId = 'console:cinaauth:' + 'x'.repeat(length); const weight = profile.weight + 1;
				assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected: profile, patch: { weight }, audit: audit({ actorId }) }), 'applied');
				profile = { ...profile, weight }; assert.equal(f.audits().at(-1)!.actor_id, actorId);
			}
			const actorId = 'a'.repeat(600); const weight = profile.weight + 1;
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected: profile, patch: { weight }, audit: audit({ actorKind: 'api_key', actorId, reason: 'r'.repeat(600) }) }), 'applied');
			profile = { ...profile, weight }; assert.equal(f.audits().at(-1)!.actor_id, actorId); assert.equal(String(f.audits().at(-1)!.reason).length, 600);
			const queries = f.queries.length; const current = f.current(); const history = f.audits();
			for (const context of [audit({ actorId: 'x'.repeat(618) }), audit({ actorKind: 'api_key', actorId: 'a'.repeat(601) }), audit({ reason: 'r'.repeat(601) })]) {
				await assert.rejects(() => f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected: profile, patch: { weight: 30 }, audit: context }), TypeError);
			}
			assert.equal(f.queries.length, queries); assert.deepEqual(f.current(), current); assert.deepEqual(f.audits(), history);
			const rows = await f.repo.listSharedKeyAdminAudit('key-1', { limit: 100 }); assert.ok(rows.some(row => row.actorKind === 'console' && row.actorId.length === 617));
		} finally { f.database.close(); }
	});
}

test('formal MySQL/PG actor migrations are bounded ALTER-only offline SQL contracts, preserving unrelated checks and data shape', () => {
	const mysql = readFileSync(new NodeURL('../../migrations-mysql/0071_admin_shared_key_actor_bounds.sql', import.meta.url), 'utf8').replace(/^--.*$/gmu, '');
	const postgres = readFileSync(new NodeURL('../../migrations-postgres/0080_admin_shared_key_actor_bounds.sql', import.meta.url), 'utf8').replace(/^--.*$/gmu, '');
	for (const sql of [mysql, postgres]) {
		assert.equal((sql.match(/\bALTER TABLE\b/gu) ?? []).length, 1);
		assert.doesNotMatch(sql, /\b(?:CREATE|INSERT|UPDATE|DELETE|REFERENCES|reason|created_at|key_id)\b/iu);
		assert.match(sql, /actor_kind = 'console' AND (?:CHAR_LENGTH|length)\(actor_id\) BETWEEN 1 AND 617/u);
		assert.match(sql, /actor_kind = 'api_key' AND (?:CHAR_LENGTH|length)\(actor_id\) BETWEEN 1 AND 600/u);
	}
	assert.equal(mysql.split(';').filter(statement => statement.trim()).length, 1);
	assert.match(mysql, /DROP CHECK admin_shared_key_audit_actor_chk/u); assert.match(mysql, /MODIFY COLUMN actor_id VARCHAR\(617\) NOT NULL/u);
	assert.match(mysql, /ADD CONSTRAINT admin_shared_key_audit_actor_chk CHECK/u);
	assert.match(postgres, /SET LOCAL lock_timeout = '2s';/u);
	assert.match(postgres, /DROP CONSTRAINT admin_shared_key_audit_actor_id_check/u); assert.match(postgres, /ADD CONSTRAINT admin_shared_key_audit_actor_id_check CHECK/u);
	const drizzle = readFileSync(new NodeURL('../storage/drizzle/schema.mysql.ts', import.meta.url), 'utf8');
	const sharedAudit = drizzle.slice(drizzle.indexOf('export const adminSharedKeyAuditTable'), drizzle.indexOf('export const adminSharedKeyAuditTable') + 1000);
	assert.match(sharedAudit, /actorId: varchar\("actor_id", \{ length: 617 \}\)/u); assert.match(sharedAudit, /reason: varchar\("reason", \{ length: 600 \}\)/u);
});

/** Real SQLite executes production D1 SQL. Native driver SQL is captured and only syntax/time formatting
 * adapted for offline transaction/predicate evidence; this is not a native engine, locking, or role acceptance. */
function fixture(driver: 'd1' | 'mysql' | 'postgres', actorBoundsMigration = true) {
	const database = new DatabaseSync(':memory:');
	database.exec(`CREATE TABLE shared_keys (id TEXT PRIMARY KEY, seller_user_id TEXT, channel_type TEXT, api_key TEXT, key_fingerprint TEXT,
		label TEXT, status TEXT, seller_priority INTEGER, weight INTEGER, input_price REAL, output_price REAL,
		cache_read_price REAL, cache_write_price REAL, validated_at TEXT, last_used_at TEXT, last_failure_at TEXT, failure_reason TEXT,
		served_input_tokens INTEGER DEFAULT 0, served_output_tokens INTEGER DEFAULT 0, earned_total REAL DEFAULT 0, created_at TEXT, updated_at TEXT)`);
	database.exec(readFileSync(new NodeURL('../../migrations-d1/0074_admin_shared_key_audit.sql', import.meta.url), 'utf8'));
	if (actorBoundsMigration) database.exec(readFileSync(new NodeURL('../../migrations-d1/0075_admin_shared_key_actor_bounds.sql', import.meta.url), 'utf8'));
	const queries: { sql: string; values: unknown[] }[] = []; let commits = 0; let rollbacks = 0; let beforeBatch: (() => void) | null = null;
	function insert(id = 'key-1', changes: Partial<SharedKeyStateExpectation> = {}) {
		const state = { ...expected, ...changes }; const values = sharedKeyStateValues(state);
		if (driver === 'mysql' && typeof values[4] === 'string') values[4] = values[4].replace('T', ' ').replace('Z', '');
		database.prepare(`INSERT INTO shared_keys (id, ${SHARED_KEY_STATE_COLUMNS.join(', ')}, api_key, created_at, updated_at) VALUES (${Array(16).fill('?').join(', ')})`)
			.run(id, ...values, secret, now, now);
	}
	insert();
	function execute(sql: string, values: unknown[] = []) {
		queries.push({ sql, values: [...values] });
		let adapted = sql.replaceAll('cinatoken_gateway.', '').replace(/ FOR UPDATE\b/gu, '').replaceAll('<=>', 'IS');
		adapted = adapted.replace(/to_char\((\w+) AT TIME ZONE 'UTC', '[^']+'\) AS (\w+)/gu, '$1 AS $2')
			.replace(/DATE_FORMAT\((\w+), '[^']+'\) AS (\w+)/gu, "admin_instant($1) AS $2").replace(/\$\d+/gu, '?');
		const statement = database.prepare(adapted);
		if (/^\s*SELECT\b/iu.test(adapted) || / RETURNING /iu.test(adapted)) return { rows: statement.all(...values as SQLInputValue[]), changes: 0 };
		return { rows: [], changes: Number(statement.run(...values as SQLInputValue[]).changes) };
	}
	database.function('admin_instant', (value) => value === null ? null : sharedKeyAdminInstant(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z')));
	class Statement {
		constructor(readonly sql: string, readonly values: unknown[] = []) {}
		bind(...values: unknown[]) { return new Statement(this.sql, values); }
		async all() { return { success: true, meta: {}, results: execute(this.sql, this.values).rows }; }
		async run() { return { success: true, meta: { changes: execute(this.sql, this.values).changes }, results: [] }; }
	}
	const d1 = { prepare: (sql: string) => new Statement(sql), async batch(statements: Statement[]) {
		beforeBatch?.(); beforeBatch = null; database.exec('BEGIN');
		try { const result = []; for (const statement of statements) result.push(/^\s*SELECT\b/u.test(statement.sql) ? await statement.all() : await statement.run());
			database.exec('COMMIT'); commits++; return result; } catch (error) { database.exec('ROLLBACK'); rollbacks++; throw error; }
	} };
	const mysqlConnection = { async execute(sql: string, values: unknown[] = []) { const result = execute(sql, values); return [/^\s*SELECT\b/u.test(sql) ? result.rows : { affectedRows: result.changes }, []]; },
		async beginTransaction() { database.exec('BEGIN'); }, async commit() { database.exec('COMMIT'); commits++; },
		async rollback() { database.exec('ROLLBACK'); rollbacks++; }, release() {} };
	const mysql = { execute: mysqlConnection.execute, getConnection: async () => mysqlConnection };
	const postgres = { unsafe: async (sql: string, values: unknown[]) => execute(sql, values).rows, async begin(run: (tx: unknown) => Promise<unknown>) {
		database.exec('BEGIN'); try { const result = await run({ unsafe: postgres.unsafe }); database.exec('COMMIT'); commits++; return result; }
		catch (error) { database.exec('ROLLBACK'); rollbacks++; throw error; }
	} };
	const repo = driver === 'd1' ? createD1SharedKeyAdminRepository({ raw: d1 } as unknown as D1DatabaseClient)
		: driver === 'mysql' ? createMySqlSharedKeyAdminRepository({ raw: mysql } as unknown as MySqlDatabaseClient)
			: createPostgresSharedKeyAdminRepository({ raw: postgres } as unknown as PostgresDatabaseClient);
	return { database, repo, queries, insert, commits: () => commits, rollbacks: () => rollbacks,
		current: () => database.prepare("SELECT * FROM shared_keys WHERE id='key-1'").get(),
		audits: () => database.prepare('SELECT * FROM admin_shared_key_audit ORDER BY rowid').all(),
		change: (column: string, value: SQLInputValue) => database.prepare(`UPDATE shared_keys SET ${column}=? WHERE id='key-1'`).run(value),
		beforeBatch: (run: () => void) => { beforeBatch = run; } };
}

test('governance revision binds all profile fields/id, excludes usage/ciphertext, and preserves microseconds', async () => {
	const revision = await sharedKeyAdminRevision('key-1', expected); assert.match(revision, /^sha256:[0-9a-f]{64}$/u);
	assert.notEqual(await sharedKeyAdminRevision('key-2', expected), revision);
	for (const [field, value] of Object.entries({ sellerUserId: 'seller-2', channelType: 'anthropic', keyFingerprint: 'other', status: 'disabled', validatedAt: null,
		label: 'other', sellerPriority: 4, weight: 11, inputPrice: 2, outputPrice: 3, cacheReadPrice: 0, cacheWritePrice: null })) {
		assert.notEqual(await sharedKeyAdminRevision('key-1', { ...expected, [field]: value }), revision, field);
	}
	assert.equal(await sharedKeyAdminRevision('key-1', { ...expected, validatedAt: '2026-09-30 00:00:00.000123Z' }), revision);
	assert.notEqual(await sharedKeyAdminRevision('key-1', { ...expected, validatedAt: '2026-09-30T00:00:00.000124Z' }), revision);
	const extra = { ...expected, apiKey: 'changed-ciphertext', servedInputTokens: 999, updatedAt: now };
	assert.equal(await sharedKeyAdminRevision('key-1', extra), revision);
});

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	test(`${driver} stable bounded list filters escape SQL patterns and direct inputs fail before IO`, async () => {
		const f = fixture(driver);
		try {
			f.insert('key-0'); f.insert('key-2', { sellerPriority: 5 }); f.insert('literal%_!', { label: 'literal%_!' });
			const first = await f.repo.listAdminSharedKeys({ page: 1, pageSize: 2 }); const second = await f.repo.listAdminSharedKeys({ page: 2, pageSize: 2 });
			assert.deepEqual(first.keys.map(key => key.id), ['key-2', 'key-0']); assert.deepEqual(second.keys.map(key => key.id), ['key-1', 'literal%_!']); assert.equal(first.total, 4);
			const found = await f.repo.listAdminSharedKeys({ page: 1, pageSize: 100, status: 'active', channelType: 'openai', sellerUserId: 'seller-1', search: '%_!' });
			assert.deepEqual(found.keys.map(key => key.id), ['literal%_!']); assert.equal(found.total, 1);
			assert.ok(f.queries.every(query => !query.sql.includes('%_!'))); assert.ok(f.queries.some(query => query.values.includes('%!%!_!!%')));
			assert.ok(f.queries.some(query => /ORDER BY seller_priority DESC, weight DESC, id ASC LIMIT/u.test(query.sql)));
			const count = f.queries.length;
			for (const options of [{ page: 0, pageSize: 20 }, { page: 1, pageSize: 101 }, { page: 1_000_001, pageSize: 20 }, { page: 1, pageSize: 20, status: 'other' },
				{ page: 1, pageSize: 20, channelType: 'other' }, { page: 1, pageSize: 20, search: ' x ' }, { page: 1, pageSize: 20, order: 'asc' }]) {
				await assert.rejects(() => f.repo.listAdminSharedKeys(options as Parameters<typeof f.repo.listAdminSharedKeys>[0]));
			}
			assert.equal(f.queries.length, count);
		} finally { f.database.close(); }
	});
	test(`${driver} full-profile CAS rejects every drift and usage/encryption changes remain writable`, async () => {
		const f = fixture(driver);
		try {
			for (const [column, value] of [['seller_user_id', 'other'], ['channel_type', 'anthropic'], ['key_fingerprint', 'other'], ['status', 'disabled'], ['validated_at', null], ['label', 'other'],
				['seller_priority', 4], ['weight', 11], ['input_price', 2], ['output_price', 3], ['cache_read_price', 0], ['cache_write_price', null]] as [string, SQLInputValue][]) {
				const before = f.current()!; f.change(column, value); const concurrent = f.current();
				assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled', weight: 20 }, audit: audit() }), 'conflict', column);
				assert.deepEqual(f.current(), concurrent); assert.equal(f.audits().length, 0); f.change(column, before[column] as SQLInputValue);
			}
			f.change('served_input_tokens', 999); f.change('earned_total', 123); f.change('api_key', 'changed-ciphertext'); f.change('updated_at', '2026-09-30T05:00:00.000Z');
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { sellerPriority: 4, weight: 20 }, audit: audit() }), 'applied');
			assert.equal(f.current()!.served_input_tokens, 999); assert.equal(f.current()!.api_key, 'changed-ciphertext'); assert.equal(f.audits().length, 1);
			const writes = f.queries.filter(query => /^UPDATE/u.test(query.sql)); assert.match(writes[0]!.sql, /key_fingerprint/u); assert.doesNotMatch(writes[0]!.sql.split('WHERE')[1]!, /updated_at|served_input_tokens|api_key\s/u);
			if (driver !== 'd1') assert.ok(f.queries.some(query => /FOR UPDATE/u.test(query.sql)));
		} finally { f.database.close(); }
	});
	test(`${driver} governance cannot activate, restore only disabled to paused, and unchanged writes have no audit`, async () => {
		const f = fixture(driver);
		try {
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { weight: 10 }, audit: audit() }), 'unchanged'); assert.equal(f.audits().length, 0);
			const before = f.queries.length;
			for (const patch of [{ status: 'active' }, { status: 'paused' }, { weight: 0 }, { sellerPriority: 2147483648 }, { inputPrice: 2 }]) {
				await assert.rejects(() => f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch, audit: audit() } as AdminSharedKeyUpdate), TypeError);
			}
			assert.equal(f.queries.length, before);
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' }, audit: audit() }), 'applied');
			const disabled = { ...expected, status: 'disabled' };
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected: disabled, patch: { status: 'paused' }, audit: audit({ actorKind: 'api_key', actorId: 'admin_key:legacy-master', source: 'legacy_admin' }) }), 'applied');
			assert.equal(f.current()!.status, 'paused'); assert.equal(f.current()!.validated_at, driver === 'mysql' ? stamp.replace('T', ' ').replace('Z', '') : stamp);
			const rows = await f.repo.listSharedKeyAdminAudit('key-1', { limit: 100 }); assert.deepEqual(new Set(rows.map(row => row.action)), new Set(['disabled', 'restored']));
			assert.ok(rows.some(row => row.actorKind === 'api_key' && row.source === 'legacy_admin'));
		} finally { f.database.close(); }
	});
	test(`${driver} ignored or failed audit/mutation rolls back both directions and never writes false success`, async () => {
		for (const target of ['audit-ignore', 'audit-fail', 'mutation-ignore', 'mutation-fail', 'audit-missing'] as const) for (const remove of [false, true]) {
			const f = fixture(driver);
			try {
				const before = f.current(); const auditTarget = target.startsWith('audit');
				if (target === 'audit-missing') f.database.exec('DROP TABLE admin_shared_key_audit');
				else f.database.exec(`CREATE TRIGGER fault BEFORE ${auditTarget ? 'INSERT' : remove ? 'DELETE' : 'UPDATE'} ON ${auditTarget ? 'admin_shared_key_audit' : 'shared_keys'} BEGIN SELECT RAISE(${target.endsWith('ignore') ? 'IGNORE' : "ABORT,'injected-failure'"}); END`);
				const input = { id: 'key-1', expected, audit: audit() };
				await assert.rejects(() => remove ? f.repo.deleteSharedKeyAdminWithAudit(input) : f.repo.updateSharedKeyAdminWithAudit({ ...input, patch: { weight: 20 } }));
				assert.deepEqual(f.current(), before, target); if (target !== 'audit-missing') assert.equal(f.audits().length, 0, target);
				if (target !== 'audit-ignore' || driver !== 'd1') assert.ok(f.rollbacks() >= 1);
			} finally { f.database.close(); }
		}
	});
	test(`${driver} delete retains safe audited history and same-time keyset has no repeats`, async () => {
		const f = fixture(driver);
		try {
			const reason = `Disable ${secret} and ${fingerprint}; bearer eyJabc.def.ghi; api_key=UNKNOWN_CREDENTIAL`;
			const firstId = '00000000-0000-4000-8000-000000000001'; const secondId = '00000000-0000-4000-8000-000000000002';
			assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { weight: 20 }, audit: audit({ auditId: firstId, reason }) }), 'applied');
			assert.equal(await f.repo.deleteSharedKeyAdminWithAudit({ id: 'key-1', expected: { ...expected, weight: 20 }, audit: audit({ auditId: secondId, reason }) }), 'applied');
			assert.equal(f.current(), undefined);
			const first = await f.repo.listSharedKeyAdminAudit('key-1', { limit: 1 }); const second = await f.repo.listSharedKeyAdminAudit('key-1', { limit: 1, before: first[0] });
			assert.equal(first[0]!.id, secondId); assert.equal(second[0]!.id, firstId); assert.equal(first[0]!.after, null); assert.equal(first[0]!.afterRevision, null);
			assert.equal((await f.repo.listSharedKeyAdminAudit('key-1', { limit: 1, before: second[0] })).length, 0);
			assert.match(first[0]!.beforeRevision, /^sha256:[0-9a-f]{64}$/u); assert.equal(second[0]!.changeMask, 4); assert.equal(first[0]!.changeMask, 8);
			const stored = JSON.stringify(f.audits()); for (const value of [secret, fingerprint, 'private-label', 'UNKNOWN_CREDENTIAL', 'eyJabc.def.ghi']) assert.equal(stored.includes(value), false, value);
			assert.ok(f.audits().every(row => !Object.keys(row).some(key => ['input_price', 'api_key', 'key_fingerprint', 'label'].includes(key))));
			assert.deepEqual(f.database.prepare('PRAGMA foreign_key_list(admin_shared_key_audit)').all(), []);
		} finally { f.database.close(); }
	});
}

test('D1 CAS catches governance between pre-read and the atomic batch without audit or overwrite', async () => {
	const f = fixture('d1');
	try { f.beforeBatch(() => f.change('status', 'disabled'));
		assert.equal(await f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { weight: 20 }, audit: audit() }), 'conflict');
		assert.equal(f.current()!.status, 'disabled'); assert.equal(f.current()!.weight, 10); assert.equal(f.audits().length, 0);
	} finally { f.database.close(); }
});

test('native audit query binds the original six-digit cursor and uses physical index order', async () => {
	const seen: { sql: string; values: unknown[] }[] = [];
	const capture = async (sql: string, values: unknown[]) => { seen.push({ sql, values }); return []; };
	const mysql = createMySqlSharedKeyAdminRepository({ raw: { execute: async (sql: string, values: unknown[]) => [await capture(sql, values), []] } } as unknown as MySqlDatabaseClient);
	const pg = createPostgresSharedKeyAdminRepository({ raw: { unsafe: capture } } as unknown as PostgresDatabaseClient);
	const before = { createdAt: stamp, id: crypto.randomUUID() };
	await mysql.listSharedKeyAdminAudit('key-1', { limit: 100, before }); await pg.listSharedKeyAdminAudit('key-1', { limit: 100, before });
	assert.deepEqual(seen[0]!.values, ['key-1', '2026-09-30 00:00:00.000123', '2026-09-30 00:00:00.000123', before.id]);
	assert.deepEqual(seen[1]!.values, ['key-1', stamp, stamp, before.id]);
	for (const query of seen) { assert.match(query.sql, /ORDER BY admin_shared_key_audit.created_at DESC, id DESC LIMIT/u); assert.doesNotMatch(query.sql, /OFFSET/u); }
});

test('D1 credited-earning protection aborts a delete and rolls back its success audit', async () => {
	const f = fixture('d1');
	try {
		f.database.exec('CREATE TABLE shared_key_earnings (id TEXT PRIMARY KEY, shared_key_id TEXT, request_log_id TEXT, seller_user_id TEXT); CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE api_key_request_logs (id TEXT PRIMARY KEY)');
		f.database.exec(readFileSync(new NodeURL('../../migrations-d1/0073_shared_key_earnings_history_guard.sql', import.meta.url), 'utf8'));
		f.database.exec("INSERT INTO shared_key_earnings VALUES ('earning-1','key-1','request-1','seller-1')");
		const before = f.current();
		await assert.rejects(() => f.repo.deleteSharedKeyAdminWithAudit({ id: 'key-1', expected, audit: audit() }), /credited_shared_key_earning_history_immutable/u);
		assert.deepEqual(f.current(), before); assert.equal(f.audits().length, 0); assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM shared_key_earnings').get()!.n, 1);
	} finally { f.database.close(); }
});

test('D1 owns pending mutation input and method names cannot switch update into delete', async () => {
	const f = fixture('d1');
	try {
		await assert.rejects(() => f.repo.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, audit: audit() } as AdminSharedKeyUpdate), TypeError);
		assert.ok(f.current());
		const input: AdminSharedKeyUpdate = { id: 'key-1', expected: { ...expected }, patch: { weight: 20 }, audit: audit() };
		f.beforeBatch(() => { (input.patch as unknown as { status: string }).status = 'active'; input.patch.weight = 100; input.expected.weight = 50; input.audit.reason = secret; });
		assert.equal(await f.repo.updateSharedKeyAdminWithAudit(input), 'applied');
		assert.equal(f.current()!.weight, 20); assert.equal(f.current()!.status, 'active'); assert.equal(f.audits()[0]!.reason, 'Support requested a governance adjustment');
	} finally { f.database.close(); }
});

test('encrypted governance redacts full plaintext/ciphertext/fingerprint without a lazy storage migration', async () => {
	const f = fixture('d1'); const encryptionSecret = 'test-only-governance-encryption-secret-32-bytes';
	const plaintext = 'arbitraryCredentialWithoutAnySpecialPrefix'; let migrations = 0; let reveals = 0;
	try {
		const ciphertext = await encryptSharedKeySecret(plaintext, encryptionSecret, `cinatoken:shared-key:key-1:${fingerprint}`);
		f.change('api_key', ciphertext);
		const wrapped = createEncryptedSharedKeysRepository({ ...f.repo,
			async replaceSharedKeySecret() { migrations++; return true; }, async getSharedKeyById() { reveals++; throw new Error('lazy reveal must not run'); },
		} as unknown as SharedKeysRepository, encryptionSecret);
		const read = await wrapped.getAdminSharedKeyById('key-1'); assert.equal(read!.apiKey, ciphertext); assert.equal(migrations, 0); assert.equal(reveals, 0);
		assert.equal(await wrapped.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' },
			audit: audit({ reason: `Please suspend ${plaintext} ${ciphertext} ${fingerprint}` }) }), 'applied');
		const recorded = String(f.audits()[0]!.reason);
		for (const value of [plaintext, ciphertext, fingerprint]) assert.equal(recorded.includes(value), false);
		assert.match(recorded, /Please suspend/u); assert.equal(f.current()!.api_key, ciphertext); assert.equal(migrations, 0); assert.equal(reveals, 0);
	} finally { f.database.close(); }
});

test('damaged encrypted credential can be disabled with fixed redacted reason, but invalid actor/reason still rejects', async () => {
	const f = fixture('d1'); let migrations = 0;
	try {
		f.change('api_key', 'enc:v2:damaged-envelope');
		const wrapped = createEncryptedSharedKeysRepository({ ...f.repo, async replaceSharedKeySecret() { migrations++; return true; } } as unknown as SharedKeysRepository,
			'test-only-governance-encryption-secret-32-bytes');
		const count = f.queries.length;
		await assert.rejects(() => wrapped.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' }, audit: audit({ reason: 'unsafe\nreason' }) }), TypeError);
		await assert.rejects(() => wrapped.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' }, audit: audit({ actorKind: 'caller' as 'console' }) }), TypeError);
		assert.equal(f.queries.length, count);
		assert.equal(await wrapped.updateSharedKeyAdminWithAudit({ id: 'key-1', expected, patch: { status: 'disabled' }, audit: audit({ reason: 'operator arbitrarySecretMustNotBeStored' }) }), 'applied');
		assert.equal(f.audits()[0]!.reason, 'Credential material unavailable; operator reason redacted');
		assert.equal(f.current()!.status, 'disabled'); assert.equal(f.current()!.api_key, 'enc:v2:damaged-envelope'); assert.equal(migrations, 0);
		assert.equal(await wrapped.deleteSharedKeyAdminWithAudit({ id: 'key-1', expected: { ...expected, status: 'disabled' }, audit: audit({ reason: 'original-private-reason' }) }), 'applied');
		assert.equal(f.audits()[1]!.reason, 'Credential material unavailable; operator reason redacted');
	} finally { f.database.close(); }
});

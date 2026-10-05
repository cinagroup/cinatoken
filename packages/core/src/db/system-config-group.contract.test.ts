import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1SystemConfigRepository } from './d1/system-config.impl';
import { createMySqlSystemConfigRepository } from './mysql/system-config.impl';
import { createPostgresSystemConfigRepository } from './postgres/system-config.impl';
import { completeConfigSnapshots, configRevisionVector, mapConfigGroupAuditRow, TOOL_CONFIG_FAMILY_KEYS, TOOL_CONFIG_FAMILY_PROVIDERS } from './system-config-group';
import type { ConfigGroupApplyInput, ConfigSnapshot, ToolConfigFamily } from './system-config-group-types';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import type { GatewayRepositories } from '../storage/repositories';
import { resolveWebSearchConfig, resolveWebSearchConfigFromSnapshots } from '../lib/web-search-system-config';
import { resolveWebFetchConfig, resolveWebFetchConfigFromSnapshots } from '../lib/web-fetch-system-config';
import { resolveWebDeepSearchConfig, resolveWebDeepSearchConfigFromSnapshots } from '../lib/web-deep-search-system-config';
import { resolveAiDetectionConfig, resolveAiDetectionConfigFromSnapshots } from '../lib/ai-detection-system-config';

const nowIso = '2026-10-01T01:02:03.000Z';
const privateValue = 'fixture-private-api-key';
const migration = (path: string) => readFileSync(fileURLToPath(new NodeURL(path, import.meta.url)), 'utf8');
const keysFor = (family: ToolConfigFamily) => [...TOOL_CONFIG_FAMILY_KEYS[family]];
const writable = (family: ToolConfigFamily) => keysFor(family).filter(key => key.endsWith('_ACTIVE') || key.endsWith('_CATALOG'));
function inputFor(family: ToolConfigFamily, rows: ConfigSnapshot[], writes: ConfigGroupApplyInput['writes'] = writable(family).map(key => ({ key, value: key.endsWith('_ACTIVE') ? TOOL_CONFIG_FAMILY_PROVIDERS[family][0] : JSON.stringify({ credential: privateValue }) }))): ConfigGroupApplyInput {
	return { family, readSet: configRevisionVector(rows), writes, safeAudit: {
		auditId: crypto.randomUUID(), actorKind: 'console', actorId: 'console:cinaauth:operator', reason: 'Reviewed configuration',
		action: 'save_activate', provider: TOOL_CONFIG_FAMILY_PROVIDERS[family][0], changedFields: [{ provider: null, field: 'catalog' }, { provider: null, field: 'active' }],
		activeBefore: null, activeAfter: TOOL_CONFIG_FAMILY_PROVIDERS[family][0], credentials: [{ provider: TOOL_CONFIG_FAMILY_PROVIDERS[family][0], field: 'apiKey', operation: 'set', configuredBefore: false, configuredAfter: true }],
		source: 'admin_api', nowIso,
	} };
}

class SqliteStatement {
	constructor(private readonly database: DatabaseSync, readonly sql: string, readonly values: SQLInputValue[] = []) {}
	bind(...values: SQLInputValue[]) { return new SqliteStatement(this.database, this.sql, values) as unknown as D1PreparedStatement; }
	async first<T>() { return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null; }
	async all<T>() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) as T[], meta: {} } as D1Result<T>; }
	async run() {
		if (/^SELECT /u.test(this.sql)) return this.all();
		const result = this.database.prepare(this.sql).run(...this.values);
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
	}
}
function fixture(existing = false) {
	const database = new DatabaseSync(':memory:');
	database.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT)');
	database.exec(migration('../../migrations-d1/0069_config_change_audit.sql'));
	database.exec(migration('../../migrations-d1/0070_system_config_revision.sql'));
	database.exec(migration('../../migrations-d1/0076_tools_config_group_audit.sql'));
	database.exec('CREATE TABLE system_config_write_mutex (id INTEGER PRIMARY KEY CHECK(id = 1)); INSERT INTO system_config_write_mutex VALUES (1)');
	if (existing) for (const key of new Set(Object.values(TOOL_CONFIG_FAMILY_KEYS).flat())) database.prepare('INSERT INTO system_config(key,value) VALUES (?,?)').run(key, key.endsWith('_ACTIVE') ? 'bocha' : key === 'BILLING_CURRENCY' ? 'USD' : 'old');
	const calls: { sql: string; values: unknown[] }[] = [], lifecycle: string[] = [];
	const raw = {
		prepare(sql: string) { calls.push({ sql, values: [] }); return new SqliteStatement(database, sql) as unknown as D1PreparedStatement; },
		async batch(statements: D1PreparedStatement[]) {
			lifecycle.push('begin'); database.exec('BEGIN IMMEDIATE');
			try {
				const results: D1Result[] = [];
				for (const statement of statements) results.push(await statement.run());
				database.exec('COMMIT'); lifecycle.push('commit'); return results;
			} catch (error) { database.exec('ROLLBACK'); lifecycle.push('rollback'); throw error; }
		},
	};
	const repository = createD1SystemConfigRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
	const state = () => JSON.stringify({ config: database.prepare('SELECT * FROM system_config ORDER BY key').all(), single: database.prepare('SELECT * FROM config_change_audit ORDER BY id').all(), group: database.prepare('SELECT * FROM config_group_audit ORDER BY id').all() });
	return { database, calls, lifecycle, repository, state };
}

test('formal group schemas preserve old single audits, have 15 safe columns and retained keyset history', async () => {
	const f = fixture();
	try {
		assert.equal(f.database.prepare('PRAGMA table_info(config_group_audit)').all().length, 15);
		assert.deepEqual(f.database.prepare('PRAGMA foreign_key_list(config_group_audit)').all(), []);
		const indexes = f.database.prepare('PRAGMA index_list(config_group_audit)').all() as { name: string }[];
		assert.equal(indexes.some(row => row.name === 'idx_config_group_audit_family_created'), true);
		for (const path of ['../../migrations-d1/0076_tools_config_group_audit.sql', '../../migrations-mysql/0074_tools_config_group_audit.sql', '../../migrations-postgres/0081_tools_config_group_audit.sql']) {
			const ddl = migration(path).replace(/^--.*$/gmu, '');
			assert.doesNotMatch(ddl, /\b(?:FOREIGN KEY|config_value|value_hash|fingerprint|request_body|DROP TABLE|ALTER TABLE)\b/iu);
			assert.match(ddl, /config_group_audit/u);
			if (!path.includes('d1')) { assert.match(ddl, /system_config_write_mutex/u); assert.match(ddl, /VALUES\s*\(1\)/u); }
		}
		assert.match(migration('../../migrations-postgres/0081_tools_config_group_audit.sql'), /SET LOCAL lock_timeout = '2s'/u);
		const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search')));
		await f.repository.applyConfigGroupIfRevisions(input);
		f.database.exec('DELETE FROM system_config');
		assert.equal((await f.repository.listConfigGroupAudit('web-search', { limit: 1 })).length, 1);
		assert.equal(f.database.prepare('SELECT * FROM config_change_audit').all().length, 0);
	} finally { f.database.close(); }
});

for (const family of Object.keys(TOOL_CONFIG_FAMILY_KEYS) as ToolConfigFamily[]) {
	test(family + ' absent readSet atomically assigns every requested key and emits only safe audit metadata', async () => {
		const f = fixture();
		try {
			const snapshot = await f.repository.getConfigSnapshots(keysFor(family).reverse());
			assert.deepEqual(snapshot, keysFor(family).map(key => ({ key, value: null, revision: null })));
			assert.equal(f.calls.length, 1, 'one statement reads all dependencies including absent currency');
			const input = inputFor(family, snapshot), result = await f.repository.applyConfigGroupIfRevisions(input);
			assert.equal(result.outcome, 'applied'); assert.equal(result.auditId, input.safeAudit.auditId);
			for (const write of input.writes) assert.match(result.revisionVector.find(row => row.key === write.key)!.revision!, /^[0-9a-f-]{36}$/u);
			assert.equal(result.revisionVector.find(row => row.key === 'BILLING_CURRENCY')!.revision, null);
			const audit = (await f.repository.listConfigGroupAudit(family, { limit: 1 }))[0]!;
			assert.equal(audit.createdAt, '2026-10-01T01:02:03.000000Z');
			assert.deepEqual(audit.revisionAfter, result.revisionVector);
			assert.equal(JSON.stringify(audit).includes(privateValue), false);
			assert.equal(JSON.stringify(result).includes(privateValue), false);
		} finally { f.database.close(); }
	});
}

test('same values are unchanged without audit; stale same values conflict and a second tab never wins', async () => {
	const f = fixture();
	try {
		const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search')));
		assert.equal((await f.repository.applyConfigGroupIfRevisions(input)).outcome, 'applied');
		const state = f.state(), snapshot = await f.repository.getConfigSnapshots(keysFor('web-search'));
		const noChange = inputFor('web-search', snapshot, [...input.writes]);
		assert.deepEqual(await f.repository.applyConfigGroupIfRevisions(noChange), { outcome: 'unchanged', auditId: null, revisionVector: configRevisionVector(snapshot) });
		assert.equal((await f.repository.applyConfigGroupIfRevisions({ ...input, safeAudit: { ...input.safeAudit, auditId: crypto.randomUUID() } })).outcome, 'conflict');
		assert.equal(f.state(), state);
	} finally { f.database.close(); }
});

test('changes to currency or any legacy dependency make the entire reviewed family stale', async () => {
	for (const key of ['BILLING_CURRENCY', 'WEB_SEARCH_API_KEY', 'WEB_SEARCH_PROVIDER', 'WEB_SEARCH_COST']) {
		const f = fixture();
		try {
			const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search')));
			await f.repository.upsertSystemConfigValueWithAudit({ auditId: crypto.randomUUID(), key, value: 'concurrent dependency', actorKind: 'console', actorId: 'console:operator', nowIso });
			const before = f.state(), result = await f.repository.applyConfigGroupIfRevisions(input);
			assert.equal(result.outcome, 'conflict'); assert.equal(result.auditId, null); assert.equal(f.state(), before);
		} finally { f.database.close(); }
	}
});

for (const existing of [false, true]) for (const fault of ['IGNORE', 'ABORT'] as const) for (const target of ['audit', 'first', 'second'] as const) {
	test(`D1 ${existing ? 'UPDATE' : 'INSERT'} ${target} ${fault} rolls back the full group before commit`, async () => {
		const f = fixture(existing);
		try {
			const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state();
			const table = target === 'audit' ? 'config_group_audit' : 'system_config', event = target === 'audit' || !existing ? 'INSERT' : 'UPDATE';
			const when = target === 'audit' ? '' : `WHEN NEW.key = '${input.writes[target === 'first' ? 0 : 1]!.key}'`;
			f.database.exec(`CREATE TRIGGER reject_group BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture fault'" : ''}); END`);
			await assert.rejects(f.repository.applyConfigGroupIfRevisions(input));
			assert.equal(f.state(), before); assert.equal(f.lifecycle.at(-1), 'rollback');
			f.database.exec('DROP TRIGGER reject_group');
			assert.equal((await f.repository.applyConfigGroupIfRevisions(input)).outcome, 'applied');
		} finally { f.database.close(); }
	});
}

test('D1 full after-vector and byte-exact values catch target/audit trigger changes to already reviewed dependencies', async () => {
	for (const trigger of [
		`AFTER UPDATE ON system_config WHEN NEW.key='WEB_SEARCH_CATALOG' BEGIN UPDATE system_config SET revision='${crypto.randomUUID()}' WHERE key='BILLING_CURRENCY'; END`,
		`AFTER UPDATE ON system_config WHEN NEW.key='WEB_SEARCH_CATALOG' BEGIN UPDATE system_config SET value='changed-case' WHERE key='WEB_SEARCH_ACTIVE'; END`,
		`AFTER INSERT ON config_group_audit BEGIN UPDATE system_config SET revision='${crypto.randomUUID()}' WHERE key='BILLING_CURRENCY'; END`,
	]) {
		const f = fixture(true);
		try {
			const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state();
			f.database.exec('CREATE TRIGGER alter_dependency ' + trigger);
			await assert.rejects(f.repository.applyConfigGroupIfRevisions(input)); assert.equal(f.state(), before);
		} finally { f.database.close(); }
	}
});

function revealInput(rows: ConfigSnapshot[]): ConfigGroupApplyInput {
	const input = inputFor('web-search', rows, []);
	input.safeAudit.action = 'reveal'; input.safeAudit.changedFields = [];
	input.safeAudit.credentials = [{ provider: 'bocha', field: 'apiKey', operation: 'reveal', configuredBefore: true, configuredAfter: true }];
	return input;
}
test('forced reveal has zero writes, audits unchanged vector and fails closed on stale or ignored audit', async () => {
	const f = fixture(true);
	try {
		const input = revealInput(await f.repository.getConfigSnapshots(keysFor('web-search')));
		const result = await f.repository.applyConfigGroupIfRevisions(input);
		assert.deepEqual(result, { outcome: 'applied', auditId: input.safeAudit.auditId, revisionVector: input.readSet });
		assert.equal(JSON.stringify(result).includes('old'), false);
		const before = f.state(); f.database.exec('CREATE TRIGGER ignore_reveal BEFORE INSERT ON config_group_audit BEGIN SELECT RAISE(IGNORE); END');
		await assert.rejects(f.repository.applyConfigGroupIfRevisions({ ...input, safeAudit: { ...input.safeAudit, auditId: crypto.randomUUID() } }));
		assert.equal(f.state(), before);
		f.database.exec('DROP TRIGGER ignore_reveal'); f.database.exec("UPDATE system_config SET revision='" + crypto.randomUUID() + "' WHERE key='BILLING_CURRENCY'");
		assert.equal((await f.repository.applyConfigGroupIfRevisions({ ...input, safeAudit: { ...input.safeAudit, auditId: crypto.randomUUID() } })).outcome, 'conflict');
	} finally { f.database.close(); }
});

test('input validation rejects malformed vectors, credentials, actor and unsafe fields before any database call', async () => {
	const f = fixture();
	try {
		const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search')));
		const mutations: ((input: ConfigGroupApplyInput) => void)[] = [
			row => { row.readSet = row.readSet.slice(1); }, row => { row.writes = [{ key: 'BILLING_CURRENCY', value: 'USD' }]; },
			row => { row.safeAudit.actorKind = 'api_key' as never; }, row => { row.safeAudit.actorId = 'console:'; },
			row => { row.safeAudit.actorId = 'console:' + 'x'.repeat(610); }, row => { row.safeAudit.actorId = 'console:bad\u0000'; },
			row => { row.safeAudit.reason = 'x'.repeat(601); }, row => { row.safeAudit.reason = 'bad\u007f'; },
			row => { row.safeAudit.provider = 'jina'; }, row => { row.safeAudit.credentials = [...row.safeAudit.credentials, ...row.safeAudit.credentials]; },
			row => { row.safeAudit.changedFields = [{ provider: null, field: 'apiKey' }]; },
			row => { row.safeAudit.credentials = [{ ...row.safeAudit.credentials[0]!, provider: 'jina' }]; },
			row => { row.safeAudit.action = 'reveal'; }, row => { row.writes = [...row.writes, row.writes[0]!]; },
		];
		for (const mutation of mutations) {
			const candidate = structuredClone(input); mutation(candidate); const count = f.calls.length;
			await assert.rejects(f.repository.applyConfigGroupIfRevisions(candidate), /Invalid config group contract/u); assert.equal(f.calls.length, count);
		}
		for (const [kind, id] of [['console', 'console:cinaauth:' + '𝄞'.repeat(600)], ['admin_key', 'named:' + '𝄞'.repeat(594)]] as const) {
			const candidate = structuredClone(input); candidate.safeAudit.actorKind = kind; candidate.safeAudit.actorId = id; candidate.safeAudit.auditId = crypto.randomUUID();
			candidate.safeAudit.reason = '界'.repeat(600); candidate.safeAudit.action = 'reveal'; candidate.writes = []; candidate.safeAudit.credentials = [{ ...candidate.safeAudit.credentials[0]!, operation: 'reveal' }];
			await f.repository.applyConfigGroupIfRevisions(candidate);
			assert.equal((await f.repository.listConfigGroupAudit('web-search', { limit: 100 })).find(row => row.id === candidate.safeAudit.auditId)!.actorId, id);
		}
	} finally { f.database.close(); }
});

test('audit keyset preserves six fractional digits and ID ties; malformed persisted metadata is never echoed', async () => {
	const f = fixture();
	try {
		for (let i = 0; i < 3; i++) await f.repository.applyConfigGroupIfRevisions(revealInput(await f.repository.getConfigSnapshots(keysFor('web-search'))));
		const all = await f.repository.listConfigGroupAudit('web-search', { limit: 100 });
		f.database.prepare('UPDATE config_group_audit SET created_at=? WHERE id=?').run('2026-10-01T01:02:03.000123Z', all[1]!.id);
		const first = await f.repository.listConfigGroupAudit('web-search', { limit: 1 }), cursor = { createdAt: first[0]!.createdAt, id: first[0]!.id };
		assert.equal(cursor.createdAt, '2026-10-01T01:02:03.000123Z');
		const rest = await f.repository.listConfigGroupAudit('web-search', { limit: 100, before: cursor });
		assert.equal(new Set([...first, ...rest].map(row => row.id)).size, 3);
		const raw = f.database.prepare('SELECT * FROM config_group_audit LIMIT 1').get() as Record<string, unknown>;
		for (const patch of [{ actor_id: 'console:bad\u0000' }, { changed_fields_json: JSON.stringify([{ provider: 'bocha', field: privateValue }]) }, { revision_after_json: JSON.stringify([{ key: privateValue, revision: 'legacy' }]) }, { credentials_json: ' '.repeat(16385) }]) {
			assert.throws(() => mapConfigGroupAuditRow({ ...raw, ...patch }), error => error instanceof TypeError && !error.message.includes(privateValue));
		}
		assert.throws(() => completeConfigSnapshots(['BILLING_CURRENCY'], [{ key: 'BILLING_CURRENCY', value: 'USD', revision: null }]));
	} finally { f.database.close(); }
});

/** Captured actual repository SQL, translated only for SQLite syntax. This is a
 * rollback/parameter contract, not native MySQL/PostgreSQL engine evidence. */
function transactionalWire(driver: 'mysql' | 'postgres', f: ReturnType<typeof fixture>) {
	const calls: { sql: string; values: unknown[] }[] = [], lifecycle: string[] = [];
	let tail = Promise.resolve();
	const execute = (sql: string, values: unknown[]) => {
		calls.push({ sql, values: [...values] });
		let translated = sql.replace(/cinatoken_gateway\./gu, '').replace(/\$(\d+)/gu, '?').replace(/ FOR UPDATE/gu, '');
		if (driver === 'mysql' && translated.includes('ON DUPLICATE KEY UPDATE')) translated = translated.replace(/ON DUPLICATE KEY UPDATE[\s\S]*/u, 'ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,revision=excluded.revision');
		if (driver === 'postgres' || /^SELECT /u.test(translated)) return f.database.prepare(translated).all(...values as SQLInputValue[]);
		const result = f.database.prepare(translated).run(...values as SQLInputValue[]);
		return { affectedRows: Number(result.changes) };
	};
	const acquire = async () => { const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous; return release; };
	if (driver === 'mysql') {
		const connection = () => { let unlock: (() => void) | undefined; return {
			async beginTransaction() { unlock = await acquire(); lifecycle.push('begin'); f.database.exec('BEGIN IMMEDIATE'); },
			async execute(sql: string, values: unknown[]) { return [execute(sql, values), []]; },
			async commit() { lifecycle.push('commit'); f.database.exec('COMMIT'); },
			async rollback() { lifecycle.push('rollback'); f.database.exec('ROLLBACK'); },
			release() { lifecycle.push('release'); unlock?.(); },
		}; };
		const raw = { async getConnection() { return connection(); }, async execute(sql: string, values: unknown[]) { return [execute(sql, values), []]; } };
		return { repository: createMySqlSystemConfigRepository({ driver, raw, drizzle: {} } as unknown as MySqlDatabaseClient), calls, lifecycle };
	}
	const raw = { async unsafe(sql: string, values: unknown[]) { return execute(sql, values); }, async begin(callback: (tx: { unsafe(sql: string, values: unknown[]): Promise<unknown> }) => Promise<unknown>) {
		const unlock = await acquire(); lifecycle.push('begin'); f.database.exec('BEGIN IMMEDIATE');
		try { const result = await callback({ async unsafe(sql, values) { return execute(sql, values); } }); lifecycle.push('commit'); f.database.exec('COMMIT'); return result; }
		catch (error) { lifecycle.push('rollback'); f.database.exec('ROLLBACK'); throw error; } finally { unlock(); }
	} };
	return { repository: createPostgresSystemConfigRepository({ driver, raw, drizzle: {} } as unknown as PostgresDatabaseClient), calls, lifecycle };
}

for (const driver of ['mysql', 'postgres'] as const) {
	test(driver + ' malformed group/snapshot/audit requests fail before acquiring a connection or issuing SQL', async () => {
		const f = fixture();
		try {
			let calls = 0;
			const rejectCall = async () => { calls++; throw new Error('database must not be reached'); };
			const repository = driver === 'mysql'
				? createMySqlSystemConfigRepository({ driver, raw: { getConnection: rejectCall, execute: rejectCall }, drizzle: {} } as unknown as MySqlDatabaseClient)
				: createPostgresSystemConfigRepository({ driver, raw: { begin: rejectCall, unsafe: rejectCall }, drizzle: {} } as unknown as PostgresDatabaseClient);
			const input = inputFor('web-search', await f.repository.getConfigSnapshots(keysFor('web-search')));
			await assert.rejects(repository.applyConfigGroupIfRevisions({ ...input, safeAudit: { ...input.safeAudit, reason: 'bad\u0000reason' } }), /Invalid config group contract/u);
			await assert.rejects(repository.applyConfigGroupIfRevisions({ ...input, readSet: input.readSet.slice(1) }), /Invalid config group contract/u);
			await assert.rejects(repository.getConfigSnapshots(['BILLING_CURRENCY', 'BILLING_CURRENCY']), /Invalid config group contract/u);
			await assert.rejects(repository.listConfigGroupAudit('web-search', { limit: 102 }), /Invalid config group contract/u);
			assert.equal(calls, 0);
		} finally { f.database.close(); }
	});
	test(driver + ' every generic, CAS and group writer fails before target when the singleton is missing', async () => {
		const f = fixture();
		try {
			const wire = transactionalWire(driver, f); f.database.exec('DELETE FROM system_config_write_mutex');
			const input = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state(); wire.calls.length = 0;
			const single = { key: 'BILLING_CURRENCY', value: 'USD', auditId: crypto.randomUUID(), actorKind: 'console' as const, actorId: 'console:operator', nowIso };
			for (const operation of [() => wire.repository.applyConfigGroupIfRevisions(input), () => wire.repository.upsertSystemConfigValueWithAudit(single), () => wire.repository.upsertSystemConfigValueWithAuditIfRevision({ ...single, expectedRevision: null })]) {
				const count = wire.calls.length; await assert.rejects(operation(), /Config write mutex unavailable/u);
				assert.equal(wire.calls.length, count + 1); assert.match(wire.calls.at(-1)!.sql, /system_config_write_mutex.*FOR UPDATE/u); assert.equal(f.state(), before);
			}
		} finally { f.database.close(); }
	});
	test(driver + ' concurrent stale group writers serialize through the same mutex, one applied and one conflict', async () => {
		const f = fixture();
		try {
			const wire = transactionalWire(driver, f), initial = await wire.repository.getConfigSnapshots(keysFor('web-search'));
			const input = inputFor('web-search', initial), second = inputFor('web-search', initial);
			const results = await Promise.all([wire.repository.applyConfigGroupIfRevisions(input), wire.repository.applyConfigGroupIfRevisions(second)]);
			assert.deepEqual(results.map(row => row.outcome), ['applied', 'conflict']);
			assert.equal(f.database.prepare('SELECT * FROM config_group_audit').all().length, 1);
			assert.equal(wire.calls.filter(row => row.sql.includes('system_config_write_mutex')).length, 2);
			assert.equal(wire.calls.some(row => row.sql.includes('config_change_audit')), false);
			assert.equal(JSON.stringify(wire.calls.filter(row => row.sql.includes('config_group_audit'))).includes(privateValue), false);
		} finally { f.database.close(); }
	});
	for (const existing of [false, true]) for (const target of ['audit', 'first', 'second'] as const) for (const fault of ['IGNORE', 'ABORT'] as const) {
		test(`${driver} ${existing ? 'UPDATE' : 'INSERT'} ${target} ${fault} cannot commit partial config or ghost audit`, async () => {
			const f = fixture(existing);
			try {
				const wire = transactionalWire(driver, f), input = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state();
				const table = target === 'audit' ? 'config_group_audit' : 'system_config', event = target === 'audit' || !existing ? 'INSERT' : 'UPDATE';
				const when = target === 'audit' ? '' : `WHEN NEW.key = '${input.writes[target === 'first' ? 0 : 1]!.key}'`;
				f.database.exec(`CREATE TRIGGER reject_group BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture fault'" : ''}); END`);
				await assert.rejects(wire.repository.applyConfigGroupIfRevisions(input)); assert.equal(f.state(), before);
				assert.equal(wire.lifecycle.includes('commit'), false); assert.equal(wire.lifecycle.includes('rollback'), true);
				f.database.exec('DROP TRIGGER reject_group'); assert.equal((await wire.repository.applyConfigGroupIfRevisions(input)).outcome, 'applied');
			} finally { f.database.close(); }
		});
	}
	test(driver + ' byte-exact no-op and full post-vector assertions reject triggers changing a value or dependency', async () => {
		for (const trigger of [
			`AFTER UPDATE ON system_config WHEN NEW.key='WEB_SEARCH_CATALOG' BEGIN UPDATE system_config SET value='BOCHA' WHERE key='WEB_SEARCH_ACTIVE'; END`,
			`AFTER INSERT ON config_group_audit BEGIN UPDATE system_config SET revision='${crypto.randomUUID()}' WHERE key='BILLING_CURRENCY'; END`,
		]) {
			const f = fixture(true);
			try {
				const wire = transactionalWire(driver, f), input = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state();
				f.database.exec('CREATE TRIGGER alter_dependency ' + trigger); await assert.rejects(wire.repository.applyConfigGroupIfRevisions(input)); assert.equal(f.state(), before);
			} finally { f.database.close(); }
		}
	});
	test(driver + ' writes every requested row once, even when one same-value field accompanies a changed catalog', async () => {
		const f = fixture(true);
		try {
			const wire = transactionalWire(driver, f), snapshot = await wire.repository.getConfigSnapshots(keysFor('web-search'));
			const input = inputFor('web-search', snapshot), result = await wire.repository.applyConfigGroupIfRevisions(input);
			assert.equal(result.outcome, 'applied');
			assert.equal(wire.calls.filter(row => /^UPDATE /u.test(row.sql)).length, 2);
			assert.notEqual(result.revisionVector.find(row => row.key === 'WEB_SEARCH_ACTIVE')!.revision, 'legacy');
			const before = f.state(), noChange = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search')));
			assert.equal((await wire.repository.applyConfigGroupIfRevisions(noChange)).outcome, 'unchanged'); assert.equal(f.state(), before);
			const alteredCase = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search')), [{ key: 'WEB_SEARCH_ACTIVE', value: 'BOCHA' }]);
			assert.equal((await wire.repository.applyConfigGroupIfRevisions(alteredCase)).outcome, 'applied', 'case changes must not collapse into unicode_ci no-op');
		} finally { f.database.close(); }
	});
	test(driver + ' generic first creation of absent currency invalidates a concurrently reviewed group', async () => {
		const f = fixture();
		try {
			const wire = transactionalWire(driver, f), input = inputFor('web-search', await wire.repository.getConfigSnapshots(keysFor('web-search')));
			const operations = await Promise.all([
				wire.repository.upsertSystemConfigValueWithAudit({ auditId: crypto.randomUUID(), key: 'BILLING_CURRENCY', value: 'USD', actorKind: 'console', actorId: 'console:operator', nowIso }),
				wire.repository.applyConfigGroupIfRevisions(input),
			]);
			assert.equal(operations[1].outcome, 'conflict'); assert.equal(f.database.prepare('SELECT * FROM config_group_audit').all().length, 0);
			assert.equal(f.database.prepare('SELECT * FROM config_change_audit').all().length, 1);
			assert.equal(wire.calls.filter(row => row.sql.includes('system_config_write_mutex')).length, 2);
		} finally { f.database.close(); }
	});
	test(driver + ' zero-write reveal requires audit effect and leaves all config values/revisions unchanged', async () => {
		for (const fault of ['IGNORE', 'ABORT'] as const) {
			const f = fixture(true);
			try {
				const wire = transactionalWire(driver, f), input = revealInput(await wire.repository.getConfigSnapshots(keysFor('web-search'))), before = f.state();
				f.database.exec(`CREATE TRIGGER reject_reveal BEFORE INSERT ON config_group_audit BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'fixture fault'" : ''}); END`);
				await assert.rejects(wire.repository.applyConfigGroupIfRevisions(input)); assert.equal(f.state(), before);
				f.database.exec('DROP TRIGGER reject_reveal');
				const result = await wire.repository.applyConfigGroupIfRevisions(input);
				assert.deepEqual(result, { outcome: 'applied', auditId: input.safeAudit.auditId, revisionVector: input.readSet });
				assert.equal(wire.calls.some(row => /^UPDATE /u.test(row.sql) || /INSERT INTO (?:cinatoken_gateway\.)?system_config \(/u.test(row.sql)), false);
			} finally { f.database.close(); }
		}
	});
}

test('MySQL/Postgres audit reads bind exact microsecond cursors and use authoritative UTC6 SQL formatting', async () => {
	const f = fixture();
	try {
		const input = revealInput(await f.repository.getConfigSnapshots(keysFor('web-search'))); await f.repository.applyConfigGroupIfRevisions(input);
		const row = f.database.prepare('SELECT * FROM config_group_audit').get() as Record<string, unknown>;
		row.created_at = '2026-10-01T01:02:03.000123Z';
		for (const driver of ['mysql', 'postgres'] as const) {
			const calls: { sql: string; values: unknown[] }[] = [];
			const execute = (sql: string, values: unknown[]) => { calls.push({ sql, values }); return [{ ...row }]; };
			const repository = driver === 'mysql'
				? createMySqlSystemConfigRepository({ driver, raw: { async execute(sql: string, values: unknown[]) { return [execute(sql, values), []]; } }, drizzle: {} } as unknown as MySqlDatabaseClient)
				: createPostgresSystemConfigRepository({ driver, raw: { async unsafe(sql: string, values: unknown[]) { return execute(sql, values); } }, drizzle: {} } as unknown as PostgresDatabaseClient);
			const rows = await repository.listConfigGroupAudit('web-search', { limit: 100, before: { createdAt: row.created_at as string, id: input.safeAudit.auditId } });
			assert.equal(rows[0]!.createdAt, row.created_at);
			assert.match(calls[0]!.sql, driver === 'mysql' ? /DATE_FORMAT\(created_at.*%fZ/u : /to_char\(created_at AT TIME ZONE 'UTC'.*US/u);
			assert.deepEqual(calls[0]!.values, driver === 'mysql' ? ['web-search', '2026-10-01 01:02:03.000123', '2026-10-01 01:02:03.000123', input.safeAudit.auditId] : ['web-search', row.created_at, input.safeAudit.auditId]);
			const count = calls.length;
			await assert.rejects(repository.listConfigGroupAudit('web-search', { limit: 1, before: { createdAt: '2026-02-30T00:00:00.000123Z', id: input.safeAudit.auditId } })); assert.equal(calls.length, count);
		}
	} finally { f.database.close(); }
});

const resolvers = {
	'web-search': { resolve: resolveWebSearchConfig, pure: resolveWebSearchConfigFromSnapshots },
	'web-fetch': { resolve: resolveWebFetchConfig, pure: resolveWebFetchConfigFromSnapshots },
	'web-deep-search': { resolve: resolveWebDeepSearchConfig, pure: resolveWebDeepSearchConfigFromSnapshots },
	'ai-detection': { resolve: resolveAiDetectionConfig, pure: resolveAiDetectionConfigFromSnapshots },
};
function runtimeSnapshot(family: ToolConfigFamily, values: Record<string, string | null>): ConfigSnapshot[] {
	return keysFor(family).map(key => ({ key, value: values[key] ?? null, revision: values[key] == null ? null : 'legacy' }));
}
for (const family of Object.keys(resolvers) as ToolConfigFamily[]) for (const provider of TOOL_CONFIG_FAMILY_PROVIDERS[family]) {
	test(`${family}/${provider} runtime resolves credential/prices from exactly one complete family snapshot`, async () => {
		const entries = { [provider]: { apiKey: privateValue, secretId: 'private-id', secretKey: privateValue, metered: 1, standard: 2, charged: 3, cost: 3, billingUnitChars: 1000, region: 'ap-guangzhou', bizType: 'fixture' } };
		const prefix = writable(family)[0]!.replace(/_ACTIVE|_CATALOG/u, ''), snapshot = runtimeSnapshot(family, { [`${prefix}_CATALOG`]: JSON.stringify(entries), [`${prefix}_ACTIVE`]: provider, BILLING_CURRENCY: 'USD' });
		let reads = 0;
		const repositories = { systemConfig: { async getConfigSnapshots(keys: string[]) { reads++; assert.deepEqual(keys, keysFor(family)); return snapshot; }, async getConfig() { throw new Error('individual read forbidden'); } } } as unknown as GatewayRepositories;
		const result = await resolvers[family].resolve(repositories);
		assert.equal(reads, 1); assert.equal(result.ok, true);
		if (result.ok) { assert.equal(result.config.provider, provider); assert.equal(result.config.metered, 1); assert.equal(result.config.standard, 2); assert.equal(result.config.charged, 3); }
	});
}
test('pure pricing resolution shares one 15-key snapshot and preserves legacy/default/malformed runtime behavior', () => {
	const keys = [...new Set(Object.values(TOOL_CONFIG_FAMILY_KEYS).flat())].sort(); assert.equal(keys.length, 15);
	const all = keys.map(key => ({ key, value: null, revision: null }));
	assert.equal(resolveWebSearchConfigFromSnapshots(all).ok, true); assert.equal(resolveWebFetchConfigFromSnapshots(all).ok, true); assert.equal(resolveWebDeepSearchConfigFromSnapshots(all).ok, true);
	assert.deepEqual(resolveAiDetectionConfigFromSnapshots(all), { ok: false, reason: 'active_missing_key', provider: 'tencent_tms' });
	for (const family of Object.keys(resolvers) as ToolConfigFamily[]) {
		const catalog = writable(family).find(key => key.endsWith('_CATALOG'))!;
		assert.deepEqual(resolvers[family].pure(runtimeSnapshot(family, { [catalog]: '{invalid' })), { ok: false, reason: 'invalid_catalog' });
		assert.throws(() => resolvers[family].pure(runtimeSnapshot(family, {}).slice(1)), /Invalid config group contract/u);
	}
	for (const [family, resolve] of [['web-search', resolveWebSearchConfigFromSnapshots], ['web-fetch', resolveWebFetchConfigFromSnapshots]] as const) {
		const prefix = family === 'web-search' ? 'WEB_SEARCH' : 'WEB_FETCH', provider = family === 'web-search' ? 'tavily' : 'jina';
		const result = resolve(runtimeSnapshot(family, { [`${prefix}_PROVIDER`]: provider, [`${prefix}_API_KEY`]: privateValue, [`${prefix}_COST`]: '7', [`${prefix}_ACTIVE`]: 'wrong' }));
		assert.equal(result.ok, true); if (result.ok) { assert.equal(result.config.sources.mode, 'legacy'); assert.equal(result.config.provider, provider); assert.equal(result.config.apiKey, privateValue); assert.equal(result.config.charged, 7); }
	}
});

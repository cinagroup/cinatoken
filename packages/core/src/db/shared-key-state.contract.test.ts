import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { drizzle as pgProxy } from 'drizzle-orm/pg-proxy';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createD1SharedKeysRepository } from './d1/portal-marketplace.impl';
import { createMySqlSharedKeysRepository } from './mysql/portal-marketplace.impl';
import { createPostgresSharedKeysRepository } from './postgres/portal-marketplace.impl';
import type { SellerSharedKeyPatch, SharedKeyStateExpectation, SharedKeyValidationResult } from './shared-keys-types';
import { SHARED_KEY_STATE_COLUMNS, sharedKeyMySqlInstant, sharedKeyStateValues } from './shared-key-state';

const stamp = '2026-09-30T00:00:00.000123Z';
const now = '2026-09-30T01:00:00.000Z';
const state: SharedKeyStateExpectation = {
	sellerUserId: 'seller-1', channelType: 'openai', keyFingerprint: '…tail', status: 'paused', validatedAt: stamp,
	label: 'before', sellerPriority: 3, weight: 10, inputPrice: 1.5, outputPrice: 2,
	cacheReadPrice: null, cacheWritePrice: 0.5,
};

/** D1 executes its actual SQL. MySQL/PG execute captured production SQL with only dialect syntax adapted to SQLite.
 * This checks atomic predicates and driver acknowledgements offline, not native engine/role behavior. */
function fixture(driver: 'd1' | 'mysql' | 'postgres') {
	const database = new DatabaseSync(':memory:');
	database.exec(`CREATE TABLE shared_keys (
		id TEXT PRIMARY KEY, seller_user_id TEXT, channel_type TEXT, key_fingerprint TEXT, status TEXT,
		validated_at TEXT, label TEXT, seller_priority INTEGER, weight INTEGER,
		input_price REAL, output_price REAL, cache_read_price REAL, cache_write_price REAL,
		failure_reason TEXT, last_failure_at TEXT, updated_at TEXT, served_input_tokens INTEGER DEFAULT 0,
		served_output_tokens INTEGER DEFAULT 0, earned_total REAL DEFAULT 0
	)`);
	const values = sharedKeyStateValues(state);
	if (driver === 'mysql') values[4] = sharedKeyMySqlInstant(stamp);
	database.prepare(`INSERT INTO shared_keys (id, ${SHARED_KEY_STATE_COLUMNS.join(', ')}) VALUES (${values.map(() => '?').join(', ')}, ?)`)
		.run('key-1', ...values);
	const queries: { sql: string; values: unknown[] }[] = [];
	function execute(sql: string, values: unknown[]) {
		queries.push({ sql, values: [...values] });
		const adapted = sql.replaceAll('cinatoken_gateway.', '').replaceAll('"cinatoken_gateway".', '')
			.replace(/\$[0-9]+/gu, '?').replaceAll('<=>', 'IS').replaceAll('CURRENT_TIMESTAMP(6)', 'CURRENT_TIMESTAMP');
		const statement = database.prepare(adapted);
		return /RETURNING/iu.test(sql) ? { rows: statement.all(...values as SQLInputValue[]), changes: 0 }
			: { rows: [], changes: Number(statement.run(...values as SQLInputValue[]).changes) };
	}
	const d1Raw = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
		async run() { return { success: true, meta: { changes: execute(sql, values).changes } }; },
	}) }) };
	const mysqlRaw = { async execute(sql: string, values: unknown[]) { return [{ affectedRows: execute(sql, values).changes }]; } };
	const postgresRaw = { async unsafe(sql: string, values: unknown[]) { return execute(sql, values).rows; } };
	const postgresDrizzle = pgProxy(async (sql, values) => ({ rows: execute(sql, values).rows.map(row => Object.values(row)) }));
	const repo = driver === 'd1' ? createD1SharedKeysRepository({ raw: d1Raw } as unknown as D1DatabaseClient)
		: driver === 'mysql' ? createMySqlSharedKeysRepository({ raw: mysqlRaw } as unknown as MySqlDatabaseClient)
			: createPostgresSharedKeysRepository({ raw: postgresRaw, drizzle: postgresDrizzle } as unknown as PostgresDatabaseClient);
	return { database, repo, queries,
		current: () => ({ ...database.prepare('SELECT * FROM shared_keys WHERE id = ?').get('key-1')! }),
		change: (column: string, value: SQLInputValue) => { database.prepare(`UPDATE shared_keys SET ${column} = ? WHERE id = ?`).run(value, 'key-1'); },
	};
}

test('MySQL shared-key reads preserve six-digit UTC validation stamps for subsequent CAS', async () => {
	let selected = '';
	const raw = { async execute(sql: string) {
		selected = sql;
		return [[{ id: 'key-1', seller_user_id: 'seller-1', channel_type: 'openai', api_key: 'synthetic-secret',
			key_fingerprint: '…tail', label: 'before', status: 'paused', seller_priority: 3, weight: 10,
			input_price: '1.500000', output_price: '2.000000', cache_read_price: null, cache_write_price: '0.500000',
			validated_at: '2026-09-30 00:00:00.000123', served_input_tokens: 0, served_output_tokens: 0, earned_total: '0.000000' }]];
	} };
	const repo = createMySqlSharedKeysRepository({ raw } as unknown as MySqlDatabaseClient);
	assert.equal((await repo.getSharedKeyById('key-1'))!.validatedAt, stamp);
	assert.match(selected, /DATE_FORMAT\(validated_at, '%Y-%m-%d %H:%i:%s\.%f'\) AS validated_at/u);
});

test('seller and validation methods reject privileged/non-finite direct inputs before any database call', async () => {
	for (const driver of ['d1', 'mysql', 'postgres'] as const) {
		const f = fixture(driver);
		try {
			for (const patch of [{ sellerPriority: 100 }, { status: 'disabled' }, { weight: NaN }, { inputPrice: Infinity }]) {
				await assert.rejects(() => f.repo.updateSharedKeyForSeller('key-1', patch as SellerSharedKeyPatch, state), TypeError);
			}
			await assert.rejects(() => f.repo.completeSharedKeyValidation('key-1', { ...state, status: 'disabled' }, { valid: true, reason: null }, now), TypeError);
			await assert.rejects(() => f.repo.completeSharedKeyValidation('key-1', state, { valid: 'yes', reason: null } as unknown as SharedKeyValidationResult, now), TypeError);
			await assert.rejects(() => f.repo.completeSharedKeyValidation('key-1', state, { valid: true, reason: null }, 'invalid-time'), TypeError);
			assert.equal(f.queries.length, 0);
		} finally { f.database.close(); }
	}
});

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	test(`${driver} seller profile CAS rejects every governance/profile drift but accepts usage/encryption-clock drift`, async () => {
		const f = fixture(driver);
		try {
			for (const [column, value] of [
				['seller_user_id', 'other'], ['channel_type', 'anthropic'], ['key_fingerprint', '…other'], ['status', 'disabled'],
				['validated_at', null], ['label', 'concurrent'], ['seller_priority', 4], ['weight', 11],
				['input_price', 1.6], ['output_price', 2.1], ['cache_read_price', 0.1], ['cache_write_price', null],
			] as [string, SQLInputValue][]) {
				const before = f.current(); f.change(column, value); const changed = f.current();
				assert.equal(await f.repo.updateSharedKeyForSeller('key-1', { label: 'after' }, state), false, column);
				assert.deepEqual(f.current(), changed); f.change(column, before[column] as SQLInputValue);
			}
			f.change('served_input_tokens', 100); f.change('earned_total', 2); f.change('updated_at', 'lazy-encryption-clock');
			assert.equal(await f.repo.updateSharedKeyForSeller('key-1', { status: 'active', label: 'after' }, state), true);
			assert.equal(f.current().status, 'active'); assert.equal(f.current().served_input_tokens, 100);
			const query = f.queries.at(-1)!;
			assert.equal(query.sql.includes('served_input_tokens'), false);
			assert.equal(query.sql.includes('updated_at ='), true);
			assert.equal(query.sql.split('WHERE')[1].includes('updated_at'), false);
			assert.equal(query.sql.includes('…tail'), false);
			assert.equal(query.values.includes(driver === 'mysql' ? '2026-09-30 00:00:00.000123' : stamp), true);
		} finally { f.database.close(); }
	});
	test(`${driver} seller cannot bypass invalid, validating, disabled, or missing validation via pause/resume`, async () => {
		const f = fixture(driver);
		try {
			for (const status of ['invalid', 'validating', 'disabled']) for (const target of ['active', 'paused'] as const) {
				await assert.rejects(() => f.repo.updateSharedKeyForSeller('key-1', { status: target }, { ...state, status }), /validation/u);
			}
			await assert.rejects(() => f.repo.updateSharedKeyForSeller('key-1', { status: 'active' }, { ...state, validatedAt: null }), /validation/u);
			assert.equal(f.queries.length, 0);
			f.change('status', 'invalid'); f.change('validated_at', null);
			assert.equal(await f.repo.updateSharedKey('key-1', { status: 'active' }), false);
			assert.equal(await f.repo.updateSharedKey('key-1', { status: 'paused' }), false);
			f.change('status', 'disabled');
			assert.equal(await f.repo.updateSharedKey('key-1', { status: 'active' }), false);
			assert.equal(await f.repo.updateSharedKey('key-1', { status: 'paused' }), true);
			assert.equal(await f.repo.updateSharedKey('key-1', { status: 'active' }), false);
		} finally { f.database.close(); }
	});
	test(`${driver} validation stamp commits atomically and disabled races or ignored/failed writes never activate`, async () => {
		const f = fixture(driver);
		try {
			f.change('status', 'validating'); f.change('validated_at', null);
			const expected = { ...state, status: 'validating', validatedAt: null };
			f.change('status', 'disabled'); const disabled = f.current();
			for (const valid of [true, false]) {
				assert.equal(await f.repo.completeSharedKeyValidation('key-1', expected, { valid, reason: 'rejected' }, now), false);
				assert.deepEqual(f.current(), disabled);
			}
			f.change('status', 'validating'); const before = f.current();
			f.database.exec("CREATE TRIGGER ignored_update BEFORE UPDATE ON shared_keys BEGIN SELECT RAISE(IGNORE); END");
			assert.equal(await f.repo.completeSharedKeyValidation('key-1', expected, { valid: true, reason: null }, now), false);
			assert.deepEqual(f.current(), before); f.database.exec('DROP TRIGGER ignored_update');
			f.database.exec("CREATE TRIGGER failed_update BEFORE UPDATE ON shared_keys BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
			await assert.rejects(() => f.repo.completeSharedKeyValidation('key-1', expected, { valid: true, reason: null }, now), /injected write failure/u);
			assert.deepEqual(f.current(), before); f.database.exec('DROP TRIGGER failed_update');
			assert.equal(await f.repo.completeSharedKeyValidation('key-1', expected, { valid: true, reason: 'ignored success reason' }, now), true);
			assert.equal(f.current().status, 'active'); assert.equal(f.current().failure_reason, null);
			assert.equal(f.current().validated_at, driver === 'mysql' ? '2026-09-30 01:00:00.000000' : now);
			assert.equal(await f.repo.completeSharedKeyValidation('key-1', expected, { valid: false, reason: 'late validation' }, now), false);
		} finally { f.database.close(); }
	});
	test(`${driver} runtime auth failure preserves disabled/paused state and invalidates only the active proof`, async () => {
		const f = fixture(driver);
		try {
			for (const status of ['disabled', 'paused', 'validating', 'invalid']) {
				f.change('status', status); const before = f.current();
				await f.repo.markSharedKeyFailure('key-1', 'upstream rejected', now);
				assert.deepEqual(f.current(), before);
			}
			f.change('status', 'active'); await f.repo.markSharedKeyFailure('key-1', 'upstream rejected', now);
			assert.equal(f.current().status, 'invalid'); assert.equal(f.current().validated_at, null);
			assert.equal(f.current().failure_reason, 'upstream rejected');
			const invalid = f.current(); await f.repo.markSharedKeyFailure('key-1', 'late failure', now);
			assert.deepEqual(f.current(), invalid);
		} finally { f.database.close(); }
	});
}

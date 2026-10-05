import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import type { MySqlDatabaseClient } from '../storage/database-client';
import { adminSessionsTable, mysqlCoreSchema, portalSessionsTable, usersTable } from '../storage/drizzle/schema.mysql';
import type { AdminSessionRow } from './admin-access-types';
import { createMySqlAdminAccessRepository } from './mysql/admin-access.impl';

const migration = () => readFileSync(new NodeURL('../../migrations-mysql/0072_admin_session_username_oidc_capacity.sql', import.meta.url), 'utf8');
const now = '2026-09-30T10:00:00.000Z';
const expiresAt = '2026-09-30T18:00:00.000Z';
const session = (subject: string, tokenHash = 'a'.repeat(64)): AdminSessionRow => ({
	tokenHash, username: `cinaauth:${subject}`, createdAt: now, expiresAt,
});

/** The production mysql2 Drizzle compiler and actual repository run against a
 * narrow captured driver. This proves bound SQL/row mapping, not native MySQL
 * ALTER, charset, strict-mode or persistent-storage acceptance. */
function harness() {
	const queries: Array<{ sql: string; values: unknown[] }> = [];
	const stored = new Map<string, unknown[]>();
	let insertError: Error | null = null;
	const raw = {
		async query(query: { sql: string; rowsAsArray?: boolean }, values: unknown[]) {
			queries.push({ sql: query.sql, values });
			if (/^insert into `admin_sessions`/u.test(query.sql)) {
				assert.match(query.sql, /\(`token_hash`, `username`, `created_at`, `expires_at`\) values \(\?, \?, \?, \?\)$/u);
				if (insertError) throw insertError;
				stored.set(String(values[0]), [...values]);
				return [{ insertId: 0, affectedRows: 1 }, []];
			}
			assert.match(query.sql, /^select `token_hash`, `username`, `created_at`, `expires_at` from `admin_sessions`/u);
			assert.match(query.sql, /where \(`admin_sessions`\.`token_hash` = \? and `admin_sessions`\.`expires_at` > \?\) limit \?$/u);
			assert.equal(query.rowsAsArray, true);
			assert.equal(values[2], 1);
			const row = stored.get(String(values[0]));
			return [row && String(row[3]) > String(values[1]) ? [[...row]] : [], []];
		},
	};
	const driver = raw as unknown as Pool;
	const client: MySqlDatabaseClient = {
		driver: 'mysql', raw: driver, drizzle: drizzle(driver, { schema: mysqlCoreSchema, mode: 'default' }),
	};
	return { repository: createMySqlAdminAccessRepository(client), queries,
		failInsert(error: Error) { insertError = error; } };
}

test('actual MySQL schema provides264 username capacity without expanding other identity columns', () => {
	const columns = getTableConfig(adminSessionsTable).columns;
	assert.deepEqual(columns.map(column => column.name), ['token_hash', 'username', 'created_at', 'expires_at']);
	assert.equal(adminSessionsTable.username.getSQLType(), 'varchar(264)');
	assert.equal(adminSessionsTable.username.notNull, true);
	assert.equal(adminSessionsTable.username.hasDefault, false);
	assert.equal(adminSessionsTable.tokenHash.getSQLType(), 'varchar(64)');
	assert.equal(adminSessionsTable.tokenHash.primary, true);
	assert.equal(adminSessionsTable.createdAt.getSQLType(), 'timestamp(6)');
	assert.equal(adminSessionsTable.expiresAt.getSQLType(), 'timestamp(6)');
	assert.equal(portalSessionsTable.subject.getSQLType(), 'varchar(255)');
	assert.equal(usersTable.externalUserId.getSQLType(), 'varchar(512)');
});

test('formal0072 only widens existing username and preserves original collation/null/default contract', () => {
	const original = readFileSync(new NodeURL('../../migrations-mysql/0023_admin_access_identity.sql', import.meta.url), 'utf8');
	const originalSessions = original.slice(original.indexOf('CREATE TABLE IF NOT EXISTS admin_sessions'), original.indexOf('INSERT IGNORE'));
	assert.match(originalSessions, /username VARCHAR\(255\) NOT NULL,/u);
	assert.match(originalSessions, /DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/u);
	assert.doesNotMatch(originalSessions, /username[^\r\n]*DEFAULT/u);
	assert.match(originalSessions, /INDEX idx_admin_sessions_expires_at \(expires_at\)/u);
	const executable = migration().replace(/--[^\r\n]*/gu, '').replace(/\s+/gu, ' ').trim();
	assert.equal(executable, 'ALTER TABLE admin_sessions MODIFY COLUMN username VARCHAR(264) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;');
	assert.doesNotMatch(executable, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE|DROP|ADD|CHECK|DEFAULT)\b/u);
});

for (const length of [246, 247, 248, 255]) {
	test(`actual MySQL repository binds and returns exact OIDC subject${length} with prefix`, async () => {
		const subject = 'Aa'.repeat(128).slice(0, length);
		const expected = session(subject);
		const probe = harness();
		await probe.repository.insertSession(expected);
		assert.equal(expected.username.length, length + 9);
		assert.deepEqual(probe.queries[0]?.values, [expected.tokenHash, expected.username, now, expiresAt]);
		assert.ok(!probe.queries[0]?.sql.includes(expected.username), 'Username must remain a bound parameter');
		assert.deepEqual(await probe.repository.getValidSession(expected.tokenHash, now), expected);
		assert.deepEqual(probe.queries[1]?.values, [expected.tokenHash, now, 1]);
	});
}

test('actual repository preserves case-distinct opaque usernames and existing Unicode characters', async () => {
	const subjects = ['Aa'.repeat(127) + 'A', 'aa'.repeat(127) + 'a', "Existing-é/用户%2F'opaque"];
	const probe = harness();
	for (const [index, subject] of subjects.entries()) {
		const expected = session(subject, String(index + 1).repeat(64));
		await probe.repository.insertSession(expected);
		assert.deepEqual(await probe.repository.getValidSession(expected.tokenHash, now), expected);
	}
	assert.notEqual(probe.queries[0]?.values[1], probe.queries[2]?.values[1]);
});

test('session lookup retains bound expiry and missing-session rejection', async () => {
	const expected = session('A'.repeat(255));
	const probe = harness();
	await probe.repository.insertSession(expected);
	assert.equal(await probe.repository.getValidSession(expected.tokenHash, expiresAt), null);
	assert.equal(await probe.repository.getValidSession('b'.repeat(64), now), null);
	assert.equal(probe.queries.length, 3);
});

test('driver rejection propagates without truncation hashing or a second insert', async () => {
	const expected = session('A'.repeat(255));
	const probe = harness();
	const failure = new Error('offline driver failure');
	probe.failInsert(failure);
	await assert.rejects(() => probe.repository.insertSession(expected), error => error instanceof Error && error.cause === failure);
	assert.equal(probe.queries.length, 1);
	assert.equal(probe.queries[0]?.values[1], expected.username);
});

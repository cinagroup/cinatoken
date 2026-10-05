import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { URL } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createD1UserAuditLogsRepository } from './d1/user-audit-logs.impl';
import { createMySqlUserAuditLogsRepository } from './mysql/user-audit-logs.impl';
import { createPostgresUserAuditLogsRepository } from './postgres/user-audit-logs.impl';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
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

test('D1 global audit pagination orders 51 same-second rows across the page boundary without duplicates', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
			CREATE TABLE user_audit_logs (
				id TEXT PRIMARY KEY,
				user_id TEXT,
				api_key_id TEXT,
				event_type TEXT NOT NULL,
				actor_type TEXT NOT NULL,
				request_log_id TEXT,
				change_payload TEXT,
				before_user_snapshot TEXT,
				after_user_snapshot TEXT,
				changed_fields TEXT,
				correlation_id TEXT,
				source TEXT,
				actor_id TEXT,
				reason_code TEXT,
				reason_text TEXT,
				created_at TEXT NOT NULL
			);
			INSERT INTO users (id, email) VALUES ('user-1', 'user@example.com');
		`);
		const insert = database.prepare(`
			INSERT INTO user_audit_logs (id, user_id, event_type, actor_type, created_at)
			VALUES (?, 'user-1', 'budget_updated', 'admin', '2026-09-29 03:00:00')
		`);
		for (let index = 0; index < 51; index += 1) {
			insert.run(`audit-${String(index).padStart(3, '0')}`);
		}
		const raw = {
			prepare(sql: string): D1PreparedStatement {
				return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
			},
		} as unknown as D1Database;
		const repository = createD1UserAuditLogsRepository({
			driver: 'd1',
			raw,
			drizzle: {} as D1DatabaseClient['drizzle'],
		});
		const first = await repository.getGlobalUserAuditLogs({ page: 1, pageSize: 50 });
		const second = await repository.getGlobalUserAuditLogs({ page: 2, pageSize: 50 });
		const ids = [...first.logs, ...second.logs].map((row) => row.id);
		assert.equal(first.total, 51);
		assert.equal(second.total, 51);
		assert.equal(first.logs.length, 50);
		assert.equal(second.logs.length, 1);
		assert.deepEqual(ids, Array.from({ length: 51 }, (_, index) => `audit-${String(50 - index).padStart(3, '0')}`));
		assert.equal(new Set(ids).size, 51);
	} finally {
		database.close();
	}
});

test('D1 export keyset handles mixed SQL/ISO UTC timestamps and a concurrent newer insert', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
			CREATE TABLE user_audit_logs (
				id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, event_type TEXT NOT NULL,
				actor_type TEXT NOT NULL, request_log_id TEXT, change_payload TEXT,
				before_user_snapshot TEXT, after_user_snapshot TEXT, changed_fields TEXT,
				correlation_id TEXT, source TEXT, actor_id TEXT, reason_code TEXT,
				reason_text TEXT, created_at TEXT NOT NULL
			);
			INSERT INTO users (id, email) VALUES ('user-1', 'user@example.com');
		`);
		const insert = database.prepare(`INSERT INTO user_audit_logs
			(id, user_id, event_type, actor_type, actor_id, created_at)
			VALUES (?, 'user-1', 'budget_updated', 'admin', 'admin_key:key-1', ?)`);
		for (let index = 0; index < 101; index += 1) {
			insert.run(`audit-${String(index).padStart(3, '0')}`, index % 2 ? '2026-09-29T03:00:00.000Z' : '2026-09-29 03:00:00');
		}
		database.exec(readFileSync(new URL('../../migrations-d1/0071_user_audit_export_order_index.sql', import.meta.url), 'utf8'));
		let exportQuery: { sql: string; values: SQLInputValue[] } | undefined;
		const raw = { prepare(sql: string): D1PreparedStatement {
			return { bind(...values: SQLInputValue[]) {
				exportQuery = { sql, values };
				return new SqliteD1Statement(database, sql, values);
			} } as unknown as D1PreparedStatement;
		} } as unknown as D1Database;
		const repository = createD1UserAuditLogsRepository({ driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'] });
		const filters = { userEmail: 'user@example.com', actorKinds: ['admin_key'], startDate: '2026-09-29 03:00:00', endDate: '2026-09-29 03:00:00' };
		const first = await repository.scanGlobalUserAuditLogsForExport({ filters, limit: 50 });
		assert.equal(first.length, 50);
		const firstPlan = database.prepare(`EXPLAIN QUERY PLAN ${exportQuery!.sql}`).all(...exportQuery!.values)
			.map((row) => String(row.detail));
		assert.ok(firstPlan.some((step) => step.includes('USING INDEX idx_user_audit_export_created_id')), firstPlan.join('\n'));
		assert.equal(firstPlan.some((step) => step.includes('USE TEMP B-TREE FOR ORDER BY')), false);
		const highWater = first[0]!.cursor;
		insert.run('newer-after-first-page', '2026-09-29T03:00:01.000Z');
		insert.run('audit-zzz', '2026-09-29T03:00:00.000Z');
		const boundedFirst = await repository.scanGlobalUserAuditLogsForExport({ filters, limit: 1, highWater });
		assert.equal(boundedFirst[0]?.log.id, 'audit-100');
		const second = await repository.scanGlobalUserAuditLogsForExport({ filters, limit: 50, highWater, after: first.at(-1)!.cursor });
		const keysetPlan = database.prepare(`EXPLAIN QUERY PLAN ${exportQuery!.sql}`).all(...exportQuery!.values)
			.map((row) => String(row.detail));
		assert.ok(keysetPlan.some((step) => step.includes('USING INDEX idx_user_audit_export_created_id')), keysetPlan.join('\n'));
		assert.equal(keysetPlan.some((step) => step.includes('USE TEMP B-TREE FOR ORDER BY')), false);
		const third = await repository.scanGlobalUserAuditLogsForExport({ filters, limit: 50, highWater, after: second.at(-1)!.cursor });
		const ids = [...first, ...second, ...third].map((entry) => entry.log.id);
		assert.equal(ids.length, 101);
		assert.equal(new Set(ids).size, 101);
		assert.equal(ids.includes('newer-after-first-page'), false);
		assert.equal(ids.includes('audit-zzz'), false);
		assert.deepEqual(ids, Array.from({ length: 101 }, (_, index) => `audit-${String(100 - index).padStart(3, '0')}`));
		insert.run('end-fraction', '2026-09-29T23:59:59.999999Z');
		insert.run('next-day', '2026-09-30 00:00:00');
		const endExclusive = await repository.scanGlobalUserAuditLogsForExport({
			filters: { endDate: '2026-09-30 00:00:00', endDateExclusive: true }, limit: 1,
		});
		assert.equal(endExclusive[0]?.log.id, 'end-fraction');
		database.prepare(`INSERT INTO user_audit_logs
			(id, user_id, event_type, actor_type, reason_text, change_payload,
			 before_user_snapshot, changed_fields, created_at)
			VALUES ('oversized', 'user-1', 'admin_adjust', 'admin', ?, ?, ?, ?, '2026-10-01 00:00:00')`)
			.run('😀'.repeat(600), 'secret-change-payload', '😀'.repeat(3_000), 'secret-changed-fields');
		const oversized = await repository.scanGlobalUserAuditLogsForExport({ filters: {}, limit: 1 });
		assert.equal(oversized[0]?.oversized, true);
		assert.equal(oversized[0]?.log.reason_text, null);
		assert.equal(oversized[0]?.log.before_user_snapshot, null);
		assert.equal(Object.hasOwn(oversized[0]!.log, 'change_payload'), false);
		assert.equal(Object.hasOwn(oversized[0]!.log, 'changed_fields'), false);
		const emptySnapshot = JSON.stringify({ budget_spent: 1, note: '' });
		const remainingBytes = 8_192 - new TextEncoder().encode(emptySnapshot).byteLength;
		const atLimitSnapshot = JSON.stringify({
			budget_spent: 1,
			note: '😀'.repeat(Math.floor(remainingBytes / 4)) + 'x'.repeat(remainingBytes % 4),
		});
		assert.equal(new TextEncoder().encode(atLimitSnapshot).byteLength, 8_192);
		const insertBoundary = database.prepare(`INSERT INTO user_audit_logs
			(id, user_id, event_type, actor_type, before_user_snapshot, created_at)
			VALUES (?, 'user-1', 'admin_adjust', 'admin', ?, ?)`);
		insertBoundary.run('at-byte-limit', atLimitSnapshot, '2026-10-02 00:00:00');
		const atLimit = await repository.scanGlobalUserAuditLogsForExport({ filters: {}, limit: 1 });
		assert.equal(atLimit[0]?.oversized, false);
		assert.equal(atLimit[0]?.log.before_user_snapshot, atLimitSnapshot);
		const overLimitSnapshot = `${atLimitSnapshot.slice(0, -2)}x"}`;
		assert.equal(new TextEncoder().encode(overLimitSnapshot).byteLength, 8_193);
		insertBoundary.run('over-byte-limit', overLimitSnapshot, '2026-10-03 00:00:00');
		const overLimit = await repository.scanGlobalUserAuditLogsForExport({ filters: {}, limit: 1 });
		assert.equal(overLimit[0]?.oversized, true);
		assert.equal(overLimit[0]?.log.before_user_snapshot, null);
	} finally {
		database.close();
	}
});

test('MySQL global audit query compiles a stable descending time and ID order', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const client = {
		query: async (query: { sql: string }, values: unknown[]) => {
			calls.push({ sql: query.sql, values });
			return [[], []];
		},
	};
	const repository = createMySqlUserAuditLogsRepository({
		driver: 'mysql',
		raw: {} as MySqlDatabaseClient['raw'],
		drizzle: mysqlDrizzle(client as never),
	});
	await repository.getGlobalUserAuditLogs({ page: 2, pageSize: 50 });
	const list = calls.at(-1);
	assert.equal(calls.length, 2);
	assert.match(list?.sql ?? '', /order by `user_audit_logs`\.`created_at` desc, `user_audit_logs`\.`id` desc limit \? offset \?/i);
	assert.deepEqual(list?.values, [50, 50]);
});

test('PostgreSQL global audit query compiles a stable descending time and ID order', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const client = {
		options: { parsers: {}, serializers: {} },
		unsafe: (sql: string, values: unknown[]) => {
			calls.push({ sql, values });
			return { values: async () => [] };
		},
	};
	const repository = createPostgresUserAuditLogsRepository({
		driver: 'postgres',
		raw: {} as PostgresDatabaseClient['raw'],
		drizzle: postgresDrizzle(client as never),
	});
	await repository.getGlobalUserAuditLogs({ page: 2, pageSize: 50 });
	const list = calls.at(-1);
	assert.equal(calls.length, 2);
	assert.match(list?.sql ?? '', /order by "cinatoken_gateway"\."user_audit_logs"\."created_at" desc, "cinatoken_gateway"\."user_audit_logs"\."id" desc limit \$1 offset \$2/i);
	assert.deepEqual(list?.values, [50, 50]);
});

test('MySQL and PostgreSQL export scans compile keyset bounds, full filters, and no offset', async () => {
	const filters = {
		userEmail: 'user@example.com', eventTypes: ['budget_updated'], actorKinds: ['admin_key'],
		startDate: '2026-09-29 00:00:00', endDate: '2026-09-29 23:59:59',
	};
	const after = { createdAt: '2026-09-29 03:00:00.123456', id: 'audit-050' };
	const highWater = { createdAt: '2026-09-29 03:00:01.123456', id: 'audit-100' };
	const mysqlCalls: Array<{ sql: string; values: unknown[] }> = [];
	const mysqlRaw = {
		query: async () => { throw new Error('Timed export must use the raw prepared SELECT'); },
		execute: async (sql: string, values: unknown[]) => {
			mysqlCalls.push({ sql, values });
			return [mysqlCalls.length === 1 ? [{
				id: 'audit-001', requestLogId: 'req-1', correlationId: 'corr-1',
				eventType: 'budget_updated', source: 'admin', reasonCode: 'manual', reasonText: 'updated',
				actorType: 'admin_key', actorId: 'admin:key-1', userId: 'user-1', userEmail: 'user@example.com',
				apiKeyId: 'key-1', beforeUserSnapshot: '{}', afterUserSnapshot: '{"budget":1}',
				oversized: 0, cursorCreatedAt: '2026-09-29 03:00:00.123456',
			}] : [], []];
		},
	};
	const mysqlRepository = createMySqlUserAuditLogsRepository({
		driver: 'mysql', raw: mysqlRaw as unknown as MySqlDatabaseClient['raw'], drizzle: mysqlDrizzle(mysqlRaw as never),
	});
	const mysqlRows = await mysqlRepository.scanGlobalUserAuditLogsForExport({
		filters, limit: 100,
		after: { createdAt: '2026-09-29T03:00:00.123456Z', id: after.id },
		highWater,
	});
	assert.equal(mysqlCalls.length, 1);
	assert.equal(mysqlRows.length, 1);
	assert.deepEqual(mysqlRows[0]!.cursor, { createdAt: '2026-09-29 03:00:00.123456', id: 'audit-001' });
	assert.equal(mysqlRows[0]!.log.request_log_id, 'req-1');
	assert.equal(mysqlRows[0]!.log.user_email, 'user@example.com');
	assert.equal(mysqlRows[0]!.log.after_user_snapshot, '{"budget":1}');
	assert.equal(mysqlRows[0]!.oversized, false);
	assert.match(mysqlCalls[0]!.sql, /^select \/\*\+ MAX_EXECUTION_TIME\(5000\) \*\//iu);
	assert.match(mysqlCalls[0]!.sql, /as `requestLogId`/iu);
	assert.match(mysqlCalls[0]!.sql, /as `cursorCreatedAt`/iu);
	assert.match(mysqlCalls[0]!.sql, /order by `user_audit_logs`\.`created_at` desc, `user_audit_logs`\.`id` desc limit \?/i);
	assert.match(mysqlCalls[0]!.sql, /date_format\(`user_audit_logs`\.`created_at`, '%Y-%m-%d %H:%i:%s\.%f'\)/i);
	assert.match(mysqlCalls[0]!.sql, /`user_audit_logs`\.`created_at` < \?/i);
	assert.match(mysqlCalls[0]!.sql, /`user_audit_logs`\.`created_at` >= \?/i);
	assert.match(mysqlCalls[0]!.sql, /`user_audit_logs`\.`id` < \?/i);
	assert.doesNotMatch(mysqlCalls[0]!.sql, /unix_timestamp|cast\(/i);
	assert.doesNotMatch(mysqlCalls[0]!.sql, /offset/i);
	assert.match(mysqlCalls[0]!.sql, /OCTET_LENGTH\(/i);
	assert.match(mysqlCalls[0]!.sql, /CASE WHEN .* THEN NULL ELSE /i);
	assert.doesNotMatch(mysqlCalls[0]!.sql, /change_payload|changed_fields/i);
	assert.ok(mysqlCalls[0]!.values.includes('budget_updated'));
	assert.ok(mysqlCalls[0]!.values.includes('audit-050'));
	assert.ok(mysqlCalls[0]!.values.includes('2026-09-29 00:00:00'));
	assert.ok(mysqlCalls[0]!.values.includes('2026-09-29 03:00:00.123456'));
	assert.ok(mysqlCalls[0]!.values.includes('2026-09-29 03:00:01.123456'));
	await mysqlRepository.scanGlobalUserAuditLogsForExport({
		filters: {}, limit: 1,
		after: { createdAt: '2026-09-29 03:00:00.123456', id: after.id },
		highWater: { createdAt: '2026-09-29T03:00:01.123456Z', id: highWater.id },
	});
	assert.ok(mysqlCalls[1]!.values.includes('2026-09-29 03:00:00.123456'));
	assert.ok(mysqlCalls[1]!.values.includes('2026-09-29 03:00:01.123456'));
	await assert.rejects(mysqlRepository.scanGlobalUserAuditLogsForExport({
		filters: {}, limit: 1, after: { createdAt: '2026-02-30 03:00:00', id: after.id },
	}), /Invalid MySQL audit UTC cursor/u);
	const pgCalls: Array<{ sql: string; values: unknown[] }> = [];
	let pgTransactions = 0;
	type MockPostgresClient = {
		options: { parsers: Record<string, never>; serializers: Record<string, never> };
		begin(callback: (client: MockPostgresClient) => Promise<unknown>): Promise<unknown>;
		unsafe(sql: string, values: unknown[]): { values(): Promise<unknown[]> };
	};
	const pgClient: MockPostgresClient = {
		options: { parsers: {}, serializers: {} },
		begin: async (callback) => {
			pgTransactions += 1;
			return callback(pgClient);
		},
		unsafe: (sql: string, values: unknown[]) => {
			pgCalls.push({ sql, values });
			return { values: async () => [] };
		},
	};
	const pgRepository = createPostgresUserAuditLogsRepository({ driver: 'postgres', raw: {} as PostgresDatabaseClient['raw'], drizzle: postgresDrizzle(pgClient as never) });
	await pgRepository.scanGlobalUserAuditLogsForExport({ filters, limit: 100, after, highWater });
	assert.equal(pgTransactions, 1);
	assert.equal(pgCalls.length, 2);
	assert.match(pgCalls[0]!.sql, /^SET LOCAL statement_timeout = 5000$/iu);
	const pgSelect = pgCalls[1]!;
	assert.match(pgSelect.sql, /order by "cinatoken_gateway"\."user_audit_logs"\."created_at" desc, "cinatoken_gateway"\."user_audit_logs"\."id" desc limit \$\d+/i);
	assert.match(pgSelect.sql, /AT TIME ZONE 'UTC'/i);
	assert.match(pgSelect.sql, /"user_audit_logs"\."id" < \$\d+/i);
	assert.doesNotMatch(pgSelect.sql, /offset/i);
	assert.match(pgSelect.sql, /octet_length\(/i);
	assert.match(pgSelect.sql, /CASE WHEN .* THEN NULL ELSE /i);
	assert.doesNotMatch(pgSelect.sql, /change_payload|changed_fields/i);
	assert.ok(pgSelect.values.includes('budget_updated'));
	assert.ok(pgSelect.values.includes('audit-050'));
});

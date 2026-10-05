import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../../storage/database-client';
import { createD1UsersRepository } from './users.impl';

class SqliteD1Statement {
	constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.db, this.sql, values) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		const result = this.db.prepare(this.sql).run(...this.values);
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
	}
}

function fixture() {
	const db = new DatabaseSync(':memory:');
	db.exec(`PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY);
		CREATE TABLE guardrails (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
			is_workspace_default INTEGER NOT NULL DEFAULT 0,
			is_account_default INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			api_key_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
			request_log_id TEXT, change_payload TEXT, before_user_snapshot TEXT,
			after_user_snapshot TEXT, changed_fields TEXT, correlation_id TEXT,
			source TEXT, actor_id TEXT, reason_code TEXT, reason_text TEXT
		);
		CREATE TABLE dispatch_history (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
		);`);
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(db, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			db.exec('BEGIN');
			try {
				const result = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	const client = { driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient;
	const atomicDelete = createD1UsersRepository(client).deleteUserHardWithAudit;
	assert.ok(atomicDelete);
	const audit = (id: string, userId = 'u1') => ({
		id, userId, eventType: 'user_deleted' as const, actorType: 'admin' as const,
		actorId: 'admin-1', source: 'admin_users', reasonCode: 'admin_user_delete',
		changePayload: JSON.stringify({ deleted_user_id: userId }),
	});
	return { db, atomicDelete, audit };
}

test('D1 hard deletion commits its audit and DELETE in one batch', async () => {
	const { db, atomicDelete, audit } = fixture();
	try {
		db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
		assert.equal(await atomicDelete('u1', audit('a1')), 'deleted');
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('u1')?.n, 0);
		const row = db.prepare('SELECT user_id, change_payload FROM user_audit_logs WHERE id = ?').get('a1');
		assert.equal(row?.user_id, null);
		assert.equal(JSON.parse(String(row?.change_payload)).deleted_user_id, 'u1');
	} finally { db.close(); }
});

test('D1 guarded or missing user leaves no success audit', async () => {
	const { db, atomicDelete, audit } = fixture();
	try {
		db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
		db.prepare('INSERT INTO guardrails (id, owner_user_id, is_account_default) VALUES (?, ?, 1)').run('g1', 'u1');
		assert.equal(await atomicDelete('u1', audit('a1')), 'not_deleted');
		assert.equal(await atomicDelete('missing', audit('a2', 'missing')), 'not_deleted');
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_audit_logs').get()?.n, 0);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n, 1);
	} finally { db.close(); }
});

test('D1 audit insert error or FK-restricted DELETE rolls back both writes', async () => {
	const { db, atomicDelete, audit } = fixture();
	try {
		db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
		db.prepare("INSERT INTO user_audit_logs (id, user_id, event_type, actor_type) VALUES ('duplicate', NULL, 'user_deleted', 'admin')").run();
		await assert.rejects(() => atomicDelete('u1', audit('duplicate')));
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('u1')?.n, 1);
		db.prepare('INSERT INTO dispatch_history (id, user_id) VALUES (?, ?)').run('history-1', 'u1');
		await assert.rejects(() => atomicDelete('u1', audit('a1')));
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('u1')?.n, 1);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_audit_logs WHERE id = ?').get('a1')?.n, 0);
	} finally { db.close(); }
});

import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { AdminKeyMutationWithAudit } from '../../storage/gateway-repository-interfaces';
import type { D1DatabaseClient } from '../../storage/database-client';
import type { UserAuditSnapshot } from '../user-audit-snapshot';
import { createD1ApiKeysRepository } from './api-keys.impl';

class SqliteD1Statement {
	constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.db, this.sql, values) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		const result = this.db.prepare(this.sql).run(...this.values);
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
	}
	first(): Record<string, unknown> | null {
		return this.db.prepare(this.sql).get(...this.values) ?? null;
	}
}

function fixture() {
	const db = new DatabaseSync(':memory:');
	db.exec(`PRAGMA foreign_keys = ON;
		CREATE TABLE users (
			id TEXT PRIMARY KEY, email TEXT NOT NULL, budget_max REAL, budget_base REAL NOT NULL,
			budget_spent REAL NOT NULL, budget_period TEXT NOT NULL, budget_reset_at TEXT,
			budget_epoch INTEGER NOT NULL, budget_reserved_micros INTEGER NOT NULL,
			status TEXT NOT NULL, metadata TEXT, charged_cost_factors TEXT,
			external_system TEXT, external_user_id TEXT
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY, key TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT, status TEXT NOT NULL,
			metadata TEXT, updated_at TEXT NOT NULL,
			CHECK (status <> 'forbidden')
		);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
			api_key_id TEXT REFERENCES api_keys(id), event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
			request_log_id TEXT, change_payload TEXT, before_user_snapshot TEXT,
			after_user_snapshot TEXT, changed_fields TEXT, correlation_id TEXT,
			source TEXT, actor_id TEXT, reason_code TEXT, reason_text TEXT
		);`);
	const userSnapshot: UserAuditSnapshot = {
		id: 'u1', email: 'user@example.test', budget_max: 10, budget_base: 10,
		budget_spent: 3, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0,
		status: 'active', metadata: null, charged_cost_factors: null,
		external_system: null, external_user_id: null,
	};
	db.prepare(`INSERT INTO users (
		id, email, budget_max, budget_base, budget_spent, budget_period, budget_reset_at,
		budget_epoch, budget_reserved_micros, status, metadata, charged_cost_factors,
		external_system, external_user_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(userSnapshot));
	db.prepare('INSERT INTO api_keys (id, key, user_id, workspace_id, name, status, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.run('k1', 'sk-secret-value', 'u1', 'w1', 'before', 'active', '{}', '2026-01-01T00:00:00.000Z');
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(db, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			db.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
				db.exec('COMMIT');
				return results;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	const repo = createD1ApiKeysRepository({ driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient);
	assert.ok(repo.applyAdminKeyMutationWithAudit);
	const mutate = repo.applyAdminKeyMutationWithAudit;
	const input = (id: string, patch: AdminKeyMutationWithAudit['patch'], reasonCode = 'admin_patch_key_profile'): AdminKeyMutationWithAudit => ({
		id: 'k1',
		expected: { userId: 'u1', workspaceId: 'w1', name: 'before', status: 'active', metadata: '{}' },
		patch,
		expectedUserSnapshot: userSnapshot,
		audit: {
			id, userId: 'u1', apiKeyId: 'k1', eventType: patch.status === 'revoked' ? 'key_revoked' : 'admin_adjust',
			actorType: 'admin', actorId: 'admin:test', source: 'admin_keys', reasonCode,
			beforeUserSnapshot: JSON.stringify(userSnapshot), afterUserSnapshot: JSON.stringify(userSnapshot),
			changePayload: JSON.stringify({ name: { from: 'before', to: patch.name } }),
		},
	});
	const key = () => db.prepare('SELECT name, status, metadata FROM api_keys WHERE id = ?').get('k1');
	const auditCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM user_audit_logs').get()?.n);
	return { db, mutate, input, key, auditCount };
}

test('D1 Admin Key multi-field mutation and audit commit together without Key secret', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		const mutation = input('a1', { name: 'after', status: 'revoked', metadata: '{"team":"ops"}' });
		assert.equal(await mutate(mutation), 'applied');
		assert.deepEqual({ ...key() }, { name: 'after', status: 'revoked', metadata: '{"team":"ops"}' });
		assert.equal(auditCount(), 1);
		const audit = db.prepare('SELECT event_type, source, reason_code, change_payload FROM user_audit_logs').get();
		assert.equal(audit?.event_type, 'key_revoked');
		assert.equal(audit?.source, 'admin_keys');
		assert.doesNotMatch(JSON.stringify(audit), /sk-secret-value/u);
	} finally { db.close(); }
});

test('D1 stale Key profile or missing row changes nothing and writes no success audit', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		const stale = input('a1', { name: 'after' });
		stale.expected.name = 'stale';
		assert.equal(await mutate(stale), 'conflict');
		assert.equal(auditCount(), 0);
		assert.equal(key()?.name, 'before');
		db.prepare('DELETE FROM api_keys WHERE id = ?').run('k1');
		assert.equal(await mutate(input('a2', { name: 'after' })), 'not_found');
		assert.equal(auditCount(), 0);
	} finally { db.close(); }
});

test('D1 rejects an audit built before a concurrent user budget charge', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		const stale = input('a1', { name: 'after' });
		// Same Key profile, but the user state included in its audit is now stale.
		db.prepare('UPDATE users SET budget_spent = ?, budget_reserved_micros = ? WHERE id = ?')
			.run(4, 1000, 'u1');
		assert.equal(await mutate(stale), 'conflict');
		assert.equal(key()?.name, 'before');
		assert.equal(auditCount(), 0);
	} finally { db.close(); }
});

test('D1 REAL long-tail budget mirror matches its six-decimal audit snapshot', async () => {
	const { db, mutate, input, auditCount } = fixture();
	try {
		db.prepare('UPDATE users SET budget_base = ?, budget_spent = ? WHERE id = ?')
			.run(10.0000000001, 3.0000000001, 'u1');
		assert.equal(await mutate(input('a1', { name: 'after' })), 'applied');
		assert.equal(auditCount(), 1);
	} finally { db.close(); }
});

test('D1 refuses a changed Key without a matching success audit', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		const missingAudit = input('a1', { name: 'after' });
		missingAudit.audit = null;
		await assert.rejects(() => mutate(missingAudit), /needs an audit/u);
		const wrongKey = input('a2', { name: 'after' });
		if (wrongKey.audit) wrongKey.audit.apiKeyId = 'another-key';
		await assert.rejects(() => mutate(wrongKey), /does not identify the changed Key/u);
		assert.equal(key()?.name, 'before');
		assert.equal(auditCount(), 0);
	} finally { db.close(); }
});

test('D1 audit failure and second-field UPDATE constraint failure roll back every write', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		db.prepare("INSERT INTO user_audit_logs (id, user_id, api_key_id, event_type, actor_type) VALUES ('duplicate', 'u1', 'k1', 'admin_adjust', 'admin')").run();
		await assert.rejects(() => mutate(input('duplicate', { name: 'after' })));
		assert.equal(key()?.name, 'before');
		assert.equal(auditCount(), 1);
		await assert.rejects(() => mutate(input('a2', { name: 'after', status: 'forbidden', metadata: '{"x":1}' })));
		assert.deepEqual({ ...key() }, { name: 'before', status: 'active', metadata: '{}' });
		assert.equal(auditCount(), 1);
	} finally { db.close(); }
});

test('D1 repeated DELETE deliberately commits another tombstone audit while status stays revoked', async () => {
	const { db, mutate, input, key, auditCount } = fixture();
	try {
		const first = input('a1', { status: 'revoked' }, 'admin_key_delete_tombstone');
		assert.equal(await mutate(first), 'applied');
		const second = input('a2', { status: 'revoked' }, 'admin_key_delete_tombstone');
		second.expected.status = 'revoked';
		assert.equal(await mutate(second), 'applied');
		assert.equal(key()?.status, 'revoked');
		assert.equal(auditCount(), 2);
	} finally { db.close(); }
});

import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from './database-client';
import { listWorkspaceBudgetUsage } from './workspace-budgets';

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

function client(database: DatabaseSync): D1DatabaseClient {
	return {
		driver: 'd1',
		raw: {
			prepare: (sql: string) => new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement,
		} as unknown as D1Database,
		drizzle: {} as D1DatabaseClient['drizzle'],
	};
}

function setup(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE workspace_budgets (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			reset_interval TEXT NOT NULL,
			limit_micros INTEGER NOT NULL,
			config_epoch INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE guardrail_budget_windows (
			workspace_id TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			period TEXT NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			unreserved_micros INTEGER NOT NULL,
			settled_micros INTEGER NOT NULL,
			reserved_micros INTEGER NOT NULL,
			PRIMARY KEY (workspace_id, scope_type, scope_id, period, period_start)
		);
		CREATE TABLE api_key_request_logs (
			workspace_id TEXT,
			charged_cost REAL NOT NULL,
			budget_charged_micros INTEGER,
			budget_accounted_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX idx_api_key_request_logs_workspace_budget_accounted
			ON api_key_request_logs(workspace_id, COALESCE(budget_accounted_at, created_at));

		INSERT INTO workspaces VALUES ('workspace-1', 'active', '2026-01-01T00:00:00.000Z');
		INSERT INTO workspace_budgets VALUES
			('budget-daily', 'workspace-1', 'daily', 10000000, 0,
				'2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
			('budget-weekly', 'workspace-1', 'weekly', 20000000, 0,
				'2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
		INSERT INTO guardrail_budget_windows VALUES (
			'workspace-1', 'workspace', 'workspace-1', 'daily',
			'2026-09-04T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
			2000000, 1000000, 500000
		);
		INSERT INTO api_key_request_logs VALUES
			('workspace-1', 99, 4000000, NULL, '2026-09-02T12:00:00.000Z'),
			('workspace-1', 1.25, NULL, '2026-09-03T12:00:00.000Z', '2026-08-01T00:00:00.000Z'),
			('workspace-1', 0, 0, NULL, '2026-09-03T13:00:00.000Z'),
			('workspace-1', 50, 50000000, NULL, '2026-08-30T23:59:59.999Z'),
			('workspace-2', 50, 50000000, NULL, '2026-09-02T12:00:00.000Z');
	`);
	return database;
}

test('Workspace budget usage prefers the current ledger and falls back to charged request logs', async () => {
	const database = setup();
	try {
		const rows = await listWorkspaceBudgetUsage(
			client(database),
			'workspace-1',
			new Date('2026-09-04T12:00:00.000Z'),
		);
		assert.deepEqual(rows.map((row) => ({
			interval: row.reset_interval,
			start: row.period_start,
			end: row.period_end,
			spent: row.spent_micros,
			reserved: row.reserved_micros,
			remaining: row.remaining_micros,
		})), [
			{
				interval: 'daily',
				start: '2026-09-04T00:00:00.000Z',
				end: '2026-09-05T00:00:00.000Z',
				spent: 3_000_000,
				reserved: 500_000,
				remaining: 6_500_000,
			},
			{
				interval: 'weekly',
				start: '2026-08-31T00:00:00.000Z',
				end: '2026-09-07T00:00:00.000Z',
				spent: 5_250_000,
				reserved: 0,
				remaining: 14_750_000,
			},
		]);

		const queryPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM(budget_charged_micros), 0)
			FROM api_key_request_logs
			WHERE workspace_id = ?
				AND COALESCE(budget_accounted_at, created_at) >= ?
				AND COALESCE(budget_accounted_at, created_at) < ?`)
			.all('workspace-1', '2026-08-31T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
		assert.match(
			queryPlan.map((row) => String(row.detail)).join('\n'),
			/idx_api_key_request_logs_workspace_budget_accounted/u,
		);
	} finally {
		database.close();
	}
});

test('Workspace budget usage fails closed on unsafe ledger values', async () => {
	const database = setup();
	try {
		database.prepare(`UPDATE guardrail_budget_windows SET settled_micros = ?
			WHERE period = 'daily'`).run(9_007_199_254_740_992);
		await assert.rejects(
			listWorkspaceBudgetUsage(client(database), 'workspace-1', new Date('2026-09-04T12:00:00.000Z')),
			/Workspace budget settled amount is invalid|too large to be represented as a JavaScript number/iu,
		);
	} finally {
		database.close();
	}
});

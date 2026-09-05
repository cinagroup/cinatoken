import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayDatabaseClient } from './database-client';
import { listWorkspaceBudgetUsage } from './workspace-budgets';

const budget = {
	id: 'budget-1',
	workspace_id: 'workspace-1',
	reset_interval: 'daily',
	limit_micros: '10000000',
	config_epoch: '0',
	workspace_created_at: '2026-01-01T00:00:00.000Z',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
};

test('PostgreSQL Workspace usage reads the exact ledger window and accepts BIGINT strings', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const raw = {
		async unsafe(sql: string, values: unknown[]) {
			calls.push({ sql, values });
			if (sql.includes('FROM workspace_budgets')) return [budget];
			if (sql.includes('FROM guardrail_budget_windows')) {
				return [{ unreserved_micros: '1250000', settled_micros: '500000', reserved_micros: '250000' }];
			}
			throw new Error(`Unexpected PostgreSQL query: ${sql}`);
		},
	};
	const rows = await listWorkspaceBudgetUsage(
		{ driver: 'postgres', raw } as unknown as GatewayDatabaseClient,
		'workspace-1',
		new Date('2026-09-04T12:00:00.000Z'),
	);
	assert.equal(rows[0]?.spent_micros, 1_750_000);
	assert.equal(rows[0]?.reserved_micros, 250_000);
	assert.equal(rows[0]?.remaining_micros, 8_000_000);
	assert.match(calls[1]?.sql ?? '', /period_start = \$3::timestamptz/u);
	assert.deepEqual(calls[1]?.values, [
		'workspace-1',
		'daily',
		'2026-09-04T00:00:00.000Z',
		'2026-09-05T00:00:00.000Z',
	]);
});

test('MySQL Workspace usage fallback uses the indexed effective accounting timestamp', async () => {
	const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
	const raw = {
		async query(sql: string, values?: unknown[]) {
			calls.push({ sql, values });
			if (sql.includes('FROM workspace_budgets')) return [[budget], []];
			if (sql.includes('FROM guardrail_budget_windows')) return [[], []];
			if (sql.includes('FROM api_key_request_logs')) return [[{ spent_micros: '2500000' }], []];
			throw new Error(`Unexpected MySQL query: ${sql}`);
		},
	};
	const rows = await listWorkspaceBudgetUsage(
		{ driver: 'mysql', raw } as unknown as GatewayDatabaseClient,
		'workspace-1',
		new Date('2026-09-04T12:00:00.000Z'),
	);
	assert.equal(rows[0]?.spent_micros, 2_500_000);
	assert.equal(rows[0]?.reserved_micros, 0);
	assert.equal(rows[0]?.remaining_micros, 7_500_000);
	const fallback = calls.find((call) => call.sql.includes('FROM api_key_request_logs'));
	assert.match(fallback?.sql ?? '', /budget_accounted_effective_at >= \?/u);
	assert.deepEqual(fallback?.values, [
		'workspace-1',
		'2026-09-04 00:00:00.000000',
		'2026-09-05 00:00:00.000000',
	]);
});

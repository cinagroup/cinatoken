import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../storage/database-client';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';

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

function requestLogsRepository(database: DatabaseSync) {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
	const client = {
		driver: 'd1',
		raw,
		drizzle: {} as D1DatabaseClient['drizzle'],
	} satisfies D1DatabaseClient;
	return createD1RequestLogsRepository(client);
}

test('D1 request logs and range stats enforce user and Workspace boundaries together', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, external_system TEXT);
			INSERT INTO users VALUES ('user-1', 'cinaauth'), ('user-2', 'cinaauth');
			CREATE TABLE api_keys (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL
			);
			INSERT INTO api_keys VALUES
				('key-user-1-personal', 'personal:user-1'),
				('key-user-1-org', 'organization:org-1'),
				('key-user-2-org', 'organization:org-1');
			CREATE TABLE api_key_request_logs (
				id TEXT PRIMARY KEY,
				user_id TEXT,
				api_key_id TEXT,
				workspace_id TEXT,
				model_id TEXT,
				model_name TEXT,
				provider_name TEXT,
				status TEXT NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				latency_ms INTEGER,
				charged_cost REAL NOT NULL,
				metered_cost REAL NOT NULL,
				standard_cost REAL NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT INTO api_key_request_logs VALUES
				('request-user-1-personal', 'user-1', 'key-user-1-personal', 'personal:user-1', 'deepseek/deepseek-chat', 'DeepSeek Chat', 'DeepSeek', 'success', 10, 5, 2, 1, 15, 120, 0.25, 0.2, 0.3, '2026-08-30T00:00:00.000Z'),
				('request-user-1-org', 'user-1', 'key-user-1-org', 'organization:org-1', 'deepseek/deepseek-chat', 'DeepSeek Chat', 'DeepSeek', 'success', 20, 10, 0, 0, 30, 200, 0.5, 0.4, 0.6, '2026-08-30T00:00:30.000Z'),
				('request-user-2', 'user-2', 'key-user-2-org', 'organization:org-1', 'private/model', 'Private Model', 'Private Provider', 'error', 1000, 500, 0, 0, 1500, 999, 7.0, 6.0, 8.0, '2026-08-30T00:01:00.000Z');
		`);

		const stats = await requestLogsRepository(database).getRequestStatsByRange({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			userId: 'user-1',
			workspaceId: 'personal:user-1',
		});

		assert.deepEqual(stats, {
			totalRequests: 1,
			errorCount: 0,
			successCount: 1,
			chargedCost: 0.25,
			meteredCost: 0.2,
			standardCost: 0.3,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
			totalTokens: 15,
			avgLatencyMs: 120,
		});

		const filteredStats = await requestLogsRepository(database).getRequestStatsByRange({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			userId: 'user-1',
			workspaceId: 'personal:user-1',
			apiKeyId: 'key-user-1-personal',
			modelId: 'deepseek/deepseek-chat',
			providerName: 'DeepSeek',
			status: 'success',
		});
		assert.equal(filteredStats.totalRequests, 1);
		assert.equal(filteredStats.chargedCost, 0.25);

		const modelGroups = await requestLogsRepository(database).getRequestActivityGroups({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			userId: 'user-1',
			workspaceId: 'personal:user-1',
			dimension: 'model',
			limit: 10,
		});
		assert.deepEqual(modelGroups, [{
			id: 'deepseek/deepseek-chat',
			name: 'DeepSeek Chat',
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 15,
			chargedCost: 0.25,
		}]);

		const keyGroups = await requestLogsRepository(database).getRequestActivityGroups({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			userId: 'user-1',
			workspaceId: 'organization:org-1',
			dimension: 'apiKey',
			limit: 10,
		});
		assert.deepEqual(keyGroups, [{
			id: 'key-user-1-org',
			name: null,
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 30,
			chargedCost: 0.5,
		}]);

		const providerGroups = await requestLogsRepository(database).getRequestActivityGroups({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			userId: 'user-1',
			workspaceId: 'organization:org-1',
			dimension: 'provider',
			limit: 10,
		});
		assert.deepEqual(providerGroups, [{
			id: 'DeepSeek',
			name: null,
			requestCount: 1,
			successCount: 1,
			errorCount: 0,
			totalTokens: 30,
			chargedCost: 0.5,
		}]);

		const timeline = await requestLogsRepository(database).queryRequestTimeseries({
			startDate: '2026-08-29T00:00:00.000Z',
			endDate: '2026-08-31T00:00:00.000Z',
			endExclusive: true,
			granularity: 'day',
			userId: 'user-1',
			workspaceId: 'organization:org-1',
			providerName: 'DeepSeek',
		});
		assert.deepEqual(timeline, [{
			bucket: '2026-08-30',
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 30,
			chargedCost: 0.5,
			avgLatencyMs: 200,
		}]);

		const logs = await requestLogsRepository(database).getRequestLogs({
			page: 1,
			pageSize: 20,
			userId: 'user-1',
			workspaceId: 'organization:org-1',
			providerName: 'DeepSeek',
		});
		assert.equal(logs.total, 1);
		assert.deepEqual(logs.logs.map((row) => row.id), ['request-user-1-org']);
	} finally {
		database.close();
	}
});

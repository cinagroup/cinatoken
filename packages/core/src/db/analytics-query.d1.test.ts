import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../storage/database-client';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';
import { buildManagementAnalyticsQuery } from './analytics-query';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function repository(database: DatabaseSync) {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
	return createD1RequestLogsRepository({
		driver: 'd1',
		raw,
		drizzle: {} as D1DatabaseClient['drizzle'],
	});
}

function createSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			organization_id TEXT,
			personal_owner_user_id TEXT,
			name TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			key_hash TEXT,
			key_preview TEXT,
			name TEXT
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			api_key_id TEXT,
			workspace_id TEXT,
			model_id TEXT,
			provider_name TEXT,
			http_referer TEXT,
			session_id TEXT,
			finish_reason TEXT,
			service_tier TEXT,
			is_byok INTEGER,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			reasoning_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			latency_ms INTEGER,
			charged_cost REAL NOT NULL,
			metered_cost REAL NOT NULL,
			standard_cost REAL NOT NULL,
			created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES
			('user-owner', 'owner@example.com'),
			('user-member', 'member@example.com'),
			('user-outsider', 'outsider@example.com');
		INSERT INTO workspaces VALUES
			('personal:user-owner', 'personal', NULL, 'user-owner', 'Personal', 'active'),
			('workspace-org', 'organization', 'org-1', NULL, 'Production', 'active'),
			('workspace-other', 'organization', 'org-2', NULL, 'Foreign', 'active');
		INSERT INTO api_keys VALUES
			('key-owner', 'sha256:${'a'.repeat(64)}', 'sk-owner…aaaa', 'Owner Key'),
			('key-member', 'sha256:${'b'.repeat(64)}', 'sk-member…bbbb', 'Batch Worker'),
			('key-other', 'sha256:${'c'.repeat(64)}', 'sk-other…cccc', 'Foreign Key');
		INSERT INTO api_key_request_logs VALUES
			('gen-personal', 'user-owner', 'key-owner', 'personal:user-owner', 'deepseek/deepseek-chat', 'DeepSeek', 'https://personal.example', NULL, 'stop', 'default', 0, 10, 5, 1, 2, 15, 100, 0.25, 0.20, 0.30, '2026-09-01T00:00:00.000Z'),
			('gen-injected', 'user-member', 'key-member', 'personal:user-owner', 'private/leak', 'Private', NULL, NULL, 'stop', 'default', 0, 999, 999, 0, 0, 1998, 999, 9, 8, 10, '2026-09-01T01:00:00.000Z'),
			('gen-org-platform', 'user-owner', 'key-owner', 'workspace-org', 'deepseek/deepseek-chat', 'DeepSeek', 'https://app.example', 'session-1', 'stop', 'default', 0, 20, 10, 2, 5, 30, 120, 0.25, 0.20, 0.30, '2026-09-01T02:00:00.000Z'),
			('gen-org-byok', 'user-member', 'key-member', 'workspace-org', 'deepseek/deepseek-chat', 'DeepSeek', 'https://app.example', 'session-1', 'length', 'flex', 1, 40, 20, 4, 10, 60, 180, 0, 0, 0.60, '2026-09-02T02:00:00.000Z'),
			('gen-foreign', 'user-outsider', 'key-other', 'workspace-other', 'private/model', 'Private Provider', 'https://foreign.example', 'foreign', 'stop', 'default', 0, 1000, 500, 0, 0, 1500, 500, 7, 6, 8, '2026-09-02T03:00:00.000Z');
	`);
}

test('D1 Management analytics enforces organization scope and computes BYOK-aware metrics', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'organization',
				personalOwnerUserId: null,
				organizationId: 'org-1',
			},
			metrics: [
				'request_count', 'total_usage', 'credits_usage', 'byok_usage',
				'usage_upstream', 'tokens_total', 'reasoning_tokens',
				'cached_tokens', 'cache_hit_rate', 'avg_latency',
			],
			dimensions: ['model', 'provider'],
			filters: [],
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			limit: 10,
		});

		assert.equal(result.truncated, false);
		assert.deepEqual(result.rows, [{
			model: 'deepseek/deepseek-chat',
			provider: 'DeepSeek',
			request_count: '2',
			total_usage: 0.85,
			credits_usage: 0.25,
			byok_usage: 0.6,
			usage_upstream: 0.2,
			tokens_total: '90',
			reasoning_tokens: '6',
			cached_tokens: '15',
			cache_hit_rate: 0.25,
			avg_latency: 150,
		}]);
	} finally {
		database.close();
	}
});

test('D1 Management analytics resolves labels, key hashes, time buckets, and group limits', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'organization',
				personalOwnerUserId: null,
				organizationId: 'org-1',
			},
			metrics: ['request_count', 'tokens_total'],
			dimensions: ['api_key_id'],
			filters: [{ field: 'api_key_id', operator: 'eq', value: 'b'.repeat(64) }],
			granularity: 'day',
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			orderBy: { field: 'date', direction: 'desc' },
			limit: 10,
			groupLimit: 1,
		});

		assert.deepEqual(result.rows, [{
			date__day: '2026-09-02T00:00:00.000Z',
			api_key_id: 'Batch Worker',
			request_count: '1',
			tokens_total: '60',
		}]);
	} finally {
		database.close();
	}
});

test('D1 personal analytics rejects cross-user rows even inside an owner Workspace', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'personal',
				personalOwnerUserId: 'user-owner',
				organizationId: null,
			},
			metrics: ['request_count', 'tokens_total'],
			dimensions: [],
			filters: [],
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			limit: 10,
		});
		assert.deepEqual(result.rows, [{ request_count: '1', tokens_total: '15' }]);
	} finally {
		database.close();
	}
});

test('D1 Management analytics keeps identically named API keys as separate groups', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		database.exec(`
			INSERT INTO api_keys VALUES
				('key-member-two', 'sha256:${'d'.repeat(64)}', 'sk-member…dddd', 'Batch Worker');
			INSERT INTO api_key_request_logs VALUES
				('gen-org-byok-two', 'user-member', 'key-member-two', 'workspace-org', 'deepseek/deepseek-chat', 'DeepSeek', 'https://app.example', 'session-2', 'stop', 'default', 1, 8, 4, 0, 0, 12, 90, 0, 0, 0.12, '2026-09-02T03:00:00.000Z');
		`);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'organization',
				personalOwnerUserId: null,
				organizationId: 'org-1',
			},
			metrics: ['request_count'],
			dimensions: ['api_key_id'],
			filters: [],
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			orderBy: { field: 'api_key_id', direction: 'asc' },
			limit: 10,
		});

		assert.equal(
			result.rows.filter((row) => row.api_key_id === 'Batch Worker').length,
			2,
		);
		assert.deepEqual(
			result.rows.filter((row) => row.api_key_id === 'Batch Worker').map((row) => row.request_count),
			['1', '1'],
		);
	} finally {
		database.close();
	}
});

test('D1 Management analytics returns one aggregate row for the zero-value BYOK fee metric', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'organization',
				personalOwnerUserId: null,
				organizationId: 'org-1',
			},
			metrics: ['byok_fees'],
			dimensions: [],
			filters: [],
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			limit: 10,
		});

		assert.deepEqual(result.rows, [{ byok_fees: 0 }]);
	} finally {
		database.close();
	}
});

test('D1 Management analytics includeUnset matches raw null dimension values', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createSchema(database);
		database.exec(`
			INSERT INTO api_key_request_logs VALUES
				('gen-org-no-session', 'user-member', 'key-member', 'workspace-org', 'deepseek/deepseek-chat', 'DeepSeek', NULL, NULL, 'stop', 'default', 0, 8, 4, 0, 0, 12, 90, 0.05, 0.04, 0.06, '2026-09-02T03:00:00.000Z');
		`);
		const result = await repository(database).queryManagementAnalytics({
			account: {
				accountType: 'organization',
				personalOwnerUserId: null,
				organizationId: 'org-1',
			},
			metrics: ['request_count'],
			dimensions: [],
			filters: [{
				field: 'session_id',
				operator: 'in',
				value: ['session-1'],
				includeUnset: true,
			}],
			startDate: '2026-09-01T00:00:00.000Z',
			endDate: '2026-09-03T00:00:00.000Z',
			limit: 10,
		});

		assert.deepEqual(result.rows, [{ request_count: '3' }]);
	} finally {
		database.close();
	}
});

test('Postgres and MySQL analytics SQL retain parameterized account and filter boundaries', () => {
	const query = {
		account: {
			accountType: 'organization' as const,
			personalOwnerUserId: null,
			organizationId: 'org-1',
		},
		metrics: ['request_count' as const],
		dimensions: ['app' as const],
		filters: [{ field: 'provider' as const, operator: 'in' as const, value: ['DeepSeek', 'OpenAI'] }],
		granularity: 'hour' as const,
		startDate: '2026-09-01T00:00:00.000Z',
		endDate: '2026-09-02T00:00:00.000Z',
		limit: 100,
	};
	const postgres = buildManagementAnalyticsQuery('postgres', query);
	assert.match(postgres.sql, /w\.organization_id = \$3/u);
	assert.match(postgres.sql, /IN \(\$4, \$5\)/u);
	assert.match(postgres.sql, /LIMIT \$6$/u);
	assert.deepEqual(postgres.values, [
		query.startDate, query.endDate, 'org-1', 'DeepSeek', 'OpenAI', 101,
	]);

	const mysql = buildManagementAnalyticsQuery('mysql', query);
	assert.match(mysql.sql, /w\.organization_id = \?/u);
	assert.match(mysql.sql, /IN \(\?, \?\)/u);
	assert.match(mysql.sql, /LIMIT \?$/u);
	assert.deepEqual(mysql.values, [
		query.startDate, query.endDate, 'org-1', 'DeepSeek', 'OpenAI', 101,
	]);
});

test('analytics SQL builder rejects unsafe runtime enum and ordering values', () => {
	const base = {
		account: {
			accountType: 'organization' as const,
			personalOwnerUserId: null,
			organizationId: 'org-1',
		},
		metrics: ['request_count' as const],
		dimensions: [] as const,
		filters: [] as const,
		startDate: '2026-09-01T00:00:00.000Z',
		endDate: '2026-09-02T00:00:00.000Z',
		limit: 100,
	};
	assert.throws(
		() => buildManagementAnalyticsQuery('d1', {
			...base,
			orderBy: { field: 'request_count', direction: 'desc; DROP TABLE users' },
		} as never),
		/orderBy direction is unsupported/u,
	);
	assert.throws(
		() => buildManagementAnalyticsQuery('d1', {
			...base,
			granularity: "day'); DROP TABLE users; --",
		} as never),
		/granularity is unsupported/u,
	);
	assert.throws(
		() => buildManagementAnalyticsQuery('d1', {
			...base,
			orderBy: { field: 'date', direction: 'desc' },
		} as never),
		/orderBy field is not selected/u,
	);
});

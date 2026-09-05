import assert from 'node:assert/strict';
import test from 'node:test';
import type { MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createMySqlRequestLogsRepository } from './mysql/request-logs.impl';
import { createPostgresRequestLogsRepository } from './postgres/request-logs.impl';

const OPTIONS = {
	startDate: '2026-08-01T00:00:00.000Z',
	endDate: '2026-09-01T00:00:00.000Z',
	endExclusive: true,
	userId: 'user-1',
	workspaceId: 'workspace-1',
	apiKeyId: 'key-1',
	modelId: 'deepseek/deepseek-chat',
	providerName: 'DeepSeek',
	status: 'success',
	limit: 10,
} as const;

const SQL_ROW = {
	group_id: 'deepseek/deepseek-chat',
	group_name: 'DeepSeek Chat',
	request_count: '2',
	success_count: '2',
	error_count: '0',
	total_tokens: '42',
	charged_cost: '0.25',
};

const TIMESERIES_SQL_ROW = {
	bucket: '2026-08-30',
	request_count: '2',
	input_tokens: '25',
	output_tokens: '17',
	cache_read_tokens: '3',
	cache_write_tokens: '1',
	total_tokens: '42',
	charged_cost: '0.25',
	avg_latency_ms: '123.5',
};

function compactSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

test('PostgreSQL Activity model grouping is tenant-scoped, filtered, and bounded', async () => {
	let capturedSql = '';
	let capturedValues: unknown[] = [];
	const raw = {
		async unsafe(sql: string, values: unknown[]) {
			capturedSql = compactSql(sql);
			capturedValues = values;
			return [SQL_ROW];
		},
	} as PostgresDatabaseClient['raw'];
	const repository = createPostgresRequestLogsRepository({
		driver: 'postgres', raw, drizzle: {} as PostgresDatabaseClient['drizzle'],
	} satisfies PostgresDatabaseClient);

	const rows = await repository.getRequestActivityGroups({ ...OPTIONS, dimension: 'model' });

	assert.match(capturedSql, /user_id = \$3 AND workspace_id = \$4/u);
	assert.match(capturedSql, /api_key_id = \$5 AND model_id = \$6 AND provider_name = \$7 AND status = \$8/u);
	assert.match(capturedSql, /GROUP BY model_id/u);
	assert.match(capturedSql, /LIMIT \$9$/u);
	assert.deepEqual(capturedValues, [
		OPTIONS.startDate, OPTIONS.endDate, OPTIONS.userId, OPTIONS.workspaceId,
		OPTIONS.apiKeyId, OPTIONS.modelId, OPTIONS.providerName, OPTIONS.status, OPTIONS.limit,
	]);
	assert.deepEqual(rows[0], {
		id: 'deepseek/deepseek-chat',
		name: 'DeepSeek Chat',
		requestCount: 2,
		successCount: 2,
		errorCount: 0,
		totalTokens: 42,
		chargedCost: 0.25,
	});
});

test('MySQL Activity Gateway Key grouping is tenant-scoped, filtered, and bounded', async () => {
	let capturedSql = '';
	let capturedValues: unknown[] = [];
	const raw = {
		async query(sql: string, values: unknown[]) {
			capturedSql = compactSql(sql);
			capturedValues = values;
			return [[{ ...SQL_ROW, group_id: 'key-1', group_name: null }], []];
		},
	};
	const repository = createMySqlRequestLogsRepository({
		driver: 'mysql', raw, drizzle: {},
	} as MySqlDatabaseClient);

	const rows = await repository.getRequestActivityGroups({ ...OPTIONS, dimension: 'apiKey', limit: 999 });

	assert.match(capturedSql, /user_id = \? AND workspace_id = \?/u);
	assert.match(capturedSql, /api_key_id = \? AND model_id = \? AND provider_name = \? AND status = \?/u);
	assert.match(capturedSql, /GROUP BY api_key_id/u);
	assert.match(capturedSql, /LIMIT \?$/u);
	assert.deepEqual(capturedValues, [
		OPTIONS.startDate, OPTIONS.endDate, OPTIONS.userId, OPTIONS.workspaceId,
		OPTIONS.apiKeyId, OPTIONS.modelId, OPTIONS.providerName, OPTIONS.status, 25,
	]);
	assert.equal(rows[0]?.id, 'key-1');
	assert.equal(rows[0]?.name, null);
});

test('PostgreSQL Activity Provider grouping uses only the public provider snapshot', async () => {
	let capturedSql = '';
	const raw = {
		async unsafe(sql: string) {
			capturedSql = compactSql(sql);
			return [{ ...SQL_ROW, group_id: 'DeepSeek', group_name: null }];
		},
	} as PostgresDatabaseClient['raw'];
	const repository = createPostgresRequestLogsRepository({
		driver: 'postgres', raw, drizzle: {} as PostgresDatabaseClient['drizzle'],
	} satisfies PostgresDatabaseClient);

	const rows = await repository.getRequestActivityGroups({
		startDate: OPTIONS.startDate,
		endDate: OPTIONS.endDate,
		userId: OPTIONS.userId,
		workspaceId: OPTIONS.workspaceId,
		dimension: 'provider',
		limit: OPTIONS.limit,
	});

	assert.match(capturedSql, /GROUP BY provider_name/u);
	assert.doesNotMatch(capturedSql, /provider_id/u);
	assert.equal(rows[0]?.id, 'DeepSeek');
	assert.equal(rows[0]?.name, null);
});

test('PostgreSQL Activity timeline applies the complete tenant filter set', async () => {
	let capturedSql = '';
	let capturedValues: unknown[] = [];
	const raw = {
		async unsafe(sql: string, values: unknown[]) {
			capturedSql = compactSql(sql);
			capturedValues = values;
			return [TIMESERIES_SQL_ROW];
		},
	} as PostgresDatabaseClient['raw'];
	const repository = createPostgresRequestLogsRepository({
		driver: 'postgres', raw, drizzle: {} as PostgresDatabaseClient['drizzle'],
	} satisfies PostgresDatabaseClient);

	const rows = await repository.queryRequestTimeseries({
		...OPTIONS,
		granularity: 'day',
	});

	assert.match(capturedSql, /created_at >= \$1 AND created_at < \$2/u);
	assert.match(capturedSql, /user_id = \$3 AND workspace_id = \$4/u);
	assert.match(capturedSql, /api_key_id = \$5 AND model_id = \$6 AND provider_name = \$7 AND status = \$8/u);
	assert.match(capturedSql, /GROUP BY 1 ORDER BY 1 ASC$/u);
	assert.deepEqual(capturedValues, [
		OPTIONS.startDate, OPTIONS.endDate, OPTIONS.userId, OPTIONS.workspaceId,
		OPTIONS.apiKeyId, OPTIONS.modelId, OPTIONS.providerName, OPTIONS.status,
	]);
	assert.deepEqual(rows, [{
		bucket: '2026-08-30', requestCount: 2, inputTokens: 25, outputTokens: 17,
		cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 42,
		chargedCost: 0.25, avgLatencyMs: 123.5,
	}]);
});

test('MySQL Activity timeline applies the complete tenant filter set', async () => {
	let capturedSql = '';
	let capturedValues: unknown[] = [];
	const raw = {
		async query(sql: string, values: unknown[]) {
			capturedSql = compactSql(sql);
			capturedValues = values;
			return [[TIMESERIES_SQL_ROW], []];
		},
	};
	const repository = createMySqlRequestLogsRepository({
		driver: 'mysql', raw, drizzle: {},
	} as MySqlDatabaseClient);

	await repository.queryRequestTimeseries({ ...OPTIONS, granularity: 'hour' });

	assert.match(capturedSql, /created_at >= \? AND created_at < \?/u);
	assert.match(capturedSql, /user_id = \? AND workspace_id = \?/u);
	assert.match(capturedSql, /api_key_id = \? AND model_id = \? AND provider_name = \? AND status = \?/u);
	assert.match(capturedSql, /GROUP BY bucket ORDER BY bucket ASC$/u);
	assert.deepEqual(capturedValues, [
		OPTIONS.startDate, OPTIONS.endDate, OPTIONS.userId, OPTIONS.workspaceId,
		OPTIONS.apiKeyId, OPTIONS.modelId, OPTIONS.providerName, OPTIONS.status,
	]);
});

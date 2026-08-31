import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { GenerationRequestLogRow } from './request-logs-types';
import type {
	D1DatabaseClient,
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from '../storage/database-client';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';
import { createMySqlRequestLogsRepository } from './mysql/request-logs.impl';
import { createPostgresRequestLogsRepository } from './postgres/request-logs.impl';

const ROW: GenerationRequestLogRow = {
	id: 'gen-owned',
	model_id: 'vendor/model',
	provider_name: 'Provider',
	request_operation: 'chat',
	input_tokens: 10,
	output_tokens: 20,
	status: 'success',
	latency_ms: 100,
	upstream_message_id: 'chatcmpl-upstream-1',
	created_at: '2026-08-30T00:00:00.000Z',
};

const OWNER = { id: ROW.id, userId: 'user-1', workspaceId: 'workspace-1' };

function compactSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function assertScopedSql(sql: string, driver: 'd1' | 'postgres' | 'mysql'): void {
	const normalized = compactSql(sql);
	assert.doesNotMatch(normalized, /SELECT rl\.\*/u);
	for (const sensitiveColumn of ['request_body', 'upstream_request_body', 'route_trace', 'error_message', 'raw_usage', 'pricing_audit', 'provider_key_fingerprint']) {
		assert.doesNotMatch(normalized, new RegExp(`rl\\.${sensitiveColumn}`, 'u'));
	}
	const markers = driver === 'postgres' ? ['\\$1', '\\$2', '\\$3'] : ['\\?', '\\?', '\\?'];
	assert.match(
		normalized,
		new RegExp(`WHERE rl\\.id = ${markers[0]} AND rl\\.user_id = ${markers[1]} AND rl\\.workspace_id = ${markers[2]}`),
	);
	assert.doesNotMatch(normalized, /FROM api_keys workspace_key/);
	assert.match(normalized, /LIMIT 1$/);
}

describe('tenant-scoped generation request-log repository contract', () => {
	it('D1 queries by id, user, and Workspace in one native statement', async () => {
		let capturedSql = '';
		let capturedValues: unknown[] = [];
		let result: GenerationRequestLogRow | null = ROW;
		const raw = {
			prepare(sql: string) {
				capturedSql = sql;
				const statement = {
					bind(...values: unknown[]) {
						capturedValues = values;
						return statement;
					},
					async first() {
						return result;
					},
				};
				return statement;
			},
		} as D1Database;
		const client = {
			driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'],
		} satisfies D1DatabaseClient;
		const row = await createD1RequestLogsRepository(client).getRequestLogByIdForOwner(OWNER);

		assert.equal(row, ROW);
		assertScopedSql(capturedSql, 'd1');
		assert.deepEqual(capturedValues, [ROW.id, OWNER.userId, OWNER.workspaceId]);
		result = null;
		assert.equal(await createD1RequestLogsRepository(client).getRequestLogByIdForOwner(OWNER), null);
	});

	it('PostgreSQL queries by id, user, and Workspace in one native statement', async () => {
		let capturedSql = '';
		let capturedValues: unknown[] = [];
		let result: GenerationRequestLogRow | null = ROW;
		const raw = {
			async unsafe(sql: string, values: unknown[]) {
				capturedSql = sql;
				capturedValues = values;
				return result ? [result] : [];
			},
		} as PostgresDatabaseClient['raw'];
		const client = {
			driver: 'postgres', raw, drizzle: {} as PostgresDatabaseClient['drizzle'],
		} satisfies PostgresDatabaseClient;
		const row = await createPostgresRequestLogsRepository(client).getRequestLogByIdForOwner(OWNER);

		assert.equal(row, ROW);
		assertScopedSql(capturedSql, 'postgres');
		assert.deepEqual(capturedValues, [ROW.id, OWNER.userId, OWNER.workspaceId]);
		result = null;
		assert.equal(await createPostgresRequestLogsRepository(client).getRequestLogByIdForOwner(OWNER), null);
	});

	it('MySQL queries by id, user, and Workspace in one native statement', async () => {
		let capturedSql = '';
		let capturedValues: unknown[] = [];
		let result: GenerationRequestLogRow | null = ROW;
		const raw = {
			async query(sql: string, values: unknown[]) {
				capturedSql = sql;
				capturedValues = values;
				return [result ? [result] : [], []];
			},
		};
		const client = {
			driver: 'mysql', raw, drizzle: {},
		} as MySqlDatabaseClient;
		const row = await createMySqlRequestLogsRepository(client).getRequestLogByIdForOwner(OWNER);

		assert.equal(row, ROW);
		assertScopedSql(capturedSql, 'mysql');
		assert.deepEqual(capturedValues, [ROW.id, OWNER.userId, OWNER.workspaceId]);
		result = null;
		assert.equal(await createMySqlRequestLogsRepository(client).getRequestLogByIdForOwner(OWNER), null);
	});
});

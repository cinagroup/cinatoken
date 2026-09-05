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
	cache_read_tokens: 3,
	reasoning_tokens: 4,
	native_tokens_prompt: 10,
	native_tokens_completion: 20,
	native_tokens_cached: 3,
	native_tokens_reasoning: 4,
	native_tokens_completion_images: null,
	input_image_count: 0,
	output_image_count: 0,
	status: 'success',
	latency_ms: 100,
	final_upstream_headers_ms: 60,
	stream_duration_ms: 30,
	upstream_message_id: 'chatcmpl-upstream-1',
	session_id: 'session-1',
	workspace_id: 'workspace-1',
	request_origin: 'https://cinatoken.com',
	http_referer: 'https://app.example',
	user_agent: 'CinaSDK/1.0',
	response_streamed: 1,
	data_region: 'global',
	is_byok: 0,
	charged_cost_usd: '0.0015',
	upstream_inference_cost_usd: '0.0012',
	service_tier: 'priority',
	finish_reason: 'stop',
	native_finish_reason: 'end_turn',
	provider_responses: '[{"status":200,"endpoint_id":"route-1"}]',
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
	for (const expectedColumn of [
		'http_referer', 'user_agent', 'service_tier', 'finish_reason', 'native_finish_reason',
		'final_upstream_headers_ms', 'stream_duration_ms',
		'native_tokens_prompt', 'native_tokens_completion', 'native_tokens_cached',
		'native_tokens_reasoning', 'native_tokens_completion_images', 'provider_responses',
	]) {
		assert.match(normalized, new RegExp(`rl\\.${expectedColumn}`, 'u'));
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

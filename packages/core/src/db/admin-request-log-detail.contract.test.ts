import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { RequestLogRow } from '../types';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';
import { createMySqlRequestLogsRepository } from './mysql/request-logs.impl';
import { createPostgresRequestLogsRepository } from './postgres/request-logs.impl';

const stamp = '2026-09-30T02:00:00.123Z';
const row: RequestLogRow = {
	id: 'request-exact', user_id: 'buyer-1', workspace_id: 'personal:buyer-1', api_key_id: 'gateway-1',
	user_email: 'buyer@example.test', model_id: 'model-1', provider_id: 'provider-1', provider_model_name: 'upstream-model',
	model_name: 'Public model', provider_name: 'Public provider', request_body: 'body-private-sentinel',
	upstream_request_body: 'upstream-body-private-sentinel', request_protocol: 'openai', request_operation: 'chat',
	upstream_protocol: 'openai', upstream_operation: 'chat', model_surface_id: 'surface-1', route_pool_id: 'pool-1',
	route_target_id: 'target-1', adapter: 'native', route_trace: 'trace-private-sentinel',
	input_tokens: 10, output_tokens: 20, cache_read_tokens: 3, cache_write_tokens: 4, reasoning_tokens: 5, total_tokens: 30,
	metered_cost: 0.01, standard_cost: 0.02, charged_cost: 0.03, route_group: 'shared', status: 'success', latency_ms: 100,
	gateway_overhead_ms: 2, upstream_response_ms: 98, final_upstream_headers_ms: 50, first_reasoning_token_ms: 60,
	first_token_ms: 70, stream_duration_ms: 30, upstream_attempt_count: 2, upstream_failover_count: 1,
	timing_metadata: 'timing-private-sentinel', error_message: 'error-private-sentinel', raw_usage: 'usage-private-sentinel',
	pricing_audit: 'pricing-private-sentinel', provider_key_id: 'shared:key-1', provider_key_label: 'label-private-sentinel',
	provider_key_fingerprint: 'fingerprint-private-sentinel', upstream_request_id: 'upstream-request-1',
	upstream_message_id: 'upstream-message-1', billing_kind: 'text_tokens', input_image_count: 0, output_image_count: 0,
	audio_duration_seconds: null, audio_characters: null, created_at: stamp,
};
const omitted = ['request_body', 'upstream_request_body', 'route_trace', 'timing_metadata', 'error_message',
	'raw_usage', 'pricing_audit', 'provider_key_label', 'provider_key_fingerprint'] as const;

/** D1 executes its production SQL in SQLite; native driver statements are captured
 * with only PostgreSQL timestamp syntax adapted. This is offline SQL/binding evidence,
 * not native engine, role, or deployment acceptance. query_only forbids hidden writes. */
function fixture(driver: 'd1' | 'mysql' | 'postgres') {
	const database = new DatabaseSync(':memory:');
	const columns = Object.keys(row);
	database.exec(`CREATE TABLE api_key_request_logs (${columns.map(column => `${column} ${typeof row[column as keyof RequestLogRow] === 'number' ? 'REAL' : 'TEXT'}`).join(', ')}, request_headers TEXT, upstream_headers TEXT)`);
	function insert(id: string, values: Partial<RequestLogRow> = {}) {
		const next = { ...row, ...values, id };
		if (driver === 'mysql') next.created_at = next.created_at.replace('T', ' ').replace('Z', '');
		database.prepare(`INSERT INTO api_key_request_logs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
			.run(...columns.map(column => next[column as keyof RequestLogRow] ?? null) as SQLInputValue[]);
	}
	insert(row.id); insert(`${row.id}-prefix`, { user_id: 'buyer-2', api_key_id: row.id, provider_key_id: 'shared:other' });
	const attack = "request' OR 1=1 --";
	insert(attack, { user_id: 'buyer-3' });
	const longId = 'legacy-request-'.padEnd(600, 'x'); insert(longId);
	database.exec('PRAGMA query_only = ON');
	const queries: Array<{ sql: string; values: unknown[] }> = [];
	function execute(sql: string, values: unknown[]) {
		queries.push({ sql, values: [...values] });
		const adapted = sql.replace(/to_char\(rl\.created_at AT TIME ZONE 'UTC', '[^']+'\)/u, 'rl.created_at').replace('$1', '?');
		return database.prepare(adapted).all(...values as SQLInputValue[]);
	}
	const d1 = { prepare(sql: string) { return { bind(...values: unknown[]) { return {
		async first() { return execute(sql, values)[0] ?? null; },
	}; } }; } };
	const mysql = { async query(sql: string, values: unknown[]) { return [execute(sql, values), []]; } };
	const postgres = { async unsafe(sql: string, values: unknown[]) { return execute(sql, values); } };
	const repo = driver === 'd1' ? createD1RequestLogsRepository({ raw: d1 } as unknown as D1DatabaseClient)
		: driver === 'mysql' ? createMySqlRequestLogsRepository({ raw: mysql } as unknown as MySqlDatabaseClient)
			: createPostgresRequestLogsRepository({ raw: postgres } as unknown as PostgresDatabaseClient);
	return { database, repo, queries, attack, longId };
}

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	test(`${driver} Admin detail reads exact request ID, preserves snapshots, and returns null for missing IDs`, async () => {
		const f = fixture(driver);
		try {
			const actual = await f.repo.getAdminRequestLogById(row.id);
			assert.equal(actual?.id, row.id); assert.equal(actual?.user_id, row.user_id);
			assert.equal(actual?.workspace_id, row.workspace_id); assert.equal(actual?.api_key_id, row.api_key_id);
			assert.equal(actual?.provider_key_id, 'shared:key-1'); assert.equal(actual?.charged_cost, row.charged_cost);
			assert.equal(actual?.created_at, stamp);
			assert.equal(await f.repo.getAdminRequestLogById('request'), null);
			assert.equal(await f.repo.getAdminRequestLogById(row.api_key_id!), null);
			assert.equal(await f.repo.getAdminRequestLogById('not-found'), null);
			assert.equal(f.queries.length, 4);
		} finally { f.database.close(); }
	});
	test(`${driver} Admin detail binds opaque IDs without SQL interpolation, prefix matching, or owner predicates`, async () => {
		const f = fixture(driver);
		try {
			assert.equal((await f.repo.getAdminRequestLogById(f.attack))?.user_id, 'buyer-3');
			assert.equal((await f.repo.getAdminRequestLogById(f.longId))?.id, f.longId);
			for (const [index, query] of f.queries.entries()) {
				assert.deepEqual(query.values, [index === 0 ? f.attack : f.longId]);
				assert.ok(!query.sql.includes(f.attack)); assert.ok(!query.sql.includes(f.longId));
				assert.match(query.sql, driver === 'postgres' ? /WHERE rl\.id = \$1 LIMIT 1$/u : /WHERE rl\.id = \? LIMIT 1$/u);
				assert.doesNotMatch(query.sql, /\bJOIN\b|\bLIKE\b|WHERE rl\.(?:api_key_id|user_id|workspace_id)|SELECT (?:rl\.)?\*/iu);
			}
		} finally { f.database.close(); }
	});
	test(`${driver} Admin detail never loads raw bodies, headers, evidence, errors, or credential material`, async () => {
		const f = fixture(driver);
		try {
			const actual = await f.repo.getAdminRequestLogById(row.id);
			for (const column of omitted) {
				assert.equal(actual?.[column], null, column);
				assert.ok(!f.queries[0].sql.includes(`rl.${column}`), column);
			}
			assert.doesNotMatch(f.queries[0].sql, /rl\.(?:request_headers|upstream_headers|http_referer|user_agent)/u);
			assert.ok(!JSON.stringify(actual).includes('private-sentinel'));
			assert.equal(f.queries.length, 1);
			assert.equal(f.database.prepare('SELECT COUNT(*) AS total FROM api_key_request_logs').get()?.total, 4);
		} finally { f.database.close(); }
	});
	test(`${driver} Admin detail propagates storage failures without fallback scans or writes`, async () => {
		const f = fixture(driver); f.database.close();
		await assert.rejects(f.repo.getAdminRequestLogById(row.id));
		assert.equal(f.queries.length, 1);
	});
}

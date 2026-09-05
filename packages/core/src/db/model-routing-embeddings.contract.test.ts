import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { D1Result } from '@cloudflare/workers-types';
import type { ModelRow } from '../types';
import type {
	D1DatabaseClient,
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from '../storage/database-client';
import {
	MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS,
} from './model-modalities';
import { createD1ModelRoutingRepository } from './d1/model-routing.impl';
import { createMySqlModelRoutingRepository } from './mysql/model-routing.impl';
import { createPostgresModelRoutingRepository } from './postgres/model-routing.impl';

class SqliteD1Statement {
	private values: SQLInputValue[] = [];

	constructor(
		private readonly statement: StatementSync,
		private readonly capture: (values: SQLInputValue[]) => void,
	) {}

	bind(...values: unknown[]) {
		this.values = values as SQLInputValue[];
		this.capture(this.values);
		return this;
	}

	async all<T>(): Promise<D1Result<T>> {
		return { results: this.statement.all(...this.values) as T[], success: true } as D1Result<T>;
	}

	async first<T>(): Promise<T | null> {
		return (this.statement.get(...this.values) as T | undefined) ?? null;
	}
}

function d1Repository(database: DatabaseSync) {
	let sql = '';
	let values: SQLInputValue[] = [];
	const raw = {
		prepare(statement: string) {
			sql = statement;
			return new SqliteD1Statement(database.prepare(statement), (bound) => { values = bound; });
		},
	};
	const repository = createD1ModelRoutingRepository({
		driver: 'd1',
		raw,
		drizzle: {},
	} as unknown as D1DatabaseClient);
	return { repository, capture: () => ({ sql, values }) };
}

function setupD1(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE models (
			id TEXT PRIMARY KEY, display_name TEXT, vendor TEXT NOT NULL,
			context_window INTEGER, max_tokens INTEGER, pricing_profile TEXT,
			description TEXT, metadata TEXT, input_modalities TEXT,
			output_modalities TEXT, released_at TEXT, route_policy TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE model_tags (model_id TEXT NOT NULL, tag TEXT NOT NULL);
		CREATE TABLE route_pools (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE model_routes (
			id TEXT PRIMARY KEY, model_id TEXT NOT NULL, status TEXT NOT NULL,
			route_pool_id TEXT, upstream_protocol TEXT NOT NULL,
			upstream_operation TEXT NOT NULL
		);
		CREATE TABLE model_surfaces (
			id TEXT PRIMARY KEY, route_pool_id TEXT NOT NULL, status TEXT NOT NULL,
			request_protocol TEXT NOT NULL, request_operation TEXT NOT NULL
		);
	`);
	return database;
}

function insertModel(database: DatabaseSync, id: string, outputModalities = '["embeddings"]') {
	database.prepare(`
		INSERT INTO models (
			id, display_name, vendor, context_window, max_tokens, pricing_profile,
			description, metadata, input_modalities, output_modalities, released_at,
			route_policy, created_at
		) VALUES (?, ?, 'Vendor', 8192, NULL, NULL, NULL, NULL, '["text"]', ?, NULL, NULL, ?)
	`).run(id, id, outputModalities, '2026-09-02T00:00:00.000Z');
}

function insertRoute(
	database: DatabaseSync,
	id: string,
	modelId: string,
	options: {
		status?: string;
		poolId?: string | null;
		protocol?: string;
		operation?: string;
	} = {},
) {
	database.prepare(`
		INSERT INTO model_routes (
			id, model_id, status, route_pool_id, upstream_protocol, upstream_operation
		) VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		id,
		modelId,
		options.status ?? 'active',
		options.poolId ?? null,
		options.protocol ?? 'openai',
		options.operation ?? 'embeddings',
	);
}

const SAMPLE_ROW: ModelRow = {
	id: 'vendor/embedding',
	display_name: 'Embedding',
	vendor: 'Vendor',
	context_window: 8_192,
	max_tokens: null,
	pricing_profile: null,
	tags: '[]',
	description: null,
	metadata: null,
	input_modalities: '["text"]',
	output_modalities: '["embeddings"]',
	released_at: null,
	created_at: '2026-09-02T00:00:00.000Z',
};

function assertQueryContract(sql: string) {
	assert.match(sql, /output_modalities LIKE '%"embeddings"%'/u);
	assert.match(sql, /mr\.status = 'active'/u);
	assert.match(sql, /rp\.status IS NULL OR rp\.status <> 'disabled'/u);
	assert.match(sql, /ms\.request_protocol = 'openai'/u);
	assert.match(sql, /ms\.request_operation IN \('embeddings', '\*'\)/u);
	assert.match(sql, /mr\.upstream_protocol = 'openai'/u);
	assert.match(sql, /mr\.upstream_operation IN \('embeddings', '\*'\)/u);
	assert.match(sql, /ORDER BY m\.id/u);
}

describe('callable embeddings model discovery repository contract', () => {
	it('D1 enforces route/surface state in SQL and keeps malformed modality JSON as a bounded caller-side candidate', async () => {
		const database = setupD1();
		try {
			for (const id of [
				'direct', 'surface', 'chat-only', 'wrong-surface', 'disabled-pool',
				'disabled-route', 'text-model', 'malformed-modality',
			]) insertModel(database, id);
			database.prepare('UPDATE models SET output_modalities = ? WHERE id = ?')
				.run('["text"]', 'text-model');
			database.prepare('UPDATE models SET output_modalities = ? WHERE id = ?')
				.run('{"kind":"embeddings"}', 'malformed-modality');

			insertRoute(database, 'direct-route', 'direct');
			insertRoute(database, 'chat-route', 'chat-only', { operation: 'chat' });
			insertRoute(database, 'disabled-route-row', 'disabled-route', { status: 'disabled' });
			insertRoute(database, 'text-route', 'text-model');
			insertRoute(database, 'malformed-route', 'malformed-modality');

			for (const [poolId, status] of [
				['surface-pool', 'active'],
				['wrong-surface-pool', 'active'],
				['disabled-pool-id', 'disabled'],
			] as const) {
				database.prepare('INSERT INTO route_pools (id, status) VALUES (?, ?)').run(poolId, status);
			}
			insertRoute(database, 'surface-route', 'surface', { poolId: 'surface-pool', operation: 'chat' });
			insertRoute(database, 'wrong-surface-route', 'wrong-surface', { poolId: 'wrong-surface-pool' });
			insertRoute(database, 'disabled-pool-route', 'disabled-pool', { poolId: 'disabled-pool-id' });
			database.prepare(`
				INSERT INTO model_surfaces (id, route_pool_id, status, request_protocol, request_operation)
				VALUES (?, ?, ?, ?, ?)
			`).run('embedding-surface', 'surface-pool', 'active', 'openai', 'embeddings');
			database.prepare(`
				INSERT INTO model_surfaces (id, route_pool_id, status, request_protocol, request_operation)
				VALUES (?, ?, ?, ?, ?)
			`).run('chat-surface', 'wrong-surface-pool', 'active', 'openai', 'chat');

			const { repository, capture } = d1Repository(database);
			const rows = await repository.listCallableEmbeddingModelCandidates();
			assert.deepEqual(rows.map((row) => row.id), ['direct', 'malformed-modality', 'surface']);
			const query = capture();
			assertQueryContract(query.sql);
			assert.match(query.sql, /LIMIT \?/u);
			assert.deepEqual(query.values, [MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS]);
		} finally {
			database.close();
		}
	});

	it('PostgreSQL binds the overflow-sentinel limit and retains the callable-route predicates', async () => {
		let sql = '';
		let values: unknown[] = [];
		const raw = ((strings: TemplateStringsArray, ...bound: unknown[]) => {
			values = bound;
			sql = strings.reduce((text, part, index) =>
				`${text}${index === 0 ? '' : `$${index}`}${part}`, '');
			return Promise.resolve([SAMPLE_ROW]);
		}) as unknown as PostgresDatabaseClient['raw'];
		const repository = createPostgresModelRoutingRepository({
			driver: 'postgres', raw, drizzle: {},
		} as unknown as PostgresDatabaseClient);
		assert.deepEqual(await repository.listCallableEmbeddingModelCandidates(), [SAMPLE_ROW]);
		assertQueryContract(sql);
		assert.match(sql, /LIMIT \$1/u);
		assert.deepEqual(values, [MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS]);
	});

	it('MySQL binds the overflow-sentinel limit and retains the callable-route predicates', async () => {
		let sql = '';
		let values: unknown[] | undefined;
		const raw = {
			query: async (statement: string, bound?: unknown[]) => {
				sql = statement;
				values = bound;
				return [[SAMPLE_ROW], []];
			},
		};
		const repository = createMySqlModelRoutingRepository({
			driver: 'mysql', raw, drizzle: {},
		} as unknown as MySqlDatabaseClient);
		assert.deepEqual(await repository.listCallableEmbeddingModelCandidates(), [SAMPLE_ROW]);
		assertQueryContract(sql);
		assert.match(sql, /LIMIT \?/u);
		assert.deepEqual(values, [MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS]);
	});
});

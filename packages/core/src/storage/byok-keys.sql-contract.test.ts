import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from './database-client';
import { createByokKeysRepository } from './byok-keys';

const principal = {
	keyId: 'management-1',
	createdByUserId: 'user-1',
	accountType: 'personal' as const,
	personalOwnerUserId: 'user-1',
	organizationId: null,
};
const ids = [
	'11111111-1111-4111-8111-111111111111',
	'22222222-2222-4222-8222-222222222222',
];

function row(id: string, sortOrder: number) {
	return {
		id,
		workspace_id: 'personal:user-1',
		provider: 'deepseek',
		name: `Key ${sortOrder + 1}`,
		label: `...key${sortOrder + 1}`,
		disabled: false,
		is_fallback: sortOrder === 1,
		always_use_for_provider: false,
		always_use_for_matching_models: false,
		sort_order: sortOrder,
		allowed_models_json: null,
		allowed_user_ids_json: null,
		allowed_api_key_hashes_json: null,
		created_by_management_key_id: 'management-1',
		created_at: '2026-09-03T00:00:00.000Z',
		updated_at: '2026-09-03T00:00:00.000Z',
	};
}

function params() {
	return {
		principal,
		nowIso: '2026-09-03T01:00:00.000Z',
		input: {
			workspaceId: 'personal:user-1',
			provider: 'deepseek',
			keys: [
				{ id: ids[1]!, isFallback: false },
				{ id: ids[0]!, isFallback: true },
			],
		},
	};
}

function portalParams() {
	return {
		...params(),
		principal: {
			principalType: 'portal_user' as const,
			userId: 'user-1',
			workspaceId: 'personal:user-1',
			accountType: 'personal' as const,
			personalOwnerUserId: 'user-1',
			organizationId: null,
		},
	};
}

test('PostgreSQL BYOK reorder locks and swaps the complete set in one transaction', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	let begins = 0;
	const transaction = {
		unsafe: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (/SELECT workspace\.id/u.test(sql)) return [{ id: 'personal:user-1' }];
			if (/FROM byok_keys byok WHERE/u.test(sql)) return [row(ids[0]!, 0), row(ids[1]!, 1)];
			return [];
		},
	};
	const raw = {
		begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) => {
			begins += 1;
			return callback(transaction);
		},
	};
	const repository = createByokKeysRepository({
		driver: 'postgres', raw, drizzle: {},
	} as unknown as PostgresDatabaseClient);

	assert.equal(await repository.reorderForManagement(params()), 'updated');
	assert.equal(begins, 1);
	assert.match(calls[0]!.sql, /FOR UPDATE OF workspace/u);
	assert.match(calls[1]!.sql, /ORDER BY byok\.id FOR UPDATE OF byok/u);
	assert.equal(calls.filter((call) => /jsonb_to_recordset/u.test(call.sql)).length, 3);
	assert.match(calls.at(-1)!.sql, /byok_key_reordered/u);
	const mapping = JSON.parse(String(calls[2]!.values[0])) as Array<{
		id: string;
		temporary_provider: string;
	}>;
	assert.deepEqual(mapping.map((item) => item.id), [ids[1], ids[0]]);
	assert.equal(new Set(mapping.map((item) => item.temporary_provider)).size, 2);
	assert.ok(mapping.every((item) => /^cinatoken-reorder-[a-f0-9]{32}-\d+$/u.test(item.temporary_provider)));
});

test('PostgreSQL BYOK reorder rejects a stale set before any mutation', async () => {
	const calls: string[] = [];
	const transaction = {
		unsafe: async (sql: string) => {
			calls.push(sql);
			if (/SELECT workspace\.id/u.test(sql)) return [{ id: 'personal:user-1' }];
			if (/FROM byok_keys byok WHERE/u.test(sql)) return [row(ids[0]!, 0)];
			return [];
		},
	};
	const repository = createByokKeysRepository({
		driver: 'postgres',
		raw: { begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction) },
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	assert.equal(await repository.reorderForManagement(params()), 'conflict');
	assert.equal(calls.length, 2);
	assert.equal(calls.some((sql) => /^\s*UPDATE/u.test(sql)), false);
});

test('PostgreSQL BYOK portal reorder authorizes the active user and exact workspace without a Management key', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const transaction = {
		unsafe: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (/SELECT workspace\.id/u.test(sql)) return [{ id: 'personal:user-1' }];
			if (/FROM byok_keys byok WHERE/u.test(sql)) return [row(ids[0]!, 0), row(ids[1]!, 1)];
			return [];
		},
	};
	const repository = createByokKeysRepository({
		driver: 'postgres',
		raw: { begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction) },
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	assert.equal(await repository.reorderForManagement(portalParams()), 'updated');
	assert.match(calls[0]!.sql, /JOIN users portal_user/u);
	assert.doesNotMatch(calls[0]!.sql, /management_api_keys/u);
	assert.deepEqual(calls[0]!.values, ['user-1', 'personal:user-1', 'user-1']);
	assert.deepEqual(calls.at(-1)!.values.slice(1, 3), ['user-1', 'user']);
	assert.equal(calls.at(-1)!.values[4], 'gateway_portal_byok');
});

test('MySQL BYOK reorder locks and swaps the complete set in one transaction', async () => {
	const calls: Array<{ kind: 'query' | 'execute'; sql: string; values: unknown[] }> = [];
	let begins = 0;
	let commits = 0;
	let rollbacks = 0;
	const connection = {
		beginTransaction: async () => { begins += 1; },
		commit: async () => { commits += 1; },
		rollback: async () => { rollbacks += 1; },
		release: () => undefined,
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: 'query', sql, values });
			if (/SELECT workspace\.id/u.test(sql)) return [[{ id: 'personal:user-1' }], {}];
			return [[row(ids[0]!, 0), row(ids[1]!, 1)], {}];
		},
		execute: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: 'execute', sql, values });
			return [{ affectedRows: 1 }, {}];
		},
	};
	const repository = createByokKeysRepository({
		driver: 'mysql',
		raw: { getConnection: async () => connection },
		drizzle: {},
	} as unknown as MySqlDatabaseClient);

	assert.equal(await repository.reorderForManagement(params()), 'updated');
	assert.deepEqual({ begins, commits, rollbacks }, { begins: 1, commits: 1, rollbacks: 0 });
	assert.match(calls[0]!.sql, /FOR UPDATE/u);
	assert.match(calls[1]!.sql, /ORDER BY byok\.id FOR UPDATE/u);
	assert.equal(calls.filter((call) => /JSON_TABLE/u.test(call.sql)).length, 3);
	assert.match(calls.at(-1)!.sql, /byok_key_reordered/u);
});

test('MySQL BYOK portal reorder authorizes the active user and exact workspace without a Management key', async () => {
	const calls: Array<{ kind: 'query' | 'execute'; sql: string; values: unknown[] }> = [];
	const connection = {
		beginTransaction: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		release: () => undefined,
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: 'query' as const, sql, values });
			if (/SELECT workspace\.id/u.test(sql)) return [[{ id: 'personal:user-1' }], {}];
			return [[row(ids[0]!, 0), row(ids[1]!, 1)], {}];
		},
		execute: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: 'execute' as const, sql, values });
			return [{ affectedRows: 1 }, {}];
		},
	};
	const repository = createByokKeysRepository({
		driver: 'mysql', raw: { getConnection: async () => connection }, drizzle: {},
	} as unknown as MySqlDatabaseClient);

	assert.equal(await repository.reorderForManagement(portalParams()), 'updated');
	assert.match(calls[0]!.sql, /JOIN users portal_user/u);
	assert.doesNotMatch(calls[0]!.sql, /management_api_keys/u);
	assert.deepEqual(calls[0]!.values, ['user-1', 'personal:user-1', 'user-1']);
	assert.deepEqual(calls.at(-1)!.values.slice(1, 3), ['user-1', 'user']);
	assert.equal(calls.at(-1)!.values[4], 'gateway_portal_byok');
});

test('PostgreSQL BYOK provider-wide policy ignores model filters but keeps identity filters', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const repository = createByokKeysRepository({
		driver: 'postgres',
		raw: {
			unsafe: async (sql: string, values: unknown[] = []) => {
				calls.push({ sql, values });
				return [{
					...row(ids[0]!, 0),
					always_use_for_provider: true,
					allowed_models_json: JSON.stringify(['deepseek/not-requested']),
					allowed_user_ids_json: JSON.stringify(['user-1']),
					allowed_api_key_hashes_json: JSON.stringify(['a'.repeat(64)]),
				}];
			},
		},
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
		workspaceId: 'personal:user-1',
		provider: 'deepseek',
		modelId: 'deepseek/requested',
		userId: 'user-1',
		apiKeyHash: 'a'.repeat(64),
	}), true);
	assert.match(calls[0]!.sql, /byok\.always_use_for_provider = TRUE/u);
	assert.match(calls[0]!.sql, /byok\.always_use_for_matching_models = TRUE/u);
	assert.match(calls[0]!.sql, /byok\.is_fallback = FALSE/u);
	assert.doesNotMatch(
		calls[0]!.sql.slice(calls[0]!.sql.indexOf('WHERE')),
		/allowed_models_json/u,
	);
	assert.deepEqual(calls[0]!.values, ['personal:user-1', 'deepseek', 100]);
});

test('MySQL BYOK provider-wide policy is a bounded metadata-only query', async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const repository = createByokKeysRepository({
		driver: 'mysql',
		raw: {
			query: async (sql: string, values: unknown[] = []) => {
				calls.push({ sql, values });
				return [[{
					...row(ids[0]!, 0),
					always_use_for_provider: true,
					allowed_models_json: JSON.stringify(['deepseek/not-requested']),
				}], {}];
			},
		},
		drizzle: {},
	} as unknown as MySqlDatabaseClient);

	assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
		workspaceId: 'personal:user-1',
		provider: 'deepseek',
		modelId: 'deepseek/requested',
		userId: 'user-1',
		apiKeyHash: 'a'.repeat(64),
	}), true);
	assert.match(calls[0]!.sql, /byok\.always_use_for_provider = TRUE/u);
	assert.match(calls[0]!.sql, /byok\.always_use_for_matching_models = TRUE/u);
	assert.match(calls[0]!.sql, /byok\.is_fallback = FALSE/u);
	assert.doesNotMatch(calls[0]!.sql, /api_key_encrypted/u);
	assert.deepEqual(calls[0]!.values, ['personal:user-1', 'deepseek', 100]);
});

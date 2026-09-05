import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from '@cloudflare/workers-types';
import { createEncryptedByokKeysRepository } from '../lib/byok-key-encryption';
import { createD1DatabaseClient } from './database-client';
import { createByokKeysRepository } from './byok-keys';

const ENCRYPTION_SECRET = 'byok-test-encryption-secret-that-is-long-enough';
const WORKSPACE_ID = 'personal:user-1';
const API_KEY_HASH = 'a'.repeat(64);
const principal = {
	keyId: 'management-1',
	createdByUserId: 'user-1',
	accountType: 'personal' as const,
	personalOwnerUserId: 'user-1',
	organizationId: null,
};

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
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

function fixture() {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE organizations (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, organization_id TEXT,
			personal_owner_user_id TEXT, status TEXT NOT NULL
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT,
			account_type TEXT NOT NULL, personal_owner_user_id TEXT,
			organization_id TEXT, created_by_user_id TEXT
		);
		CREATE TABLE api_keys (id TEXT PRIMARY KEY);
		CREATE TABLE user_audit_logs (
			id TEXT PRIMARY KEY, user_id TEXT, api_key_id TEXT, event_type TEXT NOT NULL,
			actor_type TEXT NOT NULL, change_payload TEXT, source TEXT, actor_id TEXT,
			reason_code TEXT, reason_text TEXT, created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES ('user-1', 'active'), ('user-2', 'active');
		INSERT INTO workspaces VALUES
			('${WORKSPACE_ID}', 'personal', NULL, 'user-1', 'active'),
			('personal:user-2', 'personal', NULL, 'user-2', 'active');
		INSERT INTO management_api_keys VALUES
			('management-1', 'active', NULL, 'personal', 'user-1', NULL, 'user-1'),
			('management-2', 'active', NULL, 'personal', 'user-2', NULL, 'user-2');
	`);
	const migration = readFileSync(
		new URL('../../migrations-d1/0064_private_byok.sql', import.meta.url),
		'utf8',
	);
	database.exec(migration);
	database.exec(readFileSync(
		new URL('../../migrations-d1/0065_byok_always_use_for_provider.sql', import.meta.url),
		'utf8',
	));
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]) {
			database.exec('BEGIN IMMEDIATE');
			try {
				const results: D1Result[] = [];
				for (const statement of statements) results.push(await statement.run());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	const repository = createEncryptedByokKeysRepository(
		createByokKeysRepository(createD1DatabaseClient(raw)),
		ENCRYPTION_SECRET,
	);
	return { database, repository };
}

test('D1 BYOK repository encrypts, filters, rotates, audits, and wipes credentials', async () => {
	const { database, repository } = fixture();
	try {
		const primaryId = '11111111-1111-4111-8111-111111111111';
		const primary = await repository.insertForManagement({
			principal,
			id: primaryId,
			nowIso: '2026-09-03T00:00:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				name: 'Primary',
				apiKey: 'deepseek-primary-secret',
				label: '...cret',
				disabled: false,
				isFallback: false,
				alwaysUseForProvider: true,
				alwaysUseForMatchingModels: false,
				allowedModels: ['deepseek/deepseek-chat'],
				allowedUserIds: ['user-1'],
				allowedApiKeyHashes: [API_KEY_HASH],
			},
		});
		assert.equal(primary?.sort_order, 0);
		assert.equal(primary?.always_use_for_provider, true);
		const stored = database.prepare(
			'SELECT api_key_encrypted FROM byok_keys WHERE id = ?',
		).get(primaryId) as { api_key_encrypted: string };
		assert.match(stored.api_key_encrypted, /^enc:v2:/u);
		assert.equal(stored.api_key_encrypted.includes('deepseek-primary-secret'), false);

		await repository.insertForManagement({
			principal,
			id: '22222222-2222-4222-8222-222222222222',
			nowIso: '2026-09-03T00:01:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				name: 'Fallback',
				apiKey: 'deepseek-fallback-secret',
				label: '...cret',
				disabled: false,
				isFallback: true,
				alwaysUseForProvider: false,
				alwaysUseForMatchingModels: false,
				allowedModels: null,
				allowedUserIds: null,
				allowedApiKeyHashes: null,
			},
		});
		assert.throws(
			() => database.prepare(
				'UPDATE byok_keys SET always_use_for_provider = 1 WHERE id = ?',
			).run('22222222-2222-4222-8222-222222222222'),
			/CHECK constraint failed/u,
		);

		const runtime = await repository.listActiveForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/deepseek-chat',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		});
		assert.deepEqual(runtime.map((row) => [row.name, row.api_key]), [
			['Primary', 'deepseek-primary-secret'],
			['Fallback', 'deepseek-fallback-secret'],
		]);
		assert.equal(runtime[0]?.always_use_for_provider, true);
		const mismatched = await repository.listActiveForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/deepseek-reasoner',
			userId: 'user-2',
			apiKeyHash: 'b'.repeat(64),
		});
		assert.deepEqual(mismatched.map((row) => row.name), ['Fallback']);
		assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/model-outside-primary-filter',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		}), true, 'provider-wide policy must ignore the key model filter');
		assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/model-outside-primary-filter',
			userId: 'user-2',
			apiKeyHash: API_KEY_HASH,
		}), false, 'member filters still scope provider-wide policy');
		assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/model-outside-primary-filter',
			userId: 'user-1',
			apiKeyHash: 'b'.repeat(64),
		}), false, 'Gateway key filters still scope provider-wide policy');
		await assert.rejects(repository.updateForManagement({
			principal,
			id: primaryId,
			nowIso: '2026-09-03T00:01:30.000Z',
			patch: { isFallback: true },
		}), /only valid for prioritized BYOK keys/u);

		const rotated = await repository.updateForManagement({
			principal,
			id: primaryId,
			nowIso: '2026-09-03T00:02:00.000Z',
			patch: { apiKey: 'rotated-provider-secret', label: '...cret', disabled: true },
		});
		assert.equal(rotated?.disabled, true);
		assert.deepEqual((await repository.listForAccount(principal, {
			offset: 0, limit: 50, provider: 'deepseek',
		})).data.map((row) => row.name), ['Fallback', 'Primary']);
		const rotatedStored = database.prepare(
			'SELECT api_key_encrypted FROM byok_keys WHERE id = ?',
		).get(primaryId) as { api_key_encrypted: string };
		assert.equal(rotatedStored.api_key_encrypted.includes('rotated-provider-secret'), false);

		assert.equal(await repository.deleteForManagement({
			principal: { ...principal, keyId: 'management-2', personalOwnerUserId: 'user-2' },
			id: primaryId,
			nowIso: '2026-09-03T00:03:00.000Z',
		}), false);
		assert.equal(await repository.deleteForManagement({
			principal,
			id: primaryId,
			nowIso: '2026-09-03T00:04:00.000Z',
		}), true);
		assert.deepEqual({ ...database.prepare(
			'SELECT api_key_encrypted, label, disabled, deleted_at FROM byok_keys WHERE id = ?',
		).get(primaryId) }, {
			api_key_encrypted: '',
			label: 'deleted',
			disabled: 1,
			deleted_at: '2026-09-03T00:04:00.000Z',
		});
		assert.equal(await repository.getByIdInAccount(primaryId, principal), null);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE source = 'gateway_management_byok'",
		).get()?.total, 4);
	} finally {
		database.close();
	}
});

test('D1 BYOK shared-capacity policy supports matching-model scope and enforces exclusivity', async () => {
	const { database, repository } = fixture();
	try {
		const matchingId = '77777777-7777-4777-8777-777777777777';
		const matching = await repository.insertForManagement({
			principal,
			id: matchingId,
			nowIso: '2026-09-03T00:00:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				name: 'Matching models only',
				apiKey: 'deepseek-matching-secret',
				label: '...cret',
				disabled: false,
				isFallback: false,
				alwaysUseForProvider: false,
				alwaysUseForMatchingModels: true,
				allowedModels: ['deepseek/model-a'],
				allowedUserIds: ['user-1'],
				allowedApiKeyHashes: [API_KEY_HASH],
			},
		});
		assert.equal(matching?.always_use_for_matching_models, true);
		assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/model-a',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		}), true);
		assert.equal(await repository.shouldSuppressSharedCapacityForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/model-b',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		}), false, 'matching-model policy must retain the key model filter');
		await assert.rejects(repository.updateForManagement({
			principal,
			id: matchingId,
			nowIso: '2026-09-03T00:01:00.000Z',
			patch: { alwaysUseForProvider: true },
		}), /mutually exclusive/u);
		assert.throws(
			() => database.prepare(
				'UPDATE byok_keys SET always_use_for_provider = 1 WHERE id = ?',
			).run(matchingId),
			/CHECK constraint failed/u,
		);

		const fallbackId = '88888888-8888-4888-8888-888888888888';
		await repository.insertForManagement({
			principal,
			id: fallbackId,
			nowIso: '2026-09-03T00:02:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				name: 'Fallback',
				apiKey: 'deepseek-fallback-secret',
				label: '...cret',
				disabled: false,
				isFallback: true,
				alwaysUseForProvider: false,
				alwaysUseForMatchingModels: false,
				allowedModels: null,
				allowedUserIds: null,
				allowedApiKeyHashes: null,
			},
		});
		assert.throws(
			() => database.prepare(
				'UPDATE byok_keys SET always_use_for_matching_models = 1 WHERE id = ?',
			).run(fallbackId),
			/CHECK constraint failed/u,
		);
	} finally {
		database.close();
	}
});

test('D1 BYOK runtime filters the complete bounded provider set before returning 32 keys', async () => {
	const { database, repository } = fixture();
	try {
		for (let index = 0; index < 33; index += 1) {
			const suffix = String(index).padStart(2, '0');
			await repository.insertForManagement({
				principal,
				id: `runtime-cap-${suffix}`,
				nowIso: `2026-09-03T01:${suffix}:00.000Z`,
				input: {
					workspaceId: WORKSPACE_ID,
					provider: 'deepseek',
					name: `Key ${suffix}`,
					apiKey: `secret-${suffix}`,
					label: `...${suffix}`,
					disabled: false,
					isFallback: false,
					alwaysUseForProvider: false,
					alwaysUseForMatchingModels: false,
					allowedModels: index < 32 ? ['deepseek/not-requested'] : null,
					allowedUserIds: null,
					allowedApiKeyHashes: null,
				},
			});
		}

		const runtime = await repository.listActiveForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/requested',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		});
		assert.deepEqual(runtime.map((row) => row.name), ['Key 32']);
	} finally {
		database.close();
	}
});

test('D1 BYOK repository fails closed when stored filters are corrupt', async () => {
	const { database, repository } = fixture();
	try {
		const id = '33333333-3333-4333-8333-333333333333';
		await repository.insertForManagement({
			principal,
			id,
			nowIso: '2026-09-03T00:00:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				name: null,
				apiKey: 'deepseek-secret',
				label: '...cret',
				disabled: false,
				isFallback: false,
				alwaysUseForProvider: false,
				alwaysUseForMatchingModels: false,
				allowedModels: null,
				allowedUserIds: null,
				allowedApiKeyHashes: null,
			},
		});
		database.exec('PRAGMA ignore_check_constraints = ON');
		database.prepare('UPDATE byok_keys SET allowed_models_json = ? WHERE id = ?')
			.run('{broken', id);
		database.exec('PRAGMA ignore_check_constraints = OFF');
		assert.deepEqual(await repository.listActiveForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/deepseek-chat',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		}), []);
	} finally {
		database.close();
	}
});

test('D1 BYOK portal principal is pinned to one active owned workspace and emits user audit rows', async () => {
	const { database, repository } = fixture();
	const portalPrincipal = {
		principalType: 'portal_user' as const,
		userId: 'user-1',
		workspaceId: WORKSPACE_ID,
		accountType: 'personal' as const,
		personalOwnerUserId: 'user-1',
		organizationId: null,
	};
	try {
		const ids = [
			'44444444-4444-4444-8444-444444444444',
			'55555555-5555-4555-8555-555555555555',
		];
		for (const [index, id] of ids.entries()) {
			const row = await repository.insertForManagement({
				principal: portalPrincipal,
				id,
				nowIso: `2026-09-03T01:0${index}:00.000Z`,
				input: {
					workspaceId: WORKSPACE_ID,
					provider: 'deepseek',
					name: `Portal ${index + 1}`,
					apiKey: `portal-secret-${index + 1}`,
					label: `...ret${index + 1}`,
					disabled: false,
					isFallback: index === 1,
					alwaysUseForProvider: false,
					alwaysUseForMatchingModels: false,
					allowedModels: null,
					allowedUserIds: null,
					allowedApiKeyHashes: null,
				},
			});
			assert.equal(row?.workspace_id, WORKSPACE_ID);
		}
		assert.equal(database.prepare(
			'SELECT created_by_management_key_id FROM byok_keys WHERE id = ?',
		).get(ids[0]!)?.created_by_management_key_id, null);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE source = 'gateway_portal_byok' AND actor_type = 'user' AND actor_id = 'portal:user-1'",
		).get()?.total, 2);

		assert.equal((await repository.updateForManagement({
			principal: portalPrincipal,
			id: ids[0]!,
			nowIso: '2026-09-03T01:02:00.000Z',
			patch: { alwaysUseForProvider: true },
		}))?.always_use_for_provider, true);
		assert.equal(await repository.reorderForManagement({
			principal: portalPrincipal,
			nowIso: '2026-09-03T01:03:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				keys: [
					{ id: ids[0]!, isFallback: false },
					{ id: ids[1]!, isFallback: true },
				],
			},
		}), 'updated');

		await assert.rejects(repository.insertForManagement({
			principal: portalPrincipal,
			id: '66666666-6666-4666-8666-666666666666',
			nowIso: '2026-09-03T01:04:00.000Z',
			input: {
				workspaceId: 'personal:user-2',
				provider: 'deepseek',
				name: null,
				apiKey: 'cross-workspace-secret',
				label: '...cret',
				disabled: false,
				isFallback: false,
				alwaysUseForProvider: false,
				alwaysUseForMatchingModels: false,
				allowedModels: null,
				allowedUserIds: null,
				allowedApiKeyHashes: null,
			},
		}), /selected workspace/u);

		database.prepare("UPDATE users SET status = 'disabled' WHERE id = 'user-1'").run();
		assert.equal(await repository.updateForManagement({
			principal: portalPrincipal,
			id: ids[0]!,
			nowIso: '2026-09-03T01:05:00.000Z',
			patch: { disabled: true },
		}), null);
		database.prepare("UPDATE users SET status = 'active' WHERE id = 'user-1'").run();
		assert.equal(await repository.deleteForManagement({
			principal: portalPrincipal,
			id: ids[1]!,
			nowIso: '2026-09-03T01:06:00.000Z',
		}), true);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE source = 'gateway_portal_byok'",
		).get()?.total, 5);
	} finally {
		database.close();
	}
});

test('D1 BYOK reorder atomically updates priority partitions without touching secrets', async () => {
	const { database, repository } = fixture();
	try {
		const ids = [
			'11111111-1111-4111-8111-111111111111',
			'22222222-2222-4222-8222-222222222222',
			'33333333-3333-4333-8333-333333333333',
		];
		for (const [index, id] of ids.entries()) {
			await repository.insertForManagement({
				principal,
				id,
				nowIso: `2026-09-03T00:0${index}:00.000Z`,
				input: {
					workspaceId: WORKSPACE_ID,
					provider: 'deepseek',
					name: `Key ${index + 1}`,
					apiKey: `deepseek-secret-${index + 1}`,
					label: `...ret${index + 1}`,
					disabled: false,
					isFallback: index === 2,
					alwaysUseForProvider: false,
					alwaysUseForMatchingModels: false,
					allowedModels: null,
					allowedUserIds: null,
					allowedApiKeyHashes: null,
				},
			});
		}
		const beforeSecrets = database.prepare(
			'SELECT id, api_key_encrypted FROM byok_keys ORDER BY id',
		).all();

		assert.equal(await repository.reorderForManagement({
			principal,
			nowIso: '2026-09-03T00:10:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				keys: [
					{ id: ids[1]!, isFallback: false },
					{ id: ids[2]!, isFallback: false },
					{ id: ids[0]!, isFallback: true },
				],
			},
		}), 'updated');
		assert.deepEqual(database.prepare(
			`SELECT id, provider, is_fallback, sort_order FROM byok_keys
			WHERE deleted_at IS NULL ORDER BY sort_order`,
		).all().map((row) => ({ ...row })), [
			{ id: ids[1], provider: 'deepseek', is_fallback: 0, sort_order: 0 },
			{ id: ids[2], provider: 'deepseek', is_fallback: 0, sort_order: 1 },
			{ id: ids[0], provider: 'deepseek', is_fallback: 1, sort_order: 2 },
		]);
		assert.deepEqual(database.prepare(
			'SELECT id, api_key_encrypted FROM byok_keys ORDER BY id',
		).all(), beforeSecrets);
		assert.deepEqual((await repository.listActiveForRequest({
			workspaceId: WORKSPACE_ID,
			provider: 'deepseek',
			modelId: 'deepseek/deepseek-chat',
			userId: 'user-1',
			apiKeyHash: API_KEY_HASH,
		})).map((row) => row.id), [ids[1], ids[2], ids[0]]);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE event_type = 'byok_key_reordered'",
		).get()?.total, 1);

		await repository.updateForManagement({
			principal,
			id: ids[1]!,
			nowIso: '2026-09-03T00:10:30.000Z',
			patch: { alwaysUseForProvider: true },
		});
		const beforeAlwaysUseConflict = database.prepare(
			'SELECT id, is_fallback, always_use_for_provider, sort_order FROM byok_keys ORDER BY sort_order',
		).all();
		assert.equal(await repository.reorderForManagement({
			principal,
			nowIso: '2026-09-03T00:10:45.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				keys: [
					{ id: ids[2]!, isFallback: false },
					{ id: ids[0]!, isFallback: false },
					{ id: ids[1]!, isFallback: true },
				],
			},
		}), 'conflict');
		assert.deepEqual(database.prepare(
			'SELECT id, is_fallback, always_use_for_provider, sort_order FROM byok_keys ORDER BY sort_order',
		).all(), beforeAlwaysUseConflict);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE event_type = 'byok_key_reordered'",
		).get()?.total, 1);

		const orderedBeforeConflict = database.prepare(
			'SELECT id, is_fallback, sort_order FROM byok_keys ORDER BY sort_order',
		).all();
		assert.equal(await repository.reorderForManagement({
			principal,
			nowIso: '2026-09-03T00:11:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				keys: [
					{ id: ids[0]!, isFallback: false },
					{ id: ids[1]!, isFallback: true },
				],
			},
		}), 'conflict');
		assert.deepEqual(database.prepare(
			'SELECT id, is_fallback, sort_order FROM byok_keys ORDER BY sort_order',
		).all(), orderedBeforeConflict);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS total FROM user_audit_logs WHERE event_type = 'byok_key_reordered'",
		).get()?.total, 1);
		assert.equal(await repository.reorderForManagement({
			principal: {
				...principal,
				keyId: 'management-2',
				createdByUserId: 'user-2',
				personalOwnerUserId: 'user-2',
			},
			nowIso: '2026-09-03T00:12:00.000Z',
			input: {
				workspaceId: WORKSPACE_ID,
				provider: 'deepseek',
				keys: [
					{ id: ids[1]!, isFallback: false },
					{ id: ids[2]!, isFallback: false },
					{ id: ids[0]!, isFallback: true },
				],
			},
		}), 'not_found');
		assert.deepEqual(database.prepare(
			'SELECT id, is_fallback, sort_order FROM byok_keys ORDER BY sort_order',
		).all(), orderedBeforeConflict);
	} finally {
		database.close();
	}
});

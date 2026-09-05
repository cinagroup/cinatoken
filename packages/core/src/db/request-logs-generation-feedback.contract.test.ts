import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from '@cloudflare/workers-types';
import type {
	D1DatabaseClient,
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from '../storage/database-client';
import type { InsertGenerationFeedbackForManagementAccountParams } from './generation-feedback-types';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';
import { createMySqlRequestLogsRepository } from './mysql/request-logs.impl';
import { createPostgresRequestLogsRepository } from './postgres/request-logs.impl';

const migration = readFileSync(fileURLToPath(new URL(
	'../../migrations-d1/0057_generation_feedback.sql',
	import.meta.url,
).href), 'utf8');

const PERSONAL: InsertGenerationFeedbackForManagementAccountParams = {
	id: 'gfb_00000000-0000-4000-8000-000000000001',
	generationId: 'gen-personal',
	managementApiKeyId: 'mgmt-personal',
	account: {
		accountType: 'personal',
		personalOwnerUserId: 'user-1',
		organizationId: null,
	},
	category: 'incorrect_response',
	comment: 'The response repeated a paragraph.',
	createdAtIso: '2026-09-01T00:00:00.000Z',
};

const ORGANIZATION: InsertGenerationFeedbackForManagementAccountParams = {
	...PERSONAL,
	id: 'gfb_00000000-0000-4000-8000-000000000002',
	generationId: 'gen-organization',
	managementApiKeyId: 'mgmt-organization',
	account: {
		accountType: 'organization',
		personalOwnerUserId: null,
		organizationId: 'org-1',
	},
	category: 'billing',
	comment: null,
};

function compactSql(sql: string): string {
	return sql.replace(/\s+/gu, ' ').trim();
}

function assertAtomicAccountScope(
	sql: string,
	accountType: 'personal' | 'organization',
): void {
	const normalized = compactSql(sql);
	assert.match(normalized, /^INSERT INTO generation_feedback /u);
	assert.match(normalized, /FROM api_key_request_logs rl JOIN workspaces w ON w\.id = rl\.workspace_id/u);
	assert.match(normalized, /JOIN management_api_keys mk ON mk\.id = .+ AND mk\.status = 'active'/u);
	assert.match(normalized, /WHERE rl\.id = /u);
	assert.match(normalized, new RegExp(`mk\\.account_type = '${accountType}'`, 'u'));
	if (accountType === 'personal') {
		assert.match(normalized, /rl\.user_id = mk\.personal_owner_user_id/u);
		assert.match(normalized, /w\.personal_owner_user_id = mk\.personal_owner_user_id/u);
	} else {
		assert.match(normalized, /w\.organization_id = mk\.organization_id/u);
	}
	assert.doesNotMatch(normalized, /SELECT rl\.\*/u);
}

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
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}
}

function d1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
	} as D1Database;
	return {
		driver: 'd1',
		raw,
		drizzle: {} as D1DatabaseClient['drizzle'],
	};
}

function setupD1(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY);
		CREATE TABLE organizations (id TEXT PRIMARY KEY);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			scope_type TEXT NOT NULL,
			personal_owner_user_id TEXT,
			organization_id TEXT
		);
		CREATE TABLE management_api_keys (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			account_type TEXT NOT NULL,
			personal_owner_user_id TEXT,
			organization_id TEXT
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			workspace_id TEXT
		);
	`);
	database.exec(migration);
	database.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
	database.prepare('INSERT INTO organizations (id) VALUES (?)').run('org-1');
	database.prepare(`INSERT INTO workspaces (
		id, scope_type, personal_owner_user_id, organization_id
	) VALUES (?, 'personal', ?, NULL), (?, 'organization', NULL, ?)`)
		.run('workspace-personal', 'user-1', 'workspace-organization', 'org-1');
	database.prepare(`INSERT INTO management_api_keys (
		id, status, account_type, personal_owner_user_id, organization_id
	) VALUES (?, 'active', 'personal', ?, NULL), (?, 'active', 'organization', NULL, ?),
	         (?, 'revoked', 'personal', ?, NULL)`)
		.run('mgmt-personal', 'user-1', 'mgmt-organization', 'org-1', 'mgmt-revoked', 'user-1');
	database.prepare(`INSERT INTO api_key_request_logs (id, user_id, workspace_id)
		VALUES (?, ?, ?), (?, ?, ?)`)
		.run(
			'gen-personal', 'user-1', 'workspace-personal',
			'gen-organization', 'user-1', 'workspace-organization',
		);
	return database;
}

describe('generation feedback database contract', () => {
	it('D1 atomically authorizes personal and organization feedback', async () => {
		const database = setupD1();
		try {
			const repository = createD1RequestLogsRepository(d1Client(database));
			assert.equal(await repository.insertGenerationFeedbackForManagementAccount(PERSONAL), true);
			assert.equal(await repository.insertGenerationFeedbackForManagementAccount(ORGANIZATION), true);
			assert.equal(await repository.insertGenerationFeedbackForManagementAccount({
				...PERSONAL,
				id: 'gfb_00000000-0000-4000-8000-000000000003',
				generationId: 'gen-organization',
			}), false);
			assert.equal(await repository.insertGenerationFeedbackForManagementAccount({
				...PERSONAL,
				id: 'gfb_00000000-0000-4000-8000-000000000004',
				managementApiKeyId: 'mgmt-revoked',
			}), false);

			const rows = database.prepare(`SELECT generation_id, workspace_id,
				account_type, personal_owner_user_id, organization_id, category, comment
				FROM generation_feedback ORDER BY id`).all().map((row) => ({ ...row }));
			assert.deepEqual(rows, [
				{
					generation_id: 'gen-personal',
					workspace_id: 'workspace-personal',
					account_type: 'personal',
					personal_owner_user_id: 'user-1',
					organization_id: null,
					category: 'incorrect_response',
					comment: 'The response repeated a paragraph.',
				},
				{
					generation_id: 'gen-organization',
					workspace_id: 'workspace-organization',
					account_type: 'organization',
					personal_owner_user_id: null,
					organization_id: 'org-1',
					category: 'billing',
					comment: null,
				},
			]);
		} finally {
			database.close();
		}
	});

	it('PostgreSQL uses one account-scoped INSERT ... SELECT and reports misses', async () => {
		for (const [params, resultRows] of [
			[PERSONAL, [{ id: PERSONAL.id }]],
			[ORGANIZATION, []],
		] as const) {
			let sql = '';
			let values: unknown[] = [];
			const raw = {
				async unsafe(statement: string, bound: unknown[]) {
					sql = statement;
					values = bound;
					return resultRows;
				},
			} as PostgresDatabaseClient['raw'];
			const repository = createPostgresRequestLogsRepository({
				driver: 'postgres',
				raw,
				drizzle: {} as PostgresDatabaseClient['drizzle'],
			});
			assert.equal(
				await repository.insertGenerationFeedbackForManagementAccount(params),
				resultRows.length === 1,
			);
			assertAtomicAccountScope(sql, params.account.accountType);
			assert.deepEqual(values, [
				params.id, params.category, params.comment, params.createdAtIso,
				params.managementApiKeyId, params.generationId,
				params.account.personalOwnerUserId ?? params.account.organizationId,
			]);
		}
	});

	it('MySQL uses one account-scoped INSERT ... SELECT and reports misses', async () => {
		for (const [params, affectedRows] of [
			[PERSONAL, 1],
			[ORGANIZATION, 0],
		] as const) {
			let sql = '';
			let values: unknown[] = [];
			const raw = {
				async execute(statement: string, bound: unknown[]) {
					sql = statement;
					values = bound;
					return [{ affectedRows }, []];
				},
			};
			const repository = createMySqlRequestLogsRepository({
				driver: 'mysql', raw, drizzle: {},
			} as MySqlDatabaseClient);
			assert.equal(
				await repository.insertGenerationFeedbackForManagementAccount(params),
				affectedRows === 1,
			);
			assertAtomicAccountScope(sql, params.account.accountType);
			assert.deepEqual(values, [
				params.id, params.category, params.comment, params.createdAtIso,
				params.managementApiKeyId, params.generationId,
				params.account.personalOwnerUserId ?? params.account.organizationId,
			]);
		}
	});

	it('rejects malformed identifiers, categories, comments, and account scopes before storage', async () => {
		let prepareCalls = 0;
		const raw = {
			prepare() {
				prepareCalls += 1;
				throw new Error('must not query');
			},
		} as unknown as D1Database;
		const repository = createD1RequestLogsRepository({
			driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'],
		});
		for (const params of [
			{ ...PERSONAL, id: 'bad-id' },
			{ ...PERSONAL, generationId: 'not-a-generation' },
			{ ...PERSONAL, category: 'unsupported' },
			{ ...PERSONAL, comment: '🧭'.repeat(1_001) },
			{ ...PERSONAL, account: { ...PERSONAL.account, personalOwnerUserId: null } },
		]) {
			await assert.rejects(
				repository.insertGenerationFeedbackForManagementAccount(
					params as InsertGenerationFeedbackForManagementAccountParams,
				),
				TypeError,
			);
		}
		assert.equal(prepareCalls, 0);
	});
});

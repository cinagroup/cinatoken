import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { D1DatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createD1GuardrailsRepository } from './d1/guardrails.impl';
import { createPostgresGuardrailsRepository } from './postgres/guardrails.impl';

class BoundStatement {
	private values: unknown[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]) { this.values = values; return this; }
	async run() { const result = this.statement.run(...this.values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; }
	async first<T>() { return (this.statement.get(...this.values as never[]) as T | undefined) ?? null; }
	async all<T>() { return { success: true, results: this.statement.all(...this.values as never[]) as T[], meta: { changes: 0 } }; }
}

function repository() {
	const sqlite = new DatabaseSync(':memory:');
		sqlite.exec(`
		CREATE TABLE guardrails (
			id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			is_workspace_default INTEGER NOT NULL DEFAULT 0,
			is_account_default INTEGER NOT NULL DEFAULT 0,
			account_scope_key TEXT,
			designated_version INTEGER NOT NULL, latest_version INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE guardrail_versions (
			id TEXT PRIMARY KEY, guardrail_id TEXT NOT NULL, version INTEGER NOT NULL,
			config_json TEXT NOT NULL, created_by_user_id TEXT, created_at TEXT NOT NULL,
			UNIQUE(guardrail_id, version)
		);
		CREATE TABLE guardrail_assignments (
			id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, guardrail_id TEXT NOT NULL, scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL, created_by_user_id TEXT, management_source TEXT,
			assigned_by_user_id TEXT, created_at TEXT NOT NULL,
			UNIQUE(workspace_id, scope_type, scope_id)
		);
		INSERT INTO guardrails (id, workspace_id, owner_user_id, name, description, status, designated_version, latest_version, created_at, updated_at)
		VALUES
			('admin-policy', 'ws-1', 'u1', 'Admin policy', NULL, 'active', 1, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
			('user-policy', 'ws-1', 'u1', 'User policy', NULL, 'active', 1, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
			('free-policy', 'ws-1', 'u1', 'Free policy', NULL, 'active', 1, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
		INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at)
		VALUES
			('v-admin-1', 'admin-policy', 1, '{}', NULL, '2026-08-29T00:00:00.000Z'),
			('v-user-1', 'user-policy', 1, '{}', 'u1', '2026-08-29T00:00:00.000Z'),
			('v-free-1', 'free-policy', 1, '{}', 'u1', '2026-08-29T00:00:00.000Z');
	`);
	const raw = {
		prepare: (sql: string) => new BoundStatement(sqlite.prepare(sql)),
		batch: async (statements: BoundStatement[]) => Promise.all(statements.map((statement) => statement.run())),
	};
	return createD1GuardrailsRepository({ kind: 'd1', raw } as unknown as D1DatabaseClient);
}

function postgresRepository() {
	const statements: Array<{ transactional: boolean; sql: string }> = [];
	const row = {
		id: 'guardrail-1', workspace_id: 'ws-1', owner_user_id: 'u1', name: 'Policy', description: null,
		status: 'active', designated_version: 2, latest_version: 2,
		created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-2', version_config_json: '{}', version_created_by_user_id: 'u1',
		version_created_at: '2026-08-29T00:00:00.000Z',
	};
	const respond = async (sql: string, params: unknown[], transactional: boolean): Promise<unknown[]> => {
		statements.push({ transactional, sql });
		if (/^SELECT id FROM guardrails .* FOR UPDATE$/u.test(sql)) return [{ id: params[0] }];
		if (sql.startsWith('UPDATE guardrails SET latest_version')) return [{ latest_version: 2 }];
		if (sql.startsWith('UPDATE guardrails SET')) return [{ id: params.at(-1) }];
		if (sql.startsWith('INSERT INTO guardrail_versions')) return [];
		if (sql.startsWith('INSERT INTO guardrail_assignments')) {
			return [{
				id: params[0], workspace_id: params[1], guardrail_id: params[2], scope_type: params[3],
				scope_id: params[4], created_by_user_id: params[5], management_source: params[6],
				assigned_by_user_id: params[7], created_at: params[8],
			}];
		}
		if (sql.startsWith('SELECT g.id')) return [row];
		return [];
	};
	const transaction = { unsafe: (sql: string, params: unknown[] = []) => respond(sql, params, true) };
	const raw = {
		unsafe: (sql: string, params: unknown[] = []) => respond(sql, params, false),
		begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction),
	};
	return {
		statements,
		repo: createPostgresGuardrailsRepository({ driver: 'postgres', raw } as unknown as PostgresDatabaseClient),
	};
}

function assertLockedBeforeWrite(
	statements: Array<{ transactional: boolean; sql: string }>,
	writePrefix: string,
): void {
	const lockIndex = statements.findIndex(({ sql }) => /^SELECT id FROM guardrails .* FOR UPDATE$/u.test(sql));
	const writeIndex = statements.findIndex(({ sql }) => sql.startsWith(writePrefix));
	assert.ok(lockIndex >= 0, 'expected a parent Guardrail row lock');
	assert.ok(writeIndex > lockIndex, 'expected the row lock before the protected write');
	assert.equal(statements[lockIndex]?.transactional, true);
	assert.equal(statements[writeIndex]?.transactional, true);
}

describe('guardrail assignment ownership policy', () => {
	it('does not let a user replace or delete an administrator-managed scope', async () => {
		const repo = repository();
		await repo.upsertAssignment({ id: 'a1', workspaceId: 'ws-1', guardrailId: 'admin-policy', scopeType: 'user', scopeId: 'u1', createdByUserId: null, nowIso: '2026-08-29T00:00:00.000Z' });
		const attempted = await repo.upsertAssignment({ id: 'a2', workspaceId: 'ws-1', guardrailId: 'user-policy', scopeType: 'user', scopeId: 'u1', createdByUserId: 'u1', nowIso: '2026-08-29T00:01:00.000Z', preserveAdminManaged: true });
		assert.equal(attempted.guardrail_id, 'admin-policy');
		assert.equal(attempted.created_by_user_id, null);
		assert.equal(attempted.management_source, 'admin');
		assert.equal(attempted.assigned_by_user_id, null);
		assert.equal(await repo.deleteAssignment('ws-1', 'user', 'u1', 'u1'), false);
		assert.equal(await repo.deleteAssignment('ws-1', 'user', 'u1'), true);
	});

	it('allows a user to replace and remove their own scope binding', async () => {
		const repo = repository();
		await repo.upsertAssignment({ id: 'a1', workspaceId: 'ws-1', guardrailId: 'user-policy', scopeType: 'api_key', scopeId: 'k1', createdByUserId: 'u1', nowIso: '2026-08-29T00:00:00.000Z', preserveAdminManaged: true });
		const replaced = await repo.upsertAssignment({ id: 'a2', workspaceId: 'ws-1', guardrailId: 'admin-policy', scopeType: 'api_key', scopeId: 'k1', createdByUserId: 'u1', nowIso: '2026-08-29T00:01:00.000Z', preserveAdminManaged: true });
		assert.equal(replaced.guardrail_id, 'admin-policy');
		assert.equal(replaced.management_source, null);
		assert.equal(await repo.deleteAssignment('ws-1', 'api_key', 'k1', 'u1'), true);
	});

	it('records Management API provenance without weakening administrator takeover protection', async () => {
		const repo = repository();
		const assigned = await repo.upsertAssignment({
			id: 'management-a1', workspaceId: 'ws-1', guardrailId: 'admin-policy',
			scopeType: 'api_key', scopeId: 'management-key-target', createdByUserId: null,
			managementSource: 'management_api', assignedByUserId: 'u1',
			nowIso: '2026-08-29T00:00:00.000Z',
		});
		assert.equal(assigned.management_source, 'management_api');
		assert.equal(assigned.assigned_by_user_id, 'u1');
		const replaced = await repo.upsertAssignment({
			id: 'management-a2', workspaceId: 'ws-1', guardrailId: 'free-policy',
			scopeType: 'api_key', scopeId: 'management-key-target', createdByUserId: null,
			managementSource: 'management_api', assignedByUserId: 'u1',
			nowIso: '2026-08-29T00:01:00.000Z',
		});
		assert.equal(replaced.id, 'management-a1');
		assert.equal(replaced.guardrail_id, 'free-policy');
		assert.rejects(() => repo.upsertAssignment({
			id: 'invalid-management', workspaceId: 'ws-1', guardrailId: 'free-policy',
			scopeType: 'api_key', scopeId: 'invalid-management', createdByUserId: null,
			managementSource: 'management_api', nowIso: '2026-08-29T00:02:00.000Z',
		}), /require an actor/u);
	});

	it('atomically blocks protected guardrail mutations after administrator takeover', async () => {
		const repo = repository();
		await repo.upsertAssignment({ id: 'a-admin', workspaceId: 'ws-1', guardrailId: 'user-policy', scopeType: 'user', scopeId: 'u1', createdByUserId: null, nowIso: '2026-08-29T00:01:00.000Z' });

		assert.equal(await repo.addVersion({
			guardrailId: 'user-policy', versionId: 'v-user-2', name: 'Taken over', description: 'blocked',
			configJson: '{"allowed_models":["blocked"]}', createdByUserId: 'u1',
			nowIso: '2026-08-29T00:02:00.000Z', preserveAdminManaged: true,
		}), null);
		assert.equal(await repo.updateMetadata('user-policy', {
			name: 'Blocked rename', nowIso: '2026-08-29T00:03:00.000Z', preserveAdminManaged: true,
		}), false);
		assert.equal(await repo.designateVersion('user-policy', 1, '2026-08-29T00:04:00.000Z', {
			preserveAdminManaged: true,
		}), false);

		const unchanged = await repo.getById('user-policy');
		assert.equal(unchanged?.name, 'User policy');
		assert.equal(unchanged?.latest_version, 1);
		assert.equal((await repo.listVersions('user-policy')).length, 1);
	});

	it('allows protected user mutations before takeover and preserves administrator writes', async () => {
		const repo = repository();
		const version = await repo.addVersion({
			guardrailId: 'free-policy', versionId: 'v-free-2', name: 'User update', description: 'safe',
			configJson: '{"allowed_models":["openai/gpt-5"]}', createdByUserId: 'u1',
			nowIso: '2026-08-29T00:01:00.000Z', preserveAdminManaged: true,
		});
		assert.equal(version?.latest_version, 2);
		assert.equal(version?.name, 'User update');
		assert.equal(await repo.designateVersion('free-policy', 1, '2026-08-29T00:02:00.000Z', { preserveAdminManaged: true }), true);

		await repo.upsertAssignment({ id: 'a-admin', workspaceId: 'ws-1', guardrailId: 'free-policy', scopeType: 'user', scopeId: 'u1', createdByUserId: null, nowIso: '2026-08-29T00:03:00.000Z' });
		assert.equal(await repo.updateMetadata('free-policy', {
			name: 'Administrator update', nowIso: '2026-08-29T00:04:00.000Z',
		}), true);
		assert.equal((await repo.getById('free-policy'))?.name, 'Administrator update');
	});

	it('serializes PostgreSQL user mutations and administrator assignment takeover on the parent row', async () => {
		const fixture = postgresRepository();
		await fixture.repo.addVersion({
			guardrailId: 'guardrail-1', versionId: 'version-2', name: 'Policy', description: null,
			configJson: '{}', createdByUserId: 'u1', nowIso: '2026-08-29T00:01:00.000Z',
			preserveAdminManaged: true,
		});
		assertLockedBeforeWrite(fixture.statements, 'UPDATE guardrails SET latest_version');

		fixture.statements.length = 0;
		await fixture.repo.updateMetadata('guardrail-1', {
			name: 'Updated', nowIso: '2026-08-29T00:02:00.000Z', preserveAdminManaged: true,
		});
		assertLockedBeforeWrite(fixture.statements, 'UPDATE guardrails SET name');

		fixture.statements.length = 0;
		await fixture.repo.designateVersion('guardrail-1', 1, '2026-08-29T00:03:00.000Z', {
			preserveAdminManaged: true,
		});
		assertLockedBeforeWrite(fixture.statements, 'UPDATE guardrails SET designated_version');

		fixture.statements.length = 0;
		await fixture.repo.upsertAssignment({
			id: 'assignment-admin', workspaceId: 'ws-1', guardrailId: 'guardrail-1', scopeType: 'user',
			scopeId: 'u1', createdByUserId: null, nowIso: '2026-08-29T00:04:00.000Z',
		});
		assertLockedBeforeWrite(fixture.statements, 'INSERT INTO guardrail_assignments');
	});
});

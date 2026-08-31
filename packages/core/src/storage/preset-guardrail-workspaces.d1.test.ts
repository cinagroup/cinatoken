import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1GuardrailBudgetsRepository } from '../db/d1/guardrail-budgets.impl';
import { createD1GuardrailsRepository } from '../db/d1/guardrails.impl';
import { createD1RequestPresetsRepository } from '../db/d1/request-presets.impl';
import type { GuardrailBudgetIntent } from '../db/guardrail-budget-types';
import type { D1DatabaseClient } from './database-client';

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

function d1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'] };
}

function migrate(database: DatabaseSync): void {
	database.exec('PRAGMA foreign_keys = ON');
	const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations-d1');
	const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
	for (const file of migrationFiles) {
		if (file === '0042_workspaces.sql') {
			database.prepare('INSERT INTO users (id, email) VALUES (?, ?), (?, ?)').run(
				'user-workspace-1', 'one@example.com', 'user-workspace-2', 'two@example.com',
			);
		}
		if (file === '0043_gateway_keys_workspace.sql') {
			database.prepare(`INSERT INTO api_keys (id, key, user_id, name) VALUES
				(?, ?, ?, ?), (?, ?, ?, ?)`).run(
				'key-workspace-1', 'sk-workspace-one', 'user-workspace-1', 'One',
				'key-workspace-2', 'sk-workspace-two', 'user-workspace-2', 'Two',
			);
		}
		database.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
	}
}

test('D1 Presets, Guardrails, assignments, and budget windows are isolated by Workspace', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		migrate(database);
		const client = d1Client(database);
		const presets = createD1RequestPresetsRepository(client);
		const guardrails = createD1GuardrailsRepository(client);
		const budgets = createD1GuardrailBudgetsRepository(client);
		const nowIso = '2026-08-30T00:00:00.000Z';

		await presets.createWithVersion({
			id: 'preset-workspace-1', versionId: 'preset-version-1',
			workspaceId: 'personal:user-workspace-1', ownerUserId: 'user-workspace-1',
			slug: 'shared-slug', name: 'Workspace One', description: null, visibility: 'public',
			systemPrompt: null, configJson: '{"model":"openai/gpt-5"}',
			createdByUserId: 'user-workspace-1', nowIso,
		});
		await presets.createWithVersion({
			id: 'preset-workspace-2', versionId: 'preset-version-2',
			workspaceId: 'personal:user-workspace-2', ownerUserId: 'user-workspace-2',
			slug: 'shared-slug', name: 'Workspace Two', description: null, visibility: 'private',
			systemPrompt: null, configJson: '{"model":"anthropic/claude"}',
			createdByUserId: 'user-workspace-2', nowIso,
		});
		assert.equal((await presets.getAccessibleBySlug(
			'shared-slug', 'personal:user-workspace-1', 'user-workspace-2',
		))?.id, 'preset-workspace-1', 'public means Workspace-public, not globally unique');
		assert.equal(await presets.getAccessibleBySlug(
			'shared-slug', 'personal:user-workspace-2', 'user-workspace-1',
		), null, 'a private preset cannot leak across Workspaces');

		for (const suffix of ['1', '2'] as const) {
			await guardrails.createWithVersion({
				id: `guardrail-workspace-${suffix}`, versionId: `guardrail-version-${suffix}`,
				workspaceId: `personal:user-workspace-${suffix}`,
				ownerUserId: `user-workspace-${suffix}`, name: `Policy ${suffix}`, description: null,
				configJson: '{"budget":{"limit":1,"period":"daily"}}',
				createdByUserId: `user-workspace-${suffix}`, nowIso,
			});
			await guardrails.upsertAssignment({
				id: `assignment-workspace-${suffix}`,
				workspaceId: `personal:user-workspace-${suffix}`,
				guardrailId: `guardrail-workspace-${suffix}`,
				scopeType: 'user', scopeId: 'shared-subject',
				createdByUserId: `user-workspace-${suffix}`, nowIso,
			});
		}
		assert.deepEqual((await guardrails.getEffectiveForRequest(
			'personal:user-workspace-1', 'shared-subject', 'key-workspace-1',
		)).map((row) => row.id), ['guardrail-workspace-1']);
		assert.deepEqual((await guardrails.getEffectiveForRequest(
			'personal:user-workspace-2', 'shared-subject', 'key-workspace-2',
		)).map((row) => row.id), ['guardrail-workspace-2']);
		await assert.rejects(() => guardrails.upsertAssignment({
			id: 'cross-workspace-key-assignment', workspaceId: 'personal:user-workspace-1',
			guardrailId: 'guardrail-workspace-1', scopeType: 'api_key', scopeId: 'key-workspace-2',
			createdByUserId: 'user-workspace-1', nowIso,
		}), /workspace mismatch/u);

		const intent = (workspaceId: string, assignmentId: string): GuardrailBudgetIntent => ({
			workspaceId, assignmentId, guardrailId: `guardrail-${assignmentId}`, guardrailVersion: 1,
			scopeType: 'user', scopeId: 'shared-subject', period: 'daily',
			periodStart: '2026-08-30T00:00:00.000Z', periodEnd: '2026-08-31T00:00:00.000Z',
			limitMicros: 1_000_000,
		});
		assert.equal((await budgets.reserveMany({
			requestId: 'request-workspace-1', intents: [intent('personal:user-workspace-1', 'budget-1')],
			reservedMicros: 700_000, nowIso, expiresAtIso: '2026-08-30T00:10:00.000Z',
		})).status, 'reserved');
		assert.equal((await budgets.reserveMany({
			requestId: 'request-workspace-2', intents: [intent('personal:user-workspace-2', 'budget-2')],
			reservedMicros: 700_000, nowIso, expiresAtIso: '2026-08-30T00:10:00.000Z',
		})).status, 'reserved');
		assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM guardrail_budget_windows
			WHERE scope_type = 'user' AND scope_id = 'shared-subject'`).get() as { count: number }).count, 2);
	} finally {
		database.close();
	}
});

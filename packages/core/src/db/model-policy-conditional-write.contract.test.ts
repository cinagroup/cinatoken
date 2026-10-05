import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createSqliteD1 } from '../../../proxy/src/test-support/sqlite-d1';
import { createD1ModelsRepository } from './d1/models.impl';
import { createPostgresModelsRepository } from './postgres/models.impl';
import { createMySqlModelsRepository } from './mysql/models.impl';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';

/** Real SQLite SQL/rollback with the production repository queries. PG/MySQL
 * dialect adaptation cannot verify native wire/locks/isolation/multi-session ACL. */
function fixture(driver: 'd1' | 'postgres' | 'mysql') {
	const d1 = driver === 'd1' ? createSqliteD1({}, { applyMigrations: false }) : undefined;
	const sqlite = d1?.sqlite ?? new DatabaseSync(':memory:');
	sqlite.exec(`PRAGMA foreign_keys=ON;
		CREATE TABLE models(id TEXT PRIMARY KEY,route_policy TEXT,display_name TEXT,description TEXT,pricing_profile TEXT,max_tokens INTEGER,metadata TEXT);
		CREATE TABLE model_tags(model_id TEXT REFERENCES models(id),tag TEXT,PRIMARY KEY(model_id,tag));
		INSERT INTO models VALUES('Model-A',NULL,'Original','description','price',12,'metadata');
		INSERT INTO model_tags VALUES('Model-A','old');`);
	const queries: { sql: string; params: unknown[] }[] = [];
	const events: string[] = [];
	const hooks: { receipt?: unknown; commitError?: boolean } = {};
	function execute(sql: string, params: unknown[] = []) {
		queries.push({ sql, params });
		const adapted = sql
			.replaceAll('cinatoken_gateway.', '')
			.replace(/\bBINARY\s+/gu, '')
			.replaceAll('COLLATE "C"', 'COLLATE BINARY')
			.replace(/\$\d+/gu, '?')
			.replace(/ FOR UPDATE\b/gu, '')
			.replaceAll('<=>', 'IS')
			.replaceAll('IS NOT DISTINCT FROM', 'IS');
		const stmt = sqlite.prepare(adapted);
		if (/^SELECT\b/iu.test(adapted.trim()) || /\bRETURNING\b/u.test(adapted)) return stmt.all(...(params as SQLInputValue[]));
		return { affectedRows: Number(stmt.run(...(params as SQLInputValue[])).changes) };
	}
	const tagged = async (strings: TemplateStringsArray, ...params: unknown[]) => execute(strings.join('?'), params);
	const tx = Object.assign(tagged, { unsafe: async (sql: string, params: unknown[]) => execute(sql, params) });
	const pg = {
		begin: async (fn: (sql: typeof tx) => Promise<unknown>) => {
			sqlite.exec('BEGIN');
			events.push('begin');
			try {
				const result = await fn(tx);
				if (hooks.commitError) throw new Error('Uncertain commit');
				sqlite.exec('COMMIT');
				events.push('commit');
				return result;
			} catch (error) {
				if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
				events.push('rollback');
				throw error;
			}
		},
	};
	const conn = {
		beginTransaction: async () => {
			sqlite.exec('BEGIN');
			events.push('begin');
		},
		execute: async (sql: string, params: unknown[]) => {
			const result = execute(sql, params);
			return [sql.startsWith('UPDATE') && hooks.receipt !== undefined ? { affectedRows: hooks.receipt } : result];
		},
		commit: async () => {
			if (hooks.commitError) throw new Error('Uncertain commit');
			sqlite.exec('COMMIT');
			events.push('commit');
		},
		rollback: async () => {
			if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
			events.push('rollback');
		},
		release: () => events.push('release'),
	};
	const repo =
		driver === 'd1'
			? createD1ModelsRepository({ raw: d1!.binding } as unknown as D1DatabaseClient)
			: driver === 'postgres'
				? createPostgresModelsRepository({ raw: pg, drizzle: {} } as unknown as PostgresDatabaseClient)
				: createMySqlModelsRepository({ raw: { getConnection: async () => conn }, drizzle: {} } as unknown as MySqlDatabaseClient);
	const state = () => ({
		model: { ...sqlite.prepare('SELECT * FROM models').get() },
		tags: sqlite
			.prepare('SELECT tag FROM model_tags ORDER BY tag')
			.all()
			.map((r) => r.tag),
	});
	return { sqlite, repo, queries, events, hooks, state };
}

for (const driver of ['d1', 'postgres', 'mysql'] as const) {
	test(`${driver} conditional policy: exact null matches and all patch fields/tags commit together`, async () => {
		const f = fixture(driver);
		try {
			assert.equal(
				await f.repo.updateModelWithPolicyPrecondition(
					'Model-A',
					{
						route_policy: '{"strategy":"lowest_cost"}',
						display_name: 'New',
						pricing_profile: null,
						max_tokens: 42,
						description: null,
						metadata: undefined,
					},
					null,
					['new', ' new ', 'second']
				),
				true
			);
			assert.deepEqual(f.state(), {
				model: {
					id: 'Model-A',
					route_policy: '{"strategy":"lowest_cost"}',
					display_name: 'New',
					description: null,
					pricing_profile: null,
					max_tokens: 42,
					metadata: 'metadata',
				},
				tags: ['new', 'second'],
			});
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: stale/absent/wrong-case ID are zero-write conflicts including tags`, async () => {
		const f = fixture(driver);
		try {
			for (const [id, expected] of [
				['Model-A', ''],
				['model-a', null],
				['missing', null],
			] as const) {
				const before = f.state();
				assert.equal(
					await f.repo.updateModelWithPolicyPrecondition(id, { route_policy: 'new', display_name: 'overwrite' }, expected, [
						'overwrite',
					]),
					false
				);
				assert.deepEqual(f.state(), before);
			}
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: concurrent read-set winner leaves stale writer and all its tags untouched`, async () => {
		const f = fixture(driver);
		try {
			assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'A' }, null, ['winner']), true);
			const before = f.state();
			assert.equal(
				await f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'B', pricing_profile: 'loser' }, null, ['loser']),
				false
			);
			assert.deepEqual(f.state(), before);
			assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'B' }, 'a', []), false);
			assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'B' }, ' A', []), false);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: matched no-op and tags-only mutation still check read-set`, async () => {
		const f = fixture(driver);
		try {
			assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', {}, null), true);
			assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', { unexpected_column: 'ignored' }, null, []), true);
			assert.deepEqual(f.state().tags, []);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: tag failure rolls back base and tags`, async () => {
		const f = fixture(driver);
		try {
			f.sqlite.exec(
				"CREATE TRIGGER tag_failure BEFORE INSERT ON model_tags WHEN NEW.tag='fail' BEGIN SELECT RAISE(ABORT,'tag_failure'); END"
			);
			const before = f.state();
			await assert.rejects(
				f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'A', display_name: 'New' }, null, ['good', 'fail']),
				/tag_failure/
			);
			assert.deepEqual(f.state(), before);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: model trigger exception rolls back tags too and cannot ACK`, async () => {
		const f = fixture(driver);
		try {
			f.sqlite.exec("CREATE TRIGGER model_failure BEFORE UPDATE ON models BEGIN SELECT RAISE(ABORT,'model_failure'); END");
			const before = f.state();
			await assert.rejects(
				f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'A' }, null, ['good']),
				/model_failure/
			);
			assert.deepEqual(f.state(), before);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver} conditional policy: A->B->A accepts current A, explicitly not historical revision`, async () => {
		const f = fixture(driver);
		try {
			for (const [expected, next] of [
				[null, 'A'],
				['A', 'B'],
				['B', 'A'],
				['A', 'C'],
			] as const)
				assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: next }, expected), true);
			assert.equal(f.state().model.route_policy, 'C');
		} finally {
			f.sqlite.close();
		}
	});
	if (driver !== 'd1')
		test(`${driver} conditional policy: uncertain commit throws instead of successful ACK`, async () => {
			const f = fixture(driver);
			try {
				f.hooks.commitError = true;
				const before = f.state();
				await assert.rejects(
					f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'A' }, null, ['new']),
					/Uncertain commit/
				);
				assert.deepEqual(f.state(), before);
			} finally {
				f.sqlite.close();
			}
		});
}

test('mysql conditional policy: changedRows=0 no-op is valid; malformed affectedRows is not', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.receipt = 0;
		assert.equal(await f.repo.updateModelWithPolicyPrecondition('Model-A', {}, null), true);
		for (const receipt of ['1', NaN, -1, 2]) {
			f.hooks.receipt = receipt;
			const before = f.state();
			await assert.rejects(
				f.repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'A' }, null, ['new']),
				/acknowledgement/
			);
			assert.deepEqual(f.state(), before);
		}
	} finally {
		f.sqlite.close();
	}
});

test('D1 full formal migration inventory: raw policy CAS and tags rollback use actual model schema', async () => {
	const f = createSqliteD1();
	const repo = createD1ModelsRepository({ raw: f.binding } as unknown as D1DatabaseClient);
	try {
		f.sqlite.exec("INSERT INTO models(id,vendor) VALUES('full-model','other'); INSERT INTO model_tags VALUES('full-model','old')");
		assert.equal(
			await repo.updateModelWithPolicyPrecondition('full-model', { route_policy: ' A ', max_tokens: null }, null, ['new']),
			true
		);
		assert.equal(await repo.updateModelWithPolicyPrecondition('full-model', { route_policy: 'B' }, 'A', ['stale']), false);
		f.sqlite.exec(
			"CREATE TRIGGER full_tag_failure BEFORE INSERT ON model_tags WHEN NEW.tag='fail' BEGIN SELECT RAISE(ABORT,'full_tag_failure'); END"
		);
		await assert.rejects(
			repo.updateModelWithPolicyPrecondition('full-model', { route_policy: 'B' }, ' A ', ['fail']),
			/full_tag_failure/
		);
		assert.deepEqual(
			{ ...f.sqlite.prepare('SELECT route_policy,max_tokens FROM models').get() },
			{ route_policy: ' A ', max_tokens: null }
		);
		assert.deepEqual(
			f.sqlite
				.prepare('SELECT tag FROM model_tags')
				.all()
				.map((r) => r.tag),
			['new']
		);
		assert.ok(f.migrationFiles.includes('0077_withdrawal_balance_update_guards.sql'));
	} finally {
		f.sqlite.close();
	}
});

test('D1 matched receipt uses exact RETURNING rows, independent of total_changes metadata; uncertain batch ACK throws', async () => {
	const f = createSqliteD1({}, { applyMigrations: false });
	try {
		f.sqlite.exec(
			"CREATE TABLE models(id TEXT PRIMARY KEY,route_policy TEXT); CREATE TABLE model_tags(model_id TEXT,tag TEXT); INSERT INTO models VALUES('m',NULL)"
		);
		const batch = f.binding.batch.bind(f.binding);
		let invalidReceipt = false;
		const raw = Object.assign(Object.create(f.binding), {
			async batch(statements: Parameters<typeof batch>[0]) {
				const results = await batch(statements);
				for (const result of results) result.meta.changes = 987;
				if (invalidReceipt) results.at(-1)!.results = [{ id: 'wrong-id' }];
				return results;
			},
		});
		const repo = createD1ModelsRepository({ raw } as unknown as D1DatabaseClient);
		assert.equal(await repo.updateModelWithPolicyPrecondition('m', { route_policy: 'A' }, null), true);
		assert.equal(await repo.updateModelWithPolicyPrecondition('m', { route_policy: 'B' }, null, ['stale']), false);
		assert.deepEqual(f.sqlite.prepare('SELECT * FROM model_tags').all(), []);
		invalidReceipt = true;
		await assert.rejects(repo.updateModelWithPolicyPrecondition('m', { route_policy: 'B' }, 'A'), /acknowledgement/);
		// This fake mutates only the post-commit response: outcome is unknown to the caller,
		// not a promise that a failed acknowledgement rolled back an already committed write.
		assert.equal(f.sqlite.prepare('SELECT route_policy FROM models').get()!.route_policy, 'B');
	} finally {
		f.sqlite.close();
	}
});

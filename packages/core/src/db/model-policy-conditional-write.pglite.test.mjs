/** Actual PostgreSQL engine and formal migrations, in local PGlite WASM only.
 * No native sockets, pool/isolation/role or two-session proof is claimed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialEngine } from '../test-support/postgres-financial-engine.mjs';
import { createPostgresModelsRepository } from './postgres/models.impl.ts';

test('model policy conditional writes on the actual formal PostgreSQL schema', async (t) => {
	const f = await createFinancialEngine();
	function callable(base) {
		return Object.assign(
			(parts, ...params) =>
				base.unsafe(
					parts.reduce((sql, part, i) => sql + (i ? '$' + i : '') + part, ''),
					params
				),
			base,
			{ begin: (callback) => base.begin((tx) => callback(callable(tx))) }
		);
	}
	const repo = createPostgresModelsRepository({ ...f.client, raw: callable(f.client.raw) });
	try {
		await f.pg.exec(`CREATE TABLE public.models(LIKE cinatoken_gateway.models INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TABLE public.model_tags(LIKE cinatoken_gateway.model_tags INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE models(LIKE cinatoken_gateway.models INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE model_tags(LIKE cinatoken_gateway.model_tags INCLUDING DEFAULTS INCLUDING INDEXES);
      INSERT INTO cinatoken_gateway.models(id,display_name) VALUES('Model-A','Original');
      INSERT INTO cinatoken_gateway.model_tags VALUES('Model-A','old');
      INSERT INTO public.models(id,route_policy) VALUES('Model-A','shadow');
      INSERT INTO pg_temp.models(id,route_policy) VALUES('Model-A','shadow');
      SET search_path TO pg_catalog,public,pg_temp,cinatoken_gateway;`);
		const state = async () => ({
			model: (await f.pg.query('SELECT route_policy,display_name,max_tokens,pricing_profile FROM cinatoken_gateway.models')).rows,
			tags: (await f.pg.query('SELECT tag FROM cinatoken_gateway.model_tags ORDER BY tag')).rows,
		});
		await t.test('explicit null and all fields/tags commit only to gateway despite public/temp shadows', async () => {
			assert.equal(
				await repo.updateModelWithPolicyPrecondition(
					'Model-A',
					{ route_policy: ' A ', display_name: 'Changed', max_tokens: null, pricing_profile: null },
					null,
					['new']
				),
				true
			);
			assert.deepEqual(await state(), {
				model: [{ route_policy: ' A ', display_name: 'Changed', max_tokens: null, pricing_profile: null }],
				tags: [{ tag: 'new' }],
			});
			for (const schema of ['public', 'pg_temp'])
				assert.deepEqual((await f.pg.query(`SELECT route_policy FROM ${schema}.models`)).rows, [{ route_policy: 'shadow' }]);
		});
		await t.test('stale byte/case/null and wrong ID cannot mutate fields or tags', async () => {
			const before = await state();
			for (const [id, expected] of [
				['Model-A', 'A'],
				['Model-A', null],
				['Model-A', ' a '],
				['model-a', ' A '],
				['absent', ' A '],
			])
				assert.equal(
					await repo.updateModelWithPolicyPrecondition(id, { route_policy: 'lost', display_name: 'lost' }, expected, ['lost']),
					false
				);
			assert.deepEqual(await state(), before);
		});
		await t.test('tag failure rolls back base UPDATE and tag replacement in the same transaction', async () => {
			await f.pg.exec(`ALTER TABLE cinatoken_gateway.model_tags ADD CONSTRAINT fixture_tag_failure CHECK(tag <> 'fail')`);
			const before = await state();
			await assert.rejects(
				repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: 'B', display_name: 'lost' }, ' A ', ['good', 'fail']),
				/fixture_tag_failure/
			);
			assert.deepEqual(await state(), before);
		});
		await t.test('matched no-op and A->B->A deliberately check current value rather than history', async () => {
			assert.equal(await repo.updateModelWithPolicyPrecondition('Model-A', {}, ' A '), true);
			for (const [expected, next] of [
				[' A ', 'B'],
				['B', ' A '],
				[' A ', null],
			])
				assert.equal(await repo.updateModelWithPolicyPrecondition('Model-A', { route_policy: next }, expected), true);
			assert.equal((await state()).model[0].route_policy, null);
		});
	} finally {
		await f.pg.close();
	}
});

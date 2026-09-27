import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthEngine, authImplementation, inferenceSecret, personal } from '../../test-support/postgres-auth-engine.mjs';
import { createFinancialEngine, gateway } from '../../test-support/postgres-financial-engine.mjs';
import { hashLookupKey } from '../../lib/key-hash.ts';

test('PostgreSQL API-key deletion remains usable before migration 0069', async t => {
  const fixture = await createFinancialEngine({ migrationHead: '0068_function_schema_resolution.sql' });
  t.after(() => fixture.pg.close());
  const { createPostgresApiKeysRepository } = await authImplementation('db/postgres/api-keys.impl.ts');
  const keys = createPostgresApiKeysRepository(fixture.client);
  await fixture.reset('public, pg_temp, pg_catalog');
  assert.equal(await keys.deleteApiKeyHard('key', inferenceSecret), true);
  await fixture.reset('public, pg_temp, pg_catalog');
  const keyHash = await hashLookupKey('pre-migration-key');
  await fixture.pg.query(`UPDATE ${gateway}.api_keys SET key_hash=$1 WHERE id='key'`, [keyHash]);
  assert.equal(await keys.deleteByHashForManagement({ ...personal, keyHash }), true);
});

test('PostgreSQL API-key deletion respects durable dispatch intent history', async t => {
  const fixture = await createAuthEngine();
  t.after(() => fixture.pg.close());
  const { createPostgresApiKeysRepository } = await authImplementation('db/postgres/api-keys.impl.ts');
  const keys = createPostgresApiKeysRepository(fixture.client);
  const management = () => keys.deleteByHashForManagement({ ...personal, keyHash: fixture.prepared.keyHash });
  const hard = () => keys.deleteApiKeyHard('key', inferenceSecret);
  const count = async table => Number((await fixture.pg.query(
    `SELECT count(*)::text AS n FROM ${gateway}.${table}`,
  )).rows[0].n);

  for (const [name, remove] of [['management', management], ['hard', hard]]) {
    await t.test(`${name} deletes a clean key`, async () => {
      await fixture.reset('public, pg_temp, pg_catalog');
      assert.equal(await remove(), true);
      assert.equal(await count('api_keys'), 0);
    });
  }

  await t.test('both paths return false for a key referenced only by a dispatch intent', async () => {
    await fixture.reset('pg_temp, public, pg_catalog');
    await fixture.pg.query(`INSERT INTO ${gateway}.request_dispatch_intents
      (request_id, attempt_index, user_id, api_key_id, workspace_id,
       operation, context_sha256, expires_at_ms)
      VALUES ('key-delete-history', 1, 'user', 'key', 'workspace',
        'images.generations', repeat('a', 64),
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)`);
    assert.equal(await count('api_key_request_logs'), 0);
    assert.equal(await count('user_budget_reservations'), 0);
    assert.equal(await count('guardrail_budget_reservations'), 0);
    assert.equal(await management(), false);
    assert.equal(await hard(), false);
    assert.equal(await count('api_keys'), 1);
    assert.equal(await count('request_dispatch_intents'), 1);
  });

  for (const [name, invoke] of [['management', repo => repo.deleteByHashForManagement({ ...personal, keyHash: fixture.prepared.keyHash })],
    ['hard', repo => repo.deleteApiKeyHard('key', inferenceSecret)]]) {
    for (const [label, fields, shouldReturnFalse] of [
      ['concurrent intent FK 23001', { code: '23001', constraint_name: 'request_dispatch_intents_api_key_id_fkey' }, true],
      ['concurrent intent FK 23503', { code: '23503', constraint_name: 'request_dispatch_intents_api_key_id_fkey' }, true],
      ['PGlite intent FK metadata', { code: '23001', constraint: 'request_dispatch_intents_api_key_id_fkey', schema: gateway, table: 'request_dispatch_intents' }, true],
      ['unrelated FK', { code: '23503', constraint_name: 'another_table_api_key_id_fkey' }, false],
      ['unrelated SQL error', { code: '42P01', constraint_name: 'request_dispatch_intents_api_key_id_fkey' }, false],
      ['same-name FK in another schema', { code: '23001', constraint_name: 'request_dispatch_intents_api_key_id_fkey', schema_name: 'public' }, false],
      ['conflicting constraint fields', { code: '23001', constraint_name: 'request_dispatch_intents_api_key_id_fkey', constraint: 'other_constraint' }, false],
    ]) {
      await t.test(`${name} classifies ${label} exactly`, async () => {
        const failure = Object.assign(new Error(label), fields);
        const repo = createPostgresApiKeysRepository({
          ...fixture.client,
          raw: {
            ...fixture.client.raw,
            unsafe(sql) {
              assert.match(sql, /^DELETE FROM cinatoken_gateway\.api_keys/);
              throw failure;
            },
          },
        });
        if (shouldReturnFalse) assert.equal(await invoke(repo), false);
        else await assert.rejects(invoke(repo), error => error === failure);
      });
    }
  }
});

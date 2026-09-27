// Opt-in local integration check of the render-only SQL bundle. No network or
// native PostgreSQL service is opened; the bundle builder itself remains read-only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildFactProducerProposalsBundle } from './postgres-fact-producer-proposals-bundle.mjs';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath),
  'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const schema = 'cinatoken_gateway';
const intentGuard = `${schema}.guard_request_dispatch_intent()`;
const outboxEnqueue = `${schema}.enqueue_usage_settlement_fact()`;

async function createFixture() {
  const pg = await PGlite.create();
  await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
    CREATE ROLE cinatoken_gateway_runtime;
    CREATE ROLE cinatoken_gateway_fact_producer;
    CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
    SET ROLE cinatoken_gateway_migrator;
    CREATE TABLE ${schema}.schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files.length, 73);
  for (const name of files) {
    await pg.transaction(async tx => {
      await tx.exec(readFileSync(new URL(name, migrations), 'utf8'));
      await tx.query(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
    });
  }
  await pg.exec(`GRANT EXECUTE ON FUNCTION ${intentGuard}, ${outboxEnqueue}
    TO cinatoken_gateway_runtime`);
  return pg;
}

async function functionState(pg) {
  return (await pg.query(`SELECT p.proname, p.prosecdef,
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime', p.oid, 'EXECUTE')
        AS runtime_execute
    FROM pg_catalog.pg_proc p
    WHERE p.oid IN ('${intentGuard}'::pg_catalog.regprocedure,
      '${outboxEnqueue}'::pg_catalog.regprocedure)
    ORDER BY p.proname`)).rows;
}

test('one rendered transaction activates both bound definers and revokes runtime EXECUTE',
  { timeout: 150_000 }, async () => {
    const pg = await createFixture();
    try {
      assert.deepEqual(await functionState(pg), [
        { proname: 'enqueue_usage_settlement_fact', prosecdef: false, runtime_execute: true },
        { proname: 'guard_request_dispatch_intent', prosecdef: false, runtime_execute: true },
      ]);
      await pg.exec(buildFactProducerProposalsBundle());
      assert.deepEqual(await functionState(pg), [
        { proname: 'enqueue_usage_settlement_fact', prosecdef: true, runtime_execute: false },
        { proname: 'guard_request_dispatch_intent', prosecdef: true, runtime_execute: false },
      ]);
    } finally {
      await pg.close();
    }
  });

test('second proposal preflight failure rolls back the first replacement and both revokes',
  { timeout: 150_000 }, async () => {
    const pg = await createFixture();
    try {
      await pg.exec(`ALTER TABLE ${schema}.request_usage_settlements
        DISABLE TRIGGER request_usage_settlements_enqueue`);
      await assert.rejects(pg.exec(buildFactProducerProposalsBundle()),
        /Settlement outbox enqueue trigger binding differs/u);
      await pg.exec('ROLLBACK');
      assert.deepEqual(await functionState(pg), [
        { proname: 'enqueue_usage_settlement_fact', prosecdef: false, runtime_execute: true },
        { proname: 'guard_request_dispatch_intent', prosecdef: false, runtime_execute: true },
      ]);
    } finally {
      await pg.close();
    }
  });

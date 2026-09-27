import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFinancialEngine, chargeParams, implementation, now as recordedAt } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from './usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from './usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from './usage-settlement-postgres.ts';
import { sample } from './usage-settlement-test-support.mjs';

const schema = 'cinatoken_gateway';
const head = '0073_recovery_api_key_workspace_lock.sql';
const recoveryMigrations = [
  '0069_recovery_dispatch_intents.sql',
  '0070_recovery_settlement_facts.sql',
  '0071_recovery_jobs.sql',
  '0072_recovery_commit_receipts.sql',
  head,
];
const recoveryTables = [
  'request_dispatch_intents',
  'request_usage_settlements',
  'request_usage_settlement_outbox',
  'request_usage_recovery_jobs',
  'request_usage_commit_receipts',
];

async function inspectRecoverySchema(pg) {
  const tables = (await pg.query(`SELECT c.relname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[])
    ORDER BY c.relname`, [schema, recoveryTables])).rows.map(row => row.relname);
  assert.deepEqual(tables, [...recoveryTables].sort());
  for (const table of recoveryTables) {
    const count = (await pg.query(`SELECT count(*)::int AS count FROM ${schema}.${table}`)).rows[0].count;
    assert.equal(count, 0, table);
  }
  const logGuard = (await pg.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname='api_key_request_logs'
      AND t.tgname='request_usage_log_recovery_guard'`, [schema])).rows[0].count;
  assert.equal(logGuard, 0, 'automatic migrations must not activate the legacy log INSERT guard');
  const jobChecks = (await pg.query(`SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid='cinatoken_gateway.request_usage_recovery_jobs'::regclass AND contype='c'`)).rows
    .map(row => row.conname);
  assert.ok(jobChecks.includes('request_usage_recovery_jobs_check'), 'timestamp ordering check is retained');
  assert.ok(jobChecks.includes('request_usage_recovery_jobs_lifecycle'), 'receipt-aware lifecycle is installed');
  assert.ok(!jobChecks.includes('request_usage_recovery_jobs_lifecycle_initial'), 'pre-receipt lifecycle is removed');
}

test('formal recovery migrations are ordered, parseable and leave the legacy log path open', { timeout: 150_000 }, async t => {
  for (const migration of recoveryMigrations) {
    const sql = readFileSync(new URL(`../../../migrations-postgres/${migration}`, import.meta.url), 'utf8');
    assert.match(sql, /^SET LOCAL lock_timeout = '2s';$/m, migration);
    assert.doesNotMatch(sql, /`n|LOCAL PROPOSAL ONLY|FORMAL SCHEMA ONLY/u, migration);
  }
  const { insertRequestUsageAndChargeTxPg: charge } = await implementation('db/postgres/critical-writes.impl.ts');

  await t.test('empty database applies the complete formal chain', async tcase => {
    const f = await createFinancialEngine(); tcase.after(() => f.pg.close());
    assert.equal(f.migrations.length, 73);
    assert.deepEqual(f.migrations.slice(-5), recoveryMigrations);
    await inspectRecoverySchema(f.pg);
    await f.reset('pg_catalog,cinatoken_gateway,pg_temp');
    await charge(f.client, chargeParams('legacy-after-fresh', 0.2));
    assert.equal((await f.pg.query(`SELECT count(*)::int AS count FROM ${schema}.api_key_request_logs`)).rows[0].count, 1);

    await f.reset('pg_catalog,cinatoken_gateway,pg_temp');
    const value = sample(0);
    Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace', budgetAccountedAt: recordedAt });
    value.recordedAtIso = recordedAt;
    value.params.requestLog.providerAttempts[0].observedAtIso = recordedAt;
    Object.assign(value.params, { userId: 'user', beforeSpent: 1 });
    Object.assign(value.params.audit, { apiKeyId: 'key', beforeSpent: 1 });
    const intents = createDispatchIntentRepositoryPostgres(f.client);
    const facts = createUsageSettlementFactsRepositoryPostgres(f.client);
    const jobs = createUsageRecoveryJobsPostgres(f.client);
    const settlement = createUsageSettlementRepositoryPostgres(f.client);
    const currentMs = Number((await f.pg.query(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows[0].ms);
    await intents.prepare(value.intent, currentMs + 60_000);
    assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
    const ref = await facts.persist(value);
    await jobs.ensure(ref);
    const claim = await jobs.claim({ ref, revision: 0 }, 30);
    assert.equal(claim.status, 'claimed');
    assert.equal(await settlement.commit(ref, claim.lease.proof), 'committed');
    assert.equal((await jobs.inspect(ref)).state, 'committed');
    assert.equal((await f.pg.query(`SELECT count(*)::int AS count FROM ${schema}.request_usage_commit_receipts`)).rows[0].count, 1);
  });

  await t.test('existing 0068 database upgrades without rewriting previous logs', async tcase => {
    const f = await createFinancialEngine({ migrationHead: '0068_function_schema_resolution.sql' });
    tcase.after(() => f.pg.close());
    assert.equal(f.migrations.length, 68);
    await f.reset('pg_catalog,cinatoken_gateway,pg_temp');
    await charge(f.client, chargeParams('legacy-before-upgrade', 0.2));
    const before = (await f.pg.query(`SELECT id, charged_cost::text AS charged_cost
      FROM ${schema}.api_key_request_logs WHERE id='legacy-before-upgrade'`)).rows;
    assert.equal(before.length, 1);
    for (const migration of recoveryMigrations) {
      const sql = readFileSync(new URL(`../../../migrations-postgres/${migration}`, import.meta.url), 'utf8');
      await f.pg.transaction(tx => tx.exec(sql));
    }
    await inspectRecoverySchema(f.pg);
    assert.deepEqual((await f.pg.query(`SELECT id, charged_cost::text AS charged_cost
      FROM ${schema}.api_key_request_logs WHERE id='legacy-before-upgrade'`)).rows, before);
    await charge(f.client, chargeParams('legacy-after-upgrade', 0.1));
    assert.equal((await f.pg.query(`SELECT count(*)::int AS count FROM ${schema}.api_key_request_logs`)).rows[0].count, 2);
  });

  await t.test('preexisting runtime default grants cannot expose recovery relations', async tcase => {
    const f = await createFinancialEngine({ migrationHead: '0068_function_schema_resolution.sql' });
    tcase.after(() => f.pg.close());
    await f.pg.exec(`CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
      GRANT USAGE ON SCHEMA ${schema} TO cinatoken_gateway_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cinatoken_gateway_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO cinatoken_gateway_runtime;`);
    for (const migration of recoveryMigrations) {
      const sql = readFileSync(new URL(`../../../migrations-postgres/${migration}`, import.meta.url), 'utf8');
      await f.pg.transaction(tx => tx.exec(sql));
    }
    for (const table of recoveryTables) {
      const rights = (await f.pg.query(`SELECT
        has_table_privilege('cinatoken_gateway_runtime', $1, 'SELECT') AS read,
        has_table_privilege('cinatoken_gateway_runtime', $1, 'INSERT') AS create,
        has_table_privilege('cinatoken_gateway_runtime', $1, 'UPDATE') AS mutate,
        has_table_privilege('cinatoken_gateway_runtime', $1, 'DELETE') AS erase`, [`${schema}.${table}`])).rows[0];
      assert.deepEqual(rights, { read: false, create: false, mutate: false, erase: false }, table);
    }
    assert.equal((await f.pg.query(`SELECT has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.recovery_api_key_workspace_matches(text,text)', 'EXECUTE') AS execute`)).rows[0].execute, false);
    const columnRight = async () => (await f.pg.query(`SELECT has_any_column_privilege(
      'cinatoken_gateway_runtime', 'cinatoken_gateway.request_dispatch_intents', 'SELECT') AS allowed`)).rows[0].allowed;
    assert.equal(await columnRight(), false);
    await f.pg.exec(`GRANT SELECT (request_id) ON TABLE ${schema}.request_dispatch_intents TO cinatoken_gateway_runtime`);
    assert.equal(await columnRight(), true, 'column grants must be visible to the access probe');
  });
});

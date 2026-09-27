import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFinancialEngine, chargeParams, implementation, now as recordedAt } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from './usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from './usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from './usage-settlement-postgres.ts';
import { sample } from './usage-settlement-test-support.mjs';
import { buildRecoveryLegacyLogGuardBundle } from '../../../../../scripts/db/cutover/postgres-recovery-legacy-log-guard-bundle.mjs';

const g = 'cinatoken_gateway';
const activation = readFileSync(new URL('../../../../../scripts/db/cutover/postgres-recovery-legacy-log-guard.activate.sql', import.meta.url), 'utf8');

async function prepareActivationFixture(pg) {
  await pg.exec(`CREATE TABLE ${g}.schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO ${g}.schema_migrations(version) VALUES ('0073_recovery_api_key_workspace_lock.sql');
    CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
    GRANT USAGE ON SCHEMA ${g} TO cinatoken_gateway_runtime;
    GRANT SELECT ON ${g}.api_keys TO cinatoken_gateway_runtime;
    GRANT SELECT, INSERT ON ${g}.api_key_request_logs TO cinatoken_gateway_runtime;
    GRANT EXECUTE ON FUNCTION ${g}.enforce_request_log_workspace() TO cinatoken_gateway_runtime;`);
}

async function activate(pg) {
  await pg.transaction(async tx => {
    await tx.exec("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
    await tx.exec(activation);
  });
}

async function persistedFact(f) {
  const value = sample(0);
  Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  Object.assign(value.params.requestLog, {
    userId: 'user', apiKeyId: 'key', workspaceId: 'workspace', budgetAccountedAt: recordedAt,
  });
  value.recordedAtIso = recordedAt;
  value.params.requestLog.providerAttempts[0].observedAtIso = recordedAt;
  value.params.userId = 'user';
  value.params.beforeSpent = 1;
  value.params.audit.apiKeyId = 'key';
  value.params.audit.beforeSpent = 1;
  const intents = createDispatchIntentRepositoryPostgres(f.client);
  const facts = createUsageSettlementFactsRepositoryPostgres(f.client);
  const now = Number((await f.pg.query(
    'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms',
  )).rows[0].ms);
  await intents.prepare(value.intent, now + 60_000);
  assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
  return { value, ref: await facts.persist(value) };
}

async function guardedCatalog(pg) {
  return (await pg.query(`SELECT t.tgname, t.tgtype, t.tgenabled,
      p.proname, p.prosecdef, p.provolatile, p.proconfig,
      owner.rolname AS owner
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
    WHERE t.tgrelid IN ('${g}.api_key_request_logs'::regclass,
      '${g}.request_usage_settlements'::regclass)
      AND t.tgname IN ('request_usage_log_recovery_guard',
        'request_usage_settlements_legacy_log_fence')
    ORDER BY t.tgname`)).rows;
}

test('optional legacy-log guard switch preserves ordinary writes and fences facts', { timeout: 150_000 }, async t => {
  assert.doesNotMatch(activation, /^\s*(?:BEGIN|COMMIT)\s*;/imu,
    'the caller owns the one explicit activation transaction');
  const { insertRequestUsageAndChargeTxPg: charge } = await implementation('db/postgres/critical-writes.impl.ts');
  const f = await createFinancialEngine(); t.after(() => f.pg.close());
  await prepareActivationFixture(f.pg);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'automatic migration 0073 must leave both fences disabled');

  await f.reset('public,pg_temp,pg_catalog');
  await charge(f.client, chargeParams('ordinary-before-switch', 0.1));
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs`)).rows[0].n, 1);
  await f.reset('public,pg_temp,pg_catalog');

  await assert.rejects(f.pg.transaction(tx => tx.exec(activation)), /activation assertion is missing/u);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'a missing assertion must roll back both objects');
  await assert.rejects(f.pg.transaction(async tx => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.exec("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
    await tx.exec(activation);
  }), /activation requires READ COMMITTED/u);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'a fixed activation snapshot must install neither guard');
  await f.pg.exec(`GRANT SELECT (request_id) ON ${g}.request_usage_settlements
    TO cinatoken_gateway_runtime`);
  await assert.rejects(activate(f.pg), /unexpected recovery table privilege: request_usage_settlements/u);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'column-level recovery access must block activation');
  await f.pg.exec(`REVOKE SELECT (request_id) ON ${g}.request_usage_settlements
    FROM cinatoken_gateway_runtime`);
  await f.pg.exec(`GRANT UPDATE (state) ON ${g}.request_usage_recovery_jobs
    TO cinatoken_gateway_runtime`);
  await assert.rejects(activate(f.pg), /unexpected recovery table privilege: request_usage_recovery_jobs/u);
  await f.pg.exec(`REVOKE UPDATE (state) ON ${g}.request_usage_recovery_jobs
    FROM cinatoken_gateway_runtime`);
  await f.pg.exec(`ALTER FUNCTION ${g}.enforce_request_log_workspace()
    SET search_path TO pg_catalog, pg_temp`);
  await assert.rejects(activate(f.pg), /workspace trigger function contract differs from 0068/u);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'a drifted workspace function must block activation');
  await f.pg.exec(`ALTER FUNCTION ${g}.enforce_request_log_workspace()
    SET search_path TO pg_catalog, ${g}, pg_temp`);
  await f.pg.exec(`REVOKE INSERT ON ${g}.api_key_request_logs
    FROM cinatoken_gateway_runtime`);
  await assert.rejects(activate(f.pg), /lacks the existing request-log write path/u);
  await f.pg.exec(`GRANT INSERT ON ${g}.api_key_request_logs
    TO cinatoken_gateway_runtime`);
  await f.pg.exec(`ALTER TABLE ${g}.request_usage_settlements ENABLE ROW LEVEL SECURITY`);
  await assert.rejects(activate(f.pg), /RLS-enabled/u);
  await f.pg.exec(`ALTER TABLE ${g}.request_usage_settlements DISABLE ROW LEVEL SECURITY`);
  await f.pg.exec(buildRecoveryLegacyLogGuardBundle());
  const catalog = await guardedCatalog(f.pg);
  assert.equal(catalog.length, 2);
  for (const row of catalog) {
    assert.equal(row.tgtype, 7);
    assert.equal(row.tgenabled, 'O');
    assert.equal(row.prosecdef, true);
    assert.equal(row.provolatile, 'v');
    assert.equal(row.owner, 'postgres');
    assert.ok(row.proconfig.includes('search_path=pg_catalog, pg_temp'));
  }
  assert.deepEqual(catalog.map(row => row.tgname), [
    'request_usage_log_recovery_guard', 'request_usage_settlements_legacy_log_fence',
  ]);
  for (const name of ['guard_fact_owned_usage_log()', 'guard_fact_without_legacy_log()']) {
    assert.equal((await f.pg.query(`SELECT has_function_privilege('cinatoken_gateway_runtime',
      $1, 'EXECUTE') AS allowed`, [`${g}.${name}`])).rows[0].allowed, false);
  }

  await charge(f.client, chargeParams('ordinary-after-switch', 0.1));
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs`)).rows[0].n, 1);
  await f.pg.exec('SET ROLE cinatoken_gateway_runtime');
  try {
    await f.pg.query(`INSERT INTO ${g}.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,charged_cost)
      VALUES ('runtime-nonfact','user','key','workspace',0)`);
    await assert.rejects(f.pg.query(`INSERT INTO ${g}.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,charged_cost)
      VALUES ('runtime-bad-workspace','user','key','other-workspace',0)`), /request_log_workspace_mismatch/u);
  } finally {
    await f.pg.exec('RESET ROLE');
  }
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs`)).rows[0].n, 2);

  const { ref } = await persistedFact(f);
  const before = await f.snapshot(g);
  await f.pg.exec('SET ROLE cinatoken_gateway_runtime');
  try {
    await assert.rejects(f.pg.query(`INSERT INTO ${g}.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,charged_cost)
      VALUES ($1,'user','key','workspace',0)`, [ref.requestId]),
    /Fact-owned usage log requires an active fenced receipt/u);
  } finally {
    await f.pg.exec('RESET ROLE');
  }
  await assert.rejects(charge(f.client, chargeParams(ref.requestId, 0.25)), error => {
    assert.match(error.cause?.message ?? '', /Fact-owned usage log requires an active fenced receipt/u);
    return true;
  });
  assert.deepEqual(await f.snapshot(g), before, 'the old writer must roll back its earlier debit');
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.request_usage_commit_receipts`)).rows[0].n, 0);

  const jobs = createUsageRecoveryJobsPostgres(f.client);
  const settlement = createUsageSettlementRepositoryPostgres(f.client);
  await jobs.ensure(ref);
  const claim = await jobs.claim({ ref, revision: 0 }, 30);
  assert.equal(claim.status, 'claimed');
  assert.equal(await settlement.commit(ref, claim.lease.proof), 'committed');
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.request_usage_commit_receipts`)).rows[0].n, 1);
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs WHERE id=$1`,
    [ref.requestId])).rows[0].n, 1);

  await assert.rejects(f.pg.transaction(async tx => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.query(`INSERT INTO ${g}.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,charged_cost)
      VALUES ('repeatable-read-log','user','key','workspace',0)`);
  }), /requires READ COMMITTED/u);

  await charge(f.client, chargeParams('ordinary-before-fact', 0));
  const existingId = 'ordinary-before-fact';
  const prior = await f.snapshot(g);
  const value = sample(0);
  value.intent.requestId = existingId;
  value.params.requestLog.id = existingId;
  Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  value.params.userId = 'user';
  value.params.audit.apiKeyId = 'key';
  const intents = createDispatchIntentRepositoryPostgres(f.client);
  const facts = createUsageSettlementFactsRepositoryPostgres(f.client);
  const now = Number((await f.pg.query(
    'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms',
  )).rows[0].ms);
  await intents.prepare(value.intent, now + 60_000);
  assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
  await assert.rejects(facts.persist(value));
  assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${g}.request_usage_settlements WHERE request_id=$1`,
    [existingId])).rows[0].n, 0);
  assert.deepEqual(await f.snapshot(g), prior, 'rejected fact must not rewrite the existing legacy log');
  await assert.rejects(activate(f.pg), /already exists/u);
});

test('activation rejects an existing fact and legacy log overlap atomically', { timeout: 150_000 }, async t => {
  const { insertRequestUsageAndChargeTxPg: charge } = await implementation('db/postgres/critical-writes.impl.ts');
  const f = await createFinancialEngine(); t.after(() => f.pg.close());
  await prepareActivationFixture(f.pg);
  await f.reset('pg_catalog,cinatoken_gateway,pg_temp');
  const { ref } = await persistedFact(f);
  await charge(f.client, chargeParams(ref.requestId, 0));
  await assert.rejects(activate(f.pg), /legacy log overlaps/u);
  assert.deepEqual(await guardedCatalog(f.pg), [], 'failed switch must install neither guard');
});

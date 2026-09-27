// Opt-in local SQL-engine check. PGlite uses PostgreSQL/WASM, not a native
// PostgreSQL service, Hyperdrive, or an origin role/session boundary.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPostgresRecoveryRoleSql } from './postgres-recovery-role-policy';
import type { RecoveryOriginBudgetSnapshot } from './postgres-recovery-origin-budget';

const pgliteModule = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(pgliteModule, 'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
assert.doesNotMatch(pgliteModule, /^[a-z]+:\/\//iu);
const { PGlite } = await import(pathToFileURL(resolve(pgliteModule)).href);
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardUrl = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const nowMs = Date.parse('2026-09-23T10:00:00.000Z');

function budgetFacts(): RecoveryOriginBudgetSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date(nowMs - 60_000).toISOString(),
    instance: {
      id: 'disposable_pg17_or_later', serverVersionNum: 170006, maxConnections: 50,
      superuserReservedConnections: 3, reservedConnections: 2,
      observedClientConnections: 12, observedClientConnectionsScope: 'all_databases',
      nonHyperdriveConnectionBudget: 5, safetyHeadroomConnections: 3,
    },
    inventory: {
      complete: true, scope: 'all_hyperdrives_on_instance', instanceId: 'disposable_pg17_or_later',
      origins: [
        { id: 'cinaauth', instanceId: 'disposable_pg17_or_later', roleName: 'cinaauth_runtime', originConnectionLimit: 15 },
        { id: 'gateway_runtime', instanceId: 'disposable_pg17_or_later', roleName: 'cinatoken_gateway_runtime', originConnectionLimit: 5 },
        { id: 'gateway_migrator', instanceId: 'disposable_pg17_or_later', roleName: 'cinatoken_gateway_migrator', originConnectionLimit: 5 },
      ],
    },
    recovery: {
      role: {
        name: 'cinatoken_gateway_recovery', login: false, connectionLimit: 2,
        timeoutDefaults: { transactionMs: 30_000, statementMs: 15_000, lockMs: 5_000, idleInTransactionMs: 10_000 },
      },
      hyperdrive: { id: 'gateway_recovery', instanceId: 'disposable_pg17_or_later', originConnectionLimit: 5 },
      peakConnectionsNeeded: 2, runBudgetMs: 60_000,
    },
  };
}

async function expectRejected(pg: any, sql: string, pattern: RegExp): Promise<void> {
  await assert.rejects(pg.exec(sql), pattern);
  // The generated phase begins an explicit transaction. Clear a failed one
  // before inspecting catalog state or trying the next isolated condition.
  await pg.exec('ROLLBACK');
}

test('PGlite executes generated role phases only after catalog and guard preflights', async () => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
      CREATE ROLE cinatoken_gateway_runtime;
      CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
      SET ROLE cinatoken_gateway_migrator;
      CREATE TABLE cinatoken_gateway.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()) {
      await pg.transaction(async (tx: any) => {
        await tx.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
        await tx.query('INSERT INTO cinatoken_gateway.schema_migrations(version) VALUES ($1)', [name]);
      });
    }
    await pg.exec(`GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_runtime;
      GRANT SELECT ON TABLE cinatoken_gateway.api_keys TO cinatoken_gateway_runtime;
      GRANT SELECT, INSERT ON TABLE cinatoken_gateway.api_key_request_logs TO cinatoken_gateway_runtime;
      GRANT EXECUTE ON FUNCTION cinatoken_gateway.enforce_request_log_workspace()
        TO cinatoken_gateway_runtime`);
    const plan = buildPostgresRecoveryRoleSql({ originBudgetFacts: budgetFacts(), nowMs });
    await pg.exec('RESET ROLE');
    await pg.exec(plan.adminSql);
    const role = (await pg.query(`SELECT rolcanlogin, rolinherit, rolconnlimit, rolpassword
      FROM pg_catalog.pg_authid WHERE rolname='cinatoken_gateway_recovery'`)).rows[0];
    assert.deepEqual(role, { rolcanlogin: false, rolinherit: false, rolconnlimit: 2, rolpassword: null });
    const settings = (await pg.query(`SELECT unnest(setconfig) AS setting
      FROM pg_catalog.pg_db_role_setting
      WHERE setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_recovery')
      ORDER BY setting`)).rows.map((row: { setting: string }) => row.setting);
    assert.deepEqual(settings, [
      'idle_in_transaction_session_timeout=10000', 'lock_timeout=5000',
      'search_path=pg_catalog, cinatoken_gateway', 'statement_timeout=15000',
      'transaction_timeout=30000',
    ]);
    await expectRejected(pg, plan.adminSql, /Recovery role already exists/u);

    await pg.exec('SET ROLE cinatoken_gateway_migrator');
    await expectRejected(pg, plan.migratorSql, /already has function execution via PUBLIC/u);
    await pg.exec('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_gateway FROM PUBLIC');
    await expectRejected(pg, plan.migratorSql,
      /Legacy log fence ownership or security contract differs: cinatoken_gateway\.guard_fact_owned_usage_log\(\)/u);

    // The two sided guard switch is deliberately outside formal migrations.
    // This disposable fixture applies it with the explicit local assertion.
    const guardSql = readFileSync(guardUrl, 'utf8');
    await assert.rejects(pg.transaction((tx: any) => tx.exec(guardSql)),
      /Explicit recovery log guard activation assertion is missing/u);
    await pg.transaction(async (tx: any) => {
      await tx.exec("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.exec(guardSql);
    });
    await assert.rejects(pg.transaction(async (tx: any) => {
      await tx.exec("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.exec(guardSql);
    }), /Recovery log guard switch already exists/u);
    await pg.exec(`ALTER TABLE cinatoken_gateway.api_key_request_logs
      DISABLE TRIGGER request_usage_log_recovery_guard`);
    await expectRejected(pg, plan.migratorSql, /Required recovery trigger missing, disabled/u);
    await pg.exec(`ALTER TABLE cinatoken_gateway.api_key_request_logs
      ENABLE TRIGGER request_usage_log_recovery_guard`);
    await pg.exec(`ALTER TABLE cinatoken_gateway.request_usage_settlements
      DISABLE TRIGGER request_usage_settlements_legacy_log_fence`);
    await expectRejected(pg, plan.migratorSql, /Required recovery trigger missing, disabled/u);
    await pg.exec(`ALTER TABLE cinatoken_gateway.request_usage_settlements
      ENABLE TRIGGER request_usage_settlements_legacy_log_fence`);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.recovery_api_key_workspace_matches(text,text)
      SECURITY INVOKER`);
    await expectRejected(pg, plan.migratorSql, /Recovery API-key lock helper ownership or security contract differs/u);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.recovery_api_key_workspace_matches(text,text)
      SECURITY DEFINER`);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.enforce_request_log_workspace()
      RESET search_path`);
    await expectRejected(pg, plan.migratorSql,
      /Request-log workspace trigger function security contract differs/u);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.enforce_request_log_workspace()
      SET search_path TO pg_catalog, cinatoken_gateway, pg_temp`);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.enforce_request_log_workspace()
      SECURITY DEFINER`);
    await expectRejected(pg, plan.migratorSql,
      /Request-log workspace trigger function security contract differs/u);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.enforce_request_log_workspace()
      SECURITY INVOKER`);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.guard_fact_without_legacy_log()
      SECURITY INVOKER`);
    await expectRejected(pg, plan.migratorSql, /Legacy log fence ownership or security contract differs/u);
    await pg.exec(`ALTER FUNCTION cinatoken_gateway.guard_fact_without_legacy_log()
      SECURITY DEFINER`);
    await pg.exec('GRANT SELECT ON TABLE cinatoken_gateway.request_usage_settlements TO PUBLIC');
    await expectRejected(pg, plan.migratorSql, /already has table privilege via PUBLIC/u);
    await pg.exec('REVOKE SELECT ON TABLE cinatoken_gateway.request_usage_settlements FROM PUBLIC');
    await pg.exec('GRANT MAINTAIN ON TABLE cinatoken_gateway.request_usage_settlements TO PUBLIC');
    await expectRejected(pg, plan.migratorSql, /already has table privilege via PUBLIC/u);
    await pg.exec('REVOKE MAINTAIN ON TABLE cinatoken_gateway.request_usage_settlements FROM PUBLIC');
    await pg.exec(`GRANT EXECUTE ON FUNCTION cinatoken_gateway.guard_fact_without_legacy_log()
      TO cinatoken_gateway_runtime`);
    await expectRejected(pg, plan.migratorSql, /Ordinary runtime must not execute the legacy log fence/u);
    await pg.exec(`REVOKE EXECUTE ON FUNCTION cinatoken_gateway.guard_fact_without_legacy_log()
      FROM cinatoken_gateway_runtime`);
    await pg.exec(plan.migratorSql);
    const grants = (await pg.query(`SELECT
      has_schema_privilege('cinatoken_gateway_recovery','cinatoken_gateway','USAGE') AS schema_usage,
      has_table_privilege('cinatoken_gateway_recovery','cinatoken_gateway.request_usage_recovery_jobs','INSERT') AS job_insert,
      has_table_privilege('cinatoken_gateway_recovery','cinatoken_gateway.api_keys','UPDATE') AS key_update,
      has_table_privilege('cinatoken_gateway_recovery','cinatoken_gateway.api_key_request_logs','UPDATE') AS log_update,
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.recovery_api_key_workspace_matches(text,text)','EXECUTE') AS helper_execute`)).rows[0];
    assert.deepEqual(grants, {
      schema_usage: true, job_insert: true, key_update: false, log_update: false, helper_execute: true,
    });
    const [triggerExecute] = (await pg.query(`SELECT
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.guard_usage_recovery_job()','EXECUTE') AS job_guard,
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.guard_usage_commit_receipt()','EXECUTE') AS receipt_guard,
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.check_usage_commit_transaction()','EXECUTE') AS transaction_check,
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.guard_fact_owned_usage_log()','EXECUTE') AS log_guard,
      has_function_privilege('cinatoken_gateway_recovery',
        'cinatoken_gateway.guard_fact_without_legacy_log()','EXECUTE') AS fact_guard`)).rows;
    assert.deepEqual(triggerExecute, {
      job_guard: false, receipt_guard: false, transaction_check: false,
      log_guard: false, fact_guard: false,
    });
    await pg.exec('RESET ROLE; SET ROLE cinatoken_gateway_recovery');
    assert.deepEqual((await pg.query(`SELECT cinatoken_gateway.recovery_api_key_workspace_matches(
      'missing', 'workspace') AS matches`)).rows, [{ matches: false }]);
    await assert.rejects(pg.exec(`UPDATE cinatoken_gateway.api_keys SET workspace_id = 'workspace'
      WHERE id = 'missing'`), /permission denied/u);
    await assert.rejects(pg.exec(`UPDATE cinatoken_gateway.api_key_request_logs SET status = 'success'
      WHERE id = 'missing'`), /permission denied/u);
  } finally {
    await pg.close();
  }
});

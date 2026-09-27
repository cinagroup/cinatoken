import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../storage/drizzle/schema.pg.ts';

export const gateway = 'cinatoken_gateway';
export const now = '2026-09-16T00:00:00.000Z';
export const expires = '2026-09-16T00:01:00.000Z';
export const end = '2026-09-17T00:00:00.000Z';
export const later = '2026-09-16T00:03:00.000Z';
export const baseline = process.env.GATEWAY_PG_FINANCIAL_BASELINE;
assert.ok(!baseline || ['code', 'functions'].includes(baseline));

export async function implementation(relative) {
  return import(baseline === 'code'
    ? pathToFileURL(resolve(process.env.GATEWAY_PG_FINANCIAL_BASELINE_DIR, relative.replace(/\.ts$/, '.js'))).href
    : new URL('../' + relative, import.meta.url).href);
}

export const migrationDir = new URL('../../migrations-postgres/', import.meta.url);
export const functionMigration = readFileSync(new URL('0068_function_schema_resolution.sql', migrationDir), 'utf8');
export const functionCatalogSql = `SELECT p.oid, p.proname, p.prosrc, p.proowner, p.proacl, p.prosecdef, p.proconfig,
  pg_get_function_identity_arguments(p.oid) AS arguments
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'cinatoken_gateway' ORDER BY p.proname`;

const shadowTables = ['users', 'workspaces', 'api_keys', 'guardrails', 'guardrail_assignments',
  'workspace_budgets', 'guardrail_budget_windows', 'guardrail_budget_reservations', 'user_budget_reservations',
  'api_key_request_logs', 'user_audit_logs', 'public_model_daily_stats', 'provider_attempt_availability',
  'user_earnings', 'shared_keys', 'shared_key_earnings', 'withdrawals', 'portal_ledger_entries'];

export async function createFinancialEngine({ migrationHead } = {}) {
  assert.ok(process.env.GATEWAY_PGLITE_MODULE, 'A local PGlite ESM file is required, not a database URL');
  assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE, /^[a-z]+:\/\//i);
  const { PGlite } = await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
  const pg = await PGlite.create({ parsers: { 20: value => value, 1700: value => value, 1184: value => value } });
  try {
    await pg.exec(`CREATE SCHEMA ${gateway}`);
    const allMigrations = readdirSync(migrationDir).filter(x => x.endsWith('.sql')).sort();
    assert.ok(migrationHead === undefined || allMigrations.includes(migrationHead), 'Unknown migration head');
    const migrations = migrationHead === undefined ? allMigrations : allMigrations.filter(x => x <= migrationHead);
    let functionsBefore;
    for (const file of migrations) {
      if (file === '0068_function_schema_resolution.sql') functionsBefore = (await pg.query(functionCatalogSql)).rows;
      if (file === '0068_function_schema_resolution.sql' && baseline === 'functions') continue;
      await pg.transaction(tx => tx.exec(readFileSync(new URL(file, migrationDir), 'utf8')));
    }
    for (const table of shadowTables) {
      await pg.exec(`CREATE TABLE public.${table} (LIKE ${gateway}.${table} INCLUDING DEFAULTS INCLUDING INDEXES);
        CREATE TEMP TABLE ${table} (LIKE ${gateway}.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`);
    }
    const queries = [], transactions = [];
    const options = { parsers: {}, serializers: {} };
    function adapter(engine) {
      return {
        options,
        unsafe(query, params = []) {
          // Adapt the narrow Postgres.js surface used by Drizzle to the real
          // in-memory SQL engine. No socket/protocol/pooling behavior is modeled.
          let pending;
          const execute = rowMode => pending ??= (async () => {
            queries.push({ query, params });
            return (await engine.query(query, params, { rowMode, parsers: options.parsers })).rows;
          })();
          return { then: (yes, no) => execute('object').then(yes, no), values: () => execute('array') };
        },
        async begin(callback) {
          const receipt = { state: 'started' }; transactions.push(receipt);
          try {
            const result = await pg.transaction(tx => callback(adapter(tx)));
            receipt.state = 'committed'; return result;
          } catch (error) { receipt.state = 'rolled_back'; throw error; }
        },
      };
    }
    const raw = adapter(pg), client = { driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) };
    const snapshot = async schema => {
      const digests = [];
      for (const table of shadowTables) {
        const rows = (await pg.query(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS digest FROM ${schema}.${table} t`)).rows;
        digests.push([table, rows[0].digest]);
      }
      return digests;
    };
    async function reset(searchPath) {
      // The harness owns this ephemeral in-memory database exclusively.
      await pg.exec(`TRUNCATE ${shadowTables.map(t => `${gateway}.${t}`).join(', ')} CASCADE;
        TRUNCATE ${shadowTables.flatMap(t => [`public.${t}`, `pg_temp.${t}`]).join(', ')};
        SET search_path TO pg_catalog, ${gateway}, pg_temp;
        INSERT INTO ${gateway}.users (id, email, budget_max, budget_spent) VALUES ('user', 'user@example.invalid', 10, 1), ('other', 'other@example.invalid', 10, 0);
        INSERT INTO ${gateway}.workspaces (id, scope_type, personal_owner_user_id, name, slug, status)
          VALUES ('workspace', 'personal', 'user', 'Workspace', 'workspace', 'active'), ('other-workspace', 'personal', 'other', 'Other', 'other', 'active');
        INSERT INTO ${gateway}.api_keys (id, key, user_id, workspace_id, status, limit_micros, limit_reset, include_byok_in_limit)
          VALUES ('key', '', 'user', 'workspace', 'active', 3000000, 'daily', TRUE);
        INSERT INTO ${gateway}.guardrails (id, owner_user_id, workspace_id, name, status) VALUES ('guardrail', 'user', 'workspace', 'Guardrail', 'active');
        INSERT INTO ${gateway}.guardrail_assignments (id, guardrail_id, workspace_id, scope_type, scope_id) VALUES ('assignment', 'guardrail', 'workspace', 'user', 'user');
        INSERT INTO ${gateway}.workspace_budgets (id, workspace_id, reset_interval, limit_micros) VALUES ('budget', 'workspace', 'daily', 2000000);
        INSERT INTO ${gateway}.user_earnings (user_id, balance_micros, balance) VALUES ('user', 5000000, 5);`);
      for (const table of shadowTables) await pg.exec(`INSERT INTO public.${table} SELECT * FROM ${gateway}.${table}; INSERT INTO pg_temp.${table} SELECT * FROM ${gateway}.${table}`);
      for (const schema of ['public', 'pg_temp']) await pg.exec(`
        UPDATE ${schema}.users SET budget_spent = 9;
        UPDATE ${schema}.api_keys SET workspace_id = 'other-workspace', limit_micros = 7;
        UPDATE ${schema}.workspaces SET slug = 'shadow';
        UPDATE ${schema}.workspace_budgets SET limit_micros = 7;
        UPDATE ${schema}.user_earnings SET balance = 99, balance_micros = 99000000;`);
      await pg.exec(`SET search_path TO ${searchPath}; DISCARD PLANS`);
      queries.length = 0; transactions.length = 0;
      return { public: await snapshot('public'), temp: await snapshot('pg_temp') };
    }
    return { pg, client, queries, transactions, reset, snapshot, migrations, functionsBefore };
  } catch (error) { await pg.close(); throw error; }
}

export function intent(scopeType = 'user') {
  const id = scopeType === 'workspace' ? 'workspace-budget:budget' : scopeType === 'api_key' ? 'gateway-key-limit:key' : 'assignment';
  return { workspaceId: 'workspace', assignmentId: id, guardrailId: scopeType === 'user' ? 'guardrail' : id,
    guardrailVersion: 1, scopeType, scopeId: scopeType === 'user' ? 'user' : scopeType === 'api_key' ? 'key' : 'workspace',
    period: 'daily', periodStart: now, periodEnd: end, limitMicros: scopeType === 'user' ? 1000000 : scopeType === 'api_key' ? 3000000 : 2000000 };
}
export function reserveParams(scopes = ['user'], requestId = 'request') {
  return { requestId, intents: scopes.map(intent), reservedMicros: 100000, nowIso: now, expiresAtIso: expires };
}
export function chargeParams(id = 'request', charged = 0.05) {
  return { requestLog: { id, userId: 'user', apiKeyId: 'key', workspaceId: 'workspace', modelId: 'fixture/model', upstreamProtocol: 'openai',
    inputTokens: 3, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 10,
    meteredCost: charged, standardCost: charged, chargedCost: charged, budgetAccountedAt: now, routeGroup: 'default', status: 'success' },
    userId: 'user', beforeSpent: 1, chargedCost: charged, shouldChargeBudget: true,
    audit: { apiKeyId: 'key', eventType: 'usage_charge', actorType: 'system', beforeSpent: 1, requestLogId: id } };
}

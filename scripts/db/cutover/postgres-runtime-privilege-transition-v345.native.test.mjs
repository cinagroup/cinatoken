// Review-only privilege inventory. Uses a fresh owned loopback PostgreSQL cluster.
// Revocations below are local probes, not a migration or an activation recipe.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const summarize = error => ({ code: error?.code ?? null,
  message: String(error?.stack ?? error).slice(0, 1500) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-privilege-v345-${label}` } });
}

async function privileges(sql) {
  const [row] = await sql.unsafe(`SELECT
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.shared_key_earnings', 'INSERT') AS earning_insert,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.shared_key_earnings', 'UPDATE') AS earning_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.user_earnings', 'INSERT') AS seller_account_insert,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.user_earnings', 'UPDATE') AS seller_account_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.users', 'UPDATE') AS buyer_account_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.user_budget_reservations', 'INSERT') AS reservation_insert,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.user_budget_reservations', 'UPDATE') AS reservation_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.request_usage_settlements', 'INSERT') AS recovery_fact_insert`);
  return row;
}

async function expectDenied(work) {
  await assert.rejects(work, error => error?.code === '42501');
}

test('PG73 runtime privilege transition requires writer separation and grant-rerun closure',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-runtime-privilege-v345-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; formal PG73 and current runtime grant',
      limitations: [
        'No C03.5 or C04 producer/consumer is installed by this fixture.',
        'The revokes are deliberately temporary on an owned database; they are not a production cutover.',
        'The dedicated seller consumer is proven by its separate v340/v343 native fixtures.',
        'No dedicated buyer critical-writer identity or Worker/Hyperdrive routing is supplied.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      clients.push(migrator, runtime);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(names.length, 73);
      assert.equal(names.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrations = sha256(corpus.join('\n'));
      report.sourceSha256.runtimeGrant = sha256(await readFile(
        new URL('./grant-postgres-runtime.ts', import.meta.url)));
      report.sourceSha256.fixture = sha256(await readFile(new URL(import.meta.url)));
      stage('formal-pg73-installed');

      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const before = await privileges(migrator);
      assert.deepEqual(before, { earning_insert: true, earning_update: false,
        seller_account_insert: true, seller_account_update: true,
        buyer_account_update: true, reservation_insert: true,
        reservation_update: true, recovery_fact_insert: false });
      stage('current-runtime-effective-acl', { privileges: before });

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('privilege-seller','seller-privilege@example.invalid'),
          ('privilege-buyer','buyer-privilege@example.invalid');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('privilege-workspace','personal','privilege-buyer','Default',
            'default',true,'personal:privilege-buyer');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('privilege-api-key','synthetic-privilege-api-key',
            'privilege-buyer','privilege-workspace');
        INSERT INTO ${schema}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('privilege-shared-key','privilege-seller','openai',
            'synthetic-upstream-key','synthetic-privilege-fingerprint','active');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('privilege-seller');
        INSERT INTO ${schema}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost) VALUES
          ('privilege-log-1','privilege-buyer','privilege-api-key',
            'privilege-workspace',1),
          ('privilege-log-2','privilege-buyer','privilege-api-key',
            'privilege-workspace',1);`).simple();
      await runtime.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,gross_amount,
          platform_fee,net_amount)
        VALUES ('privilege-earning-1','privilege-log-1','privilege-shared-key',
          'privilege-seller',1,0.1,0.9)`);
      const [credited] = await migrator.unsafe(`SELECT
        (SELECT balance_micros::text FROM ${schema}.user_earnings
          WHERE user_id='privilege-seller') AS balance_micros,
        (SELECT count(*)::int FROM ${schema}.portal_ledger_entries
          WHERE reference_type='shared_key_earning') AS ledger_count`);
      assert.deepEqual(credited, { balance_micros: '900000', ledger_count: 1 });
      stage('legacy-runtime-insert-invokes-seller-credit-trigger');

      await assert.rejects(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${schema}.user_earnings SET
          balance_micros=balance_micros+1000000,
          balance=balance+1 WHERE user_id='privilege-seller'`);
        const [row] = await tx.unsafe(`SELECT balance_micros::text AS balance_micros
          FROM ${schema}.user_earnings WHERE user_id='privilege-seller'`);
        assert.equal(row.balance_micros, '1900000');
        assert.equal((await tx.unsafe(`SELECT count(*)::int AS n
          FROM ${schema}.portal_ledger_entries`))[0].n, 1);
        throw new Error('rollback-direct-seller-account-update');
      }), /rollback-direct-seller-account-update/u);
      await assert.rejects(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${schema}.users
          SET budget_spent=budget_spent+1 WHERE id='privilege-buyer'`);
        const [row] = await tx.unsafe(`SELECT budget_spent::text AS spent
          FROM ${schema}.users WHERE id='privilege-buyer'`);
        assert.equal(row.spent, '1.000000');
        assert.equal((await tx.unsafe(`SELECT count(*)::int AS n
          FROM ${schema}.user_audit_logs`))[0].n, 0);
        throw new Error('rollback-direct-buyer-account-update');
      }), /rollback-direct-buyer-account-update/u);
      stage('runtime-can-update-seller-and-buyer-balances-without-settlement');

      await migrator.unsafe(`REVOKE INSERT ON ${schema}.shared_key_earnings
          FROM cinatoken_gateway_runtime;
        REVOKE INSERT, UPDATE ON ${schema}.user_earnings
          FROM cinatoken_gateway_runtime;
        REVOKE UPDATE ON ${schema}.users FROM cinatoken_gateway_runtime;
        REVOKE INSERT, UPDATE ON ${schema}.user_budget_reservations
          FROM cinatoken_gateway_runtime;`).simple();
      const closed = await privileges(migrator);
      assert.deepEqual(closed, { earning_insert: false, earning_update: false,
        seller_account_insert: false, seller_account_update: false,
        buyer_account_update: false, reservation_insert: false,
        reservation_update: false, recovery_fact_insert: false });
      await expectDenied(runtime.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,gross_amount,
          platform_fee,net_amount)
        VALUES ('privilege-earning-2','privilege-log-2','privilege-shared-key',
          'privilege-seller',1,0.1,0.9)`));
      await expectDenied(runtime.unsafe(`INSERT INTO ${schema}.user_earnings(user_id)
        VALUES ('privilege-buyer')`));
      await expectDenied(runtime.unsafe(`UPDATE ${schema}.users
        SET budget_spent=budget_spent+1 WHERE id='privilege-buyer'`));
      await expectDenied(runtime.unsafe(`INSERT INTO ${schema}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at)
        VALUES ('privilege-reservation','privilege-buyer','privilege-api-key',
          0,10000000,1000000,'reserved',now()+interval '1 day')`));
      await expectDenied(runtime.unsafe(`UPDATE ${schema}.user_budget_reservations
        SET state='released' WHERE request_id='privilege-reservation'`));
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${schema}.user_earnings WHERE user_id='privilege-seller'`))[0].n,
      '900000');
      stage('targeted-revokes-break-legacy-writers-and-protect-balances');

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const reopened = await privileges(migrator);
      assert.deepEqual(reopened, before);
      stage('current-grant-rerun-reopens-direct-writes', { privileges: reopened });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = summarize(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summarize(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`runtime-privilege-v345-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

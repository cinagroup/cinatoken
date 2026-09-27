// Review-only privilege probe on a fresh owned loopback PostgreSQL cluster.
// The grant proposal is intentionally not a formal migration or rollout plan.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { createPostgresSharedKeysRepository } from '../../../packages/core/src/db/postgres/portal-marketplace.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const policyUrl = new URL('../../../packages/core/migrations-proposals/postgres/buyer-critical-writer-privilege-split-v346.sql', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-buyer-split-v346-${label}` } });
}

async function expectDenied(work) {
  await assert.rejects(work, error => {
    assert.equal((error?.cause ?? error)?.code, '42501', String(error));
    return true;
  });
}

function charge(id, spent, mode) {
  const params = chargeParams(id, 0.01);
  params.requestLog = { ...params.requestLog, userId: 'buyer-split-user',
    apiKeyId: 'buyer-split-key', workspaceId: 'buyer-split-workspace' };
  params.userId = 'buyer-split-user';
  params.beforeSpent = spent;
  params.audit = { ...params.audit, apiKeyId: 'buyer-split-key',
    beforeSpent: spent, requestLogId: id };
  if (mode) params.userBudgetSettlement = { requestId: id, mode,
    reason: `buyer-split-${mode}` };
  return params;
}

test('PG73 critical writer uses a distinct buyer LOGIN after local financial revokes',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-buyer-critical-writer-split-v346-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; PG73 non-economic critical writer only',
      limitations: [
        'Review-only policy breaks existing management, admission and payout callers; no production role or grant changed.',
        'The v2 economic producer hardcodes SESSION_USER=cinatoken_gateway_runtime, so a distinct buyer LOGIN cannot yet produce economic events.',
        'C03 recovery has its separate NOLOGIN role and is not exercised by this buyer LOGIN fixture.',
        'The dedicated buyer LOGIN can directly update its granted buyer financial columns; its credential must remain a separate trust boundary.',
        'The current grant routine reopens ordinary runtime rights on rerun; a cutover must modify that routine atomically.',
        'Worker/Hyperdrive binding, default ACL, direct public schema and role membership rollout, D1/MySQL, and production capacity are unverified.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const buyerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${buyerPassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const buyer = client(cluster, 'cinatoken_gateway_buyer_settlement',
        buyerPassword, 'buyer');
      clients.push(migrator, runtime, buyer);
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
      report.sourceSha256.policy = sha256(await readFile(policyUrl));
      report.sourceSha256.criticalWriter = sha256(await readFile(
        new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)));
      report.sourceSha256.fixture = sha256(await readFile(new URL(import.meta.url)));
      stage('formal-pg73-installed');

      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await migrator.unsafe(`INSERT INTO ${schema}.users
        (id,email,budget_max,budget_spent) VALUES
        ('buyer-split-seller','seller-split@example.invalid',10,0);
        INSERT INTO ${schema}.shared_keys
        (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
        VALUES ('buyer-split-shared','buyer-split-seller','openai',
          'synthetic-shared-key','synthetic-shared-fingerprint','active')`).simple();
      const runtimeSharedKeys = createPostgresSharedKeysRepository({
        driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }),
      });
      assert.deepEqual(
        (await runtimeSharedKeys.listActiveSharedKeysByChannel('openai')).map(row => row.id),
        ['buyer-split-shared']);
      stage('legacy-shared-key-pool-visible-before-buyer-split');
      const policy = await readFile(policyUrl, 'utf8');
      await assert.rejects(migrator.begin(tx => tx.unsafe(policy).simple()),
        /activation or dependency differs/u);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.buyer_settlement_privilege_split = 'reviewed-v1'");
        await tx.unsafe(policy).simple();
      });
      stage('default-off-then-test-only-policy-installed');
      assert.deepEqual(await runtimeSharedKeys.listActiveSharedKeysByChannel('openai'), []);
      stage('buyer-split-revokes-legacy-payout-and-hides-shared-key-pool');

      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${schema}.users','budget_spent','UPDATE') AS runtime_spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${schema}.user_earnings','balance_micros','UPDATE') AS runtime_seller_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_earnings','INSERT') AS runtime_legacy_earning,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${schema}.users','budget_spent','UPDATE') AS buyer_spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${schema}.users','budget_max','UPDATE') AS buyer_limit_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${schema}.api_keys','workspace_id','UPDATE') AS buyer_key_identity_update`);
      assert.deepEqual(acl, { runtime_spend_update: false,
        runtime_seller_update: false, runtime_legacy_earning: false,
        buyer_spend_update: true, buyer_limit_update: false,
        buyer_key_identity_update: false });
      await expectDenied(runtime.unsafe('SET ROLE cinatoken_gateway_buyer_settlement'));
      await expectDenied(buyer.unsafe('SET ROLE cinatoken_gateway_runtime'));
      await expectDenied(runtime.unsafe(`UPDATE ${schema}.users SET budget_spent=budget_spent+1
        WHERE id='missing'`));
      await expectDenied(runtime.unsafe(`UPDATE ${schema}.user_earnings
        SET balance_micros=balance_micros+1 WHERE user_id='missing'`));
      await expectDenied(runtime.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,gross_amount,
          platform_fee,net_amount) VALUES ('x','x','x','x',1,0,1)`));
      stage('ordinary-runtime-financial-writes-and-set-role-denied', { acl });

      await migrator.unsafe(`INSERT INTO ${schema}.users
        (id,email,budget_max,budget_spent) VALUES
          ('buyer-split-user','buyer-split@example.invalid',10,1);
        INSERT INTO ${schema}.user_earnings(user_id)
          VALUES ('buyer-split-seller');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('buyer-split-workspace','personal','buyer-split-user',
            'Split Fixture','buyer-split','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('buyer-split-key','synthetic-buyer-split-key',
            'buyer-split-user','buyer-split-workspace');`).simple();
      const db = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      const snapshot = async id => (await migrator.unsafe(`SELECT
        (SELECT budget_spent::text FROM ${schema}.users
          WHERE id='buyer-split-user') AS spent,
        (SELECT budget_reserved_micros::text FROM ${schema}.users
          WHERE id='buyer-split-user') AS held,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT budget_charged_micros::text FROM ${schema}.api_key_request_logs
          WHERE id=$1) AS guardrail_micros,
        (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE request_log_id=$1) AS audits,
        (SELECT state FROM ${schema}.user_budget_reservations WHERE request_id=$1)
          AS reservation_state,
        (SELECT settled_micros::text FROM ${schema}.user_budget_reservations
          WHERE request_id=$1) AS reservation_settled`, [id]))[0];
      const ordinaryId = `buyer-split-${randomUUID()}`;
      const ordinary = charge(ordinaryId, 1);
      await insertRequestUsageAndChargeTxPg(db, ordinary);
      const ordinaryCommitted = await snapshot(ordinaryId);
      assert.deepEqual(ordinaryCommitted, { spent: '1.010000', held: '0',
        logs: 1, guardrail_micros: '10000', audits: 1,
        reservation_state: null, reservation_settled: null });
      stage('real-unreserved-critical-writer-commits-under-buyer-login',
        { state: ordinaryCommitted });

      const reservedId = `buyer-split-${randomUUID()}`;
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${schema}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='buyer-split-user'`);
        await tx.unsafe(`INSERT INTO ${schema}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'buyer-split-user','buyer-split-key',0,10000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [reservedId]);
      });
      const reserved = charge(reservedId, 1.01, 'actual');
      await insertRequestUsageAndChargeTxPg(db, reserved);
      const reservedCommitted = await snapshot(reservedId);
      assert.deepEqual(reservedCommitted, { spent: '1.020000', held: '0',
        logs: 1, guardrail_micros: '10000', audits: 1,
        reservation_state: 'settled',
        reservation_settled: '10000' });
      await insertRequestUsageAndChargeTxPg(db, reserved);
      assert.deepEqual(await snapshot(reservedId), reservedCommitted);
      stage('real-reserved-critical-writer-and-replay-under-buyer-login',
        { state: reservedCommitted });

      const ceilingId = `buyer-split-${randomUUID()}`;
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${schema}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='buyer-split-user'`);
        await tx.unsafe(`INSERT INTO ${schema}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'buyer-split-user','buyer-split-key',0,10000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [ceilingId]);
      });
      const ceiling = charge(ceilingId, 1.02, 'reserved');
      await insertRequestUsageAndChargeTxPg(db, ceiling);
      assert.deepEqual(await snapshot(ceilingId), { spent: '1.040000', held: '0',
        logs: 1, guardrail_micros: '10000', audits: 1,
        reservation_state: 'expired',
        reservation_settled: '20000' });
      stage('real-reserved-ceiling-critical-writer-under-buyer-login');

      await expectDenied(buyer.unsafe(`UPDATE ${schema}.users SET budget_max=0
        WHERE id='buyer-split-user'`));
      await expectDenied(buyer.unsafe(`UPDATE ${schema}.api_keys
        SET workspace_id='other' WHERE id='buyer-split-key'`));
      await expectDenied(buyer.unsafe(`UPDATE ${schema}.user_earnings
        SET balance_micros=balance_micros+1
        WHERE user_id='buyer-split-seller'`));
      await expectDenied(buyer.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,gross_amount,
          platform_fee,net_amount) VALUES ('x','x','x','x',1,0,1)`));
      stage('buyer-login-cannot-change-policy-key-identity-or-seller-account');

      const v2Producer = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/shared-key-economic-producer-v2.sql',
        import.meta.url), 'utf8');
      report.sourceSha256.v2Producer = sha256(v2Producer);
      assert.match(v2Producer, /SESSION_USER <> 'cinatoken_gateway_runtime'/u);
      assert.match(v2Producer, /TO cinatoken_gateway_runtime/u);
      assert.equal((await buyer.unsafe('SELECT session_user AS identity'))[0].identity,
        'cinatoken_gateway_buyer_settlement');
      stage('v2-producer-source-session-user-gate-is-incompatible-with-new-login');

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const [reopened] = await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${schema}.users','budget_spent','UPDATE') AS spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${schema}.user_earnings','balance_micros','UPDATE') AS seller_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_earnings','INSERT') AS legacy_earning_insert`);
      assert.deepEqual(reopened, { spend_update: true, seller_update: true,
        legacy_earning_insert: true });
      assert.deepEqual(
        (await runtimeSharedKeys.listActiveSharedKeysByChannel('openai')).map(row => row.id),
        ['buyer-split-shared']);
      stage('current-grant-rerun-reopens-ordinary-runtime-financial-writes');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { code: error?.code ?? error?.cause?.code ?? null,
        message: String(error?.stack ?? error).slice(0, 2500) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try {
        await cluster.cleanup();
        report.cleanup = 'PASS';
      } catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = String(error?.stack ?? error).slice(0, 2500);
        if (!failure) failure = error;
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      assert.equal(report.status, 'PASS', `native report: ${reportPath}\n${report.error?.message ?? ''}`);
      assert.equal(report.cleanup, 'PASS', `native report: ${reportPath}`);
      console.log(`native report: ${reportPath}`);
      if (failure) throw failure;
    }
  });

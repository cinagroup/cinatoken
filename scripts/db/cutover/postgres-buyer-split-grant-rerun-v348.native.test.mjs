// Review-only proof: the legacy grant cannot reopen financial writes once the
// v346/v347 split and durable v348 marker commit in one locked transaction.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { createPostgresSharedKeysRepository } from '../../../packages/core/src/db/postgres/portal-marketplace.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';

const gateway = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const prerequisites = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation', 'reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation', 'reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation', 'reviewed-v1'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation', 'reviewed-v1'],
];
const splitNames = [
  'buyer-critical-writer-privilege-split-v346.sql',
  'shared-key-economic-producer-buyer-login-v347.sql',
  'buyer-split-grant-marker-v348.sql',
];
const reconcileName = 'buyer-split-runtime-grant-v348.sql';
const hash = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-grant-v348-${label}` } });
}

function charge(id, spent) {
  const params = chargeParams(id, 0.01);
  params.requestLog = { ...params.requestLog, userId: 'grant-v348-buyer',
    apiKeyId: 'grant-v348-key', workspaceId: 'grant-v348-workspace' };
  params.userId = 'grant-v348-buyer';
  params.beforeSpent = spent;
  params.audit = { ...params.audit, apiKeyId: 'grant-v348-key',
    beforeSpent: spent, requestLogId: id };
  return params;
}

async function expectCode(work, code) {
  await assert.rejects(work, error => {
    assert.equal((error?.cause ?? error)?.code, code, String(error));
    return true;
  });
}

test('split marker makes old grants fail closed and v348 reconciler reruns safely',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-buyer-split-grant-v348-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6, formal PG73 and review-only C04 proposal chain',
      limitations: [
        'Review-only grant switch; no production role, credential, migration, Worker binding, Queue, or deployment changed.',
        'The old grant runner guard must ship before any split; v346/v347 and the marker must then commit in one locked transaction.',
        'The split reconciler grants no new ordinary-runtime table writes; management, admission, payout and recovery writers still need separate identities and grants.',
        'The buyer LOGIN remains a trusted direct financial writer; secret isolation and application routing are unverified.',
        'Rollback to the old broad grant is not an automatic safe downgrade; old writer and economic v1 callers need a migration gate.',
        'D1/MySQL, production capacity, multiple hosts, Linux CI, and live cutover lock timing are unverified.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const buyerPassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${buyerPassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement,
          cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const buyer = client(cluster, 'cinatoken_gateway_buyer_settlement',
        buyerPassword, 'buyer');
      clients.push(migrator, runtime, buyer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = await listPg73Migrations();
      assert.equal(names.length, 73);
      assert.equal(names.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version)
            VALUES($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrations = hash(corpus.join('\n'));
      for (const name of [...prerequisites.map(([name]) => name),
        ...splitNames, reconcileName]) {
        report.sourceSha256[name] = hash(await readFile(new URL(name, proposals)));
      }
      report.sourceSha256.runtimeGrant = hash(await readFile(
        new URL('./grant-postgres-runtime.ts', import.meta.url)));
      report.sourceSha256.splitGrantRunner = hash(await readFile(
        new URL('./grant-postgres-buyer-split-v348.ts', import.meta.url)));
      report.sourceSha256.splitActivationRunner = hash(await readFile(
        new URL('./activate-postgres-buyer-split-v348.ts', import.meta.url)));
      report.sourceSha256.criticalWriter = hash(await readFile(new URL(
        '../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)));
      report.sourceSha256.fixture = hash(await readFile(new URL(import.meta.url)));
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.has_column_privilege(
        'cinatoken_gateway_runtime','${gateway}.users','budget_spent','UPDATE')
        AS allowed`))[0].allowed, true);
      stage('legacy-grant-rerun-remains-functional-before-marker');

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent) VALUES
          ('grant-v348-buyer','grant-v348@example.invalid',10,1),
          ('grant-v348-seller','grant-v348-seller@example.invalid',10,0);
        INSERT INTO ${gateway}.user_earnings(user_id)
          VALUES ('grant-v348-seller');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('grant-v348-workspace','personal','grant-v348-buyer',
            'Grant Fixture','grant-v348','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('grant-v348-key','synthetic-grant-v348-key',
            'grant-v348-buyer','grant-v348-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('grant-v348-shared','grant-v348-seller','openai',
            'synthetic-shared-key','synthetic-shared-fingerprint','active');`).simple();
      const runtimeDb = { driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }) };
      const runtimeSharedKeys = createPostgresSharedKeysRepository(runtimeDb);
      const sharedPoolIds = async () =>
        (await runtimeSharedKeys.listActiveSharedKeysByChannel('openai')).map(row => row.id);
      assert.deepEqual(await sharedPoolIds(), ['grant-v348-shared']);
      const buyerDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      const legacyId = `grant-v348-legacy-${randomUUID()}`;
      await insertRequestUsageAndChargeTxPg(runtimeDb, charge(legacyId, 1));
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent
        FROM ${gateway}.users WHERE id='grant-v348-buyer'`))[0].spent,
      '1.010000');
      stage('old-runtime-critical-writer-works-in-legacy-mode');

      for (const [name, activation, value] of prerequisites) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${activation} = '${value}'`);
          await tx.unsafe(await readFile(new URL(name, proposals), 'utf8')).simple();
        });
      }
      stage('economic-prerequisites-installed-before-cutover');

      const splitSql = await readFile(new URL(splitNames[0], proposals), 'utf8');
      const markerSql = await readFile(new URL(splitNames[2], proposals), 'utf8');
      const reconcileSql = await readFile(new URL(reconcileName, proposals), 'utf8');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.buyer_settlement_privilege_split = 'reviewed-v1'");
        await tx.unsafe(splitSql).simple();
        await tx.unsafe(markerSql).simple();
      }), /marker activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        '${gateway}.buyer_split_grant_policy_v348()') IS NULL AS absent`))[0].absent,
      true);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.has_column_privilege(
        'cinatoken_gateway_runtime','${gateway}.users','budget_spent','UPDATE')
        AS allowed`))[0].allowed, true);
      stage('partial-cutover-rolls-back-revokes-and-marker');

      await activatePostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      const acl = async () => (await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${gateway}.user_earnings','UPDATE') AS runtime_seller,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${gateway}.shared_key_earnings','INSERT') AS runtime_legacy_earning,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${gateway}.users','budget_spent','UPDATE') AS buyer_spend,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS runtime_v2,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS buyer_v2`))[0];
      const closed = { runtime_spend: false, runtime_seller: false,
        runtime_legacy_earning: false, buyer_spend: true,
        runtime_v2: false, buyer_v2: true };
      assert.deepEqual(await acl(), closed);
      assert.deepEqual(await sharedPoolIds(), []);
      stage('v346-v347-and-marker-commit-atomically-under-shared-lock',
        { acl: closed });

      await assert.rejects(grantPostgresRuntime({ DATABASE_URL: migratorUrl }),
        /Buyer settlement split is active/u);
      assert.deepEqual(await acl(), closed);
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_spent=budget_spent+1 WHERE id='grant-v348-buyer'`), '42501');
      stage('real-legacy-grant-rerun-rejects-before-broad-authorization-and-preserves-acl');

      await grantPostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      await grantPostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      assert.deepEqual(await acl(), closed);
      assert.deepEqual(await sharedPoolIds(), []);
      stage('new-split-grant-runner-is-idempotent-and-keeps-runtime-closed');

      const deniedId = `grant-v348-denied-${randomUUID()}`;
      await expectCode(insertRequestUsageAndChargeTxPg(runtimeDb,
        charge(deniedId, 1.01)), '42501');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.api_key_request_logs WHERE id=$1`, [deniedId]))[0].n, 0);
      const buyerId = `grant-v348-buyer-${randomUUID()}`;
      await insertRequestUsageAndChargeTxPg(buyerDb, charge(buyerId, 1.01));
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent
        FROM ${gateway}.users WHERE id='grant-v348-buyer'`))[0].spent,
      '1.020000');
      stage('old-runtime-writer-rolls-back-and-buyer-writer-commits-after-rerun');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT UPDATE ON TABLE ${gateway}.users
          TO cinatoken_gateway_runtime`);
        await tx.unsafe(reconcileSql).simple();
      }), /Buyer split grant drift or dependency differs/u);
      assert.deepEqual(await acl(), closed);
      stage('runtime-financial-write-drift-rejected-without-committed-grant');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT UPDATE (budget_max) ON TABLE ${gateway}.users
          TO cinatoken_gateway_buyer_settlement`);
        await tx.unsafe(reconcileSql).simple();
      }), /Buyer split grant drift or dependency differs/u);
      assert.deepEqual(await acl(), closed);
      stage('buyer-policy-column-drift-rejected-without-committed-grant');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT UPDATE (balance_micros)
          ON TABLE ${gateway}.user_earnings
          TO cinatoken_gateway_runtime`);
        await tx.unsafe(reconcileSql).simple();
      }), /Buyer split grant drift or dependency differs/u);
      assert.deepEqual(await acl(), closed);
      stage('runtime-column-only-seller-write-drift-rejected');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT EXECUTE ON FUNCTION
          cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            text,text,text,bigint,jsonb,text)
          TO cinatoken_gateway_shared_quote_attempt_producer`);
        await tx.unsafe(reconcileSql).simple();
      }), /Buyer split grant drift or dependency differs/u);
      assert.deepEqual(await acl(), closed);
      stage('third-party-private-producer-execute-drift-rejected');

      await migrator.unsafe(`REVOKE UPDATE (budget_spent) ON TABLE ${gateway}.users
        FROM cinatoken_gateway_buyer_settlement`);
      assert.equal((await acl()).buyer_spend, false);
      await grantPostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      assert.deepEqual(await acl(), closed);
      stage('missing-reviewed-buyer-column-grant-repaired-on-rerun');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION ${gateway}.buyer_split_grant_policy_v348()
          RETURNS text LANGUAGE sql IMMUTABLE
          SET search_path TO pg_catalog, pg_temp
          AS $marker$SELECT 'tampered'::text$marker$`);
        await tx.unsafe(reconcileSql).simple();
      }), /Buyer split grant drift or dependency differs/u);
      assert.deepEqual(await acl(), closed);
      stage('marker-source-drift-rejected-and-transaction-rolled-back');

      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        message: String(error?.stack ?? error).slice(0, 4000) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = String(error?.stack ?? error).slice(0, 1500);
        failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`buyer-split-grant-v348-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

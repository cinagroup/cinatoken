// Owned PG18 proof for a direct admission LOGIN with no raw financial writes.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createPostgresRepositories } from '../../../packages/core/src/storage/repositories-postgres.ts';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { openPostgresOrdinaryBudgetAdmissionOwner } from '../../../packages/proxy/src/services/postgres-ordinary-budget-admission.ts';

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
const admissionName = 'budget-admission-login-v350.sql';
const hash = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `admission-v350-${label}` } });
}

async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause?.code, code, String(error));
    if (constraint) assert.equal(cause?.constraint_name, constraint);
    return true;
  });
}

test('dedicated admission LOGIN has only checked ordinary-budget function capability',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-budget-admission-v350-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; formal PG73 plus review-only buyer split and admission API',
      limitations: [
        'No production role, credential, Worker binding, migration, or deployment changed.',
        'The existing Postgres repository still issues raw table writes; only the explicit request-local v351 adapter uses this function-only LOGIN. No route or Worker creates it by default.',
        'Guardrail window and multi-intent reservations, dispatched forfeiture, lease recovery, and the v348 Guardrail-denial receipt are not covered by these three ordinary-budget functions.',
        'The LOGIN can call the ordinary functions for any authenticated user/key pair; an application identity binding is still needed.',
        'The existing buyer settlement LOGIN remains a trusted direct financial writer; this test verifies its ACL but does not close all C04 buyer authority.',
        'D1/MySQL and Linux CI are not exercised here.',
      ] };
    const stage = (name, detail = {}) =>
      report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const buyerPassword = randomBytes(24).toString('hex');
      const admissionPassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${buyerPassword}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT PASSWORD '${admissionPassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO
          cinatoken_gateway_migrator,cinatoken_gateway_runtime,
          cinatoken_gateway_buyer_settlement,cinatoken_gateway_budget_admission,
          cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const buyer = client(cluster, 'cinatoken_gateway_buyer_settlement',
        buyerPassword, 'buyer');
      const admission = client(cluster, 'cinatoken_gateway_budget_admission',
        admissionPassword, 'admission');
      const admissionPeer = client(cluster, 'cinatoken_gateway_budget_admission',
        admissionPassword, 'admission-peer');
      clients.push(migrator, runtime, buyer, admission, admissionPeer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations))
        .filter(name => name.endsWith('.sql')).sort();
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
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      report.sourceSha256.runtimeGrant = hash(await readFile(new URL(
        './grant-postgres-runtime.ts', import.meta.url)));
      report.sourceSha256.buyerActivation = hash(await readFile(new URL(
        './activate-postgres-buyer-split-v348.ts', import.meta.url)));
      report.sourceSha256.ordinaryRepository = hash(await readFile(new URL(
        '../../../packages/core/src/db/postgres/user-budget-reservations.impl.ts',
        import.meta.url)));
      report.sourceSha256.ordinaryAdmissionAdapter = hash(await readFile(new URL(
        '../../../packages/proxy/src/services/postgres-ordinary-budget-admission.ts',
        import.meta.url)));
      report.sourceSha256.fixture = hash(await readFile(new URL(import.meta.url)));
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      for (const [name, setting, value] of prerequisites) {
        const body = await readFile(new URL(name, proposals), 'utf8');
        report.sourceSha256[name] = hash(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting} = '${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      await activatePostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      stage('pg73-economic-prerequisites-and-atomic-buyer-split-installed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent)
          VALUES('admission-v350-buyer','admission-v350@example.invalid',1,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('admission-v350-workspace','personal','admission-v350-buyer',
            'Admission Fixture','admission-v350','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES('admission-v350-key','synthetic-admission-key',
            'admission-v350-buyer','admission-v350-workspace');`).simple();
      const admissionSql = await readFile(new URL(admissionName, proposals), 'utf8');
      report.sourceSha256[admissionName] = hash(admissionSql);
      await assert.rejects(migrator.begin(tx => tx.unsafe(admissionSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT UPDATE (budget_reserved_micros)
          ON ${gateway}.users TO cinatoken_gateway_budget_admission`);
        await tx.unsafe(
          "SET LOCAL cinatoken.budget_admission_login_activation = 'reviewed-v1'");
        await tx.unsafe(admissionSql).simple();
      }), /activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        '${gateway}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)')
        IS NULL AS absent`))[0].absent, true);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.budget_admission_login_activation = 'reviewed-v1'");
        await tx.unsafe(admissionSql).simple();
      });
      stage('admission-api-default-off-and-explicit-install-atomic');

      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.users','budget_reserved_micros','UPDATE') AS admission_counter_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.user_budget_reservations','INSERT') AS admission_row_insert,
        pg_catalog.has_table_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.guardrail_budget_windows','UPDATE') AS admission_window_update,
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
          'EXECUTE') AS admission_reserve,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${gateway}.users','budget_spent','UPDATE') AS buyer_spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend_update`);
      assert.deepEqual(acl, { admission_counter_update: false,
        admission_row_insert: false, admission_window_update: false,
        admission_reserve: true, buyer_spend_update: true,
        runtime_spend_update: false });
      await expectCode(admission.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=0 WHERE id='admission-v350-buyer'`), '42501');
      await expectCode(admission.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at,created_at,updated_at)
        VALUES('forged','admission-v350-buyer','admission-v350-key',0,
          1000000,1,'reserved',now()+interval '1 minute',now(),now())`), '42501');
      await expectCode(admission.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=0`), '42501');
      await expectCode(runtime.unsafe(`SELECT ${gateway}.reserve_user_budget_v350(
        'forged','admission-v350-buyer','admission-v350-key',0,1,now(),
        now()+interval '2 minutes')`), '42501');
      await expectCode(buyer.unsafe(`SELECT ${gateway}.reserve_user_budget_v350(
        'forged','admission-v350-buyer','admission-v350-key',0,1,now(),
        now()+interval '2 minutes')`), '42501');
      await expectCode(admission.unsafe('SET ROLE cinatoken_gateway_buyer_settlement'), '42501');
      await expectCode(runtime.unsafe('SET ROLE cinatoken_gateway_budget_admission'), '42501');
      await expectCode(admission.unsafe(`UPDATE ${gateway}.user_earnings
        SET balance_micros=balance_micros+1`), '42501');
      stage('admission-cannot-forge-counters-rows-or-Guardrail-windows-and-other-logins-cannot-call-api',
        { acl });

      const oldRepositories = createPostgresRepositories({
        driver: 'postgres', raw: admission,
        drizzle: drizzle(admission, { schema: pgCoreSchema }),
      });
      const directNow = new Date();
      const rawReserve = oldRepositories.userBudgets.reserve({
        requestId: `legacy-reserve-${randomUUID()}`,
        userId: 'admission-v350-buyer', apiKeyId: 'admission-v350-key',
        expectedBudgetEpoch: 0, reservedMicros: 1,
        nowIso: directNow.toISOString(),
        expiresAtIso: new Date(directNow.getTime() + 120_000).toISOString(),
      });
      await expectCode(rawReserve, '42501');
      await expectCode(oldRepositories.guardrailBudgets.reserveMany({
        requestId: `legacy-guardrail-${randomUUID()}`,
        intents: [{ workspaceId: 'admission-v350-workspace',
          assignmentId: 'gateway-key-limit:admission-v350-key',
          guardrailId: 'gateway-key-limit:admission-v350-key',
          guardrailVersion: 1, scopeType: 'api_key',
          scopeId: 'admission-v350-key', period: 'daily',
          periodStart: new Date(Date.UTC(2026, 8, 25)).toISOString(),
          periodEnd: new Date(Date.UTC(2026, 8, 26)).toISOString(),
          limitMicros: 1_000_000 }],
        reservedMicros: 1, nowIso: directNow.toISOString(),
        expiresAtIso: new Date(directNow.getTime() + 120_000).toISOString(),
      }), '42501');
      stage('current-raw-SQL-ordinary-and-Guardrail-repositories-cannot-run-under-function-only-login');

      const now = () => new Date();
      const reserve = (sql, id, micros, overrides = {}) => {
        const current = now();
        const expires = new Date(current.getTime() + 120_000);
        return sql.unsafe(`SELECT ${gateway}.reserve_user_budget_v350(
          $1,$2,$3,$4::bigint,$5::bigint,$6::timestamptz,
          $7::timestamptz) AS value`, [
          id, overrides.userId ?? 'admission-v350-buyer',
          overrides.apiKeyId ?? 'admission-v350-key',
          overrides.epoch ?? 0, micros,
          current.toISOString(), expires.toISOString(),
        ]);
      };
      const activeId = `admission-v350-${randomUUID()}`;
      assert.deepEqual((await reserve(admission, activeId, 600_000))[0].value,
        { status: 'reserved', limitMicros: 1_000_000 });
      assert.equal((await migrator.unsafe(`SELECT hold_verified AS verified
        FROM cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
        WHERE request_id=$1`, [activeId]))[0].verified, true);
      assert.deepEqual((await reserve(admission, activeId, 600_000))[0].value,
        { status: 'idempotent', limitMicros: 1_000_000 });
      assert.deepEqual((await reserve(admission, `blocked-${randomUUID()}`, 500_000))[0].value,
        { status: 'blocked', remainingMicros: 400_000 });
      assert.deepEqual((await reserve(admission, `wrong-key-${randomUUID()}`, 1,
        { apiKeyId: 'missing' }))[0].value, { status: 'conflict' });
      assert.deepEqual((await reserve(admission, `stale-${randomUUID()}`, 1,
        { epoch: 1 }))[0].value, { status: 'stale' });
      stage('ordinary-reserve-has-v344-private-hold-receipt-and-replay-capacity-ownership-epoch-checks');

      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros+1
        WHERE id='admission-v350-buyer'`);
      await expectCode(reserve(admission, `counter-drift-${randomUUID()}`, 1),
        '23514', 'budget_admission_counter_v350');
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros-1
        WHERE id='admission-v350-buyer'`);
      stage('existing-ledger-counter-drift-fails-closed-before-new-admission');

      const dispatchAt = now();
      const dispatchExpiry = new Date(dispatchAt.getTime() + 15 * 60_000);
      assert.equal((await admission.unsafe(`SELECT
        ${gateway}.mark_user_budget_dispatched_v350(
          $1,$2::timestamptz,$3::timestamptz) AS ok`,
      [activeId, dispatchAt.toISOString(), dispatchExpiry.toISOString()]))[0].ok, true);
      assert.equal((await admission.unsafe(`SELECT
        ${gateway}.release_user_budget_v350($1,now(),'pre_dispatch_cancel') AS n`,
      [activeId]))[0].n, 0);
      const releasedId = `release-v350-${randomUUID()}`;
      assert.equal((await reserve(admission, releasedId, 100_000))[0].value.status,
        'reserved');
      await expectCode(admission.unsafe(`SELECT
        ${gateway}.release_user_budget_v350(
          $1,now(),'guardrail_budget_admission_rejected')`,
      [releasedId]), '23514', 'budget_admission_call_v350');
      assert.equal((await admission.unsafe(`SELECT
        ${gateway}.release_user_budget_v350($1,now(),'client_cancel') AS n`,
      [releasedId]))[0].n, 1);
      assert.equal((await admission.unsafe(`SELECT
        ${gateway}.release_user_budget_v350($1,now(),'client_cancel') AS n`,
      [releasedId]))[0].n, 1);
      assert.deepEqual((await migrator.unsafe(`SELECT
        u.budget_reserved_micros::text AS reserved,r.state
        FROM ${gateway}.users u JOIN ${gateway}.user_budget_reservations r
          ON r.user_id=u.id WHERE r.request_id=$1`, [activeId]))[0],
      { reserved: '600000', state: 'dispatched' });
      stage('mark-and-release-only-reviewed-transitions-and-denial-reason-is-reserved-for-buyer-proof');

      const firstId = `race-first-${randomUUID()}`;
      const secondId = `race-second-${randomUUID()}`;
      const [first, second] = await Promise.all([
        reserve(admission, firstId, 300_000),
        reserve(admissionPeer, secondId, 300_000),
      ]);
      assert.deepEqual([first[0].value.status, second[0].value.status].sort(),
        ['blocked', 'reserved']);
      assert.equal((await migrator.unsafe(`SELECT budget_reserved_micros::text
        AS held FROM ${gateway}.users
        WHERE id='admission-v350-buyer'`))[0].held, '900000');
      stage('concurrent-reserve-serializes-at-user-row-and-does-not-overbook');

      const runtimeUrl = `postgres://cinatoken_gateway_runtime:${runtimePassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      const admissionUrl = `postgres://cinatoken_gateway_budget_admission:${admissionPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
        runtimeClient: { driver: 'postgres', raw: runtime,
          drizzle: drizzle(runtime, { schema: pgCoreSchema }) },
        runtimeConnectionString: runtimeUrl,
        admissionConnectionString: admissionUrl,
      });
      try {
        const firstAt = now();
        const firstId = `adapter-release-${randomUUID()}`;
        const released = await owner.ordinaryBudgetRepositories.userBudgets.reserve({
          requestId: firstId, userId: 'admission-v350-buyer',
          apiKeyId: 'admission-v350-key', expectedBudgetEpoch: 0,
          reservedMicros: 50_000, nowIso: firstAt.toISOString(),
          expiresAtIso: new Date(firstAt.getTime() + 120_000).toISOString(),
        });
        assert.equal(released.status, 'reserved');
        assert.equal(await owner.ordinaryBudgetRepositories.userBudgets.release(
          firstId, now().toISOString(), 'client_cancel'), 1);
        const secondAt = now();
        const secondId = `adapter-mark-${randomUUID()}`;
        const marked = await owner.ordinaryBudgetRepositories.userBudgets.reserve({
          requestId: secondId, userId: 'admission-v350-buyer',
          apiKeyId: 'admission-v350-key', expectedBudgetEpoch: 0,
          reservedMicros: 50_000, nowIso: secondAt.toISOString(),
          expiresAtIso: new Date(secondAt.getTime() + 120_000).toISOString(),
        });
        assert.equal(marked.status, 'reserved');
        const dispatchAt = now();
        assert.equal(await owner.ordinaryBudgetRepositories.userBudgets.markDispatched(
          secondId, dispatchAt.toISOString(),
          new Date(dispatchAt.getTime() + 15 * 60_000).toISOString()), true);
        await assert.rejects(owner.ordinaryBudgetRepositories.userBudgets.forfeitDispatched(
          secondId, now().toISOString(), 'unknown_after_send'),
        /cannot forfeit a dispatched ordinary budget lease/u);
        assert.deepEqual((await migrator.unsafe(`SELECT
          (SELECT state FROM ${gateway}.user_budget_reservations WHERE request_id=$1)
            AS released_state,
          (SELECT state FROM ${gateway}.user_budget_reservations WHERE request_id=$2)
            AS dispatched_state,
          (SELECT budget_reserved_micros::text FROM ${gateway}.users
            WHERE id='admission-v350-buyer') AS held`, [firstId, secondId]))[0],
        { released_state: 'released', dispatched_state: 'dispatched', held: '950000' });
      } finally {
        await owner.close();
      }
      stage('request-local-v351-adapter-composes-with-real-function-only-login-and-commit');

      await migrator.unsafe(`INSERT INTO ${gateway}.guardrail_budget_windows
        (workspace_id,scope_type,scope_id,period,period_start,period_end,
          unreserved_micros,settled_micros,reserved_micros,seeded_at,updated_at)
        VALUES('admission-v350-workspace','user','admission-v350-buyer',
          'daily','2026-09-25T00:00:00Z','2026-09-26T00:00:00Z',
          0,0,0,now(),now())`);
      await migrator.unsafe(`GRANT SELECT
        (workspace_id,scope_type,scope_id,period,period_start),
        UPDATE (reserved_micros) ON
        ${gateway}.guardrail_budget_windows
        TO cinatoken_gateway_budget_admission`);
      await admission.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=500000
        WHERE workspace_id='admission-v350-workspace'
          AND scope_type='user' AND scope_id='admission-v350-buyer'
          AND period='daily' AND period_start='2026-09-25T00:00:00Z'`);
      assert.equal((await migrator.unsafe(`SELECT reserved_micros::text AS held
        FROM ${gateway}.guardrail_budget_windows
        WHERE workspace_id='admission-v350-workspace'
          AND scope_type='user' AND scope_id='admission-v350-buyer'
          AND period='daily' AND period_start='2026-09-25T00:00:00Z'`))[0].held,
      '500000');
      await migrator.unsafe(`REVOKE SELECT
        (workspace_id,scope_type,scope_id,period,period_start),
        UPDATE (reserved_micros) ON
        ${gateway}.guardrail_budget_windows
        FROM cinatoken_gateway_budget_admission`);
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=0
        WHERE workspace_id='admission-v350-workspace'
          AND scope_type='user' AND scope_id='admission-v350-buyer'
          AND period='daily' AND period_start='2026-09-25T00:00:00Z'`);
      stage('temporary-raw-Guardrail-window-grant-allows-unmatched-counter-forgery-and-is-revoked');

      await assert.rejects(grantPostgresRuntime({ DATABASE_URL: migratorUrl }),
        /Buyer settlement split is active/u);
      const [after] = await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.users','budget_reserved_micros','UPDATE') AS admission_counter_update`);
      assert.deepEqual(after, { runtime_spend_update: false,
        admission_counter_update: false });
      stage('legacy-grant-rerun-fails-closed-with-admission-and-runtime-finance-acl-unchanged');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 4000) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = String(error?.stack ?? error).slice(0, 1500);
        failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`budget-admission-v350-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

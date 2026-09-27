// Owned PostgreSQL 18.6 proof for v372's opt-in application writer.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const oldSqlUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-held-writer-v368.sql', import.meta.url);
const proposalUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-window-accountant-v371.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-legacy-buyer-windowed-app-v372-report.json', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const dayStart = new Date(Date.now());
dayStart.setUTCHours(0, 0, 0, 0);
const periodStart = dayStart.toISOString();
const periodEnd = new Date(dayStart.getTime() + 86_400_000).toISOString();
const accountedAt = new Date(dayStart.getTime() + 12 * 3_600_000).toISOString();
const expiresAt = new Date(Date.now() + 60_000).toISOString();

function connection(cluster, name, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: name, password, ssl: false, max: 1, prepare: false,
    fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: false, onnotice() {},
    connection: { application_name: `v371-${label}`, search_path: `${g},public` } });
}
async function rejected(work, code, constraint) {
  await assert.rejects(work, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause.code, code, String(error));
    if (constraint) assert.equal(cause.constraint_name, constraint);
    return true;
  });
}
async function waitForBlock(admin, blockedPid, blockerPid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin.unsafe(`SELECT pg_catalog.pg_blocking_pids($1) AS blockers`,
      [blockedPid]);
    if (row.blockers.includes(blockerPid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected backend ${blockedPid} to wait for ${blockerPid}`);
}

test('v372 opt-in application writer composes v371 and v2 economic event',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only local PG73 plus proposals; no formal migration, remote SQL, Worker, Provider or production credential changed.',
        'The fixture installs the exact v368 body, v371/v372 successors, real v2 economic producer and receipt, v347/v348/v349 buyer-login split, and v350 ordinary admission; it uses a minimal v362 grant table and does not install every v351–v368 proposal.',
        'The fixture grants the buyer its app log, API-key, audit, stats and v2 producer rights manually; there is no reviewed production privilege migration for this exact app path.',
        'The buyer log amount and usage evidence are caller supplied; no immutable final result or independently authenticated Provider bill binds the debit.',
        'The same-user audit baseline is reconstructed from the v371-locked account and held reservation in one transaction; an unknown outer COMMIT outcome still needs a terminal read protocol.',
        'The global SHARE ROW EXCLUSIVE window-table lock serializes all writers and may cause capacity loss or deadlock retries. Production-scale contention remains unmeasured.',
        'Only the narrow non-grant, current-epoch, charged-basis held actual/v2 path is covered. Reserved, old-epoch, late actual, BYOK, recovery, no-hold and commit-unknown replay need successors.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator', 'buyer', 'runtime',
        'admission', 'sharedProducer', 'sharedConsumer'].map(x =>
        [x, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${passwords.buyer}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN NOINHERIT
          PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT
          PASSWORD '${passwords.admission}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN
          PASSWORD '${passwords.sharedProducer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN
          PASSWORD '${passwords.sharedConsumer}';
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_buyer_settlement,cinatoken_gateway_runtime,
          cinatoken_gateway_budget_admission,
          cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        GRANT USAGE ON SCHEMA ${g} TO cinatoken_gateway_buyer_settlement,
          cinatoken_gateway_runtime;`).simple();
      const migrator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'migrator');
      const buyer = connection(cluster, 'cinatoken_gateway_buyer_settlement',
        passwords.buyer, 'buyer');
      const concurrentBuyer = connection(cluster,
        'cinatoken_gateway_buyer_settlement', passwords.buyer,
        'concurrent-buyer');
      const creator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'creator');
      const runtime = connection(cluster, 'cinatoken_gateway_runtime',
        passwords.runtime, 'runtime');
      const admission = connection(cluster, 'cinatoken_gateway_budget_admission',
        passwords.admission, 'admission');
      const sharedProducer = connection(cluster,
        'cinatoken_gateway_shared_quote_attempt_producer',
        passwords.sharedProducer, 'shared-producer');
      clients.push(migrator, buyer, concurrentBuyer, creator, runtime,
        admission, sharedProducer);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort();
      assert.equal(names.length, 73);
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES($1)`,
            [name]);
        });
      }
      report.sourceSha256.formalMigrations = sha(corpus.join('\n'));
      report.sourceSha256['grant-postgres-runtime.ts'] = sha(await readFile(
        new URL('./grant-postgres-runtime.ts', import.meta.url)));
      stage('full-formal-pg73-schema-installed');

      const migratorUrl = `postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const economicProposals = [
        ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation'],
        ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation'],
        ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation'],
        ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation'],
        ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation'],
        ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation'],
        ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation'],
        ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation'],
      ];
      for (const [name, setting] of economicProposals) {
        const body = await readFile(new URL(name,
          new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url)), 'utf8');
        report.sourceSha256[name] = sha(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='${name ===
            'shared-key-quote-versions.sql' ? 'reviewed-v2' : 'reviewed-v1'}'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v2-economic-producer-and-budget-receipt-proposals-installed');

      // The v368 function's runtime body is exact. The preceding fixture
      // already proves the full v368 proposal installation and ACL policy.
      await migrator.unsafe(`CREATE TABLE ${g}.complete_text_attempt_grants_v362
        (request_id text PRIMARY KEY)`);
      const oldSource = await readFile(oldSqlUrl, 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-held-writer-v368.sql'] = sha(oldSource);
      const begin = oldSource.indexOf(`CREATE FUNCTION ${g}.settle_legacy_buyer_held_v368(`);
      const end = oldSource.indexOf('$settle$;', begin) + '$settle$;'.length;
      assert.ok(begin >= 0 && end > begin);
      await migrator.unsafe(oldSource.slice(begin, end)).simple();
      await migrator.unsafe(`REVOKE ALL ON FUNCTION
          ${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION
          ${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
          TO cinatoken_gateway_buyer_settlement;
        GRANT INSERT ON ${g}.api_key_request_logs
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT ON ${g}.api_keys
          TO cinatoken_gateway_buyer_settlement;`).simple();
      const [sourcePin] = await migrator.unsafe(`SELECT
        pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10))) AS digest
        FROM pg_catalog.pg_proc p WHERE p.oid=
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)'
            ::pg_catalog.regprocedure`);
      assert.equal(sourcePin.digest, 'abeb0cc33ab91be53a41e42c8f8aeb16');
      stage('exact-v368-held-body-and-restricted-buyer-log-writer-installed');

      const successor = await readFile(proposalUrl, 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-window-accountant-v371.sql'] =
        sha(successor);
      report.sourceSha256.fixture = sha(await readFile(new URL(import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(successor).simple()), 'P0001');
      const [beforeInstall] = await migrator.unsafe(`SELECT
        pg_catalog.to_regprocedure('${g}.settle_legacy_buyer_windowed_v371(text,text)')
          IS NULL AS no_wrapper,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS old_callable`);
      assert.deepEqual(beforeInstall, { no_wrapper: true, old_callable: true });
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_window_accountant_v371_activation='reviewed-v1'`);
        await tx.unsafe(successor).simple();
      });
      const aclSource = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-window-acl-v372.sql',
        import.meta.url), 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-window-acl-v372.sql'] =
        sha(aclSource);
      await rejected(migrator.begin(tx => tx.unsafe(aclSource).simple()), 'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_window_acl_v372_activation='reviewed-v1'`);
        await tx.unsafe(aclSource).simple();
      });
      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE') AS new_call,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS old_call,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_windows','UPDATE') AS raw_update,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname='seed_guardrail_window_unreserved_v371'
            AND tgenabled='O' AND NOT tgisinternal) AS seed_triggers`);
      assert.deepEqual(acl, { new_call: true, old_call: false,
        raw_update: false, seed_triggers: 1 });
      await rejected(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET unreserved_micros=unreserved_micros+1 WHERE false`), '42501');
      await rejected(buyer.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        'missing',1,1,'bypass')`), '42501');
      await rejected(runtime.unsafe(`SELECT ${g}.settle_legacy_buyer_windowed_v371(
        'missing','bypass')`), '42501');
      stage('default-off-and-successor-ACL-revoke-raw-old-bypass', { acl });

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const [rerunAcl] = await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)',
          'EXECUTE') AS runtime_call,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)',
          'EXECUTE') AS buyer_call`);
      assert.deepEqual(rerunAcl, { runtime_call: false, buyer_call: true });
      await rejected(runtime.unsafe(`SELECT ${g}.settle_legacy_buyer_windowed_v371(
        'missing','post_rerun_bypass')`), '42501');
      stage('broad-runtime-grant-rerun-preserves-v371-buyer-only-ACL',
        { rerunAcl });

      // The v347 producer replacement is what lets the dedicated buyer
      // LOGIN create the v2 event in the same transaction. These positive
      // grants precede the fixture's narrow financial-rights revocation.
      await activatePostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      await grantPostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      await activatePostgresBuyerGuardrailSplitV349({ DATABASE_URL: migratorUrl });
      await grantPostgresBuyerGuardrailSplitV349({ DATABASE_URL: migratorUrl });
      const admissionSql = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/budget-admission-login-v350.sql',
        import.meta.url), 'utf8');
      report.sourceSha256['budget-admission-login-v350.sql'] = sha(admissionSql);
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.budget_admission_login_activation='reviewed-v1'`);
        await tx.unsafe(admissionSql).simple();
      });
      await migrator.unsafe(`REVOKE UPDATE
          (budget_spent,budget_reserved_micros,updated_at)
          ON ${g}.users FROM cinatoken_gateway_buyer_settlement;
        REVOKE UPDATE
          (state,settled_micros,terminal_at,terminal_reason,updated_at)
          ON ${g}.user_budget_reservations
          FROM cinatoken_gateway_buyer_settlement;
        REVOKE UPDATE ON ${g}.guardrail_budget_reservations,
          ${g}.guardrail_budget_windows
          FROM cinatoken_gateway_buyer_settlement;`).simple();
      stage('v347-buyer-v2-producer-v348-v349-split-and-v350-admission-installed');

      // The application writer still inserts the log, audit, stats and v2
      // event as the direct buyer LOGIN. The financial counters stay revoked.
      await migrator.unsafe(`GRANT SELECT,UPDATE ON ${g}.api_keys
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT ON ${g}.users,
          ${g}.user_budget_reservations,
          ${g}.guardrail_budget_reservations
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT,INSERT ON ${g}.api_key_request_logs
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT,INSERT,UPDATE ON ${g}.public_model_daily_stats
          TO cinatoken_gateway_buyer_settlement;
        GRANT INSERT ON ${g}.user_audit_logs,
          ${g}.provider_attempt_availability
          TO cinatoken_gateway_buyer_settlement;
        GRANT USAGE ON SCHEMA cinatoken_economic_outbox
          TO cinatoken_gateway_buyer_settlement;
        GRANT EXECUTE ON FUNCTION
          cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            text,text,text,bigint,jsonb,text)
          TO cinatoken_gateway_buyer_settlement;`).simple();
      const [appAcl] = await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_windows','UPDATE') AS window_update,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.users','UPDATE') AS user_update,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            text,text,text,bigint,jsonb,text)','EXECUTE') AS v2_event`);
      assert.deepEqual(appAcl, { window_update: false,
        user_update: false, v2_event: true });
      stage('app-buyer-log-audit-event-rights-without-raw-financial-updates');

      const insertWindow = async (sql, scenario, scopeType, scopeId) =>
        sql.unsafe(`INSERT INTO ${g}.guardrail_budget_windows
          (workspace_id,scope_type,scope_id,period,period_start,period_end,
            unreserved_micros,settled_micros,reserved_micros,seeded_at,updated_at)
          VALUES($1,$2,$3,'daily',$4,$5,0,0,0,now(),now())`,
        [scenario.workspace, scopeType, scopeId, periodStart, periodEnd]);
      const seed = async (label, admitOrdinary = false) => {
        const scenario = { requestId: `v371-${label}`, user: `v371-user-${label}`,
          key: `v371-key-${label}`, workspace: `v371-workspace-${label}` };
        const keyHash = `sha256:${sha(`v371-${label}-bearer`)}`;
        await migrator.unsafe(`INSERT INTO ${g}.users
          (id,email,budget_max,budget_reserved_micros)
          VALUES($1,$2,10,$3)`,
        [scenario.user, `${label}@example.invalid`,
          admitOrdinary ? 0 : 10]);
        await migrator.unsafe(`INSERT INTO ${g}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES($1,'personal',$2,$3,$4,'active')`,
        [scenario.workspace, scenario.user, label, label]);
        await migrator.unsafe(`INSERT INTO ${g}.api_keys
          (id,key,key_hash,user_id,workspace_id,status)
          VALUES($1,$2,$3,$4,$5,'active')`,
        [scenario.key, `hashref:${keyHash}`, keyHash, scenario.user,
          scenario.workspace]);
        await insertWindow(migrator, scenario, 'user', scenario.user);
        await migrator.unsafe(`UPDATE ${g}.guardrail_budget_windows
          SET reserved_micros=10 WHERE workspace_id=$1 AND scope_type='user'
            AND scope_id=$2`, [scenario.workspace, scenario.user]);
        await insertWindow(migrator, scenario, 'workspace', scenario.workspace);
        await insertWindow(migrator, scenario, 'user', `unrelated-${label}`);
        if (!admitOrdinary) {
          await migrator.unsafe(`INSERT INTO ${g}.user_budget_reservations
            (request_id,user_id,api_key_id,budget_epoch,limit_micros,
              reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
            VALUES($1,$2,$3,0,1000000,10,0,'reserved',$4,now(),now())`,
          [scenario.requestId, scenario.user, scenario.key, expiresAt]);
        }
        await migrator.unsafe(`INSERT INTO ${g}.guardrail_budget_reservations
          (id,workspace_id,request_id,assignment_id,guardrail_id,
            guardrail_version,scope_type,scope_id,period,period_start,
            period_end,limit_micros,reserved_micros,settled_micros,
            settlement_basis,state,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,1,'user',$6,'daily',$7,$8,
            1000000,10,0,'charged','reserved',$9,now(),now())`,
        [`hold-${label}`, scenario.workspace, scenario.requestId,
          `assignment-${label}`, `guardrail-${label}`, scenario.user,
          periodStart, periodEnd, expiresAt]);
        return scenario;
      };
      const insertLog = (sql, scenario, overrides = {}) => sql.unsafe(`INSERT INTO
        ${g}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,
          budget_charged_micros,budget_accounted_at,is_byok,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scenario.requestId, scenario.user, scenario.key, scenario.workspace,
        overrides.chargedCost ?? '0.000001', overrides.micros ?? 1,
        accountedAt, overrides.isByok ?? false, overrides.status ?? 'success']);
      const settle = async (sql, scenario) => {
        const [row] = await sql.unsafe(`SELECT
          ${g}.settle_legacy_buyer_windowed_v371($1,'native_actual') AS value`,
        [scenario.requestId]);
        assert.equal(row.value.status, 'windowed_legacy_settled');
        assert.equal(row.value.chargeMicros, 1);
        assert.equal(row.value.guardrailRows, 1);
        return row.value;
      };
      const snapshot = async scenario => {
        const [row] = await migrator.unsafe(`SELECT
          (SELECT budget_spent::text FROM ${g}.users WHERE id=$1) AS spent,
          (SELECT budget_reserved_micros::text FROM ${g}.users WHERE id=$1)
            AS reserved,
          (SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$2)
            AS ordinary,
          (SELECT state FROM ${g}.guardrail_budget_reservations WHERE request_id=$2)
            AS guardrail,
          (SELECT count(*)::integer FROM ${g}.api_key_request_logs WHERE id=$2)
            AS logs`, [scenario.user, scenario.requestId]);
        const windows = await migrator.unsafe(`SELECT scope_type,scope_id,
          unreserved_micros::text AS unreserved,
          settled_micros::text AS settled,reserved_micros::text AS reserved
          FROM ${g}.guardrail_budget_windows WHERE workspace_id=$1
          ORDER BY scope_type,scope_id`, [scenario.workspace]);
        return { ...row, windows };
      };
      const [buyerPid] = await buyer.unsafe('SELECT pg_catalog.pg_backend_pid() AS pid');
      const [creatorPid] = await creator.unsafe('SELECT pg_catalog.pg_backend_pid() AS pid');

      const before = await seed('creator-before-lock');
      let creatorReady;
      const creatorStarted = new Promise(resolve => { creatorReady = resolve; });
      let releaseCreator;
      const creatorGate = new Promise(resolve => { releaseCreator = resolve; });
      const heldCreator = creator.begin(async tx => {
        await insertWindow(tx, before, 'api_key', before.key);
        creatorReady();
        await creatorGate;
      });
      await creatorStarted;
      const waitingBuyer = buyer.begin(async tx => {
        await insertLog(tx, before);
        return settle(tx, before);
      });
      try { await waitForBlock(cluster.admin, buyerPid.pid, creatorPid.pid); }
      finally { releaseCreator(); }
      const [, beforeValue] = await Promise.all([heldCreator, waitingBuyer]);
      assert.equal(beforeValue.unreservedWindowRows, 2);
      const beforeState = await snapshot(before);
      assert.equal(beforeState.ordinary, 'settled');
      assert.equal(beforeState.guardrail, 'settled');
      assert.equal(beforeState.logs, 1);
      assert.deepEqual(beforeState.windows.map(w =>
        [w.scope_type, w.scope_id, w.unreserved, w.settled]), [
        ['api_key', before.key, '1', '0'],
        ['user', `unrelated-creator-before-lock`, '0', '0'],
        ['user', before.user, '0', '1'],
        ['workspace', before.workspace, '1', '0'],
      ]);
      stage('creator-commits-before-lock-buyer-sees-and-accounts-window',
        { blockedBuyerPid: buyerPid.pid, unreservedWindowRows: 2 });

      const after = await seed('creator-after-lock');
      let buyerReady;
      const buyerStarted = new Promise(resolve => { buyerReady = resolve; });
      let releaseBuyer;
      const buyerGate = new Promise(resolve => { releaseBuyer = resolve; });
      const heldBuyer = buyer.begin(async tx => {
        await insertLog(tx, after);
        const value = await settle(tx, after);
        buyerReady(value);
        await buyerGate;
      });
      const afterValue = await buyerStarted;
      assert.equal(afterValue.unreservedWindowRows, 1);
      const waitingCreator = insertWindow(creator, after, 'api_key', after.key);
      try { await waitForBlock(cluster.admin, creatorPid.pid, buyerPid.pid); }
      finally { releaseBuyer(); }
      await Promise.all([heldBuyer, waitingCreator]);
      const afterState = await snapshot(after);
      assert.deepEqual(afterState.windows.map(w =>
        [w.scope_type, w.scope_id, w.unreserved, w.settled]), [
        ['api_key', after.key, '1', '0'],
        ['user', `unrelated-creator-after-lock`, '0', '0'],
        ['user', after.user, '0', '1'],
        ['workspace', after.workspace, '1', '0'],
      ]);
      stage('creator-after-lock-waits-for-commit-and-seeds-from-buyer-log',
        { blockedCreatorPid: creatorPid.pid, unreservedWindowRows: 1 });

      const stable = await snapshot(before);
      await rejected(buyer.begin(async tx => settle(tx, before)), '23514',
        'legacy_buyer_hold_v368');
      assert.deepEqual(await snapshot(before), stable);
      stage('terminal-replay-cannot-double-debit-held-or-unreserved-windows');

      const rollback = await seed('rollback');
      const beforeRollback = await snapshot(rollback);
      await assert.rejects(buyer.begin(async tx => {
        await insertLog(tx, rollback);
        await settle(tx, rollback);
        throw new Error('v371-deliberate-outer-rollback');
      }), /v371-deliberate-outer-rollback/u);
      assert.deepEqual(await snapshot(rollback), beforeRollback);
      stage('outer-rollback-restores-log-account-holds-and-windows');

      const wrong = await seed('wrong-amount');
      const beforeWrong = await snapshot(wrong);
      await rejected(buyer.begin(async tx => {
        await insertLog(tx, wrong, { chargedCost: '0.000002' });
        await settle(tx, wrong);
      }), '23514', 'legacy_buyer_log_v371');
      assert.deepEqual(await snapshot(wrong), beforeWrong);
      const byok = await seed('byok');
      const beforeByok = await snapshot(byok);
      await rejected(buyer.begin(async tx => {
        await insertLog(tx, byok, { isByok: true });
        await settle(tx, byok);
      }), '23514', 'legacy_buyer_log_v371');
      assert.deepEqual(await snapshot(byok), beforeByok);
      stage('wrong-charge-and-byok-rejected-before-financial-writes');

      await rejected(insertWindow(migrator, after, 'workspace',
        'spoofed-workspace-scope'), '23514', 'guardrail_window_seed_v371');
      const mismatch = await seed('mismatched-history');
      await migrator.unsafe(`INSERT INTO ${g}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,
          budget_charged_micros,budget_accounted_at,is_byok,status)
        VALUES($1,$2,$3,$4,0.000002,1,$5,false,'success')`,
      [`history-${mismatch.requestId}`, mismatch.user, mismatch.key,
        mismatch.workspace, accountedAt]);
      await rejected(insertWindow(migrator, mismatch, 'api_key', mismatch.key),
        '23514', 'guardrail_window_seed_v371');
      stage('workspace-scope-spoof-and-mismatched-positive-history-denied');

      const timeout = await seed('lock-timeout');
      const beforeTimeout = await snapshot(timeout);
      let creatorLockReady;
      const locked = new Promise(resolve => { creatorLockReady = resolve; });
      let releaseCreatorLock;
      const creatorLockGate = new Promise(resolve => { releaseCreatorLock = resolve; });
      const tableHolder = creator.begin(async tx => {
        await tx.unsafe(`LOCK TABLE ${g}.guardrail_budget_windows
          IN ROW EXCLUSIVE MODE`);
        creatorLockReady();
        await creatorLockGate;
      });
      await locked;
      try {
        await rejected(buyer.begin(async tx => {
          await insertLog(tx, timeout);
          await settle(tx, timeout);
        }), '55P03');
      } finally { releaseCreatorLock(); }
      await tableHolder;
      assert.deepEqual(await snapshot(timeout), beforeTimeout);
      stage('contended-window-table-lock-times-out-and-rolls-back-buyer');

      await migrator.unsafe(`INSERT INTO ${g}.users
          (id,email,budget_max) VALUES
          ('v372-seller','v372-seller@example.invalid',10);
        INSERT INTO ${g}.user_earnings(user_id) VALUES('v372-seller');
        INSERT INTO ${g}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES('v372-shared-key','v372-seller','openai',
            'synthetic-upstream-v372','synthetic-fingerprint-v372','active');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES('v372-quote','v372-shared-key','v372-seller',
            1.25,2.5,0.1,0.2,0.1,'USD','per_million_tokens',
            'shared_seller_key','synthetic-v1');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,
            transition_kind,quote_version_id,seller_user_id)
          VALUES('v372-transition','v372-shared-key',NULL,'activate',
            'v372-quote','v372-seller');`).simple();
      const appDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      const concurrentAppDb = { driver: 'postgres', raw: concurrentBuyer,
        drizzle: drizzle(concurrentBuyer, { schema: pgCoreSchema }) };
      const appInput = async (label, shared = null) => {
        const scenario = shared
          ? { ...shared, requestId: `v371-${label}` }
          : await seed(label, true);
        if (shared) {
          await migrator.begin(async tx => {
            await tx.unsafe(`UPDATE ${g}.guardrail_budget_windows
              SET reserved_micros=reserved_micros+10
              WHERE workspace_id=$1 AND scope_type='user'
                AND scope_id=$2`, [scenario.workspace, scenario.user]);
            await tx.unsafe(`INSERT INTO ${g}.guardrail_budget_reservations
              (id,workspace_id,request_id,assignment_id,guardrail_id,
                guardrail_version,scope_type,scope_id,period,period_start,
                period_end,limit_micros,reserved_micros,settled_micros,
                settlement_basis,state,expires_at,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5,1,'user',$6,'daily',$7,$8,
                1000000,10,0,'charged','reserved',$9,now(),now())`,
              [`hold-${label}`, scenario.workspace, scenario.requestId,
                `assignment-${label}`, `guardrail-${label}`, scenario.user,
                periodStart, periodEnd, expiresAt]);
          });
        } else {
          await insertWindow(migrator, scenario, 'api_key', scenario.key);
        }
        const [admitted] = await admission.unsafe(`SELECT
          ${g}.reserve_user_budget_v350($1,$2,$3,0,10,
            pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp()+INTERVAL '1 minute') AS value`,
          [scenario.requestId, scenario.user, scenario.key]);
        assert.equal(admitted.value.status, 'reserved');
        const [admissionReceipt] = await migrator.unsafe(`SELECT hold_verified
          FROM cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
          WHERE request_id=$1`, [scenario.requestId]);
        assert.equal(admissionReceipt?.hold_verified, true);
        const [claim] = await sharedProducer.unsafe(`SELECT * FROM
          cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
            $1::uuid,$2,1,'v372-shared-key','v372-target')`,
          [randomUUID(), scenario.requestId]);
        assert.equal(claim.request_log_id, scenario.requestId);
        const params = chargeParams(scenario.requestId, 0.000001);
        params.requestLog = { ...params.requestLog,
          userId: scenario.user, apiKeyId: scenario.key,
          workspaceId: scenario.workspace, modelId: 'v372/app',
          routeTargetId: 'v372-target', inputTokens: 10,
          outputTokens: 5, totalTokens: 15, isByok: false,
          requestOrigin: 'https://example.invalid',
          dataRegion: 'global', chargedCostUsd: 0.000001,
          budgetAccountedAt: accountedAt };
        params.userId = scenario.user;
        params.beforeSpent = 0;
        params.audit = { ...params.audit, apiKeyId: scenario.key,
          beforeSpent: 0, requestLogId: scenario.requestId };
        params.userBudgetSettlement = { requestId: scenario.requestId,
          mode: 'actual', reason: 'v372_actual' };
        params.guardrailBudgetSettlement = { requestId: scenario.requestId,
          mode: 'actual', reason: 'v372_actual' };
        params.economicOutbox = { eventVersion: 2,
          buyerChargeBasis: 'actual', buyerUsageCertainty: 'actual',
          attempts: [{ attemptId: claim.attempt_id,
            requestLogId: scenario.requestId, attemptIndex: 1,
            sharedKeyId: claim.shared_key_id,
            transitionId: claim.transition_id,
            quoteVersionId: claim.quote_version_id,
            usageCertainty: 'actual', inputTokens: 10,
            outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
            providerCostCertainty: 'unknown', providerCostMicros: null,
            evidenceKind: 'provider_usage', evidenceSha256: 'a'.repeat(64),
            observedAtIso: new Date().toISOString() }] };
        params.legacyBuyerWindowedV371 = 'review-only';
        return { scenario, params };
      };
      const appState = async scenario => {
        const base = await snapshot(scenario);
        const [facts] = await migrator.unsafe(`SELECT
          (SELECT count(*)::int FROM ${g}.user_audit_logs
            WHERE request_log_id=$1) AS audits,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_economic_events
            WHERE request_log_id=$1) AS events,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_economic_event_attempts
            WHERE request_log_id=$1) AS event_attempts`,
          [scenario.requestId]);
        return { ...base, ...facts };
      };
      report.sourceSha256['critical-writes.impl.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts',
          import.meta.url)));
      report.sourceSha256['legacy-buyer-windowed-transaction-v372.ts'] =
        sha(await readFile(new URL('../../../packages/core/src/db/postgres/legacy-buyer-windowed-transaction-v372.ts',
          import.meta.url)));
      const committedApp = await appInput('app-commit');
      const beforeApp = await appState(committedApp.scenario);
      assert.equal(beforeApp.logs, 0);
      await insertRequestUsageAndChargeTxPg(appDb, committedApp.params);
      const afterApp = await appState(committedApp.scenario);
      assert.equal(afterApp.ordinary, 'settled');
      assert.equal(afterApp.guardrail, 'settled');
      assert.equal(afterApp.spent, '0.000001');
      assert.equal(afterApp.reserved, '0');
      assert.deepEqual([afterApp.logs, afterApp.audits,
        afterApp.events, afterApp.event_attempts], [1, 1, 1, 1]);
      assert.deepEqual(afterApp.windows.map(w =>
        [w.scope_type, w.scope_id, w.unreserved, w.settled]), [
        ['api_key', committedApp.scenario.key, '1', '0'],
        ['user', `unrelated-app-commit`, '0', '0'],
        ['user', committedApp.scenario.user, '0', '1'],
        ['workspace', committedApp.scenario.workspace, '1', '0'],
      ]);
      const [receipt] = await migrator.unsafe(`SELECT
        e.buyer_debit_micros::text AS debit,
        m.log_xact_id::text AS log_xact_id,
        r.xact_id::text AS receipt_xact_id,
        r.spent_delta_micros::text AS spent_delta
        FROM cinatoken_economic_outbox.shared_key_economic_events e
        JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          ON m.request_log_id=e.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
          ON r.xact_id=m.log_xact_id AND r.user_id=e.buyer_user_id
        WHERE e.request_log_id=$1`, [committedApp.scenario.requestId]);
      assert.equal(receipt.debit, '1');
      assert.equal(receipt.log_xact_id, receipt.receipt_xact_id);
      assert.equal(receipt.spent_delta, '1.000000');
      const [committedAudit] = await migrator.unsafe(`SELECT
        before_user_snapshot,after_user_snapshot,changed_fields
        FROM ${g}.user_audit_logs WHERE request_log_id=$1`,
      [committedApp.scenario.requestId]);
      assert.deepEqual([
        JSON.parse(committedAudit.before_user_snapshot).budget_spent,
        JSON.parse(committedAudit.after_user_snapshot).budget_spent,
        JSON.parse(committedAudit.before_user_snapshot).budget_reserved_micros,
        JSON.parse(committedAudit.after_user_snapshot).budget_reserved_micros,
      ], [0, 0.000001, 10, 0]);
      assert.deepEqual(JSON.parse(committedAudit.changed_fields),
        ['budget_spent', 'budget_reserved_micros']);
      stage('actual-app-writer-commits-held-unreserved-log-audit-v2-event-and-receipt',
        { receipt });

      await assert.rejects(insertRequestUsageAndChargeTxPg(
        appDb, committedApp.params), /replay needs a committed terminal read protocol/u);
      assert.deepEqual(await appState(committedApp.scenario), afterApp);
      const invalid = { ...committedApp.params,
        userBudgetSettlement: { ...committedApp.params.userBudgetSettlement,
          mode: 'reserved' } };
      await assert.rejects(insertRequestUsageAndChargeTxPg(appDb, invalid),
        /Shared-key economic buyer basis differs from critical-write settlement/u);
      assert.deepEqual(await appState(committedApp.scenario), afterApp);
      stage('app-replay-and-unsupported-mode-fail-without-double-debit');

      const sameFirst = await appInput('same-account-first');
      const secondKey = 'v371-key-same-account-second';
      const secondHash = `sha256:${sha('v371-same-account-second-bearer')}`;
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES($1,$2,$3,$4,$5,'active')`, [secondKey,
        `hashref:${secondHash}`, secondHash, sameFirst.scenario.user,
        sameFirst.scenario.workspace]);
      const sameSecond = await appInput('same-account-second',
        { ...sameFirst.scenario, key: secondKey });
      assert.equal(sameFirst.params.beforeSpent, 0);
      assert.equal(sameSecond.params.beforeSpent, 0);
      await Promise.all([
        insertRequestUsageAndChargeTxPg(appDb, sameFirst.params),
        insertRequestUsageAndChargeTxPg(concurrentAppDb, sameSecond.params),
      ]);
      const firstState = await appState(sameFirst.scenario);
      const secondState = await appState(sameSecond.scenario);
      for (const state of [firstState, secondState]) {
        assert.equal(state.spent, '0.000002');
        assert.equal(state.reserved, '0');
        assert.equal(state.ordinary, 'settled');
        assert.equal(state.guardrail, 'settled');
        assert.deepEqual([state.logs, state.audits,
          state.events, state.event_attempts], [1, 1, 1, 1]);
      }
      const concurrentAudits = await migrator.unsafe(`SELECT
        request_log_id,before_user_snapshot,after_user_snapshot,changed_fields
        FROM ${g}.user_audit_logs
        WHERE request_log_id IN ($1,$2)`, [sameFirst.scenario.requestId,
        sameSecond.scenario.requestId]);
      assert.equal(concurrentAudits.length, 2);
      const observed = concurrentAudits.map(audit => {
        const before = JSON.parse(audit.before_user_snapshot);
        const after = JSON.parse(audit.after_user_snapshot);
        assert.equal(before.id, sameFirst.scenario.user);
        assert.equal(after.id, sameFirst.scenario.user);
        assert.deepEqual(JSON.parse(audit.changed_fields),
          ['budget_spent', 'budget_reserved_micros']);
        return [before.budget_spent, after.budget_spent,
          before.budget_reserved_micros, after.budget_reserved_micros];
      }).sort((a, b) => a[0] - b[0]);
      assert.deepEqual(observed, [
        [0, 0.000001, 20, 10],
        [0.000001, 0.000002, 10, 0],
      ]);
      const [sameReceipts] = await migrator.unsafe(`SELECT
        count(*)::int AS events,
        count(DISTINCT m.log_xact_id)::int AS transactions,
        count(r.xact_id)::int AS receipts
        FROM cinatoken_economic_outbox.shared_key_economic_events e
        JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          ON m.request_log_id=e.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
          ON r.xact_id=m.log_xact_id AND r.user_id=e.buyer_user_id
        WHERE e.request_log_id IN ($1,$2)`,
      [sameFirst.scenario.requestId, sameSecond.scenario.requestId]);
      assert.deepEqual(sameReceipts,
        { events: 2, transactions: 2, receipts: 2 });
      stage('same-user-distinct-key-concurrent-admissions-derive-ordered-audit-baselines',
        { observed, sameReceipts });

      const untrustedBaseline = await appInput('untrusted-audit-baseline');
      untrustedBaseline.params.beforeSpent = 999;
      untrustedBaseline.params.audit.beforeSpent = -77;
      untrustedBaseline.params.audit.beforeUserSnapshot =
        JSON.stringify({ id: untrustedBaseline.scenario.user,
          budget_spent: 999 });
      untrustedBaseline.params.audit.afterUserSnapshot =
        JSON.stringify({ id: untrustedBaseline.scenario.user,
          budget_spent: 1000 });
      await insertRequestUsageAndChargeTxPg(appDb, untrustedBaseline.params);
      const [authoritativeAudit] = await migrator.unsafe(`SELECT
        before_user_snapshot,after_user_snapshot
        FROM ${g}.user_audit_logs WHERE request_log_id=$1`,
      [untrustedBaseline.scenario.requestId]);
      assert.deepEqual([
        JSON.parse(authoritativeAudit.before_user_snapshot).budget_spent,
        JSON.parse(authoritativeAudit.after_user_snapshot).budget_spent,
      ], [0, 0.000001]);
      assert.equal((await appState(untrustedBaseline.scenario)).spent,
        '0.000001');
      stage('caller-pre-state-and-supplied-user-snapshots-cannot-set-audit-money');

      const clamped = await appInput('clamped-negative-before');
      await migrator.unsafe(`UPDATE ${g}.users SET budget_spent=-0.000002
        WHERE id=$1`, [clamped.scenario.user]);
      const beforeClamped = await appState(clamped.scenario);
      await assert.rejects(insertRequestUsageAndChargeTxPg(
        appDb, clamped.params),
        /PostgreSQL windowed buyer audit account\/hold differs/u);
      assert.deepEqual(await appState(clamped.scenario), beforeClamped);
      stage('clamped-account-inversion-fails-and-rolls-back-every-write');

      const rolledApp = await appInput('app-rollback');
      const beforeRolled = await appState(rolledApp.scenario);
      await migrator.unsafe(`ALTER TABLE ${g}.user_audit_logs
        ADD CONSTRAINT v372_reject_late_audit CHECK
          (request_log_id<>'${rolledApp.scenario.requestId}')`);
      try {
        await assert.rejects(insertRequestUsageAndChargeTxPg(
          appDb, rolledApp.params));
        assert.deepEqual(await appState(rolledApp.scenario), beforeRolled);
      } finally {
        await migrator.unsafe(`ALTER TABLE ${g}.user_audit_logs
          DROP CONSTRAINT v372_reject_late_audit`);
      }
      stage('late-audit-failure-rolls-back-holds-windows-log-event-and-stats');

      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.failedAfterStage = report.stages.at(-1)?.name ?? null;
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 5000) };
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = String(error).slice(0, 1500);
        failure ??= error; }
      await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`legacy-buyer-windowed-app-v372-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
  });

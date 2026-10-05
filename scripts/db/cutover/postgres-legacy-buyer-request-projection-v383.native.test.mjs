// Owned PostgreSQL 18.6 integration of v383's DB-log projection receipt with
// the real v372 writer, v375 reader and v378 durable uncertainty journal.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { runLegacyBuyerProjectionWriteV383,
  readBuyerLogProjectionV383 } from '../../../packages/core/src/db/postgres/legacy-buyer-request-projection-receipt-v383.ts';
import { commitAckProxy } from '../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs';
import { delayedCommitProxy } from '../../../packages/core/src/test-support/postgres-delayed-commit-proxy-v377.mjs';
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { applyRequestBodyLoggingPolicy } from '../../../packages/proxy/src/services/request-body-log-policy.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const oldSqlUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-held-writer-v368.sql', import.meta.url);
const proposalUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-window-accountant-v371.sql', import.meta.url);
const terminalUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-terminal-reader-v375.sql', import.meta.url);
const journalUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-commit-journal-v378.sql', import.meta.url);
const projectionUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-request-projection-receipt-v383.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-legacy-buyer-request-projection-v383-report.json', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const dayStart = new Date(Date.now());
dayStart.setUTCHours(0, 0, 0, 0);
const periodStart = dayStart.toISOString();
const periodEnd = new Date(dayStart.getTime() + 86_400_000).toISOString();
const accountedAt = new Date(dayStart.getTime() + 12 * 3_600_000).toISOString();
const expiresAt = () => new Date(Date.now() + 120_000).toISOString();

function connection(cluster, name, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: name, password, ssl: false, max: 1, prepare: false,
    fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: false, onnotice() {},
    connection: { application_name: `v381-${label}`, search_path: `${g},public` } });
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

test('v383 real buyer writer emits a narrow same-xact DB-log projection receipt',
  { timeout: 360_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only owned local PG73 plus proposals; no formal migration, remote SQL, Worker, Provider, production credential, or scheduler changed.',
        'The fixture installs the real v372 writer, v375 reader, v378 journal, exact v368 body, v2 economic producer and budget receipt, v347/v348/v349 login split, and v350 admission. It uses a minimal v362 grant table and manual buyer app rights, not all production ACL proposals.',
        'The v383 DB-log projection is only 19 selected non-sensitive columns. The v378 fullRequestSha256 remains caller-reported and is not compared with actual HTTP/Provider wire bytes; this is an executable complete-request identity blocker.',
        'Request body logging defaults off and the Provider response field is a bounded snapshot. No trusted pre-egress full-wire attestation or independently verified Provider bill enters this v372 transaction.',
        'Guardrail rows, unreserved windows, audit, and daily statistics lack independent request-scoped transaction markers. Their presence is not complete request-level success proof.',
        'The COMMIT ACK proxy drops PostgreSQL CommandComplete, not TCP ACK. The delayed COMMIT proxy models an intermediary holding original client frames, not a COMMIT already delivered to PostgreSQL but uncommitted internally.',
        'The fixture creates fresh journal and terminal-reader LOGIN connections and checks backend PIDs; production connection factories and scheduler wiring remain absent.',
        'Only the narrow non-grant current-epoch charged-basis held actual/v2 path is covered. Other buyer branches need successors; receipt retention across automated and operator review is not installed.',
        'Installing v383 is a buyer-login cutover barrier: every buyer settlement LOGIN request-log INSERT requires a fresh verified v383 prewrite. Existing v372 callers would fail until all are routed through the new wrapper; incremental enable is unsupported.',
        'The 31-second expiry negative uses a privileged fixture-only metadata time warp. It proves trigger enforcement, not wall-clock waiting behavior under production load.',
        'The global SHARE ROW EXCLUSIVE window-table lock can reduce capacity; production-scale contention remains unmeasured.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator', 'buyer', 'reader', 'journal', 'runtime',
        'admission', 'sharedProducer', 'sharedConsumer'].map(x =>
        [x, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${passwords.buyer}';
        CREATE ROLE cinatoken_gateway_buyer_terminal_reader LOGIN NOINHERIT
          PASSWORD '${passwords.reader}';
        CREATE ROLE cinatoken_gateway_buyer_commit_journal LOGIN NOINHERIT
          PASSWORD '${passwords.journal}';
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
          cinatoken_gateway_buyer_settlement,
          cinatoken_gateway_buyer_terminal_reader,cinatoken_gateway_runtime,
          cinatoken_gateway_buyer_commit_journal,
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
      const reader = connection(cluster,
        'cinatoken_gateway_buyer_terminal_reader', passwords.reader, 'reader');
      const journal = connection(cluster,
        'cinatoken_gateway_buyer_commit_journal', passwords.journal,
        'journal');
      const creator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'creator');
      const runtime = connection(cluster, 'cinatoken_gateway_runtime',
        passwords.runtime, 'runtime');
      const admission = connection(cluster, 'cinatoken_gateway_budget_admission',
        passwords.admission, 'admission');
      const sharedProducer = connection(cluster,
        'cinatoken_gateway_shared_quote_attempt_producer',
        passwords.sharedProducer, 'shared-producer');
      clients.push(migrator, buyer, reader, journal, creator, runtime,
        admission, sharedProducer);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = await listPg73Migrations();
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
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
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
      const terminalSource = await readFile(terminalUrl, 'utf8');
      report.sourceSha256['legacy-buyer-terminal-reader-v375.sql'] = sha(terminalSource);
      report.sourceSha256['legacy-buyer-terminal-reader-v375.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/legacy-buyer-terminal-reader-v375.ts',
          import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(terminalSource).simple()), 'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_terminal_reader_v375_activation='reviewed-v1'`);
        await tx.unsafe(terminalSource).simple();
      });
      const [readerAcl] = await migrator.unsafe(`SELECT
        pg_catalog.has_schema_privilege(
          'cinatoken_gateway_buyer_terminal_reader',
          'cinatoken_buyer_terminal','USAGE') AS terminal_schema,
        pg_catalog.has_function_privilege(
          'cinatoken_gateway_buyer_terminal_reader',
          'cinatoken_buyer_terminal.read_windowed_v375(
            text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)',
          'EXECUTE') AS terminal_execute,
        pg_catalog.has_schema_privilege(
          'cinatoken_gateway_buyer_terminal_reader',
          '${g}','USAGE') AS gateway_schema,
        pg_catalog.has_schema_privilege(
          'cinatoken_gateway_buyer_terminal_reader',
          'cinatoken_economic_outbox','USAGE') AS economic_schema`);
      assert.deepEqual(readerAcl, { terminal_schema: true,
        terminal_execute: true, gateway_schema: false,
        economic_schema: false });
      await rejected(reader.unsafe(`SELECT * FROM ${g}.api_key_request_logs`),
        '42501');
      await rejected(buyer.unsafe(`SELECT cinatoken_buyer_terminal.read_windowed_v375(
        'missing','u','k','w',1,1,1,0,0,'reason','[]'::jsonb)`), '42501');
      stage('terminal-proposal-default-off-and-reader-execute-only', { readerAcl });
      const journalSource = await readFile(journalUrl, 'utf8');
      report.sourceSha256['legacy-buyer-commit-journal-v378.sql'] = sha(journalSource);
      report.sourceSha256['legacy-buyer-commit-journal-v378.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/legacy-buyer-commit-journal-v378.ts',
          import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(journalSource).simple()), 'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_commit_journal_v378_activation='reviewed-v1'`);
        await tx.unsafe(journalSource).simple();
      });
      await rejected(journal.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.intents_v378`), '42501');
      await rejected(journal.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`, [randomUUID(),randomUUID()]), '42501');
      stage('v378-journal-installed-after-real-v375-with-separated-logins');
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

      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
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
          [scenario.requestId, scenario.user, scenario.key, expiresAt()]);
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
          periodStart, periodEnd, expiresAt()]);
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
                periodStart, periodEnd, expiresAt()]);
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
      const terminalExpected = ({ scenario, params }) => ({
        requestId: scenario.requestId,
        userId: scenario.user,
        apiKeyId: scenario.key,
        workspaceId: scenario.workspace,
        chargeMicros: 1,
        inputTokens: params.requestLog.inputTokens,
        outputTokens: params.requestLog.outputTokens,
        cacheReadTokens: params.requestLog.cacheReadTokens,
        cacheWriteTokens: params.requestLog.cacheWriteTokens,
        reason: params.userBudgetSettlement.reason,
        outcomes: params.economicOutbox.attempts.map(a => ({
          attempt_id: a.attemptId,
          attempt_index: a.attemptIndex,
          shared_key_id: a.sharedKeyId,
          transition_id: a.transitionId,
          quote_version_id: a.quoteVersionId,
          usage_certainty: a.usageCertainty,
          input_tokens: a.inputTokens,
          output_tokens: a.outputTokens,
          cache_read_tokens: a.cacheReadTokens,
          cache_write_tokens: a.cacheWriteTokens,
          provider_cost_certainty: a.providerCostCertainty,
          provider_cost_micros: a.providerCostMicros,
          evidence_kind: a.evidenceKind,
          evidence_sha256: a.evidenceSha256,
          observed_at: a.observedAtIso,
        })),
      });
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
      report.sourceSha256['postgres-commit-ack-proxy.mjs'] = sha(await readFile(
        new URL('../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs',
          import.meta.url)));
      report.sourceSha256['postgres-delayed-commit-proxy-v377.mjs'] =
        sha(await readFile(new URL(
          '../../../packages/core/src/test-support/postgres-delayed-commit-proxy-v377.mjs',
          import.meta.url)));
      report.sourceSha256['postgres-journal-commit-ack-proxy-v381.mjs'] =
        sha(await readFile(new URL(
          '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs',
          import.meta.url)));
      const journalPids = [];
      const readerPids = [];
      const openJournalSession = async () => {
        const raw = connection(cluster,
          'cinatoken_gateway_buyer_commit_journal',passwords.journal,
          `journal-session-${journalPids.length}`);
        clients.push(raw);
        const [identity] = await raw.unsafe(`SELECT pg_catalog.pg_backend_pid() AS pid,
          current_user AS login`);
        assert.equal(identity.login,'cinatoken_gateway_buyer_commit_journal');
        journalPids.push(identity.pid);
        return { client: { driver:'postgres',raw },
          close: () => raw.end({ timeout: 1 }) };
      };
      const openFreshReader = async () => {
        const raw = connection(cluster,
          'cinatoken_gateway_buyer_terminal_reader',passwords.reader,
          `terminal-session-${readerPids.length}`);
        clients.push(raw);
        const [identity] = await raw.unsafe(`SELECT pg_catalog.pg_backend_pid() AS pid,
          current_user AS login`);
        assert.equal(identity.login,'cinatoken_gateway_buyer_terminal_reader');
        readerPids.push(identity.pid);
        return { client: { driver:'postgres',raw },
          close: () => raw.end({ timeout: 1 }) };
      };
      const journalIntent = (input,label) => ({
        intentId: randomUUID(),
        // Synthetic fixture request manifest; no authenticated Provider bill.
        fullRequestSha256: sha(JSON.stringify({ label,
          requestLog:input.params.requestLog,
          economicOutbox:input.params.economicOutbox,
          userBudgetSettlement:input.params.userBudgetSettlement })),
        deadlineAt: new Date(Date.now()+3_600_000).toISOString(),
        expectedFinancialFacts: terminalExpected(input),
      });
      const financialReceipt = async scenario => {
        const rows = await migrator.unsafe(`SELECT
          m.log_xact_id::text AS event_xact_id,
          b.xact_id::text AS budget_xact_id,
          b.spent_delta_micros::text AS spent_delta
          FROM cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          JOIN cinatoken_economic_outbox.shared_key_economic_events e
            ON e.request_log_id=m.request_log_id
          JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
            ON b.xact_id=m.log_xact_id AND b.user_id=e.buyer_user_id
          WHERE m.request_log_id=$1`,[scenario.requestId]);
        assert.equal(rows.length,1);
        assert.equal(rows[0].event_xact_id,rows[0].budget_xact_id);
        assert.equal(rows[0].spent_delta,'1.000000');
        return rows[0];
      };
      const assertCommittedBuyer = async scenario => {
        const after = await appState(scenario);
        assert.equal(after.spent,'0.000001');
        assert.equal(after.reserved,'0');
        assert.equal(after.ordinary,'settled');
        assert.equal(after.guardrail,'settled');
        assert.deepEqual([after.logs,after.audits,after.events,
          after.event_attempts],[1,1,1,1]);
        return { after,receipt:await financialReceipt(scenario) };
      };
      const logProjection = ({ scenario, params }) => {
        const p = params.requestLog;
        return { apiKeyId:scenario.key,billingKind:p.billingKind ?? null,
          isByok:false,modelId:p.modelId ?? null,providerId:p.providerId ?? null,
          providerKeyFingerprint:p.providerKeyFingerprint ?? null,
          requestId:scenario.requestId,
          requestOperation:p.requestOperation ?? null,
          requestProtocol:p.requestProtocol ?? null,
          routeGroup:p.routeGroup ?? 'default',routePoolId:p.routePoolId ?? null,
          routeTargetId:p.routeTargetId ?? null,routeTrace:p.routeTrace ?? null,
          status:'success',upstreamOperation:p.upstreamOperation ?? null,
          upstreamProtocol:p.upstreamProtocol ?? 'openai',
          upstreamRequestId:p.upstreamRequestId ?? null,
          userId:scenario.user,workspaceId:scenario.workspace };
      };
      const projectionReceipt = async requestId => {
        const [row] = await migrator.unsafe(`SELECT
          r.intent_id::text AS intent_id,r.projection_sha256,
          r.xact_id::text AS receipt_xact_id,
          m.log_xact_id::text AS event_xact_id,
          b.xact_id::text AS budget_xact_id,
          r.inserted_backend_pid,p.prepared_backend_pid,
          p.verified_backend_pid
          FROM cinatoken_buyer_request_projection.receipts_v383 r
          JOIN cinatoken_buyer_request_projection.prewrites_v383 p
            ON p.intent_id=r.intent_id
          JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
            ON m.request_log_id=r.request_id
          JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
            ON b.xact_id=m.log_xact_id
          WHERE r.request_id=$1`,[requestId]);
        assert.ok(row);
        assert.equal(row.receipt_xact_id,row.event_xact_id);
        assert.equal(row.receipt_xact_id,row.budget_xact_id);
        assert.notEqual(row.prepared_backend_pid,row.verified_backend_pid);
        assert.notEqual(row.inserted_backend_pid,row.prepared_backend_pid);
        return row;
      };
      const v383Read = async intentId => readBuyerLogProjectionV383(
        intentId,openFreshReader,'review-only');

      // The old v375 subset can confirm a historical financial write. v383
      // must refuse to adopt it after the fact, even for identical economics.
      const historical=await appInput('historical-before-v383');
      await insertRequestUsageAndChargeTxPg(appDb,historical.params);
      const historicalCommitted=await assertCommittedBuyer(historical.scenario);
      const historicalIntent=journalIntent(historical,'historical');
      const historicalPrepare=await openJournalSession();
      await historicalPrepare.client.raw.unsafe(`SELECT
        cinatoken_buyer_commit_journal.prepare_v378(
          $1::uuid,$2,$3,$4::jsonb,$5::timestamptz)`,
        [historicalIntent.intentId,historical.scenario.requestId,
          historicalIntent.fullRequestSha256,
          historicalPrepare.client.raw.json(historicalIntent.expectedFinancialFacts),
          historicalIntent.deadlineAt]);
      await historicalPrepare.close();
      stage('real-historical-buyer-write-before-v383-has-v375-financial-facts',
        { historical:historicalCommitted });

      const projectionSource=await readFile(projectionUrl,'utf8');
      report.sourceSha256['legacy-buyer-request-projection-receipt-v383.sql']=
        sha(projectionSource);
      report.sourceSha256['legacy-buyer-request-projection-receipt-v383.ts']=
        sha(await readFile(new URL('../../../packages/core/src/db/postgres/legacy-buyer-request-projection-receipt-v383.ts',import.meta.url)));
      report.sourceSha256['request-body-log-policy.ts']=sha(await readFile(
        new URL('../../../packages/proxy/src/services/request-body-log-policy.ts',
          import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(projectionSource).simple()),
        'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_request_projection_v383_activation='reviewed-v1'`);
        await tx.unsafe(projectionSource).simple();
      });
      await rejected(journal.unsafe(`SELECT * FROM
        cinatoken_buyer_request_projection.receipts_v383`),'42501');
      await rejected(reader.unsafe(`SELECT * FROM
        cinatoken_buyer_request_projection.receipts_v383`),'42501');
      await rejected(buyer.unsafe(`SELECT * FROM
        cinatoken_buyer_request_projection.receipts_v383`),'42501');
      await rejected(journal.unsafe(`SELECT
        cinatoken_buyer_request_projection.read_v383($1::uuid)`,
        [historicalIntent.intentId]),'42501');
      stage('v383-review-only-install-and-dedicated-login-acl');

      await rejected(journal.unsafe(`SELECT
        cinatoken_buyer_request_projection.prepare_v383($1::uuid,$2::jsonb)`,
        [historicalIntent.intentId,
          journal.json(logProjection(historical))]),
        '23514','buyer_projection_late_v383');
      assert.equal(await v383Read(historicalIntent.intentId),'unconfirmed');
      report.latePrepare={ requestId:historical.scenario.requestId,
        earlierFinancialXact:historicalCommitted.receipt.event_xact_id,
        projectionReader:'unconfirmed' };
      stage('already-committed-financial-log-cannot-be-adopted-by-late-v383-intent',
        report.latePrepare);

      // No shared-key quote is claimed for this admission-only log, so its
      // original deferred event constraint permits a historical row.
      const raced={ scenario:await seed('log-commit-races-prewrite-v383',true),
        params:{ requestLog:{} } };
      const racedIntent={ intentId:randomUUID(),
        fullRequestSha256:sha('log-commit-race'),
        deadlineAt:new Date(Date.now()+3_600_000).toISOString(),
        expectedFinancialFacts:{ ...terminalExpected(historical),
          requestId:raced.scenario.requestId,userId:raced.scenario.user,
          apiKeyId:raced.scenario.key,workspaceId:raced.scenario.workspace } };
      const racedPreparation=await openJournalSession();
      await racedPreparation.client.raw.unsafe(`SELECT
        cinatoken_buyer_commit_journal.prepare_v378(
          $1::uuid,$2,$3,$4::jsonb,$5::timestamptz)`,
        [racedIntent.intentId,raced.scenario.requestId,
          racedIntent.fullRequestSha256,
          racedPreparation.client.raw.json(racedIntent.expectedFinancialFacts),
          racedIntent.deadlineAt]);
      await racedPreparation.close();
      const [logWriterIdentity]=await creator.unsafe(`SELECT
        pg_catalog.pg_backend_pid() AS pid`);
      const [journalIdentity]=await journal.unsafe(`SELECT
        pg_catalog.pg_backend_pid() AS pid`);
      let logInserted;
      const logReady=new Promise(resolve => { logInserted=resolve; });
      let releaseLog;
      const logGate=new Promise(resolve => { releaseLog=resolve; });
      const logTransaction=creator.begin(async tx => {
        await tx.unsafe(`SELECT pg_catalog.pg_advisory_xact_lock(
          746923554,pg_catalog.hashtext($1))`,[raced.scenario.requestId]);
        await tx.unsafe(`INSERT INTO ${g}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,created_at)
          VALUES($1,$2,$3,$4,pg_catalog.clock_timestamp())`,
          [raced.scenario.requestId,raced.scenario.user,
            raced.scenario.key,raced.scenario.workspace]);
        logInserted();
        await logGate;
      });
      await Promise.race([logReady,logTransaction.then(() => {
        throw new Error('Race log transaction ended before test barrier');
      },error => { throw error; })]);
      const racedPrepare=journal.unsafe(`SELECT
        cinatoken_buyer_request_projection.prepare_v383($1::uuid,$2::jsonb)`,
        [racedIntent.intentId,journal.json(logProjection(raced))])
        .then(() => null,error => error);
      await waitForBlock(cluster.admin,journalIdentity.pid,logWriterIdentity.pid);
      releaseLog();
      await logTransaction;
      const racedError=await racedPrepare;
      assert.equal(racedError?.code,'23514');
      assert.equal(racedError?.constraint_name,'buyer_projection_late_v383');
      assert.equal(await v383Read(racedIntent.intentId),'unconfirmed');
      stage('concurrent-log-commit-wins-request-lock-and-late-prewrite-fails',
        { requestId:raced.scenario.requestId,
          logWriterPid:logWriterIdentity.pid,journalPid:journalIdentity.pid,
          blockedObserved:true });

      const successful=await appInput('projection-success-v383');
      const successfulIntent=journalIntent(successful,'projection-success');
      // Deliberately bogus complete-wire digest: v383 must still expose only
      // its narrow DB-log projection conclusion.
      successfulIntent.fullRequestSha256='0'.repeat(64);
      let successfulWriterCalls=0;
      const successfulObservation=await runLegacyBuyerProjectionWriteV383(
        successfulIntent,logProjection(successful),openJournalSession,() => {
          successfulWriterCalls++;
          return insertRequestUsageAndChargeTxPg(appDb,successful.params);
        },'review-only');
      assert.equal(successfulObservation.kind,'write_acknowledged');
      assert.equal(successfulWriterCalls,1);
      assert.equal(await v383Read(successfulIntent.intentId),
        'db_log_projection_confirmed');
      const successfulCommitted=await assertCommittedBuyer(successful.scenario);
      const successfulReceipt=await projectionReceipt(successful.scenario.requestId);
      assert.equal(successfulReceipt.intent_id,successfulIntent.intentId);
      const [successfulDbDigest]=await migrator.unsafe(`SELECT
        cinatoken_buyer_request_projection.digest_v383(expected_projection)
          AS digest FROM cinatoken_buyer_request_projection.prewrites_v383
          WHERE intent_id=$1`,[successfulIntent.intentId]);
      assert.equal(successfulReceipt.projection_sha256,successfulDbDigest.digest);
      assert.notEqual(successfulReceipt.projection_sha256,
        successfulIntent.fullRequestSha256);
      report.success={ writerCalls:successfulWriterCalls,
        observation:successfulObservation.kind,
        terminal:'db_log_projection_confirmed',
        falseFullRequestSha256:successfulIntent.fullRequestSha256,
        receipt:successfulReceipt,financial:successfulCommitted };
      stage('real-v372-write-produces-db-generated-same-xact-projection-receipt',
        report.success);
      const actualWireA='{"model":"a","prompt":"one"}';
      const actualWireB='{"model":"a","prompt":"two"}';
      assert.notEqual(sha(actualWireA),sha(actualWireB));
      assert.equal(applyRequestBodyLoggingPolicy(actualWireA,'off'),null);
      assert.equal(applyRequestBodyLoggingPolicy(actualWireB,'off'),null);
      report.completeWireBlocker={ wireSha256A:sha(actualWireA),
        wireSha256B:sha(actualWireB),samePersistedBody:null,
        journalFullDigest:successfulIntent.fullRequestSha256,
        terminal:'db_log_projection_confirmed' };
      stage('distinct-provider-wire-bodies-collapse-to-same-default-off-db-log-view',
        report.completeWireBlocker);

      const replay=journalIntent(successful,'replay-different-digest');
      replay.fullRequestSha256='f'.repeat(64);
      await rejected(journal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.prepare_v378(
          $1::uuid,$2,$3,$4::jsonb,$5::timestamptz)`,
        [replay.intentId,successful.scenario.requestId,
          replay.fullRequestSha256,
          journal.json(replay.expectedFinancialFacts),replay.deadlineAt]),'23505');
      const [oneIntent]=await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_buyer_commit_journal.intents_v378 WHERE request_id=$1`,
        [successful.scenario.requestId]);
      assert.equal(oneIntent.n,1);
      stage('same-request-different-digest-replay-cannot-create-second-intent',
        { requestId:successful.scenario.requestId,intents:oneIntent.n });

      const mismatch=await appInput('projection-mismatch-v383');
      const mismatchIntent=journalIntent(mismatch,'projection-mismatch');
      let mismatchWriterCalls=0;
      const mismatchBefore=await appState(mismatch.scenario);
      const mismatchObservation=await runLegacyBuyerProjectionWriteV383(
        mismatchIntent,{ ...logProjection(mismatch),modelId:'wrong-model' },
        openJournalSession,() => {
          mismatchWriterCalls++;
          return insertRequestUsageAndChargeTxPg(appDb,mismatch.params);
        },'review-only');
      assert.equal(mismatchObservation.kind,'write_unacknowledged');
      assert.equal(mismatchWriterCalls,1);
      assert.deepEqual(await appState(mismatch.scenario),mismatchBefore);
      assert.equal(await v383Read(mismatchIntent.intentId),'unconfirmed');
      stage('actual-buyer-log-projection-mismatch-rolls-back-whole-debit',
        { writerCalls:mismatchWriterCalls,
          reader:'unconfirmed',before:mismatchBefore });

      const wrongA=await appInput('intent-a-writer-b-v383');
      const wrongB=await appInput('writer-b-without-intent-v383');
      const wrongIntent=journalIntent(wrongA,'intent-a-writer-b');
      const beforeB=await appState(wrongB.scenario);
      let wrongWriterCalls=0;
      const wrongObservation=await runLegacyBuyerProjectionWriteV383(
        wrongIntent,logProjection(wrongA),openJournalSession,() => {
          wrongWriterCalls++;
          return insertRequestUsageAndChargeTxPg(appDb,wrongB.params);
        },'review-only');
      assert.equal(wrongObservation.kind,'write_unacknowledged');
      assert.equal(wrongWriterCalls,1);
      assert.deepEqual(await appState(wrongB.scenario),beforeB);
      assert.equal(await v383Read(wrongIntent.intentId),'unconfirmed');
      const [wrongReceipts]=await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_buyer_request_projection.receipts_v383
        WHERE request_id IN ($1,$2)`,
        [wrongA.scenario.requestId,wrongB.scenario.requestId]);
      assert.equal(wrongReceipts.n,0);
      stage('intent-a-callback-writing-b-is-rejected-before-b-financial-commit',
        { writerCalls:wrongWriterCalls,receiptCount:0,beforeB });

      const otherWriter=await appInput('wrong-login-log-insert-v383');
      const otherIntent=journalIntent(otherWriter,'wrong-login');
      let otherCalls=0;
      const otherObservation=await runLegacyBuyerProjectionWriteV383(
        otherIntent,logProjection(otherWriter),openJournalSession,() => {
          otherCalls++;
          return creator.unsafe(`INSERT INTO ${g}.api_key_request_logs
            (id,user_id,api_key_id,workspace_id,created_at)
            VALUES($1,$2,$3,$4,pg_catalog.clock_timestamp())`,
            [otherWriter.scenario.requestId,otherWriter.scenario.user,
              otherWriter.scenario.key,otherWriter.scenario.workspace]);
        },'review-only');
      assert.equal(otherCalls,1);
      assert.equal(otherObservation.kind,'write_unacknowledged');
      const [otherLog]=await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${g}.api_key_request_logs WHERE id=$1`,
        [otherWriter.scenario.requestId]);
      assert.equal(otherLog.n,0);
      assert.equal(await v383Read(otherIntent.intentId),'unconfirmed');
      stage('other-login-cannot-forge-buyer-log-from-verified-prewrite',
        { writerCalls:otherCalls,logCount:otherLog.n });

      const expired=await appInput('expired-prewrite-v383');
      const expiredIntent=journalIntent(expired,'expired-prewrite');
      const expiredBefore=await appState(expired.scenario);
      let expiredWriterCalls=0;
      const expiredObservation=await runLegacyBuyerProjectionWriteV383(
        expiredIntent,logProjection(expired),openJournalSession,async () => {
          expiredWriterCalls++;
          // Privileged fixture-only time warp avoids a 31-second wall wait.
          await migrator.begin(async tx => {
            await tx.unsafe(`ALTER TABLE
              cinatoken_buyer_request_projection.prewrites_v383
              DISABLE TRIGGER guard_prewrites_v383`);
            await tx.unsafe(`UPDATE
              cinatoken_buyer_request_projection.prewrites_v383
              SET verified_at=pg_catalog.clock_timestamp()-INTERVAL '31 seconds'
              WHERE intent_id=$1`,[expiredIntent.intentId]);
            await tx.unsafe(`ALTER TABLE
              cinatoken_buyer_request_projection.prewrites_v383
              ENABLE TRIGGER guard_prewrites_v383`);
          });
          return insertRequestUsageAndChargeTxPg(appDb,expired.params);
        },'review-only');
      assert.equal(expiredObservation.kind,'write_unacknowledged');
      assert.equal(expiredWriterCalls,1);
      assert.deepEqual(await appState(expired.scenario),expiredBefore);
      assert.equal(await v383Read(expiredIntent.intentId),'unconfirmed');
      stage('expired-verified-prewrite-cannot-authorize-later-buyer-debit',
        { writerCalls:expiredWriterCalls,privilegedTimeWarpSeconds:31 });

      const lostWriteAck=await appInput('projection-writer-ack-loss-v383');
      const lostWriteIntent=journalIntent(lostWriteAck,'writer-ack-loss');
      const writeAckProxy=await commitAckProxy(cluster.port);
      let writeAckProxyFailure;
      try {
        const proxiedWriter=connection({ ...cluster,port:writeAckProxy.port },
          'cinatoken_gateway_buyer_settlement',passwords.buyer,
          'v383-writer-ack-loss');
        clients.push(proxiedWriter);
        const [writerIdentity]=await proxiedWriter.unsafe(`SELECT
          pg_catalog.pg_backend_pid() AS pid`);
        const proxiedDb={ driver:'postgres',raw:proxiedWriter,
          drizzle:drizzle(proxiedWriter,{schema:pgCoreSchema}) };
        let writerCalls=0;
        writeAckProxy.arm();
        const pending=runLegacyBuyerProjectionWriteV383(lostWriteIntent,
          logProjection(lostWriteAck),openJournalSession,() => {
            writerCalls++;
            return insertRequestUsageAndChargeTxPg(proxiedDb,lostWriteAck.params);
          },'review-only');
        await writeAckProxy.dropped;
        const observation=await pending;
        assert.equal(observation.kind,'write_unacknowledged');
        assert.equal(writerCalls,1);
        assert.equal(writeAckProxy.observations.droppedCommitAcks,1);
        assert.equal(await v383Read(lostWriteIntent.intentId),
          'db_log_projection_confirmed');
        const receipt=await projectionReceipt(lostWriteAck.scenario.requestId);
        const committed=await assertCommittedBuyer(lostWriteAck.scenario);
        report.writerAckLoss={ writerPid:writerIdentity.pid,writerCalls,
          proxy:{ ...writeAckProxy.observations },receipt,committed };
        stage('writer-commit-command-complete-lost-v383-reader-recovers-same-xact-receipt',
          report.writerAckLoss);
      } catch (error) { writeAckProxyFailure=error; }
      finally {
        try { await writeAckProxy.close(); }
        catch (error) { writeAckProxyFailure ??= error; }
      }
      if (writeAckProxyFailure) throw writeAckProxyFailure;

      const delayed=await appInput('projection-delayed-commit-v383');
      const delayedIntent=journalIntent(delayed,'delayed-commit');
      const delayedBefore=await appState(delayed.scenario);
      const delayProxy=await delayedCommitProxy(cluster.port);
      let delayProxyFailure;
      try {
        const delayedWriter=connection({ ...cluster,port:delayProxy.port },
          'cinatoken_gateway_buyer_settlement',passwords.buyer,
          'v383-delayed-commit');
        clients.push(delayedWriter);
        const [writerIdentity]=await delayedWriter.unsafe(`SELECT
          pg_catalog.pg_backend_pid() AS pid`);
        const delayedDb={ driver:'postgres',raw:delayedWriter,
          drizzle:drizzle(delayedWriter,{schema:pgCoreSchema}) };
        let writerCalls=0;
        const pending=runLegacyBuyerProjectionWriteV383(delayedIntent,
          logProjection(delayed),openJournalSession,() => {
            writerCalls++;
            return insertRequestUsageAndChargeTxPg(delayedDb,delayed.params);
          },'review-only');
        await delayProxy.held;
        const observation=await pending;
        assert.equal(observation.kind,'write_unacknowledged');
        assert.equal(writerCalls,1);
        assert.equal(await v383Read(delayedIntent.intentId),'unconfirmed');
        assert.deepEqual(await appState(delayed.scenario),delayedBefore);
        const [beforeReceipt]=await migrator.unsafe(`SELECT count(*)::int AS n
          FROM cinatoken_buyer_request_projection.receipts_v383
          WHERE request_id=$1`,[delayed.scenario.requestId]);
        assert.equal(beforeReceipt.n,0);
        const [inFlight]=await cluster.admin.unsafe(`SELECT state,
          xact_start IS NOT NULL AS transaction_open FROM pg_catalog.pg_stat_activity
          WHERE pid=$1`,[writerIdentity.pid]);
        assert.equal(inFlight.transaction_open,true);
        await delayProxy.release();
        await delayProxy.committed;
        assert.equal(await v383Read(delayedIntent.intentId),
          'db_log_projection_confirmed');
        const receipt=await projectionReceipt(delayed.scenario.requestId);
        const committed=await assertCommittedBuyer(delayed.scenario);
        report.delayedCommit={ writerPid:writerIdentity.pid,writerCalls,
          first:'unconfirmed',later:'db_log_projection_confirmed',
          beforeReceiptCount:beforeReceipt.n,backendState:inFlight.state,
          proxy:{ ...delayProxy.observations },receipt,committed };
        stage('delayed-pg-commit-is-unconfirmed-then-confirms-after-original-commit',
          report.delayedCommit);
      } catch (error) { delayProxyFailure=error; }
      finally {
        try { await delayProxy.close(); }
        catch (error) { delayProxyFailure ??= error; }
      }
      if (delayProxyFailure) throw delayProxyFailure;

      const lostPrepareAck=await appInput('projection-prepare-ack-loss-v383');
      const lostPrepareIntent=journalIntent(lostPrepareAck,'prepare-ack-loss');
      const prepareProxy=await startJournalCommitAckDropProxyV381({
        upstreamHost:'127.0.0.1',upstreamPort:cluster.port });
      let prepareProxyFailure;
      try {
        const proxiedJournal=connection({ ...cluster,port:prepareProxy.port },
          'cinatoken_gateway_buyer_commit_journal',passwords.journal,
          'v383-prepare-ack-loss');
        clients.push(proxiedJournal);
        let opens=0;
        const openWithLostThirdAck=async () => {
          opens++;
          if (opens!==3) return openJournalSession();
          return { client:{ driver:'postgres',raw:{
            json:value => proxiedJournal.json(value),
            unsafe:(sql,params) => proxiedJournal.begin(
              tx => tx.unsafe(sql,params)),
          } },close:() => proxiedJournal.end({timeout:1}) };
        };
        let writerCalls=0;
        const pending=runLegacyBuyerProjectionWriteV383(lostPrepareIntent,
          logProjection(lostPrepareAck),openWithLostThirdAck,() => {
            writerCalls++;
            return insertRequestUsageAndChargeTxPg(appDb,lostPrepareAck.params);
          },'review-only');
        await prepareProxy.waitForDrop();
        const observation=await pending;
        assert.equal(observation.kind,'projection_prewrite_unacknowledged');
        assert.equal(writerCalls,0);
        assert.equal(prepareProxy.facts.backendCommitCompletes,1);
        assert.equal(prepareProxy.facts.droppedCommitAcks,1);
        const [durable]=await migrator.unsafe(`SELECT p.intent_id::text,
          p.verified_at,p.prepared_backend_pid,
          j.state AS journal_state FROM
          cinatoken_buyer_request_projection.prewrites_v383 p JOIN
          cinatoken_buyer_commit_journal.intents_v378 j
            ON j.intent_id=p.intent_id WHERE p.intent_id=$1`,
          [lostPrepareIntent.intentId]);
        assert.equal(durable.intent_id,lostPrepareIntent.intentId);
        assert.equal(durable.verified_at,null);
        assert.equal(await v383Read(lostPrepareIntent.intentId),'unconfirmed');
        const [noWrite]=await migrator.unsafe(`SELECT count(*)::int AS n FROM
          cinatoken_gateway.api_key_request_logs WHERE id=$1`,
          [lostPrepareAck.scenario.requestId]);
        assert.equal(noWrite.n,0);
        report.prepareAckLoss={ opens,writerCalls,
          proxy:{ ...prepareProxy.facts },durable,noWrite:noWrite.n,
          terminal:'unconfirmed' };
        stage('v383-prewrite-commit-response-lost-durable-intent-but-zero-writer-calls',
          report.prepareAckLoss);
      } catch (error) { prepareProxyFailure=error; }
      finally {
        try { await prepareProxy.close(); }
        catch (error) { prepareProxyFailure ??= error; }
      }
      if (prepareProxyFailure) throw prepareProxyFailure;
      report.backendPids={ journal:journalPids,reader:readerPids };
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
      process.stdout.write(`legacy-buyer-request-projection-v383-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
  });

// Owned PostgreSQL 18.6 proof of the v376 buyer COMMIT ACK loss protocol.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { readLegacyBuyerTerminalV375 } from '../../../packages/core/src/db/postgres/legacy-buyer-terminal-reader-v375.ts';
import { observeLegacyBuyerCommitV376 } from '../../../packages/core/src/db/postgres/legacy-buyer-commit-ack-v376.ts';
import { commitAckProxy } from '../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs';
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
const terminalUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-terminal-reader-v375.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-legacy-buyer-commit-ack-v376-report.json', import.meta.url);
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

test('v376 lost buyer COMMIT response is read without financial replay',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only local PG73 plus proposals; no formal migration, remote SQL, Worker, Provider or production credential changed.',
        'The fixture installs the exact v368 body, v371/v372 successors, real v2 economic producer and budget receipt, v347/v348/v349 buyer-login split, and v350 ordinary admission; it uses a minimal v362 grant table, not every v351–v368 proposal.',
        'The app writer receives manual fixture rights; the separate terminal LOGIN receives only CONNECT plus USAGE/EXECUTE on its isolated schema/function. The v374 production app-rights proposal is not installed here.',
        'The reader confirms exact request/user/key/workspace, amount, tokens, reason, v2 event, every economic attempt, log xid marker and budget receipt. It does not bind route, protocol or provider request payload to an immutable intent digest.',
        'Guardrail reservation terminal rows are checked, but no independent same-transaction marker binds those rows, unreserved windows, user audit or stats to the v2 event. Full application-transaction confirmation still requires a durable receipt covering these side effects.',
        'Buyer log amount and usage evidence remain caller supplied; no independently authenticated final Provider result or bill binds the debit.',
        'A transparent local PostgreSQL protocol proxy forwards COMMIT to native PG18.6, then drops CommandComplete(COMMIT) and the client connection. This does not manipulate TCP ACK packets or exercise a remote Worker/Provider.',
        'The v376 wrapper invokes its supplied writer exactly once. The separate reader LOGIN observes financial facts, but confirmed does not authenticate the full route/protocol/Provider payload; therefore it is not yet a production success acknowledgement.',
        'The wrapper depends on the caller to supply a genuinely fresh terminal-reader connection after failure; its TypeScript code checks the driver, while the v375 SQL checks SESSION_USER. The fixture proves separate backend PIDs and ACLs only for this run. Production factory and credential wiring are absent.',
        'A missing receipt returns unconfirmed and cannot authorize another debit. The native fixture deletes the receipt only as a privileged local retention simulation; it does not exercise the v346 maintenance job.',
        'Only the narrow non-grant current-epoch charged-basis held actual/v2 path is covered. Reserved, old-epoch, late actual, BYOK, recovery, no-hold and grant-linked branches need successors.',
        'The global SHARE ROW EXCLUSIVE window-table lock can reduce capacity; production-scale contention remains unmeasured.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator', 'buyer', 'reader', 'runtime',
        'admission', 'sharedProducer', 'sharedConsumer'].map(x =>
        [x, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${passwords.buyer}';
        CREATE ROLE cinatoken_gateway_buyer_terminal_reader LOGIN NOINHERIT
          PASSWORD '${passwords.reader}';
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
      clients.push(migrator, buyer, reader, concurrentBuyer, creator, runtime,
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
      const readerDb = { driver: 'postgres', raw: reader };
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
      report.sourceSha256['legacy-buyer-commit-ack-v376.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/legacy-buyer-commit-ack-v376.ts',
          import.meta.url)));
      report.sourceSha256['postgres-commit-ack-proxy.mjs'] = sha(await readFile(
        new URL('../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs',
          import.meta.url)));
      const lost = await appInput('commit-ack-v376');
      const expected = terminalExpected(lost);
      const mutableExpected = structuredClone(expected);
      const beforeLost = await appState(lost.scenario);
      assert.equal(beforeLost.logs, 0);
      assert.equal(await readLegacyBuyerTerminalV375(
        readerDb, expected, 'review-only'), 'unconfirmed');
      const [readerIdentity] = await reader.unsafe(`SELECT
        pg_catalog.pg_backend_pid() AS pid, current_user AS login`);
      assert.equal(readerIdentity.login,
        'cinatoken_gateway_buyer_terminal_reader');
      const freshReaderPids = [];
      const openFreshReader = async () => {
        const fresh = connection(cluster,
          'cinatoken_gateway_buyer_terminal_reader', passwords.reader,
          `post-error-reader-${freshReaderPids.length}`);
        clients.push(fresh);
        const [identity] = await fresh.unsafe(`SELECT
          pg_catalog.pg_backend_pid() AS pid, current_user AS login`);
        assert.equal(identity.login,
          'cinatoken_gateway_buyer_terminal_reader');
        assert.notEqual(identity.pid, readerIdentity.pid);
        freshReaderPids.push(identity.pid);
        return { client: { driver: 'postgres', raw: fresh },
          close: () => fresh.end({ timeout: 1 }) };
      };
      stage('pre-write-independent-reader-sees-no-terminal-facts',
        { readerPid: readerIdentity.pid });

      const proxy = await commitAckProxy(cluster.port);
      let proxyFailure;
      try {
        const proxiedWriter = connection({ ...cluster, port: proxy.port },
          'cinatoken_gateway_buyer_settlement', passwords.buyer,
          'ack-loss-v376');
        clients.push(proxiedWriter);
        const [writerIdentity] = await proxiedWriter.unsafe(`SELECT
          pg_catalog.pg_backend_pid() AS pid, current_user AS login`);
        assert.equal(writerIdentity.login,
          'cinatoken_gateway_buyer_settlement');
        assert.notEqual(writerIdentity.pid, readerIdentity.pid);
        const proxiedDb = { driver: 'postgres', raw: proxiedWriter,
          drizzle: drizzle(proxiedWriter, { schema: pgCoreSchema }) };
        let writeInvocations = 0;
        let releaseWrite;
        const writeGate = new Promise(resolve => { releaseWrite = resolve; });
        proxy.arm();
        const observed = observeLegacyBuyerCommitV376(async () => {
          writeInvocations++;
          await writeGate;
          return insertRequestUsageAndChargeTxPg(proxiedDb, lost.params);
        }, openFreshReader, mutableExpected, 'review-only');
        mutableExpected.chargeMicros = 2;
        mutableExpected.outcomes[0].evidence_sha256 = 'b'.repeat(64);
        releaseWrite();
        await proxy.dropped;
        const outcome = await observed;
        assert.equal(outcome.kind, 'write_unacknowledged');
        assert.equal(outcome.financialFacts, 'confirmed');
        assert.equal(writeInvocations, 1);
        assert.equal(mutableExpected.chargeMicros, 2);
        assert.notDeepEqual(mutableExpected.outcomes, expected.outcomes);
        assert.equal(proxy.observations.commitCommands, 1);
        assert.equal(proxy.observations.droppedCommitAcks, 1);
        assert.equal(freshReaderPids.length, 1);
        assert.notEqual(freshReaderPids[0], writerIdentity.pid);
        report.loss = {
          proxy: { ...proxy.observations },
          writerPid: writerIdentity.pid,
          prewriteReaderPid: readerIdentity.pid,
          posterrorReaderPid: freshReaderPids[0],
          writeInvocations,
          writeError: { name: outcome.writeError?.name ?? null,
            code: outcome.writeError?.code ?? null },
          financialFacts: outcome.financialFacts,
        };
        stage('real-postgres-commit-command-completes-but-ack-is-withheld',
          report.loss);
      } catch (error) { proxyFailure = error; }
      finally {
        try { await proxy.close(); }
        catch (error) { proxyFailure ??= error; }
      }
      if (proxyFailure) throw proxyFailure;

      const afterLost = await appState(lost.scenario);
      assert.equal(afterLost.spent, '0.000001');
      assert.equal(afterLost.reserved, '0');
      assert.equal(afterLost.ordinary, 'settled');
      assert.equal(afterLost.guardrail, 'settled');
      assert.deepEqual([afterLost.logs, afterLost.audits,
        afterLost.events, afterLost.event_attempts], [1, 1, 1, 1]);
      const [receipt] = await migrator.unsafe(`SELECT
        m.log_xact_id::text AS event_xact_id,
        b.xact_id::text AS budget_xact_id,
        b.spent_delta_micros::text AS spent_delta
        FROM cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
        JOIN cinatoken_economic_outbox.shared_key_economic_events e
          ON e.request_log_id=m.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
          ON b.xact_id=m.log_xact_id AND b.user_id=e.buyer_user_id
        WHERE m.request_log_id=$1`, [lost.scenario.requestId]);
      assert.equal(receipt.event_xact_id, receipt.budget_xact_id);
      assert.equal(receipt.spent_delta, '1.000000');
      assert.equal(await readLegacyBuyerTerminalV375(
        readerDb, expected, 'review-only'), 'confirmed');
      stage('fresh-reader-and-durable-xid8-receipt-confirm-one-debit',
        { receipt, state: afterLost });
      stage('pre-write-expectation-snapshot-survives-concurrent-nested-mutation');

      await assert.rejects(insertRequestUsageAndChargeTxPg(appDb,
        lost.params), /replay needs a committed terminal read protocol/u);
      assert.deepEqual(await appState(lost.scenario), afterLost);
      stage('direct-replay-is-rejected-without-a-second-debit');

      const alternateRequest = { ...lost.params.requestLog,
        modelId: 'v376/different-model',
        routeTargetId: 'v376-different-target',
        requestOrigin: 'https://different.example.invalid' };
      const alternate = { ...lost, params: { ...lost.params,
        requestLog: alternateRequest } };
      assert.notEqual(alternateRequest.routeTargetId,
        lost.params.requestLog.routeTargetId);
      const [storedRequest] = await migrator.unsafe(`SELECT model_id,
        route_target_id,request_origin FROM ${g}.api_key_request_logs
        WHERE id=$1`, [lost.scenario.requestId]);
      assert.deepEqual(storedRequest, {
        model_id: lost.params.requestLog.modelId,
        route_target_id: lost.params.requestLog.routeTargetId,
        request_origin: lost.params.requestLog.requestOrigin,
      });
      assert.deepEqual(terminalExpected(alternate), expected);
      assert.equal(await readLegacyBuyerTerminalV375(
        readerDb, terminalExpected(alternate), 'review-only'), 'confirmed');
      stage('strict-negative-route-model-and-origin-identity-remain-unbound',
        { storedRequest,
          changedFields: ['modelId', 'routeTargetId', 'requestOrigin'] });

      const rolled = await appInput('commit-rollback-v376');
      const beforeRolled = await appState(rolled.scenario);
      await migrator.unsafe(`ALTER TABLE ${g}.user_audit_logs
        ADD CONSTRAINT v376_reject_late_audit CHECK
          (request_log_id<>'${rolled.scenario.requestId}')`);
      try {
        let writeInvocations = 0;
        const result = await observeLegacyBuyerCommitV376(() => {
          writeInvocations++;
          return insertRequestUsageAndChargeTxPg(appDb, rolled.params);
        }, openFreshReader, terminalExpected(rolled), 'review-only');
        assert.equal(writeInvocations, 1);
        assert.equal(result.kind, 'write_unacknowledged');
        assert.equal(result.financialFacts, 'unconfirmed');
        assert.deepEqual(await appState(rolled.scenario), beforeRolled);
      } finally {
        await migrator.unsafe(`ALTER TABLE ${g}.user_audit_logs
          DROP CONSTRAINT v376_reject_late_audit`);
      }
      stage('late-audit-error-rolls-back-and-unconfirmed-never-retries');

      const conflict = await seed('old-log-conflict-v376');
      await insertLog(migrator, conflict);
      const beforeConflict = await appState(conflict);
      assert.equal(beforeConflict.logs, 1);
      const conflictExpected = { ...expected,
        requestId: conflict.requestId, userId: conflict.user,
        apiKeyId: conflict.key, workspaceId: conflict.workspace };
      let conflictInvocations = 0;
      const conflictResult = await observeLegacyBuyerCommitV376(() => {
        conflictInvocations++;
        return buyer.begin(tx => insertLog(tx, conflict));
      }, openFreshReader, conflictExpected, 'review-only');
      assert.equal(conflictInvocations, 1);
      assert.equal(conflictResult.kind, 'write_unacknowledged');
      assert.equal(conflictResult.financialFacts, 'conflict');
      assert.deepEqual(await appState(conflict), beforeConflict);
      stage('preexisting-unreceipted-log-rejects-duplicate-and-conflicts');

      await migrator.unsafe(`DELETE FROM
        cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
        WHERE xact_id=$1::xid8 AND user_id=$2`,
      [receipt.event_xact_id, lost.scenario.user]);
      let attemptedAgain = 0;
      const missingReceipt = await observeLegacyBuyerCommitV376(() => {
        attemptedAgain++;
        throw new Error('prior write response unavailable');
      }, openFreshReader, expected, 'review-only');
      assert.equal(attemptedAgain, 1);
      assert.equal(missingReceipt.kind, 'write_unacknowledged');
      assert.equal(missingReceipt.financialFacts, 'unconfirmed');
      assert.deepEqual(await appState(lost.scenario), afterLost);
      stage('pruned-receipt-remains-unconfirmed-and-wrapper-does-not-replay');
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
      process.stdout.write(`legacy-buyer-commit-ack-v376-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
  });

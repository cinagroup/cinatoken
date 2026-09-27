// Owned PostgreSQL 18.6 counterexample: v361 quote admission versus v372 buyer writer.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
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
const counterPolicyUrl = new URL('../../../packages/core/migrations-proposals/postgres/buyer-split-counter-grant-policy-v368.sql', import.meta.url);
const appPrivilegesUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-windowed-app-privileges-v374.sql', import.meta.url);
const renewalPrivilegesUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-windowed-app-privileges-renewal-v376.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-admission-buyer-v379-report.json', import.meta.url);
const proposal = name => new URL(`../../../packages/core/migrations-proposals/postgres/${name}`, import.meta.url);
const extraRoles = {
  recovery: 'cinatoken_gateway_budget_recovery',
  capability: 'cinatoken_gateway_request_capability_issuer',
  claim: 'cinatoken_gateway_request_capability_claim',
  ceiling: 'cinatoken_gateway_request_route_ceiling_issuer',
  verifier: 'cinatoken_gateway_route_source_verifier',
  quote: 'cinatoken_gateway_complete_text_quote_issuer',
  granter: 'cinatoken_gateway_complete_text_attempt_granter',
  holder: 'cinatoken_gateway_complete_text_send_holder',
  renewer: 'cinatoken_gateway_complete_text_hold_renewer',
};
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

test('v379 real quote admission and narrow buyer writer boundary in one database',
  { timeout: 360_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only local PG73 and proposals; no formal migration, remote SQL, Worker, Provider or production credential changed.',
        'v360/v361 support only strict flat-text platform-credential routes. The v372 economic event requires a shared-key quote attempt, so the synthetic shared-key attempt in the no-grant control is a demonstrated cross-domain mismatch, not a legitimate platform send.',
        'The grant-linked path is expected to fail at v368. A full legitimate platform buyer settlement requires a successor writer bound to committed grant and result facts.',
        'The direct v351 reserve before v361 activation only validates a prerequisite grant; v379 request holds are created solely by v361 admission under its dedicated LOGIN.',
        'No physical secret holder, upstream send, authenticated result, remote database, production role routing, or platform charge is established.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator', 'buyer', 'runtime',
        'admission', 'sharedProducer', 'sharedConsumer', ...Object.keys(extraRoles)].map(x =>
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
        ${Object.entries(extraRoles).map(([label, name]) =>
          `CREATE ROLE ${name} LOGIN NOINHERIT PASSWORD '${passwords[label]}';`).join('\n')}
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_buyer_settlement,cinatoken_gateway_runtime,
          cinatoken_gateway_budget_admission,
          cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer,
          ${Object.values(extraRoles).join(',')};
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
      const renewer = connection(cluster, extraRoles.renewer,
        passwords.renewer, 'renewer');
      clients.push(migrator, buyer, concurrentBuyer, creator, runtime,
        admission, sharedProducer, renewer);
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

      // Install the exact narrow v368 body before the buyer-split grant
      // runners. PL/pgSQL resolves its later v362 table only when invoked.
      const oldSource = await readFile(oldSqlUrl, 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-held-writer-v368.sql'] = sha(oldSource);
      const begin = oldSource.indexOf(`CREATE FUNCTION ${g}.settle_legacy_buyer_held_v368(`);
      const end = oldSource.indexOf('$settle$;', begin) + '$settle$;'.length;
      assert.ok(begin >= 0 && end > begin);
      await migrator.unsafe(oldSource.slice(begin, end)).simple();
      await migrator.unsafe(`REVOKE ALL ON FUNCTION
          ${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
          FROM PUBLIC,cinatoken_gateway_runtime;
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
      stage('v347-buyer-v2-producer-v348-v349-split-and-v350-admission-installed');

      const completeTextPrerequisites = [
        ['guardrail-budget-admission-login-v351.sql',
          'guardrail_budget_admission_v351_activation'],
        ['authenticated-request-capability-login-v356.sql',
          'request_capability_login_activation'],
        ['authenticated-text-route-ceiling-issuer-v357.sql',
          'request_route_ceiling_activation'],
        ['authenticated-text-route-source-fence-v359.sql',
          'route_source_fence_activation'],
        ['authenticated-complete-text-quote-v360.sql',
          'complete_text_quote_activation'],
        ['complete-text-quote-budget-admission-v361.sql',
          'complete_text_budget_admission_activation'],
        ['complete-text-attempt-grant-v362.sql',
          'complete_text_attempt_grant_activation'],
        ['complete-text-send-start-v365.sql',
          'complete_text_send_start_activation'],
        ['guardrail-budget-lifecycle-login-v353.sql',
          'guardrail_budget_lifecycle_v353_activation'],
        ['ordinary-budget-recovery-login-v354.sql',
          'ordinary_budget_recovery_v354_activation'],
        ['complete-text-legacy-reaper-fence-v366.sql',
          'complete_text_legacy_reaper_fence_v366_activation'],
      ];
      for (const [name, setting] of completeTextPrerequisites) {
        const body = await readFile(proposal(name), 'utf8');
        report.sourceSha256[name] = sha(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
        if (name === 'guardrail-budget-admission-login-v351.sql') {
          await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
              VALUES('v376-admission-user','v376-admission@example.invalid',10);
            INSERT INTO ${g}.workspaces
              (id,scope_type,personal_owner_user_id,name,slug,status)
              VALUES('v376-admission-workspace','personal',
                'v376-admission-user','Admission','v376-admission','active');
            INSERT INTO ${g}.api_keys
              (id,key,key_hash,user_id,workspace_id,status,limit_micros,limit_reset)
              VALUES('v376-admission-key','hashref:v376','sha256:v376',
                'v376-admission-user','v376-admission-workspace','active',
                1000000,'daily');`).simple();
          const [ordinaryLegacy] = await admission.unsafe(`SELECT
            ${g}.reserve_user_budget_v350(
              'v376-v351-admission','v376-admission-user',
              'v376-admission-key',0,10,pg_catalog.clock_timestamp(),
              pg_catalog.clock_timestamp()+INTERVAL '90 seconds') AS value`);
          assert.equal(ordinaryLegacy.value.status, 'reserved');
          const admissionIntent = [{
            workspaceId: 'v376-admission-workspace',
            assignmentId: 'gateway-key-limit:v376-admission-key',
            guardrailId: 'gateway-key-limit:v376-admission-key',
            guardrailVersion: 1, scopeType: 'api_key',
            scopeId: 'v376-admission-key', period: 'daily',
            periodStart, periodEnd, limitMicros: 1000000,
          }];
          const [reserved] = await admission.unsafe(`SELECT
            ${g}.reserve_guardrail_budgets_v351(
              'v376-v351-admission','v376-admission-user',
              'v376-admission-key',$1::jsonb,10,'charged',
              pg_catalog.clock_timestamp(),
              pg_catalog.clock_timestamp()+INTERVAL '1 minute') AS value`,
          [admission.json(admissionIntent)]);
          assert.equal(reserved.value.status, 'reserved');
          const [marked] = await admission.unsafe(`SELECT
            ${g}.mark_guardrail_budgets_dispatched_v351(
              'v376-v351-admission',pg_catalog.clock_timestamp(),
              pg_catalog.clock_timestamp()+INTERVAL '30 seconds') AS value`);
          assert.equal(marked.value, true);
          stage('v350-v351-dedicated-login-creates-genuine-legacy-ordinary-and-guardrail-holds');
        }
      }
      stage('full-v351-through-v366-prerequisite-chain-installed');
      const counterPolicy = await readFile(counterPolicyUrl, 'utf8');
      report.sourceSha256['buyer-split-counter-grant-policy-v368.sql'] =
        sha(counterPolicy);
      const [pre368] = await migrator.unsafe(`SELECT
        current_user AS role,
        (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\\n'
          ORDER BY version COLLATE "C"))
          FROM ${g}.schema_migrations) AS migration_hash,
        (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=
          '${g}.buyer_split_grant_policy_v348()'::pg_catalog.regprocedure)
          AS marker_348,
        (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=
          '${g}.buyer_split_guardrail_grant_policy_v349()'
            ::pg_catalog.regprocedure) AS marker_349,
        (SELECT pg_catalog.md5(pg_catalog.replace(prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          FROM pg_catalog.pg_proc WHERE oid=
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)'
            ::pg_catalog.regprocedure) AS writer_hash,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS buyer_exec,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS runtime_exec,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.users','budget_spent','UPDATE') AS buyer_spent,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.users','budget_reserved_micros','UPDATE') AS buyer_reserved,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_windows','UPDATE') AS buyer_window,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger WHERE tgname IN
          ('complete_text_ordinary_hold_fence_v366',
            'complete_text_guardrail_hold_fence_v366')
          AND tgenabled='O' AND NOT tgisinternal) AS fence_triggers`);
      stage('v368-policy-preconditions-observed', { pre368 });
      await rejected(migrator.begin(tx => tx.unsafe(counterPolicy).simple()),
        'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.buyer_counter_grant_policy_v368_activation='reviewed-v1'`);
        await tx.unsafe(counterPolicy).simple();
      });
      stage('v368-full-counter-policy-revokes-raw-buyer-rights-and-supersedes-old-grants');

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


      const appPrivileges = await readFile(appPrivilegesUrl, 'utf8');
      report.sourceSha256['legacy-buyer-windowed-app-privileges-v374.sql'] =
        sha(appPrivileges);
      const [pre374] = await migrator.unsafe(`SELECT
        (SELECT pg_catalog.md5(pg_catalog.replace(prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          FROM pg_catalog.pg_proc WHERE oid=
          '${g}.reject_complete_text_enrolled_hold_mutation_v366()'
            ::pg_catalog.regprocedure) AS fence_hash,
        (SELECT pg_catalog.md5(pg_catalog.replace(prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          FROM pg_catalog.pg_proc WHERE oid=
          '${g}.settle_legacy_buyer_windowed_v371(text,text)'
            ::pg_catalog.regprocedure) AS window_hash,
        (SELECT proconfig::text FROM pg_catalog.pg_proc WHERE oid=
          '${g}.settle_legacy_buyer_windowed_v371(text,text)'
            ::pg_catalog.regprocedure) AS window_config,
        (SELECT pg_catalog.md5(pg_catalog.replace(prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          FROM pg_catalog.pg_proc WHERE oid=
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'
            ::pg_catalog.regprocedure) AS producer_hash,
        (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=
          '${g}.buyer_split_counter_policy_v368()'
            ::pg_catalog.regprocedure) AS marker_368,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','UPDATE') AS buyer_key_update,
        (SELECT count(*)::int FROM pg_catalog.pg_attribute a
          WHERE a.attrelid='${g}.api_keys'::pg_catalog.regclass
            AND a.attnum>0 AND NOT a.attisdropped
            AND a.attname<>'updated_at'
            AND pg_catalog.has_column_privilege(
              'cinatoken_gateway_buyer_settlement',a.attrelid,a.attname,'UPDATE'))
          AS buyer_key_other_update,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.users','UPDATE') AS buyer_user_update,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.user_budget_reservations','UPDATE') AS buyer_hold_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_reservations',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          AS buyer_guardrail_dml,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.public_model_daily_stats',
          'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          AS buyer_stats_extra,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${g}.guardrail_budget_windows','INSERT,UPDATE,DELETE')
          AS runtime_window_dml,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
          '${g}.guardrail_budget_windows','INSERT,UPDATE')
          AS runtime_window_column_dml,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${g}.user_budget_reservations','INSERT,UPDATE,DELETE')
          AS runtime_hold_dml,
        (SELECT count(*)::int FROM pg_catalog.pg_class c
          WHERE c.oid IN ('${g}.users'::pg_catalog.regclass,
            '${g}.api_keys'::pg_catalog.regclass,
            '${g}.user_budget_reservations'::pg_catalog.regclass,
            '${g}.guardrail_budget_reservations'::pg_catalog.regclass,
            '${g}.guardrail_budget_windows'::pg_catalog.regclass,
            '${g}.api_key_request_logs'::pg_catalog.regclass,
            '${g}.user_audit_logs'::pg_catalog.regclass,
            '${g}.provider_attempt_availability'::pg_catalog.regclass,
            '${g}.public_model_daily_stats'::pg_catalog.regclass)
            AND c.relkind='r' AND c.relowner=
              'cinatoken_gateway_migrator'::pg_catalog.regrole)
          AS owned_tables,
        (SELECT count(*)::int FROM pg_catalog.pg_auth_members m
          WHERE m.roleid IN ('cinatoken_gateway_buyer_settlement'::pg_catalog.regrole,
            'cinatoken_gateway_runtime'::pg_catalog.regrole,
            'cinatoken_gateway_budget_admission'::pg_catalog.regrole)
            OR m.member IN ('cinatoken_gateway_buyer_settlement'::pg_catalog.regrole,
            'cinatoken_gateway_runtime'::pg_catalog.regrole,
            'cinatoken_gateway_budget_admission'::pg_catalog.regrole))
          AS memberships,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.user_audit_logs','SELECT') AS buyer_audit_select,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.provider_attempt_availability','SELECT') AS buyer_attempt_select,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE')
          AS buyer_window_exec,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS buyer_producer_exec,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS runtime_producer_exec,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE')
          AS runtime_window_exec,
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
          '${g}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
          'EXECUTE') AS admission_exec`);
      stage('v374-policy-preconditions-observed', { pre374 });
      await rejected(migrator.begin(tx => tx.unsafe(appPrivileges).simple()),
        'P0001');
      assert.equal(pre374.admission_exec, false);
      await rejected(migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_windowed_app_privileges_v374_activation='reviewed-v1'`);
        await tx.unsafe(appPrivileges).simple();
      }), 'P0001');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT EXECUTE ON FUNCTION
          ${g}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)
          TO cinatoken_gateway_budget_admission`);
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_windowed_app_privileges_v374_activation='reviewed-v1'`);
        await tx.unsafe(appPrivileges).simple();
        throw new Error('v374-direct-v350-positive-control-rollback');
      }), /v374-direct-v350-positive-control-rollback/u);
      stage('v374-rejects-full-v361-privilege-chain-P0001-and-rollback-control-proves-cause',
        { code: 'P0001', rawV350Execute: pre374.admission_exec });

      const renewalSql = await readFile(proposal(
        'complete-text-all-hold-renewal-v367.sql'), 'utf8');
      report.sourceSha256['complete-text-all-hold-renewal-v367.sql'] =
        sha(renewalSql);
      await rejected(migrator.begin(tx => tx.unsafe(renewalSql).simple()),
        'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'`);
        await tx.unsafe(renewalSql).simple();
      });
      const [fullRenewal] = await migrator.unsafe(`SELECT
        pg_catalog.md5(pg_catalog.replace(f.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          AS fence_hash,
        pg_catalog.md5(pg_catalog.replace(r.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          AS renewal_hash,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t
          WHERE t.tgname IN ('complete_text_ordinary_hold_fence_v366',
            'complete_text_guardrail_hold_fence_v366')
            AND t.tgenabled='O' AND t.tgfoid=f.oid
            AND NOT t.tgisinternal) AS fence_triggers,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t
          WHERE t.tgname='complete_text_hold_renewals_v367_no_mutation'
            AND t.tgenabled='O' AND NOT t.tgisinternal) AS epoch_triggers
        FROM pg_catalog.pg_proc f CROSS JOIN pg_catalog.pg_proc r
        WHERE f.oid='${g}.reject_complete_text_enrolled_hold_mutation_v366()'
          ::pg_catalog.regprocedure
          AND r.oid='${g}.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)'
          ::pg_catalog.regprocedure`);
      assert.deepEqual(fullRenewal, {
        fence_hash: 'fbb71177d61d3e668bea3b662a5769f5',
        renewal_hash: '61cef47071a34d3821b1377e959abf7b',
        fence_triggers: 2, epoch_triggers: 1,
      });
      const [missingGrant] = await renewer.unsafe(`SELECT
        ${g}.renew_complete_text_holds_v367(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
          pg_catalog.gen_random_uuid(),1) AS value`);
      assert.equal(missingGrant.value.status, 'missing_grant');
      await rejected(buyer.unsafe(`SELECT ${g}.renew_complete_text_holds_v367(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
        pg_catalog.gen_random_uuid(),1)`), '42501');
      await rejected(renewer.unsafe(`SELECT * FROM
        ${g}.complete_text_hold_renewals_v367`), '42501');
      stage('full-v367-renewal-replaces-fence-with-isolated-renewer-login',
        { fullRenewal });

      await rejected(migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_windowed_app_privileges_v374_activation='reviewed-v1'`);
        await tx.unsafe(appPrivileges).simple();
      }), 'P0001');
      const renewalPrivileges = await readFile(renewalPrivilegesUrl, 'utf8');
      report.sourceSha256['legacy-buyer-windowed-app-privileges-renewal-v376.sql'] =
        sha(renewalPrivileges);
      const renewalAppGrant = () => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_windowed_app_privileges_v376_activation='reviewed-v1'`);
        await tx.unsafe(renewalPrivileges).simple();
      });
      await rejected(migrator.begin(tx => tx.unsafe(renewalPrivileges).simple()),
        'P0001');
      await migrator.unsafe(`REVOKE INSERT ON ${g}.user_audit_logs
        FROM cinatoken_gateway_buyer_settlement`);
      await renewalAppGrant();
      await renewalAppGrant();
      const rejectV376Drift = async driftSql => rejected(
        migrator.begin(async tx => {
          await tx.unsafe(driftSql).simple();
          await tx.unsafe(`SET LOCAL
            cinatoken.legacy_buyer_windowed_app_privileges_v376_activation='reviewed-v1'`);
          await tx.unsafe(renewalPrivileges).simple();
        }), 'P0001');
      await rejectV376Drift(`GRANT INSERT ON TABLE
        ${g}.complete_text_hold_renewals_v367
        TO cinatoken_gateway_buyer_settlement`);
      await rejectV376Drift(`DROP TRIGGER
          complete_text_ordinary_hold_fence_v366 ON
          ${g}.user_budget_reservations;
        CREATE TRIGGER complete_text_ordinary_hold_fence_v366
          BEFORE INSERT OR UPDATE OR DELETE ON
          ${g}.user_budget_reservations
          FOR EACH ROW WHEN (false) EXECUTE FUNCTION
          ${g}.reject_complete_text_enrolled_hold_mutation_v366()`);
      await rejectV376Drift(`DROP TRIGGER
          complete_text_hold_renewals_v367_no_mutation ON
          ${g}.complete_text_hold_renewals_v367;
        CREATE TRIGGER complete_text_hold_renewals_v367_no_mutation
          BEFORE UPDATE OF lease_until OR DELETE ON
          ${g}.complete_text_hold_renewals_v367
          FOR EACH ROW EXECUTE FUNCTION
          ${g}.reject_complete_text_hold_renewal_mutation_v367()`);
      await rejected(migrator.begin(async tx => {
        await tx.unsafe(`REVOKE EXECUTE ON FUNCTION
          ${g}.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)
          FROM cinatoken_gateway_complete_text_hold_renewer`);
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_windowed_app_privileges_v376_activation='reviewed-v1'`);
        await tx.unsafe(renewalPrivileges).simple();
      }), 'P0001');
      await assert.rejects(grantPostgresRuntime({ DATABASE_URL: migratorUrl }),
        /Request capability v356 is installed/u);
      await assert.rejects(grantPostgresBuyerSplitV348(
        { DATABASE_URL: migratorUrl }), /drift or dependency differs/u);
      await assert.rejects(grantPostgresBuyerGuardrailSplitV349(
        { DATABASE_URL: migratorUrl }), /drift or dependency differs/u);
      await rejected(admission.unsafe(`SELECT ${g}.reserve_user_budget_v350(
        'missing','u','k',0,10,pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp()+INTERVAL '1 minute')`), '42501');
      await rejected(admission.unsafe(`SELECT ${g}.reserve_guardrail_budgets_v351(
        'missing','u','k','[]'::jsonb,10,'charged',
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp()+INTERVAL '1 minute')`), '42501');
      stage('v376-repairs-buyer-acl-and-rejects-renewal-grant-or-trigger-drift');

      await buyer.unsafe(`SELECT id FROM ${g}.api_keys WHERE false FOR UPDATE`);
      await rejected(buyer.unsafe(`SELECT key FROM ${g}.api_keys
        WHERE false`), '42501');
      await rejected(buyer.unsafe(`SELECT * FROM ${g}.workspaces
        WHERE false`), '42501');
      await rejected(buyer.unsafe(`UPDATE ${g}.api_keys
        SET workspace_id=workspace_id WHERE false`), '42501');
      await rejected(buyer.unsafe(`UPDATE ${g}.users
        SET budget_spent=budget_spent+0.000001 WHERE false`), '42501');
      await rejected(buyer.unsafe(`UPDATE ${g}.user_budget_reservations
        SET state='settled' WHERE false`), '42501');
      await rejected(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET unreserved_micros=unreserved_micros+1 WHERE false`), '42501');
      await rejected(runtime.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET unreserved_micros=unreserved_micros+1 WHERE false`), '42501');
      await rejected(runtime.unsafe(`UPDATE ${g}.guardrail_budget_reservations
        SET state='settled' WHERE false`), '42501');
      await rejected(runtime.unsafe(`SELECT ${g}.settle_legacy_buyer_windowed_v371(
        'missing','runtime_bypass')`), '42501');
      await rejected(buyer.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        'missing',1,1,'old_bypass')`), '42501');
      const [appAcl] = await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_windows','UPDATE') AS window_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${g}.guardrail_budget_windows','UPDATE') AS runtime_window_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${g}.guardrail_budget_reservations','UPDATE') AS runtime_reservation_update,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.users','UPDATE') AS user_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','UPDATE') AS key_broad_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','SELECT') AS key_broad_select,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','key','SELECT') AS key_secret_select,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','id','SELECT') AS key_id_select,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','workspace_id','SELECT') AS key_workspace_select,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.workspaces','SELECT') AS workspace_broad_select,
        pg_catalog.has_column_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.api_keys','updated_at','UPDATE') AS key_row_lock,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.user_audit_logs','INSERT') AS audit_insert,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          'cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            text,text,text,bigint,jsonb,text)','EXECUTE') AS v2_event`);
      assert.deepEqual(appAcl, { window_update: false,
        runtime_window_update: false, runtime_reservation_update: false,
        user_update: false, key_broad_update: false,
        key_broad_select: false, key_secret_select: false,
        key_id_select: true, key_workspace_select: true,
        workspace_broad_select: false, key_row_lock: true,
        audit_insert: true, v2_event: true });
      stage('buyer-login-has-exact-app-rights-without-raw-financial-update',
        { appAcl });

      const capability = connection(cluster, extraRoles.capability,
        passwords.capability, 'capability');
      const verifier = connection(cluster, extraRoles.verifier,
        passwords.verifier, 'verifier');
      const quoteIssuer = connection(cluster, extraRoles.quote,
        passwords.quote, 'quote');
      const granter = connection(cluster, extraRoles.granter,
        passwords.granter, 'granter');
      clients.push(capability, verifier, quoteIssuer, granter);
      const bearer = 'sk-local-v379-platform-bearer';
      const keyHash = `sha256:${sha(bearer)}`;
      const originalHash = sha('v379-original-ingress-body');
      const finalBody = JSON.stringify({ model: 'v379-model',
        models: ['v379-model'], messages: [{ role: 'user', content: 'hello' }],
        max_completion_tokens: 300 });
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
          VALUES('v379-user','v379@example.invalid',10);
        INSERT INTO ${g}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v379-workspace','personal','v379-user',
            'V379 Platform','v379-platform','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status,limit_micros,limit_reset)
        VALUES('v379-key',$1,$2,'v379-user','v379-workspace',
          'active',2000000,'daily')`, [`hashref:${keyHash}`, keyHash]);
      await migrator.unsafe(`INSERT INTO ${g}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v379-budget','v379-workspace','daily',2000000);
        INSERT INTO ${g}.guardrails
          (id,workspace_id,owner_user_id,name,status)
          VALUES('v379-guardrail','v379-workspace','v379-user',
            'Budget','active');
        INSERT INTO ${g}.guardrail_versions
          (id,guardrail_id,version,config_json)
          VALUES('v379-version','v379-guardrail',1,
            '{"budget":{"limit":2,"period":"daily"}}');
        INSERT INTO ${g}.guardrail_assignments
          (id,workspace_id,guardrail_id,scope_type,scope_id)
          VALUES('v379-assignment','v379-workspace','v379-guardrail',
            'user','v379-user');
        INSERT INTO ${g}.providers(id,name,api_key,status)
          VALUES('v379-provider','V379 Provider','enc:v2:fixture','active');
        INSERT INTO ${g}.models(id,vendor) VALUES('v379-model','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
          VALUES('v379-pool','v379-model','default','Default','active');
        INSERT INTO ${g}.model_surfaces
          (id,model_id,route_group,request_protocol,request_operation,
            route_pool_id,status)
          VALUES('v379-surface','v379-model','default','openai','chat',
            'v379-pool','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
          VALUES('v379-route','v379-model','v379-provider','upstream-v379',
            'v379-pool','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            evidence_url,verified_by,verified_at,expires_at,status)
          VALUES('v379-endpoint','v379-model','v379-provider','v379-provider',
            'default',1000,
            '{"currency":"USD","prompt":"0.000010","completion":"0.000020"}',
            'https://example.invalid/v379','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
          VALUES('v379-endpoint','v379-route');`).simple();
      const [route] = await migrator.unsafe(`SELECT provider_id,
        provider_model_name,custom_params,upstream_protocol,
        upstream_operation,adapter FROM ${g}.model_routes
        WHERE id='v379-route'`);
      const [provider] = await migrator.unsafe(`SELECT id,endpoints,api_key,
        shared_channel_type FROM ${g}.providers WHERE id='v379-provider'`);
      const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
        route, provider);
      await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
        SET subject_fingerprint=$1 WHERE route_target_id='v379-route'`,
      [fingerprint]);
      const [generation] = await verifier.unsafe(`SELECT generation::text AS n
        FROM ${g}.route_source_generations_v359
        WHERE route_target_id='v379-route'`);
      const [attested] = await verifier.unsafe(`SELECT
        ${g}.attest_text_route_source_v359('v379-route',$1,$2) AS value`,
      [generation.n, fingerprint]);
      assert.equal(attested.value.status, 'attested');
      stage('v379-platform-route-and-budget-sources-ready');

      const intents = () => {
        const common = { workspaceId: 'v379-workspace', guardrailVersion: 1,
          period: 'daily', periodStart, periodEnd, limitMicros: 2000000 };
        return [
          { ...common, assignmentId: 'v379-assignment',
            guardrailId: 'v379-guardrail', scopeType: 'user',
            scopeId: 'v379-user' },
          { ...common, assignmentId: 'workspace-budget:v379-budget',
            guardrailId: 'workspace-budget:v379-budget',
            scopeType: 'workspace', scopeId: 'v379-workspace' },
          { ...common, assignmentId: 'gateway-key-limit:v379-key',
            guardrailId: 'gateway-key-limit:v379-key',
            scopeType: 'api_key', scopeId: 'v379-key' },
        ];
      };
      const issueQuote = async label => {
        const requestId = `v379-${label}-${randomUUID()}`;
        const [issued] = await capability.unsafe(`SELECT
          ${g}.issue_request_capability_v356($1,$2,$3) AS value`,
        [requestId, bearer, originalHash]);
        assert.equal(issued.value.status, 'issued');
        const [quoted] = await quoteIssuer.unsafe(`SELECT
          ${g}.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value`,
        [requestId, issued.value.capability, originalHash, finalBody]);
        assert.equal(quoted.value.status, 'quoted_complete_subset');
        const quote = quoted.value;
        assert.equal(Number(quote.threeAttemptCeilingMicros), 90003);
        return quote;
      };
      const admitQuote = async quote => {
        const requestId = quote.requestId;
        const [admitted] = await admission.unsafe(`SELECT
          ${g}.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb)
            AS value`, [requestId, quote.quoteId, admission.json(intents())]);
        assert.equal(admitted.value.status, 'admitted');
        assert.equal(Number(admitted.value.reservedMicros), 90003);
        assert.equal(admitted.value.finalBodySha256, sha(finalBody));
        const [ordinary] = await migrator.unsafe(`SELECT user_id,api_key_id,
          reserved_micros::text AS amount,state
          FROM ${g}.user_budget_reservations WHERE request_id=$1`,
        [requestId]);
        assert.deepEqual(ordinary, { user_id: 'v379-user',
          api_key_id: 'v379-key', amount: '90003', state: 'reserved' });
        const guards = await migrator.unsafe(`SELECT reserved_micros::text AS amount,
          state,settlement_basis FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1`, [requestId]);
        assert.equal(guards.length, 3);
        assert.ok(guards.every(row => row.amount === '90003' &&
          row.state === 'reserved' && row.settlement_basis === 'charged'));
        return admitted.value;
      };
      const issueAndAdmit = async label => {
        const quote = await issueQuote(label);
        await admitQuote(quote);
        return quote;
      };
      const quoteWithoutGrant = await issueAndAdmit('without-grant');
      const quoteWithGrant = await issueAndAdmit('with-grant');
      stage('dedicated-v361-login-creates-real-quote-bound-ordinary-and-guardrail-holds',
        { requests: [quoteWithoutGrant.requestId, quoteWithGrant.requestId],
          reservedMicros: 90003, guardrailHoldsPerRequest: 3 });

      const [manifest] = await migrator.unsafe(`SELECT candidate_index,model_id,
        route_target_id,provider_id,endpoint_id,credential_class,
        credential_id,provider_ciphertext_sha256
        FROM ${g}.complete_text_quote_routes_v360
        WHERE quote_id=$1::uuid ORDER BY candidate_index,route_target_id
        LIMIT 1`, [quoteWithGrant.quoteId]);
      assert.equal(manifest.credential_class, 'platform');
      const grantClaim = { requestId: quoteWithGrant.requestId,
        quoteId: quoteWithGrant.quoteId,
        finalBodySha256: quoteWithGrant.finalBodySha256,
        candidateIndex: manifest.candidate_index, modelId: manifest.model_id,
        routeTargetId: manifest.route_target_id,
        providerId: manifest.provider_id, endpointId: manifest.endpoint_id,
        credentialClass: manifest.credential_class,
        credentialId: manifest.credential_id,
        providerCiphertextSha256: manifest.provider_ciphertext_sha256,
        preparedRouteSourceSha256: sha('v379-prepared-route'),
        method: 'POST',
        upstreamUrlSha256: sha('https://example.invalid/v1/chat/completions'),
        outboundBodySha256: sha(finalBody),
        outboundBodyCanonicalSha256: sha(JSON.stringify(JSON.parse(finalBody))),
        outboundBodyBytes: Buffer.byteLength(finalBody),
        credentialFingerprintSha256: sha('v379-opaque-plaintext-bearer') };
      const [grant] = await granter.unsafe(`SELECT
        ${g}.grant_complete_flat_text_attempt_v362($1::uuid,$2::jsonb)
          AS value`, [randomUUID(), granter.json(grantClaim)]);
      assert.equal(grant.value.status, 'grant_recorded');
      const [grantFact] = await migrator.unsafe(`SELECT request_id,quote_id::text,
        obligation_state FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`, [quoteWithGrant.requestId]);
      assert.equal(grantFact.request_id, quoteWithGrant.requestId);
      assert.equal(grantFact.quote_id, quoteWithGrant.quoteId);
      assert.equal(grantFact.obligation_state, 'unknown');
      stage('v362-grant-is-committed-for-exact-v361-request-and-platform-quote',
        { requestId: quoteWithGrant.requestId,
          quoteId: quoteWithGrant.quoteId, grantId: grant.value.grantId });

      // The v372 writer requires a shared-key economic attempt. Deliberately
      // create one against the same request ID to test whether the database
      // ties it to the v360 platform manifest. This is a counterexample, not
      // evidence that a shared key was actually used to send the platform route.
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
          VALUES('v379-seller','v379-seller@example.invalid',10);
        INSERT INTO ${g}.user_earnings(user_id) VALUES('v379-seller');
        INSERT INTO ${g}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES('v379-shared-key','v379-seller','openai',
            'synthetic-upstream-v379','synthetic-fingerprint-v379','active');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES('v379-shared-quote','v379-shared-key','v379-seller',
            1.25,2.5,0.1,0.2,0.1,'USD','per_million_tokens',
            'shared_seller_key','synthetic-v1');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,
            transition_kind,quote_version_id,seller_user_id)
          VALUES('v379-shared-transition','v379-shared-key',NULL,'activate',
            'v379-shared-quote','v379-seller');`).simple();
      const appDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      const appParams = async (quote, identity = {
        user: 'v379-user', key: 'v379-key', workspace: 'v379-workspace',
      }) => {
        const [sharedClaim] = await sharedProducer.unsafe(`SELECT * FROM
          cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
            $1::uuid,$2,1,'v379-shared-key','v379-route')`,
        [randomUUID(), quote.requestId]);
        assert.equal(sharedClaim.request_log_id, quote.requestId);
        const params = chargeParams(quote.requestId, 0.000001);
        params.requestLog = { ...params.requestLog, userId: identity.user,
          apiKeyId: identity.key, workspaceId: identity.workspace,
          modelId: 'v379-model', routeTargetId: 'v379-route',
          inputTokens: 10, outputTokens: 5, totalTokens: 15,
          isByok: false, requestOrigin: 'https://example.invalid',
          dataRegion: 'global', chargedCostUsd: 0.000001,
          budgetAccountedAt: accountedAt };
        params.userId = identity.user;
        params.beforeSpent = 0;
        params.audit = { ...params.audit, apiKeyId: identity.key,
          beforeSpent: 0, requestLogId: quote.requestId };
        params.userBudgetSettlement = { requestId: quote.requestId,
          mode: 'actual', reason: 'v379_actual' };
        params.guardrailBudgetSettlement = { requestId: quote.requestId,
          mode: 'actual', reason: 'v379_actual' };
        params.economicOutbox = { eventVersion: 2,
          buyerChargeBasis: 'actual', buyerUsageCertainty: 'actual',
          attempts: [{ attemptId: sharedClaim.attempt_id,
            requestLogId: quote.requestId, attemptIndex: 1,
            sharedKeyId: sharedClaim.shared_key_id,
            transitionId: sharedClaim.transition_id,
            quoteVersionId: sharedClaim.quote_version_id,
            usageCertainty: 'actual', inputTokens: 10, outputTokens: 5,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            providerCostCertainty: 'unknown', providerCostMicros: null,
            evidenceKind: 'provider_usage', evidenceSha256: 'a'.repeat(64),
            observedAtIso: new Date().toISOString() }] };
        params.legacyBuyerWindowedV371 = 'review-only';
        return params;
      };
      const state = async requestId => {
        const [row] = await migrator.unsafe(`SELECT
          (SELECT state FROM ${g}.user_budget_reservations
            WHERE request_id=$1) AS ordinary,
          (SELECT count(*)::int FROM ${g}.guardrail_budget_reservations
            WHERE request_id=$1 AND state='settled') AS settled_guards,
          (SELECT count(*)::int FROM ${g}.api_key_request_logs
            WHERE id=$1) AS logs,
          (SELECT count(*)::int FROM ${g}.user_audit_logs
            WHERE request_log_id=$1) AS audits,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_economic_events
            WHERE request_log_id=$1) AS events,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
            JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
              ON m.log_xact_id=r.xact_id
            WHERE m.request_log_id=$1) AS receipts`, [requestId]);
        return row;
      };
      const noGrantParams = await appParams(quoteWithoutGrant);
      await insertRequestUsageAndChargeTxPg(appDb, noGrantParams);
      const noGrantState = await state(quoteWithoutGrant.requestId);
      assert.deepEqual(noGrantState, { ordinary: 'settled',
        settled_guards: 3, logs: 1, audits: 1, events: 1, receipts: 1 });
      const [noGrantReceipt] = await migrator.unsafe(`SELECT
        m.log_xact_id::text AS log_xact_id,
        r.xact_id::text AS receipt_xact_id,
        r.spent_delta_micros::text AS spent_delta,
        e.buyer_debit_micros::text AS buyer_debit
        FROM cinatoken_economic_outbox.shared_key_economic_events e
        JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          ON m.request_log_id=e.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
          ON r.xact_id=m.log_xact_id AND r.user_id=e.buyer_user_id
        WHERE e.request_log_id=$1`, [quoteWithoutGrant.requestId]);
      assert.equal(noGrantReceipt.log_xact_id,
        noGrantReceipt.receipt_xact_id);
      assert.equal(noGrantReceipt.spent_delta, '1.000000');
      assert.equal(noGrantReceipt.buyer_debit, '1');
      stage('counterexample-admission-only-platform-hold-can-be-charged-by-synthetic-shared-key-event',
        { requestId: quoteWithoutGrant.requestId, receipt: noGrantReceipt });

      const grantParams = await appParams(quoteWithGrant);
      const beforeGrantWriter = await state(quoteWithGrant.requestId);
      assert.deepEqual(beforeGrantWriter, { ordinary: 'dispatched',
        settled_guards: 0, logs: 0, audits: 0, events: 0, receipts: 0 });
      await rejected(insertRequestUsageAndChargeTxPg(appDb, grantParams),
        '23514', 'complete_text_enrolled_buyer_v368');
      assert.deepEqual(await state(quoteWithGrant.requestId),
        beforeGrantWriter);
      stage('grant-linked-v372-writer-rejects-and-rolls-back-log-debit-audit-event-and-receipt',
        { requestId: quoteWithGrant.requestId, state: beforeGrantWriter });

      const v380Sql = await readFile(proposal(
        'complete-text-legacy-buyer-admission-fence-v380.sql'), 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-admission-fence-v380.sql'] =
        sha(v380Sql);
      await rejected(migrator.begin(tx => tx.unsafe(v380Sql).simple()),
        'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_legacy_buyer_admission_fence_v380_activation=
            'reviewed-v1'`);
        await tx.unsafe(v380Sql).simple();
      });
      await rejected(buyer.unsafe(`SELECT
        ${g}.reject_legacy_buyer_admitted_log_v380()`), '42501');
      stage('v380-default-off-activation-and-trigger-function-acl-pass');

      const fencedQuote = await issueAndAdmit('fenced-admission-only');
      const fencedParams = await appParams(fencedQuote);
      const beforeFenced = await state(fencedQuote.requestId);
      await rejected(insertRequestUsageAndChargeTxPg(appDb, fencedParams),
        '23514', 'legacy_buyer_admitted_log_v380');
      assert.deepEqual(await state(fencedQuote.requestId), beforeFenced);
      assert.deepEqual(beforeFenced, { ordinary: 'reserved',
        settled_guards: 0, logs: 0, audits: 0, events: 0, receipts: 0 });
      stage('v380-rejects-admission-only-buyer-log-and-rolls-back-entire-writer',
        { requestId: fencedQuote.requestId, state: beforeFenced });

      const legacyParams = await appParams(
        { requestId: 'v376-v351-admission' }, {
          user: 'v376-admission-user', key: 'v376-admission-key',
          workspace: 'v376-admission-workspace',
        });
      await insertRequestUsageAndChargeTxPg(appDb, legacyParams);
      const legacyState = await state('v376-v351-admission');
      assert.deepEqual(legacyState, { ordinary: 'settled',
        settled_guards: 1, logs: 1, audits: 1, events: 1, receipts: 1 });
      const [legacyReceipt] = await migrator.unsafe(`SELECT
        m.log_xact_id::text AS log_xact_id,
        r.xact_id::text AS receipt_xact_id,
        e.buyer_debit_micros::text AS debit
        FROM cinatoken_economic_outbox.shared_key_economic_events e
        JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          ON m.request_log_id=e.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
          ON r.xact_id=m.log_xact_id AND r.user_id=e.buyer_user_id
        WHERE e.request_log_id='v376-v351-admission'`);
      assert.equal(legacyReceipt.log_xact_id,
        legacyReceipt.receipt_xact_id);
      assert.equal(legacyReceipt.debit, '1');
      stage('v380-preserves-dedicated-v350-v351-genuine-legacy-hold-settlement',
        { requestId: 'v376-v351-admission', receipt: legacyReceipt });

      const insertPreexistingLog = (sql, requestId) => sql.unsafe(`INSERT INTO
        ${g}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost,
            budget_charged_micros,is_byok,status)
        VALUES($1,'v379-user','v379-key','v379-workspace',
          0.000001,1,false,'success')`, [requestId]);
      // A privileged fixture log cannot make the v371 settlement bypass the
      // second v380 fence on the ordinary hold transition.
      const backstopQuote = await issueAndAdmit('backstop');
      await insertPreexistingLog(migrator, backstopQuote.requestId);
      const beforeBackstop = await state(backstopQuote.requestId);
      await rejected(buyer.unsafe(`SELECT
        ${g}.settle_legacy_buyer_windowed_v371($1,'v380_backstop')`,
      [backstopQuote.requestId]), '23514',
      'legacy_buyer_admitted_hold_v380');
      assert.deepEqual(await state(backstopQuote.requestId), beforeBackstop);
      assert.deepEqual(beforeBackstop, { ordinary: 'reserved',
        settled_guards: 0, logs: 1, audits: 0, events: 0, receipts: 0 });
      stage('v380-hold-backstop-rejects-v371-after-privileged-preexisting-log',
        { requestId: backstopQuote.requestId });

      const logFirstQuote = await issueQuote('log-first');
      await insertPreexistingLog(buyer, logFirstQuote.requestId);
      await rejected(admission.unsafe(`SELECT
        ${g}.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb)`,
      [logFirstQuote.requestId, logFirstQuote.quoteId,
        admission.json(intents())]), '23514',
      'complete_text_preexisting_log_v380');
      const [logFirstState] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${g}.complete_text_admissions_v361
          WHERE request_id=$1) AS admissions,
        (SELECT count(*)::int FROM ${g}.user_budget_reservations
          WHERE request_id=$1) AS ordinary_holds,
        (SELECT count(*)::int FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1) AS guardrail_holds`,
      [logFirstQuote.requestId]);
      assert.deepEqual(logFirstState,
        { admissions: 0, ordinary_holds: 0, guardrail_holds: 0 });
      stage('v380-rejects-v361-admission-after-preexisting-buyer-log-with-no-holds',
        { requestId: logFirstQuote.requestId });

      // Hold the exact request advisory lock inside the admission transaction.
      // The buyer INSERT must wait and then see the committed admission row.
      const concurrentQuote = await issueQuote('admission-first-race');
      const [admissionPid] = await admission.unsafe(
        'SELECT pg_catalog.pg_backend_pid() AS pid');
      const [buyerPid] = await buyer.unsafe(
        'SELECT pg_catalog.pg_backend_pid() AS pid');
      let releaseAdmission;
      const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
      let enteredAdmission;
      const admissionEntered = new Promise(resolve => { enteredAdmission = resolve; });
      const pendingAdmission = admission.begin(async tx => {
        const [row] = await tx.unsafe(`SELECT
          ${g}.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb)
            AS value`, [concurrentQuote.requestId, concurrentQuote.quoteId,
          tx.json(intents())]);
        assert.equal(row.value.status, 'admitted');
        enteredAdmission();
        await admissionGate;
      });
      await admissionEntered;
      const rejectedConcurrentLog = rejected(insertPreexistingLog(
        buyer, concurrentQuote.requestId), '23514',
      'legacy_buyer_admitted_log_v380');
      try {
        await waitForBlock(cluster.admin, buyerPid.pid, admissionPid.pid);
      } finally { releaseAdmission(); }
      await pendingAdmission;
      await rejectedConcurrentLog;
      assert.equal((await state(concurrentQuote.requestId)).logs, 0);
      stage('v380-admission-first-race-serializes-buyer-log-behind-request-lock',
        { requestId: concurrentQuote.requestId,
          blockedBuyerPid: buyerPid.pid });

      // Reverse order: a committed buyer log makes the admission transaction
      // fail after it acquires the same lock, rolling back any staged holds.
      const reverseQuote = await issueQuote('log-first-race');
      let releaseLog;
      const logGate = new Promise(resolve => { releaseLog = resolve; });
      let enteredLog;
      const logEntered = new Promise(resolve => { enteredLog = resolve; });
      const pendingLog = buyer.begin(async tx => {
        await insertPreexistingLog(tx, reverseQuote.requestId);
        enteredLog();
        await logGate;
      });
      await logEntered;
      const rejectedConcurrentAdmission = rejected(admission.unsafe(`SELECT
        ${g}.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb)`,
      [reverseQuote.requestId, reverseQuote.quoteId,
        admission.json(intents())]), '23514',
      'complete_text_preexisting_log_v380');
      try {
        await waitForBlock(cluster.admin, admissionPid.pid, buyerPid.pid);
      } finally { releaseLog(); }
      await pendingLog;
      await rejectedConcurrentAdmission;
      const [reverseState] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${g}.complete_text_admissions_v361
          WHERE request_id=$1) AS admissions,
        (SELECT count(*)::int FROM ${g}.user_budget_reservations
          WHERE request_id=$1) AS ordinary_holds,
        (SELECT count(*)::int FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1) AS guardrail_holds`,
      [reverseQuote.requestId]);
      assert.deepEqual(reverseState,
        { admissions: 0, ordinary_holds: 0, guardrail_holds: 0 });
      stage('v380-log-first-race-rejects-admission-and-rolls-back-holds',
        { requestId: reverseQuote.requestId,
          blockedAdmissionPid: admissionPid.pid });
      report.sourceSha256['critical-writes.impl.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts',
          import.meta.url)));
      report.sourceSha256['legacy-buyer-windowed-transaction-v372.ts'] =
        sha(await readFile(new URL(
          '../../../packages/core/src/db/postgres/legacy-buyer-windowed-transaction-v372.ts',
          import.meta.url)));
      report.sourceSha256.fixture = sha(await readFile(new URL(import.meta.url)));
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
        report.cleanupError = String(error).slice(0, 1500); failure ??= error; }
      await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`complete-text-admission-buyer-v379-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

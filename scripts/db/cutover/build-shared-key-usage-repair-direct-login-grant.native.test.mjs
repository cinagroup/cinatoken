// Review-only PG18.6 fixture: owned loopback cluster, no ambient database URL.
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import {
  runSharedKeyUsageRepairClient,
  SHARED_KEY_USAGE_REPAIR_ROLE as RUNNER_REPAIR_ROLE,
} from '../../../packages/proxy/src/runtime/shared-key-usage-repair-worker.ts';
import {
  buildSharedKeyUsageRepairDirectLoginGrant, SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION,
  SHARED_KEY_USAGE_REPAIR_ROLE,
} from './build-shared-key-usage-repair-direct-login-grant.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const failureIsolation = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-failure-isolation.sql', import.meta.url);
const durableClaim = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-durable-claim.sql', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const password = () => randomBytes(32).toString('hex');

function scramVerifier(secret) {
  const iterations = 32768, salt = randomBytes(20);
  const salted = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
function client(cluster, username, secret, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password: secret, ssl: false, sslnegotiation: null,
    fetch_types: false, prepare: false, max: 1, max_pipeline: 1,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    keep_alive: 0, debug: false, onnotice() {},
    connection: { application_name: `cinatoken-repair-login-${label}` } });
}
async function activate(sql, setting, url, value = 'reviewed-v1') {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = '${value}'`);
    await tx.unsafe(await readFile(url, 'utf8')).simple();
  });
}
async function denied(run) { await assert.rejects(run, error => error?.code === '42501'); }

test('native PG18 repair-only direct LOGIN can repair a durable job and nothing else',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-repair-login-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, 73 formal migrations, four review-only repair proposals and direct LOGIN grant',
      stages: [], sourceSha256: {}, limitations: [
        'No production SQL, remote database, Hyperdrive, Workers Cron, Queue or deployment is exercised.',
        'A SCRAM verifier format cannot prove externally generated password entropy or origin binding.',
        'The role connection limit must be reconciled with the live instance-wide connection budget.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    let failure;
    const clients = [];
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      for (const [name, url] of [
        ['generator', new URL('./build-shared-key-usage-repair-direct-login-grant.ts', import.meta.url)],
        ['nativeTest', new URL(import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['repairRunner', new URL('../../../packages/proxy/src/runtime/shared-key-usage-repair-worker.ts', import.meta.url)],
        ['repairJobsProposal', repairJobs],
        ['failureIsolationProposal', failureIsolation],
        ['durableClaimProposal', durableClaim],
        ['historyGuardProposal', historyGuard],
      ]) report.sourceSha256[name] = digest(await readFile(url));
      const admin = cluster.admin;
      const migratorPassword = password(), runtimePassword = password();
      const consumerPassword = password(), verifier = scramVerifier(consumerPassword);
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE ALL ON DATABASE postgres FROM PUBLIC;
        REVOKE ALL ON DATABASE template1 FROM PUBLIC;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;
        GRANT TEMPORARY ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      clients.push(migrator, runtime);
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await activate(migrator, 'cinatoken.shared_key_earnings_history_guard_activation', historyGuard);
      await activate(migrator, 'cinatoken.shared_key_usage_repair_activation', repairJobs);
      await activate(migrator, 'cinatoken.shared_key_usage_repair_failure_activation', failureIsolation, 'reviewed-v2');
      await activate(migrator, 'cinatoken.shared_key_usage_repair_claim_activation', durableClaim, 'reviewed-v3');
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      stage('formal-migrations-and-review-only-proposals-installed');

      const request = { activation: SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION,
        role: SHARED_KEY_USAGE_REPAIR_ROLE, database: 'postgres',
        roleConnectionLimit: 2, scramVerifier: verifier };
      assert.equal(SHARED_KEY_USAGE_REPAIR_ROLE, RUNNER_REPAIR_ROLE);
      const plan = await buildSharedKeyUsageRepairDirectLoginGrant(request);
      assert.equal(plan.proposalSha256, report.sourceSha256.repairJobsProposal);
      assert.equal(plan.isolationProposalSha256, report.sourceSha256.failureIsolationProposal);
      assert.equal(plan.claimProposalSha256, report.sourceSha256.durableClaimProposal);
      await admin.unsafe(plan.adminSql).simple();
      const [role] = await admin.unsafe(`SELECT r.rolcanlogin,r.rolinherit,r.rolconnlimit,
        (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid) AS memberships,
        (SELECT rolpassword FROM pg_catalog.pg_authid a WHERE a.oid=r.oid) AS verifier
        FROM pg_catalog.pg_roles r WHERE r.rolname='${SHARED_KEY_USAGE_REPAIR_ROLE}'`);
      assert.deepEqual(role, { rolcanlogin: true, rolinherit: false, rolconnlimit: 2,
        memberships: 0, verifier });
      stage('isolated-scram-login-and-server-defaults');

      // Catalog drift must abort all grants from the migrator transaction.
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_enqueue_usage_repair`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Repair LOGIN proposal, role or pre-grant ACL differs/u);
      await migrator.unsafe('ROLLBACK').simple();
      assert.equal((await admin.unsafe(`SELECT pg_catalog.has_schema_privilege(
        '${SHARED_KEY_USAGE_REPAIR_ROLE}','${schema}','USAGE') AS allowed`))[0].allowed, false);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_enqueue_usage_repair`);
      await migrator.unsafe(`DROP TRIGGER shared_key_earnings_enqueue_usage_repair
        ON ${schema}.shared_key_earnings;
        CREATE TRIGGER shared_key_earnings_enqueue_usage_repair
        AFTER INSERT ON ${schema}.shared_key_earnings
        FOR EACH ROW WHEN (false)
        EXECUTE FUNCTION ${schema}.enqueue_shared_key_usage_repair();`).simple();
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Repair LOGIN proposal, role or pre-grant ACL differs/u);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`DROP TRIGGER shared_key_earnings_enqueue_usage_repair
        ON ${schema}.shared_key_earnings;
        CREATE TRIGGER shared_key_earnings_enqueue_usage_repair
        AFTER INSERT ON ${schema}.shared_key_earnings
        FOR EACH ROW EXECUTE FUNCTION ${schema}.enqueue_shared_key_usage_repair();`).simple();
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Repair LOGIN proposal, role or pre-grant ACL differs/u);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await migrator.unsafe('BEGIN').simple();
      await migrator.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.repair_one_shared_key_usage()
        RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path TO pg_catalog, pg_temp AS $drift$ BEGIN RETURN NULL; END; $drift$;`).simple();
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Repair LOGIN proposal, role or pre-grant ACL differs/u);
      await migrator.unsafe('ROLLBACK').simple();
      stage('trigger-predicate-and-function-drift-block-atomic-grant');

      await migrator.unsafe(`GRANT SELECT (id) ON TABLE ${schema}.users TO PUBLIC`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Repair LOGIN column privilege differs/u);
      await migrator.unsafe('ROLLBACK').simple();
      assert.equal((await admin.unsafe(`SELECT pg_catalog.has_function_privilege(
        '${SHARED_KEY_USAGE_REPAIR_ROLE}','${schema}.repair_one_shared_key_usage()','EXECUTE') AS allowed`))[0].allowed, false);
      await migrator.unsafe(`REVOKE SELECT (id) ON TABLE ${schema}.users FROM PUBLIC`);
      await migrator.unsafe(plan.migratorSql).simple();
      const [acl] = await admin.unsafe(`WITH role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${SHARED_KEY_USAGE_REPAIR_ROLE}'
      ), relations AS (
        SELECT c.oid,c.relkind FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}'
      ), functions AS (
        SELECT p.oid FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}'
      ) SELECT
        (SELECT count(*)::int FROM relations c,role r WHERE c.relkind IN ('r','p','v','m','f')
          AND pg_catalog.has_table_privilege(r.oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')) AS tables,
        (SELECT count(*)::int FROM relations c,role r,pg_catalog.pg_attribute a
          WHERE c.relkind IN ('r','p','v','m','f') AND a.attrelid=c.oid
            AND a.attnum>0 AND NOT a.attisdropped
            AND pg_catalog.has_column_privilege(r.oid,c.oid,a.attnum,
              'SELECT,INSERT,UPDATE,REFERENCES')) AS columns,
        (SELECT count(*)::int FROM relations c,role r WHERE c.relkind='S'
          AND pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')) AS sequences,
        (SELECT count(*)::int FROM functions p,role r
          WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS executable_functions`);
      assert.deepEqual(acl, { tables: 0, columns: 0, sequences: 0, executable_functions: 2 });
      stage('public-column-drift-blocks-grant-then-exact-grant-succeeds');

      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await denied(() => runtime.unsafe(`SELECT ${schema}.repair_one_shared_key_usage()`));
      await denied(() => runtime.unsafe(`SELECT * FROM ${schema}.attempt_one_shared_key_usage_repair()`));
      await denied(() => runtime.unsafe(`SELECT * FROM ${schema}.claim_one_shared_key_usage_repair()`));
      await denied(() => runtime.unsafe(`SELECT 1 FROM ${schema}.shared_key_usage_repair_jobs`));
      stage('ordinary-runtime-rerun-keeps-definer-and-job-closed');

      const direct = client(cluster, SHARED_KEY_USAGE_REPAIR_ROLE, consumerPassword, 'direct');
      clients.push(direct);
      const [identity] = await direct.unsafe(`SELECT current_user AS current_role,
        session_user AS session_role,current_setting('search_path') AS search_path`);
      assert.deepEqual(identity, { current_role: SHARED_KEY_USAGE_REPAIR_ROLE,
        session_role: SHARED_KEY_USAGE_REPAIR_ROLE, search_path: 'pg_catalog, pg_temp' });
      const settings = await direct.unsafe(`SELECT name,setting,unit,source FROM pg_catalog.pg_settings
        WHERE name IN ('transaction_timeout','statement_timeout','lock_timeout',
          'idle_in_transaction_session_timeout') ORDER BY name`);
      assert.deepEqual(Object.fromEntries(settings.map(row => [row.name,[row.setting,row.unit,row.source]])), {
        idle_in_transaction_session_timeout: ['10000','ms','database user'],
        lock_timeout: ['5000','ms','database user'],
        statement_timeout: ['15000','ms','database user'],
        transaction_timeout: ['30000','ms','database user'],
      });
      await denied(() => direct.unsafe(`SELECT 1 FROM ${schema}.shared_key_usage_repair_jobs`));
      await denied(() => direct.unsafe(`SELECT 1 FROM ${schema}.users`));
      await denied(() => direct.unsafe(`SELECT ${schema}.enqueue_shared_key_usage_repair()`));
      await denied(() => direct.unsafe(`SELECT ${schema}.repair_one_shared_key_usage()`));
      await denied(() => direct.unsafe(`SELECT * FROM ${schema}.attempt_one_shared_key_usage_repair()`));
      await denied(() => direct.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter('used-key','00000000000000000000000000000000')`));
      await denied(() => direct.unsafe(`CREATE TABLE ${schema}.forbidden(id int)`));
      await assert.rejects(direct.unsafe('SET ROLE cinatoken_gateway_runtime'),
        error => error?.code === '42501');
      stage('direct-login-role-defaults-and-table-function-denials');

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('seller','seller@example.invalid'),('buyer','buyer@example.invalid');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('buyer-workspace','personal','buyer','Buyer','buyer','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('buyer-key','synthetic-hash','buyer','buyer-workspace');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('seller');
        INSERT INTO ${schema}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint)
          VALUES ('used-key','seller','openai','synthetic-secret','fingerprint');
        INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
          VALUES ('log-1','buyer','buyer-key','buyer-workspace');
        INSERT INTO ${schema}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,net_amount)
          VALUES ('earning-1','log-1','used-key','seller',100,20,0.05,0.04);`).simple();
      const [before] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs) AS jobs,
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='used-key') AS input,
        (SELECT earned_total::text FROM ${schema}.shared_keys WHERE id='used-key') AS net`);
      assert.deepEqual(before, { jobs: 1, input: '0', net: '0.000000' });
      await assert.rejects(runSharedKeyUsageRepairClient(runtime,
        { maxItems: 1, admissionBudgetMs: 10_000 }),
      /Dedicated shared-key usage repair LOGIN and server deadlines required/u);
      const repaired = await runSharedKeyUsageRepairClient(direct,
        { maxItems: 1, admissionBudgetMs: 10_000 });
      assert.deepEqual(repaired, { processed: 1, repaired: 1, deferred: 0,
        deadLettered: 0, cancelled: 0, stale: 0, stopReason: 'item_limit' });
      const [after] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs) AS jobs,
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='used-key') AS input,
        (SELECT earned_total::text FROM ${schema}.shared_keys WHERE id='used-key') AS net`);
      assert.deepEqual(after, { jobs: 0, input: '100', net: '0.040000' });
      stage('direct-login-runner-repairs-one-durable-job-without-second-credit');

      await migrator.unsafe(`INSERT INTO ${schema}.shared_keys
        (id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('bad-timeout','seller','openai','synthetic-secret-bad','fingerprint-bad'),
          ('good-after-timeout','seller','openai','synthetic-secret-good','fingerprint-good');
        INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
        VALUES ('log-bad-timeout','buyer','buyer-key','buyer-workspace'),
          ('log-good-after-timeout','buyer','buyer-key','buyer-workspace');
        INSERT INTO ${schema}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,net_amount)
        VALUES ('earning-bad-timeout','log-bad-timeout','bad-timeout','seller',30,0,0.05,0.04),
          ('earning-good-after-timeout','log-good-after-timeout','good-after-timeout','seller',20,0,0.05,0.04);
        CREATE FUNCTION ${schema}.slow_timeout_projection() RETURNS trigger
          LANGUAGE plpgsql AS $slow$ BEGIN IF NEW.id='bad-timeout' THEN
            PERFORM pg_catalog.pg_sleep(16); END IF; RETURN NEW; END; $slow$;
        CREATE TRIGGER slow_timeout_projection BEFORE UPDATE ON ${schema}.shared_keys
          FOR EACH ROW EXECUTE FUNCTION ${schema}.slow_timeout_projection();`).simple();
      const sameTick = await runSharedKeyUsageRepairClient(direct,
        { maxItems: 3, admissionBudgetMs: 25_000 });
      assert.deepEqual(sameTick, { processed: 2, repaired: 1, deferred: 0,
        deadLettered: 0, cancelled: 1, stale: 0, stopReason: 'no_candidate' });
      const [sameTickState] = await migrator.unsafe(`SELECT
        (SELECT attempt_count FROM ${schema}.shared_key_usage_repair_jobs
          WHERE shared_key_id='bad-timeout') AS bad_attempts,
        (SELECT retry_after > pg_catalog.clock_timestamp()
          FROM ${schema}.shared_key_usage_repair_jobs
          WHERE shared_key_id='bad-timeout') AS bad_deferred,
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys
          WHERE id='good-after-timeout') AS good_projection,
        (SELECT lifetime_earned::text FROM ${schema}.user_earnings
          WHERE user_id='seller') AS credited`);
      assert.deepEqual(sameTickState, { bad_attempts: 1, bad_deferred: true,
        good_projection: '20', credited: '0.120000' });
      stage('real-15-second-server-timeout-rolls-back-finish-and-runner-repairs-healthy-key-in-same-tick');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 400) };
    } finally {
      await Promise.allSettled(clients.map(raw => raw.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key usage repair direct LOGIN report: ' + reportPath);
    }
    if (failure) throw failure;
  });

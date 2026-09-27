// Explicit local fixture. Never uses DATABASE_URL or an existing data directory.
// NOLOGIN SET ROLE is a superuser-only test of effective ACL, not a production origin.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createParentDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from '../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { buildImageFactJobProducerGrant } from './build-image-fact-job-producer-grant.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const producerRole = 'cinatoken_gateway_fact_producer';
const runtimeRole = 'cinatoken_gateway_runtime';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation',
    new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation',
    new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.settlement_outbox_definer_activation',
    new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url)],
];
const sha256 = input => createHash('sha256').update(input).digest('hex');
const client = raw => ({ driver: 'postgres', raw, drizzle: {} });

function localMigrator(cluster, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: 'cinatoken-native-fact-job-grant-migrator' } });
}

function producerClient(cluster, username, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-fact-direct-login' },
    onnotice() {} });
}

async function runBundle(sql, bundle) {
  try { await sql.unsafe(bundle).simple(); }
  catch (error) { await sql.unsafe('ROLLBACK').simple(); throw error; }
}

async function directAcl(sql) {
  const rows = await sql.unsafe(`SELECT c.relname AS relation_name,
    a.attname AS column_name,acl.privilege_type,acl.is_grantable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      AND a.attnum>0 AND NOT a.attisdropped,
    LATERAL pg_catalog.aclexplode(a.attacl) acl
    WHERE n.nspname='${schema}' AND acl.grantee=${producerRoleOid(sql)}
      AND c.relname IN ('request_usage_settlements',
        'request_usage_settlement_outbox','request_usage_recovery_jobs')
    ORDER BY c.relname,a.attnum,acl.privilege_type`);
  return rows;
}

// This OID expression keeps the ACL snapshot independent of session SET ROLE.
function producerRoleOid() {
  return `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${producerRole}')`;
}

test('fact/job grant SQL requires explicit reviewed source and has no side effect', async () => {
  await assert.rejects(buildImageFactJobProducerGrant(), /Explicit reviewed-v1/);
  await assert.rejects(buildImageFactJobProducerGrant({ activation: 'enabled' }),
    /Explicit reviewed-v1/);
  const bundle = await buildImageFactJobProducerGrant({ activation: 'reviewed-v1' });
  assert.match(bundle, /^-- REVIEW ONLY/);
  assert.match(bundle, /GRANT INSERT \(request_id, payload_sha256, fact_created_at_ms, user_id, workspace_id\)/);
  assert.doesNotMatch(bundle, /GRANT (?:UPDATE|DELETE|TRUNCATE) /);
  assert.doesNotMatch(bundle, /GRANT EXECUTE/);
  const direct = await buildImageFactJobProducerGrant({ activation: 'reviewed-direct-login-v1' });
  assert.match(direct, /SET LOCAL cinatoken.image_fact_job_producer_grant = 'reviewed-direct-login-v1'/);
  assert.match(direct, /WHERE oid=producer_oid AND rolcanlogin AND NOT rolinherit/);
  assert.doesNotMatch(direct, /PASSWORD|ALTER ROLE|CREATE ROLE/);
});

test('native pinned Images fact/outbox/job producer column grant',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async t => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-image-fact-job-grant-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; pinned migrations and proposals; default-disabled SQL candidate',
      limitations: [
        'NOLOGIN SET ROLE is simulated locally by the owned superuser; production origin, credential and membership are unproven.',
        'This grants fact/outbox/job persistence only. Dispatch, worker financial settlement and cloud cutover are separate gates.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let completed = false;
    t.after(async () => {
      try {
        await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
        await cluster.cleanup();
        report.cleanup = 'PASS';
      } catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = String(error?.message ?? error);
        throw error;
      } finally {
        report.status = completed && report.cleanup === 'PASS' ? 'PASS' : 'FAIL';
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        t.diagnostic('Native evidence: ' + reportFile);
      }
    });
    for (const [name, url] of [
      ['test', new URL(import.meta.url)],
      ['grant', new URL('./build-image-fact-job-producer-grant.mjs', import.meta.url)],
      ['legacyLogGuard', guardSwitch],
      ['factRepo', new URL('../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts', import.meta.url)],
      ['jobRepo', new URL('../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts', import.meta.url)],
      ...proposals.map(([name, url]) => [name, url]),
    ]) report.sourceSha256[name] = sha256(await readFile(url));
    const [server] = await cluster.admin.unsafe(`SELECT
      current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 180000 && server.version_num < 190000);
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const password = randomBytes(24).toString('hex');
    await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
      CREATE ROLE ${runtimeRole} NOLOGIN;
      CREATE ROLE ${producerRole} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE cinatoken_gateway_dispatch_producer NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
    const migrator = localMigrator(cluster, password);
    clients.push(migrator);
    const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres`;
    await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations(
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
    assert.equal(files.length, 73);
    const corpus = [];
    for (const name of files) {
      const body = await readFile(new URL(name, migrationDir), 'utf8');
      corpus.push(`${name}\n${body}`);
      await migrator.begin(async tx => {
        await tx.unsafe(body).simple();
        await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
      });
    }
    report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
    stage('formal-migrations', { count: files.length });
    for (const [setting, url] of proposals.slice(0, 2)) {
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
        await tx.unsafe(await readFile(url, 'utf8')).simple();
      });
    }
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    await runBundle(migrator, await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
    const [outboxSetting, outboxUrl] = proposals[2];
    await migrator.begin(async tx => {
      await tx.unsafe(`SET LOCAL ${outboxSetting} = 'reviewed-v1'`);
      await tx.unsafe(await readFile(outboxUrl, 'utf8')).simple();
    });
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    await migrator.unsafe(`GRANT USAGE ON SCHEMA ${schema}
      TO cinatoken_gateway_dispatch_producer`);
    stage('optional-parent-and-outbox-definers-installed');

    const grant = await buildImageFactJobProducerGrant({ activation: 'reviewed-v1' });
    const before = await directAcl(migrator);
    assert.equal(before.length, 0);
    await cluster.admin.unsafe(`CREATE ROLE fact_job_shadow NOLOGIN;
      GRANT fact_job_shadow TO ${producerRole}`).simple();
    await assert.rejects(runBundle(migrator, grant), /role separation differs/);
    await cluster.admin.unsafe(`REVOKE fact_job_shadow FROM ${producerRole}`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('membership-drift-rolls-back');

    await migrator.unsafe(`GRANT UPDATE(payload_json) ON TABLE
      ${schema}.request_usage_settlements TO ${producerRole}`);
    await assert.rejects(runBundle(migrator, grant), /unreviewed column privilege/);
    await migrator.unsafe(`REVOKE UPDATE(payload_json) ON TABLE
      ${schema}.request_usage_settlements FROM ${producerRole}`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('overbroad-column-drift-rolls-back');

    await migrator.unsafe(`GRANT SELECT(request_id) ON TABLE
      ${schema}.request_usage_settlements TO cinatoken_gateway_dispatch_producer`);
    await assert.rejects(runBundle(migrator, grant), /dispatch producer or ordinary runtime table ACL differs/);
    await migrator.unsafe(`REVOKE SELECT(request_id) ON TABLE
      ${schema}.request_usage_settlements FROM cinatoken_gateway_dispatch_producer`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('dispatch-role-column-leak-rolls-back');

    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_settlements
      DISABLE TRIGGER request_usage_settlements_enqueue`);
    await assert.rejects(runBundle(migrator, grant), /trigger binding differs/);
    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_settlements
      ENABLE TRIGGER request_usage_settlements_enqueue`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('trigger-drift-rolls-back');

    const [jobFk] = await migrator.unsafe(`SELECT conname FROM pg_catalog.pg_constraint
      WHERE contype='f'
        AND conrelid='${schema}.request_usage_recovery_jobs'::pg_catalog.regclass
        AND confrelid='${schema}.request_usage_settlements'::pg_catalog.regclass`);
    assert.match(jobFk.conname, /^[a-z0-9_]+$/);
    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_recovery_jobs
      DROP CONSTRAINT ${jobFk.conname}`);
    await assert.rejects(runBundle(migrator, grant), /foreign key contract differs/);
    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_recovery_jobs
      ADD CONSTRAINT ${jobFk.conname} FOREIGN KEY
        (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
      REFERENCES ${schema}.request_usage_settlements
        (request_id,payload_sha256,created_at_ms,user_id,workspace_id)`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('foreign-key-drift-rolls-back');

    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
    });
    const [installedGuard] = await migrator.unsafe(`SELECT
      p.prosecdef AS security_definer, t.tgenabled AS enabled,
      t.tgtype AS trigger_type
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_trigger t ON t.tgfoid=p.oid
      WHERE p.oid='${schema}.guard_fact_without_legacy_log()'::pg_catalog.regprocedure
        AND t.tgrelid='${schema}.request_usage_settlements'::pg_catalog.regclass
        AND t.tgname='request_usage_settlements_legacy_log_fence'`);
    assert.deepEqual(installedGuard, { security_definer: true, enabled: 'O', trigger_type: 7 });
    assert.deepEqual(await directAcl(migrator), before);
    stage('pinned-legacy-log-guard-installed-before-grant');

    await migrator.unsafe(`ALTER FUNCTION ${schema}.guard_fact_without_legacy_log()
      SECURITY INVOKER`);
    await assert.rejects(runBundle(migrator, grant), /legacy-log guard function or trigger differs/);
    await migrator.unsafe(`ALTER FUNCTION ${schema}.guard_fact_without_legacy_log()
      SECURITY DEFINER`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('legacy-log-guard-function-drift-rolls-back');

    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_settlements
      DISABLE TRIGGER request_usage_settlements_legacy_log_fence`);
    await assert.rejects(runBundle(migrator, grant), /legacy-log guard function or trigger differs/);
    await migrator.unsafe(`ALTER TABLE ${schema}.request_usage_settlements
      ENABLE TRIGGER request_usage_settlements_legacy_log_fence`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('legacy-log-guard-disabled-trigger-rolls-back');

    await migrator.unsafe(`CREATE TRIGGER image_unreviewed_fact_guard BEFORE INSERT
      ON ${schema}.request_usage_settlements FOR EACH ROW
      EXECUTE FUNCTION ${schema}.guard_fact_without_legacy_log()`);
    await assert.rejects(runBundle(migrator, grant), /fact\/outbox\/job trigger binding differs/);
    await migrator.unsafe(`DROP TRIGGER image_unreviewed_fact_guard
      ON ${schema}.request_usage_settlements`);
    assert.deepEqual(await directAcl(migrator), before);
    stage('extra-fact-trigger-rolls-back');

    await runBundle(migrator, grant);
    const once = await directAcl(migrator);
    assert.equal(once.length, 49);
    await runBundle(migrator, grant);
    assert.deepEqual(await directAcl(migrator), once);
    stage('grant-idempotent', { exactColumnGrants: once.length });

    await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
      VALUES ('image-user','fact-job@example.invalid',10,0);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('image-space','personal','image-user','Fact Job','fact-job','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('image-key','fact-job-key','image-user','image-space');`).simple();
    const value = sample(0);
    const now = new Date().toISOString();
    value.recordedAtIso = now;
    Object.assign(value.intent, { userId: 'image-user', apiKeyId: 'image-key',
      workspaceId: 'image-space' });
    Object.assign(value.params.requestLog, { userId: 'image-user',
      apiKeyId: 'image-key', workspaceId: 'image-space', budgetAccountedAt: now });
    value.params.requestLog.providerAttempts[0].observedAtIso = now;
    value.params.userId = 'image-user';
    value.params.audit.apiKeyId = 'image-key';
    const parent = createParentDispatchIntentRepositoryPostgres(client(migrator));
    const parentRef = { ...value.intent, requestSha256: 'b'.repeat(64) };
    const [clock] = await cluster.admin.unsafe(`SELECT
      (floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint+120000)::text AS deadline`);
    assert.equal(await parent.prepare(parentRef, Number(clock.deadline), 1), 'newly_prepared');
    assert.equal(await parent.claim(parentRef, 0, value.dispatchClaimId), 'granted');
    const factRaw = cluster.client('image-fact-job-role');
    await factRaw.unsafe(`SET ROLE ${producerRole}`);
    assert.equal((await factRaw.unsafe('SELECT current_user AS role'))[0].role, producerRole);
    const facts = createUsageSettlementFactsRepositoryPostgres(client(factRaw));
    const jobs = createUsageRecoveryJobsPostgres(client(factRaw));
    const ref = await facts.persist(value);
    assert.deepEqual(await facts.load(ref), value);
    const job = await jobs.ensure(ref);
    assert.equal(job.state, 'pending');
    const [stored] = await cluster.admin.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS fact,
      (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox WHERE request_id=$1) AS outbox,
      (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job,
      (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipt,
      (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS log,
      (SELECT budget_spent::text FROM ${schema}.users WHERE id='image-user') AS spent`,
    [ref.requestId]);
    assert.deepEqual(stored, { fact: 1, outbox: 1, job: 1,
      receipt: 0, log: 0, spent: '0.000000' });
    stage('set-role-fact-outbox-job', { currentUser: producerRole, stored,
      outboxTriggerUsedWithoutDirectInsert: true });

    const parentSignature = `${schema}.prepare_request_dispatch_intent_v1(
      text,integer,text,text,text,text,text,text,bigint,integer)`.replaceAll(/\s+/g, '');
    for (const [name, statement] of [
      ['outbox INSERT', `INSERT INTO ${schema}.request_usage_settlement_outbox
        (request_id,payload_sha256,created_at_ms) VALUES ('unowned',repeat('a',64),1)`],
      ['job UPDATE', `UPDATE ${schema}.request_usage_recovery_jobs SET state='blocked'
        WHERE request_id='${ref.requestId}'`],
      ['receipt INSERT', `INSERT INTO ${schema}.request_usage_commit_receipts(request_id)
        VALUES ('${ref.requestId}')`],
      ['financial log INSERT', `INSERT INTO ${schema}.api_key_request_logs(id)
        VALUES ('unowned')`],
      ['balance UPDATE', `UPDATE ${schema}.users SET budget_spent=1 WHERE id='image-user'`],
      ['budget INSERT', `INSERT INTO ${schema}.user_budget_reservations(request_id)
        VALUES ('unowned')`],
      ['parent SELECT', `SELECT request_id FROM ${schema}.request_dispatch_requests`],
      ['intent SELECT', `SELECT request_id FROM ${schema}.request_dispatch_intents`],
      ['parent EXECUTE', `SELECT ${schema}.prepare_request_dispatch_intent_v1(
        'unowned',1,'image-user','image-key','image-space','images.generations',
        repeat('b',64),repeat('a',64),1,1)`],
    ]) {
      await assert.rejects(factRaw.unsafe(statement), error => error.code === '42501', name);
    }
    const [acl] = await factRaw.unsafe(`SELECT
      pg_catalog.has_function_privilege(current_user,
        '${parentSignature}'::pg_catalog.regprocedure,'EXECUTE') AS parent_execute,
      pg_catalog.has_table_privilege(current_user,
        '${schema}.request_usage_settlements','INSERT') AS fact_table_insert,
      pg_catalog.has_column_privilege(current_user,
        '${schema}.request_usage_settlements','payload_json','INSERT') AS fact_column_insert,
      pg_catalog.has_column_privilege(current_user,
        '${schema}.request_usage_recovery_jobs','request_id','INSERT') AS job_column_insert,
      pg_catalog.has_table_privilege(current_user,
        '${schema}.request_usage_settlement_outbox','INSERT') AS outbox_insert`);
    assert.deepEqual(acl, { parent_execute: false, fact_table_insert: false,
      fact_column_insert: true, job_column_insert: true, outbox_insert: false });
    stage('set-role-denies-parent-and-financial-writes', { denials: 9, acl });

    const runtimeRaw = cluster.client('image-ordinary-runtime');
    await runtimeRaw.unsafe(`SET ROLE ${runtimeRole}`);
    await assert.rejects(runtimeRaw.unsafe(`SELECT request_id FROM
      ${schema}.request_usage_settlements`), error => error.code === '42501');
    await assert.rejects(runtimeRaw.unsafe(`SELECT request_id FROM
      ${schema}.request_usage_recovery_jobs`), error => error.code === '42501');
    await assert.rejects(runtimeRaw.unsafe(`SELECT ${schema}.prepare_request_dispatch_intent_v1(
      'unowned',1,'image-user','image-key','image-space','images.generations',
      repeat('b',64),repeat('a',64),1,1)`), error => error.code === '42501');
    stage('ordinary-runtime-denied');

    const dispatchRaw = cluster.client('image-dispatch-producer');
    await dispatchRaw.unsafe('SET ROLE cinatoken_gateway_dispatch_producer');
    await assert.rejects(dispatchRaw.unsafe(`SELECT request_id FROM
      ${schema}.request_usage_settlements`), error => error.code === '42501');
    await assert.rejects(dispatchRaw.unsafe(`INSERT INTO ${schema}.request_usage_recovery_jobs
      (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
      VALUES ('unowned',repeat('a',64),1,'image-user','image-space')`), error => error.code === '42501');
    stage('dispatch-role-denied-fact-and-job');

    await migrator.unsafe(`GRANT SELECT ON TABLE ${schema}.users TO ${producerRole}`);
    await assert.rejects(runBundle(migrator, grant), /unrelated gateway relation/);
    await migrator.unsafe(`REVOKE SELECT ON TABLE ${schema}.users FROM ${producerRole}`);
    await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${parentSignature} TO ${producerRole}`);
    await assert.rejects(runBundle(migrator, grant), /definer function|parent functions/);
    await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${parentSignature} FROM ${producerRole}`);
    assert.deepEqual(await directAcl(migrator), once);
    stage('post-grant-privilege-drift-fails-closed');

    completed = true;
  });

test('native direct LOGIN fact producer authenticates independently and writes only pinned fact/job columns',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async t => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-image-fact-job-direct-login-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18 SCRAM password-authenticated fact and dispatch LOGIN roles',
      limitations: [
        'Local password-authenticated roles do not prove a production origin, credential rotation or capacity.',
        'The review-only SQL grants producer persistence only, not the financial settlement consumer.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let completed = false;
    t.after(async () => {
      try {
        await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
        await cluster.cleanup();
        report.cleanup = 'PASS';
      } catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = String(error?.message ?? error);
        throw error;
      } finally {
        report.status = completed && report.cleanup === 'PASS' ? 'PASS' : 'FAIL';
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        t.diagnostic('Native direct LOGIN evidence: ' + reportFile);
      }
    });
    for (const [name, url] of [
      ['test', new URL(import.meta.url)],
      ['grant', new URL('./build-image-fact-job-producer-grant.mjs', import.meta.url)],
      ['legacyLogGuard', guardSwitch],
      ['factRepo', new URL('../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts', import.meta.url)],
      ['jobRepo', new URL('../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts', import.meta.url)],
      ...proposals.map(([name, url]) => [name, url]),
    ]) report.sourceSha256[name] = sha256(await readFile(url));
    const [server] = await cluster.admin.unsafe(`SELECT
      current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 180000 && server.version_num < 190000);
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const migratorPassword = randomBytes(32).toString('hex');
    const dispatchPassword = randomBytes(32).toString('hex');
    const factPassword = randomBytes(32).toString('hex');
    await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
      CREATE ROLE ${runtimeRole} NOLOGIN;
      CREATE ROLE ${producerRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${factPassword}';
      CREATE ROLE cinatoken_gateway_dispatch_producer LOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${dispatchPassword}';
      CREATE ROLE fact_direct_shadow NOLOGIN;
      CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
        ${producerRole}, cinatoken_gateway_dispatch_producer;`).simple();
    const migrator = localMigrator(cluster, migratorPassword);
    const fact = producerClient(cluster, producerRole, factPassword);
    const dispatch = producerClient(cluster, 'cinatoken_gateway_dispatch_producer', dispatchPassword);
    const wrong = producerClient(cluster, producerRole, dispatchPassword);
    clients.push(migrator, fact, dispatch, wrong);
    await assert.rejects(wrong.unsafe('SELECT 1'), error => error.code === '28P01');
    for (const [sql, role] of [[fact, producerRole],
      [dispatch, 'cinatoken_gateway_dispatch_producer']]) {
      const [identity] = await sql.unsafe(`SELECT session_user, current_user,
        pg_catalog.host(inet_client_addr()) AS client_address`);
      assert.equal(identity.session_user, role);
      assert.equal(identity.current_user, role);
      assert.equal(identity.client_address, '127.0.0.1');
    }
    await assert.rejects(fact.unsafe('SET ROLE cinatoken_gateway_dispatch_producer'),
      error => error.code === '42501');
    await assert.rejects(dispatch.unsafe(`SET ROLE ${producerRole}`),
      error => error.code === '42501');
    stage('distinct-scram-identities-no-cross-role-switch');

    const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
    await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations(
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
    assert.equal(files.length, 73);
    for (const name of files) {
      const body = await readFile(new URL(name, migrationDir), 'utf8');
      await migrator.begin(async tx => {
        await tx.unsafe(body).simple();
        await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
      });
    }
    for (const [setting, url] of proposals.slice(0, 2)) {
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
        await tx.unsafe(await readFile(url, 'utf8')).simple();
      });
    }
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    await runBundle(migrator,
      await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
    const [outboxSetting, outboxUrl] = proposals[2];
    await migrator.begin(async tx => {
      await tx.unsafe(`SET LOCAL ${outboxSetting} = 'reviewed-v1'`);
      await tx.unsafe(await readFile(outboxUrl, 'utf8')).simple();
    });
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    await migrator.unsafe(`GRANT USAGE ON SCHEMA ${schema}
      TO cinatoken_gateway_dispatch_producer`);
    stage('pinned-migrations-parent-and-outbox-installed', { count: files.length });

    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
    });
    stage('pinned-legacy-log-guard-installed-before-direct-grant');

    const directGrant = await buildImageFactJobProducerGrant({ activation: 'reviewed-direct-login-v1' });
    const noLoginGrant = await buildImageFactJobProducerGrant({ activation: 'reviewed-v1' });
    const initial = await directAcl(migrator);
    assert.equal(initial.length, 0);
    await assert.rejects(runBundle(migrator, noLoginGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE ${producerRole} NOLOGIN`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE ${producerRole} LOGIN`);
    await cluster.admin.unsafe(`ALTER ROLE cinatoken_gateway_dispatch_producer INHERIT`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE cinatoken_gateway_dispatch_producer NOINHERIT`);
    await cluster.admin.unsafe(`GRANT fact_direct_shadow TO cinatoken_gateway_dispatch_producer`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`REVOKE fact_direct_shadow FROM cinatoken_gateway_dispatch_producer`);
    await cluster.admin.unsafe(`GRANT ${producerRole} TO fact_direct_shadow`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`REVOKE ${producerRole} FROM fact_direct_shadow`);
    assert.deepEqual(await directAcl(migrator), initial);
    stage('wrong-mode-property-and-membership-refuse-atomically');

    await runBundle(migrator, directGrant);
    const once = await directAcl(migrator);
    assert.equal(once.length, 49);
    await runBundle(migrator, directGrant);
    assert.deepEqual(await directAcl(migrator), once);
    await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
      VALUES ('direct-fact-user','direct-fact@example.invalid',10,0);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('direct-fact-space','personal','direct-fact-user','Direct Fact','direct-fact','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('direct-fact-key','direct-fact-key-value','direct-fact-user','direct-fact-space');`).simple();
    const value = sample(0);
    const now = new Date().toISOString();
    value.recordedAtIso = now;
    Object.assign(value.intent, { userId: 'direct-fact-user', apiKeyId: 'direct-fact-key',
      workspaceId: 'direct-fact-space' });
    Object.assign(value.params.requestLog, { userId: 'direct-fact-user',
      apiKeyId: 'direct-fact-key', workspaceId: 'direct-fact-space', budgetAccountedAt: now });
    value.params.requestLog.providerAttempts[0].observedAtIso = now;
    value.params.userId = 'direct-fact-user';
    value.params.audit.apiKeyId = 'direct-fact-key';
    const parent = createParentDispatchIntentRepositoryPostgres(client(migrator));
    const parentRef = { ...value.intent, requestSha256: 'b'.repeat(64) };
    const [clock] = await cluster.admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+120000)::text AS deadline`);
    assert.equal(await parent.prepare(parentRef, Number(clock.deadline), 1), 'newly_prepared');
    assert.equal(await parent.claim(parentRef, 0, value.dispatchClaimId), 'granted');
    const facts = createUsageSettlementFactsRepositoryPostgres(client(fact));
    const jobs = createUsageRecoveryJobsPostgres(client(fact));
    const ref = await facts.persist(value);
    assert.deepEqual(await facts.load(ref), value);
    assert.equal((await jobs.ensure(ref)).state, 'pending');
    const [stored] = await cluster.admin.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS fact,
      (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox WHERE request_id=$1) AS outbox,
      (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job,
      (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipt,
      (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS log`, [ref.requestId]);
    assert.deepEqual(stored, { fact: 1, outbox: 1, job: 1, receipt: 0, log: 0 });
    await assert.rejects(fact.unsafe(`SELECT request_id FROM ${schema}.request_dispatch_requests`),
      error => error.code === '42501');
    await assert.rejects(fact.unsafe(`UPDATE ${schema}.request_usage_recovery_jobs SET state='blocked'
      WHERE request_id=$1`, [ref.requestId]), error => error.code === '42501');
    await assert.rejects(fact.unsafe(`INSERT INTO ${schema}.request_usage_settlement_outbox
      (request_id,payload_sha256,created_at_ms) VALUES ('unowned',repeat('a',64),1)`),
    error => error.code === '42501');
    await assert.rejects(fact.unsafe(`INSERT INTO ${schema}.api_key_request_logs(id)
      VALUES ('unowned')`), error => error.code === '42501');
    await assert.rejects(dispatch.unsafe(`SELECT request_id FROM ${schema}.request_usage_settlements`),
      error => error.code === '42501');
    await assert.rejects(dispatch.unsafe(`INSERT INTO ${schema}.request_usage_recovery_jobs
      (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
      VALUES ('unowned',repeat('a',64),1,'direct-fact-user','direct-fact-space')`),
    error => error.code === '42501');
    stage('password-authenticated-fact-job-persistence-and-cross-role-denials',
      { exactColumnGrants: once.length, stored });
    completed = true;
  });

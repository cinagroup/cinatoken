// Explicit local PostgreSQL 18+ fixture for the dedicated financial consumer.
// Never reads an ambient database URL and never provisions a remote origin.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { createPostgresFinancialConsumer, FINANCIAL_RECOVERY_ROLE } from '../../../packages/proxy/src/runtime/postgres-financial-consumer.ts';
import { RECOVERY_TABLE_GRANTS, RECOVERY_FUNCTION_GRANTS } from './postgres-recovery-role-policy.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const timeoutSettings = Object.freeze({ transaction_timeout: '30s', statement_timeout: '15s',
  lock_timeout: '5s', idle_in_transaction_session_timeout: '10s', search_path: 'pg_catalog, pg_temp' });

function loginClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres', username, password,
    ssl: false, max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
    idle_timeout: 0, max_lifetime: 0, backoff: 0, max_pipeline: 1,
    connection: { application_name: `cinatoken-native-${label}` }, onnotice() {} });
}
function adapter(raw) { return { driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) }; }
function summary(error) { return { name: error?.name ?? null, code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 400) }; }
async function denied(run, label) {
  await assert.rejects(run, error => error?.code === '42501', label);
}

/** Fixture-only grant. Uses the existing fixed recovery ACL catalogue; never broadens via ALL TABLES. */
async function provisionFixture(admin, migrator, password) {
  assert.match(password, /^[0-9a-f]{48}$/);
  const [server] = await admin.unsafe("SELECT current_setting('server_version_num')::int AS version_num");
  assert.ok(server.version_num >= 180000, 'This fixture requires native PostgreSQL 18');
  await admin.begin(async tx => {
    const [owner] = await tx.unsafe(`SELECT current_user AS current_role,
      (SELECT r.rolname FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
       WHERE n.nspname='${schema}') AS schema_owner`);
    assert.equal(owner.schema_owner, 'cinatoken_gateway_migrator');
    assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname='${FINANCIAL_RECOVERY_ROLE}'`))[0].n, 0);
    await tx.unsafe(`REVOKE ALL ON DATABASE postgres FROM PUBLIC`);
    await tx.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await tx.unsafe(`CREATE ROLE ${FINANCIAL_RECOVERY_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '${password}'`);
    await tx.unsafe(`GRANT CONNECT ON DATABASE postgres TO ${FINANCIAL_RECOVERY_ROLE}`);
    for (const [key, value] of Object.entries(timeoutSettings))
      await tx.unsafe(`ALTER ROLE ${FINANCIAL_RECOVERY_ROLE} IN DATABASE postgres SET ${key} TO ${key === 'search_path' ? value : `'${value}'`}`);
    const [role] = await tx.unsafe(`SELECT oid, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
      rolcreaterole, rolreplication, rolbypassrls, rolconnlimit FROM pg_catalog.pg_roles
      WHERE rolname='${FINANCIAL_RECOVERY_ROLE}'`);
    assert.equal(role.rolcanlogin, true);
    for (const key of ['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])
      assert.equal(role[key], false, key);
    assert.equal(role.rolconnlimit, 2);
    assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members
      WHERE roleid=$1 OR member=$1`, [role.oid]))[0].n, 0, 'PG18 creator membership forbidden');
    const [databaseAcl] = await tx.unsafe(`SELECT
      pg_catalog.has_database_privilege($1, current_database(), 'CONNECT') AS connect,
      pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS create,
      pg_catalog.has_database_privilege($1, current_database(), 'TEMP') AS temp,
      pg_catalog.has_schema_privilege($1, 'public', 'USAGE') AS public_usage`, [FINANCIAL_RECOVERY_ROLE]);
    assert.deepEqual(databaseAcl, { connect: true, create: false, temp: false, public_usage: false });
  });
  await migrator.begin(async tx => {
    const [identity] = await tx.unsafe('SELECT current_user AS role, session_user AS session_role');
    assert.deepEqual(identity, { role: 'cinatoken_gateway_migrator', session_role: 'cinatoken_gateway_migrator' });
    const [role] = await tx.unsafe(`SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${FINANCIAL_RECOVERY_ROLE}'`);
    assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members
      WHERE roleid=$1 OR member=$1`, [role.oid]))[0].n, 0);
    for (const entry of RECOVERY_TABLE_GRANTS) {
      const [table] = await tx.unsafe(`SELECT c.relkind, r.rolname AS owner FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
        WHERE n.nspname=$1 AND c.relname=$2`, [schema, entry.table]);
      assert.ok(table && ['r','p'].includes(table.relkind) && table.owner === 'cinatoken_gateway_migrator', entry.table);
    }
    await tx.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${FINANCIAL_RECOVERY_ROLE}`);
    for (const entry of RECOVERY_TABLE_GRANTS) {
      const target = `${schema}.${entry.table}`;
      if (entry.selectColumns?.length)
        await tx.unsafe(`GRANT SELECT (${entry.selectColumns.join(', ')}) ON TABLE ${target} TO ${FINANCIAL_RECOVERY_ROLE}`);
      if (entry.privileges.length)
        await tx.unsafe(`GRANT ${entry.privileges.join(', ')} ON TABLE ${target} TO ${FINANCIAL_RECOVERY_ROLE}`);
      if (entry.updateColumns.length)
        await tx.unsafe(`GRANT UPDATE (${entry.updateColumns.join(', ')}) ON TABLE ${target} TO ${FINANCIAL_RECOVERY_ROLE}`);
    }
    for (const signature of RECOVERY_FUNCTION_GRANTS) {
      assert.ok((await tx.unsafe('SELECT pg_catalog.to_regprocedure($1)::text AS oid', [`${schema}.${signature}`]))[0].oid,
        signature);
      await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${FINANCIAL_RECOVERY_ROLE}`);
    }
  });
}

test('native PG18 financial consumer direct LOGIN and least-privilege fixture',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-financial-consumer-login-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18; fixture-only direct LOGIN; no remote SQL or deployment', stages: [], sourceSha256: {} };
    for (const [name, url] of [
      ['nativeTest', new URL(import.meta.url)], ['roleCatalogue', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
      ['consumer', new URL('../../../packages/proxy/src/runtime/postgres-financial-consumer.ts', import.meta.url)],
      ['guardSwitch', guardSwitch],
    ]) report.sourceSha256[name] = createHash('sha256').update(await readFile(url)).digest('hex');
    const clients = [];
    const ownClient = (username, password, label) => { const raw = loginClient(cluster, username, password, label);
      clients.push(raw); return raw; };
    const stage = (name, detail={}) => report.stages.push({ name, result: 'PASS', ...detail });
    try {
      const { admin } = cluster;
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const [server] = await admin.unsafe("SELECT current_setting('listen_addresses') AS listen_addresses");
      assert.equal(server.listen_addresses, '127.0.0.1');
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
      const migrator = ownClient('cinatoken_gateway_migrator', migratorPassword, 'financial-migrator');
      const producerRaw = ownClient('cinatoken_gateway_migrator', migratorPassword, 'financial-producer');
      const runtimeRaw = ownClient('cinatoken_gateway_runtime', runtimePassword, 'financial-runtime');
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
      const guard = await readFile(guardSwitch, 'utf8');
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
        await tx.unsafe(guard).simple();
      });
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      stage('formal-migrations-and-guard', { count: files.length });
      await provisionFixture(admin, migrator, consumerPassword);
      const consumerRaw = ownClient(FINANCIAL_RECOVERY_ROLE, consumerPassword, 'financial-direct-login');
      const wrongRaw = ownClient('cinatoken_gateway_runtime', runtimePassword, 'financial-wrong-login');
      const [identity] = await consumerRaw.unsafe(`SELECT current_user AS role, session_user AS session_role,
        current_setting('transaction_timeout') AS transaction_timeout,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('lock_timeout') AS lock_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
        current_setting('search_path') AS search_path`);
      assert.deepEqual(identity, { role: FINANCIAL_RECOVERY_ROLE, session_role: FINANCIAL_RECOVERY_ROLE,
        ...timeoutSettings });
      stage('scram-direct-login-and-defaults', { sessionEqualsCurrent: true, connectionLimit: 2 });
      await denied(() => consumerRaw.unsafe(`INSERT INTO ${schema}.request_usage_settlements(request_id) VALUES ('forbidden')`), 'fact insertion');
      await denied(() => consumerRaw.unsafe(`DELETE FROM ${schema}.request_usage_recovery_jobs WHERE request_id='none'`), 'job deletion');
      await denied(() => consumerRaw.unsafe(`UPDATE ${schema}.api_keys SET workspace_id='none' WHERE id='none'`), 'key mutation');
      await denied(() => consumerRaw.unsafe(`UPDATE ${schema}.api_key_request_logs SET status='failed' WHERE id='none'`), 'log mutation');
      await denied(() => consumerRaw.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ('forbidden')`), 'migration write');
      await denied(() => consumerRaw.unsafe(`CREATE TABLE ${schema}.forbidden(id int)`), 'schema create');
      await denied(() => consumerRaw.unsafe(`SELECT * FROM ${schema}.api_keys LIMIT 1`), 'full key select');
      await assert.rejects(consumerRaw.unsafe('SET ROLE cinatoken_gateway_runtime'), error => error?.code === '42501');
      stage('cross-role-and-object-denials');
      const wrongOutcome = await createPostgresFinancialConsumer({ enabled: true,
        runtime: adapter(runtimeRaw), dispatchProducer: adapter(producerRaw), factProducer: adapter(migrator),
        openInvocationClient: async () => adapter(wrongRaw),
        retireConfirmedClient: async () => { throw new Error('wrong login must not retire as confirmed'); },
        capacity: { tryAcquire() { throw new Error('wrong login must not acquire capacity'); } },
        limits: { scope: { kind: 'all' }, maxRegistrations: 1, maxItems: 1,
          concurrency: 1, leaseSeconds: 30, runBudgetMs: 10000,
          reservedBytesPerConsumer: 7, reservedBytesPerScan: 11 },
      }).runOnce();
      assert.deepEqual(wrongOutcome, { status: 'authority_rejected', queueAckSafe: false, locallyRetainedClient: true });
      stage('real-wrong-login-rejected-before-work');
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('user','native-consumer@example.invalid',10,1);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('workspace','personal','user','Consumer Native','consumer-native','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('key','native-consumer-key','user','workspace');`).simple();
      const value = sample(0.25);
      const recordedAtIso = new Date().toISOString();
      Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
      value.recordedAtIso = recordedAtIso;
      Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
        budgetAccountedAt: recordedAtIso });
      value.params.requestLog.providerAttempts[0].observedAtIso = recordedAtIso;
      value.params.userId = 'user'; value.params.beforeSpent = 1;
      value.params.audit.apiKeyId = 'key'; value.params.audit.beforeSpent = 1;
      delete value.params.userBudgetSettlement;
      const intents = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: producerRaw });
      const facts = createUsageSettlementFactsRepositoryPostgres({ driver: 'postgres', raw: producerRaw });
      const [clock] = await admin.unsafe(`SELECT
        (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS deadline`);
      await intents.prepare(value.intent, Number(clock.deadline));
      assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
      const ref = await facts.persist(value);
      const capacity = { tryAcquire() { return { release() {} }; } };
      let retireCalls = 0;
      const consumer = createPostgresFinancialConsumer({ enabled: true,
        runtime: adapter(runtimeRaw), dispatchProducer: adapter(producerRaw), factProducer: adapter(migrator),
        openInvocationClient: async () => adapter(consumerRaw),
        retireConfirmedClient: async client => { assert.equal(client.raw, consumerRaw); retireCalls++;
          await consumerRaw.end({ timeout: 1 }); },
        capacity, limits: { scope: { kind: 'all' }, maxRegistrations: 2, maxItems: 2,
          concurrency: 1, leaseSeconds: 30, runBudgetMs: 10000,
          reservedBytesPerConsumer: 7, reservedBytesPerScan: 11 },
      });
      const outcome = await consumer.runOnce();
      assert.equal(outcome.status, 'run_drained', JSON.stringify(outcome));
      assert.equal(outcome.queueAckSafe, false);
      assert.equal(outcome.result.committed, 1);
      assert.equal(outcome.result.resources, 'confirmed');
      assert.equal(retireCalls, 1);
      const [durable] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT count(*)::int FROM ${schema}.provider_attempt_availability WHERE request_log_id=$1) AS attempts,
        (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE request_log_id=$1) AS audits,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent,
        (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`, [ref.requestId]);
      assert.deepEqual(durable, { receipts: 1, logs: 1, attempts: 1, audits: 1,
        spent: '1.250000', job_state: 'committed' });
      stage('dedicated-login-financial-commit', { durable, retireCalls, queueAckSafe: false });
      report.status = 'PASS';
    } catch (error) { report.status = 'FAIL'; report.fatal = summary(error); throw error; }
    finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native financial consumer LOGIN evidence: ' + reportFile);
      assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
    }
  });

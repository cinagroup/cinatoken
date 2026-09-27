// Explicit owned, loopback PG18 fixture. It never reads an ambient database URL.
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createPostgresFinancialConsumer } from '../../../packages/proxy/src/runtime/postgres-financial-consumer.ts';
import {
  buildFinancialConsumerDirectLoginGrant, FINANCIAL_CONSUMER_GRANT_ACTIVATION,
  FINANCIAL_CONSUMER_ROLE,
} from './build-financial-consumer-direct-login-grant.ts';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const replayProposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_replay_reservations_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url)],
  ['cinatoken.request_dispatch_replay_parent_gate_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url)],
];
const limits = Object.freeze({ scope: { kind: 'all' }, maxRegistrations: 1,
  maxItems: 1, concurrency: 1, leaseSeconds: 30, runBudgetMs: 10_000,
  reservedBytesPerConsumer: 7, reservedBytesPerScan: 11 });

function password() { return randomBytes(32).toString('hex'); }
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
    connection: { application_name: `cinatoken-native-${label}` } });
}
function adapter(raw) { return { driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) }; }
async function denied(run) { await assert.rejects(run, error => error?.code === '42501'); }

test('native PG18 review-only financial LOGIN grant enforces SCRAM, exact ACL and timeout authority',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned),
      `report-financial-direct-grant-${randomUUID()}.json`);
    const open = new Set();
    const tracked = (username, secret, label) => {
      const raw = client(cluster, username, secret, label); open.add(raw); return raw;
    };
    const stages = [];
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      scope: 'owned loopback PG18.6; review-only generated login and ACL after replay base/gate; no production SQL, Hyperdrive or Queue',
      binaryVersion: cluster.binaryVersion, stages, sourceSha256: {},
      limitations: ['SCRAM verifier structure cannot prove password entropy',
        'role connection limit requires separate live instance-wide origin budget',
        'grant fixture scans no financial job; durable commit is covered by the separate v328 fixture',
        'role default timeouts are session mutable; consumer rejects changed pg_settings source'] };
    for (const [name, url] of [
      ['generator', new URL('./build-financial-consumer-direct-login-grant.ts', import.meta.url)],
      ['unitTest', new URL('./build-financial-consumer-direct-login-grant.test.ts', import.meta.url)],
      ['nativeTest', new URL(import.meta.url)],
      ['roleCatalogue', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
      ['consumer', new URL('../../../packages/proxy/src/runtime/postgres-financial-consumer.ts', import.meta.url)],
    ]) report.sourceSha256[name] = createHash('sha256').update(await readFile(url)).digest('hex');
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
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
      const migrator = tracked('cinatoken_gateway_migrator', migratorPassword, 'financial-grant-migrator');
      const runtime = tracked('cinatoken_gateway_runtime', runtimePassword, 'financial-grant-runtime');
      const producerA = tracked('cinatoken_gateway_migrator', migratorPassword, 'financial-grant-producer-a');
      const producerB = tracked('cinatoken_gateway_migrator', migratorPassword, 'financial-grant-producer-b');
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation='reviewed-v1'");
        await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
      });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      stages.push('73-formal-migrations-guard-and-runtime-acl');

      for (const [index, [setting, url]] of replayProposals.entries()) {
        if (index === 2) {
          await migrator.unsafe(await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' })).simple();
        }
        const body = await readFile(url, 'utf8');
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      stages.push('parent-replay-expand-empty-backfill-gate-and-runtime-acl');

      const request = {
        activation: FINANCIAL_CONSUMER_GRANT_ACTIVATION,
        role: FINANCIAL_CONSUMER_ROLE, database: 'postgres',
        roleConnectionLimit: 2, scramVerifier: verifier,
      };
      const defaultPlan = await buildFinancialConsumerDirectLoginGrant(request);
      const plan = await buildFinancialConsumerDirectLoginGrant({
        ...request, replayReservationPhase: 'parent-gated',
      });
      await admin.unsafe(plan.adminSql).simple();
      const [role] = await admin.unsafe(`SELECT r.rolcanlogin, r.rolinherit, r.rolconnlimit,
        (SELECT count(*)::int FROM pg_catalog.pg_auth_members m
          WHERE m.roleid=r.oid OR m.member=r.oid) AS memberships,
        (SELECT rolpassword FROM pg_catalog.pg_authid a WHERE a.oid=r.oid) AS verifier
        FROM pg_catalog.pg_roles r WHERE r.rolname='${FINANCIAL_CONSUMER_ROLE}'`);
      assert.deepEqual(role, { rolcanlogin: true, rolinherit: false, rolconnlimit: 2,
        memberships: 0, verifier });
      stages.push('superuser-created-scram-login-without-pg18-membership');

      await assert.rejects(migrator.unsafe(defaultPlan.migratorSql).simple(),
        /Financial grant requires explicit parent-gated replay phase/);
      await migrator.unsafe('ROLLBACK').simple();
      stages.push('default-no-replay-plan-rejects-gated-replay-schema');

      await migrator.unsafe(`ALTER FUNCTION ${schema}.usage_commit_matches(text,text) VOLATILE`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant callable function contract differs/);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`ALTER FUNCTION ${schema}.usage_commit_matches(text,text) STABLE`);
      stages.push('callable-function-drift-blocks-grant');

      await migrator.unsafe('BEGIN').simple();
      await migrator.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.usage_money_v1(v text)
        RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
        SET search_path=pg_catalog,pg_temp SET extra_float_digits=3
        AS $financial_test$ SELECT 0::numeric $financial_test$;`).simple();
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant callable function contract differs/);
      await migrator.unsafe('ROLLBACK').simple();
      stages.push('callable-function-body-drift-blocks-grant');

      await migrator.unsafe(`CREATE TRIGGER financial_unreviewed_probe BEFORE INSERT
        ON ${schema}.request_usage_recovery_jobs FOR EACH ROW
        EXECUTE FUNCTION ${schema}.guard_usage_recovery_job()`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant reviewed relation has an extra trigger/);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`DROP TRIGGER financial_unreviewed_probe
        ON ${schema}.request_usage_recovery_jobs`);
      stages.push('unexpected-trigger-blocks-grant');

      await migrator.unsafe(`ALTER TABLE ${schema}.request_dispatch_intents
        DISABLE TRIGGER request_dispatch_intents_replay_reserve`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant trigger contract differs/);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`ALTER TABLE ${schema}.request_dispatch_intents
        ENABLE TRIGGER request_dispatch_intents_replay_reserve`);
      stages.push('disabled-replay-trigger-blocks-grant');

      await migrator.unsafe(`ALTER TABLE ${schema}.api_key_request_logs
        DISABLE TRIGGER api_key_request_logs_replay_id_immutable`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant trigger contract differs/);
      await migrator.unsafe('ROLLBACK').simple();
      await migrator.unsafe(`ALTER TABLE ${schema}.api_key_request_logs
        ENABLE TRIGGER api_key_request_logs_replay_id_immutable`);
      stages.push('disabled-replay-log-id-guard-blocks-grant');

      await migrator.unsafe('BEGIN').simple();
      await migrator.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.reserve_request_dispatch_parent_id()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
        SET search_path TO pg_catalog, pg_temp AS $replay_drift$
        BEGIN RETURN NEW; END; $replay_drift$;`).simple();
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial grant callable function contract differs/);
      await migrator.unsafe('ROLLBACK').simple();
      stages.push('replay-function-body-drift-blocks-grant');

      await migrator.unsafe(`GRANT SELECT (id) ON TABLE ${schema}.api_keys TO PUBLIC`);
      await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
        /Financial consumer column ACL differs|Financial consumer table ACL differs/);
      await migrator.unsafe('ROLLBACK').simple();
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.has_schema_privilege(
        '${FINANCIAL_CONSUMER_ROLE}', '${schema}', 'USAGE') AS allowed`))[0].allowed, false);
      await migrator.unsafe(`REVOKE SELECT (id) ON TABLE ${schema}.api_keys FROM PUBLIC`);
      await migrator.unsafe(plan.migratorSql).simple();
      stages.push('public-column-drift-blocks-atomic-grant-then-exact-grant-succeeds');

      const direct = tracked(FINANCIAL_CONSUMER_ROLE, consumerPassword, 'financial-grant-direct');
      const [identity] = await direct.unsafe(`SELECT current_user AS current_role,
        session_user AS session_role, current_setting('search_path') AS search_path`);
      assert.deepEqual(identity, { current_role: FINANCIAL_CONSUMER_ROLE,
        session_role: FINANCIAL_CONSUMER_ROLE, search_path: 'pg_catalog, pg_temp' });
      const settings = await direct.unsafe(`SELECT name, setting, unit, source
        FROM pg_catalog.pg_settings WHERE name IN ('transaction_timeout','statement_timeout',
          'lock_timeout','idle_in_transaction_session_timeout') ORDER BY name`);
      assert.deepEqual(Object.fromEntries(settings.map(row => [row.name, [row.setting, row.unit, row.source]])), {
        idle_in_transaction_session_timeout: ['10000', 'ms', 'database user'],
        lock_timeout: ['5000', 'ms', 'database user'],
        statement_timeout: ['15000', 'ms', 'database user'],
        transaction_timeout: ['30000', 'ms', 'database user'],
      });
      await denied(() => direct.unsafe(`SELECT * FROM ${schema}.api_keys LIMIT 1`));
      await denied(() => direct.unsafe(`UPDATE ${schema}.api_key_request_logs SET status='failed' WHERE id='none'`));
      await denied(() => direct.unsafe(`INSERT INTO ${schema}.request_usage_settlements(request_id) VALUES ('forbidden')`));
      await denied(() => direct.unsafe(`CREATE TABLE ${schema}.forbidden(id int)`));
      await assert.rejects(direct.unsafe('SET ROLE cinatoken_gateway_runtime'),
        error => error?.code === '42501');
      stages.push('direct-password-login-defaults-and-cross-role-denials');
      await direct.end({ timeout: 1 });

      const tampered = tracked(FINANCIAL_CONSUMER_ROLE, consumerPassword, 'financial-grant-tampered');
      await tampered.unsafe("SET transaction_timeout='0'");
      assert.equal((await tampered.unsafe(`SELECT source FROM pg_catalog.pg_settings
        WHERE name='transaction_timeout'`))[0].source, 'session');
      let acquired = 0;
      const base = {
        enabled: true, runtime: adapter(runtime), dispatchProducer: adapter(producerA),
        factProducer: adapter(producerB),
        limits, capacity: { tryAcquire() { acquired++; return { release() {} }; } },
        retireConfirmedClient: async () => {},
      };
      const rejected = createPostgresFinancialConsumer({
        ...base, openInvocationClient: async () => adapter(tampered),
      });
      assert.deepEqual(await rejected.runOnce(), { status: 'authority_rejected',
        queueAckSafe: false, locallyRetainedClient: true });
      assert.equal(acquired, 0);
      stages.push('session-overridden-deadline-rejected-before-scan-and-capacity');
      await tampered.end({ timeout: 1 });

      const clean = tracked(FINANCIAL_CONSUMER_ROLE, consumerPassword, 'financial-grant-clean');
      const drained = createPostgresFinancialConsumer({ ...base,
        openInvocationClient: async () => adapter(clean),
        retireConfirmedClient: async () => { await clean.end({ timeout: 1 }); },
      });
      const outcome = await drained.runOnce();
      assert.equal(outcome.status, 'run_drained', JSON.stringify(outcome));
      assert.equal(outcome.queueAckSafe, false);
      assert.equal(outcome.result.scanned, 0);
      stages.push('clean-login-empty-financial-scan');

      // A separate fresh LOGIN must load the shorter default from the server.
      await admin.unsafe(`ALTER ROLE ${FINANCIAL_CONSUMER_ROLE} IN DATABASE postgres
        SET transaction_timeout TO 200`);
      const bounded = tracked(FINANCIAL_CONSUMER_ROLE, consumerPassword, 'financial-grant-bounded');
      const [timeoutSource] = await bounded.unsafe(`SELECT setting, source FROM pg_catalog.pg_settings
        WHERE name='transaction_timeout'`);
      assert.deepEqual(timeoutSource, { setting: '200', source: 'database user' });
      await assert.rejects(bounded.begin(async tx => {
        await tx.unsafe('SELECT pg_catalog.pg_sleep(0.6)');
      }), error => ['25P03', '57014', '57P01', 'CONNECTION_CLOSED'].includes(error?.code)
        || /transaction timeout/i.test(String(error?.message)));
      assert.match(await cluster.readLog(), /terminating connection due to transaction timeout/i);
      stages.push('server-transaction-timeout-terminates-long-transaction');
      console.log(`Native financial LOGIN grant evidence: ${stages.length} stages PASS`);
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL';
      report.fatal = { name: error?.name ?? null, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 400) };
      throw error;
    } finally {
      await Promise.allSettled([...open].map(raw => raw.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error).slice(0, 400); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native financial direct grant report: ' + reportFile);
      assert.equal(report.cleanup, 'PASS', 'Owned native cluster cleanup failed');
    }
  });

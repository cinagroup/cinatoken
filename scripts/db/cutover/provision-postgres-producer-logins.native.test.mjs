// Explicit opt-in PG18+ password-authentication fixture. It starts only an
// owned loopback cluster and passes a dedicated URL to the provisioner.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import {
  DISPATCH_PRODUCER_ROLE, FACT_PRODUCER_ROLE, PRODUCER_LOGIN_ACTIVATION,
  provisionPostgresProducerLogins,
} from './provision-postgres-producer-logins.ts';

function summarize(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 240) };
}

function credential() { return randomBytes(32).toString('hex'); }

function client(cluster, username, password, database = 'postgres') {
  return postgres({ host: '127.0.0.1', port: cluster.port, database, username,
    password, ssl: false, sslnegotiation: null, fetch_types: false, prepare: false,
    max: 1, max_pipeline: 1, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, keep_alive: 0, debug: false, onnotice() {} });
}

async function rejectedLogin(cluster, username, password, database, expectedCode) {
  const sql = client(cluster, username, password, database);
  try {
    await assert.rejects(sql.unsafe('SELECT 1'), error => error?.code === expectedCode);
  } finally { await sql.end({ timeout: 1 }).catch(() => {}); }
}

test('PG18 producer login provisioner uses two direct identities and password rotation',
  { timeout: 150_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned),
      'report-producer-direct-login-' + randomUUID() + '.json');
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      scope: 'owned loopback-only PG18+ cluster, password-authenticated direct producer identities; no Hyperdrive or production origin',
      binaryVersion: cluster.binaryVersion, stages: [], sourceSha256: {} };
    for (const [name, url] of [
      ['nativeTest', new URL(import.meta.url)],
      ['provisioner', new URL('./provision-postgres-producer-logins.ts', import.meta.url)],
      ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ]) report.sourceSha256[name] = createHash('sha256').update(await readFile(url)).digest('hex');
    const open = new Set();
    const tracked = (username, password, database) => {
      const sql = client(cluster, username, password, database);
      open.add(sql); return sql;
    };
    try {
      const { admin } = cluster;
      const adminPassword = credential();
      const dbaPassword = credential();
      const firstDispatch = credential(), firstFact = credential();
      const secondDispatch = credential(), secondFact = credential();
      const adminRole = 'cinatoken_producer_provision_probe';
      const dbaRole = 'cinatoken_producer_dba_probe';
      await admin.unsafe(`
        CREATE ROLE cinatoken_gateway_migrator NOLOGIN;
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE ALL ON SCHEMA cinatoken_gateway FROM PUBLIC;
        REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
        CREATE ROLE ${adminRole} LOGIN CREATEROLE PASSWORD '${adminPassword}';
        CREATE ROLE ${dbaRole} LOGIN SUPERUSER PASSWORD '${dbaPassword}';
        GRANT CONNECT ON DATABASE postgres TO ${adminRole} WITH GRANT OPTION;
      `).simple();
      const administrator = tracked(adminRole, adminPassword);
      const [adminIdentity] = await administrator.unsafe(`
        SELECT session_user AS session_user, current_user AS current_user,
          (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
          (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=current_user) AS createrole
      `);
      assert.deepEqual(adminIdentity, { session_user: adminRole, current_user: adminRole,
        superuser: false, createrole: true });

      const env = (dispatchPassword, factPassword, additional = {},
        administratorRole = dbaRole, administratorPassword = dbaPassword) => ({
        DATABASE_URL: 'postgres://ambient:wrong@127.0.0.1:1/wrong',
        CINATOKEN_GATEWAY_PRODUCER_ACTIVATION: PRODUCER_LOGIN_ACTIVATION,
        CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL:
          `postgres://${administratorRole}:${administratorPassword}@127.0.0.1:${cluster.port}/postgres`,
        CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: dispatchPassword,
        CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: factPassword,
        ...additional,
      });

      await assert.rejects(
        provisionPostgresProducerLogins(env(firstDispatch, firstFact, {}, adminRole, adminPassword)),
        /requires a superuser/,
      );
      assert.equal((await admin.unsafe(`SELECT count(*)::integer AS count FROM pg_catalog.pg_roles
        WHERE rolname IN ('${DISPATCH_PRODUCER_ROLE}','${FACT_PRODUCER_ROLE}')`))[0].count, 0);
      report.stages.push({ name: 'createrole-user-fails-closed-before-automatic-membership',
        result: 'PASS', adminIdentity });

      const preview = await provisionPostgresProducerLogins(env(firstDispatch, firstFact,
        { CINATOKEN_GATEWAY_PRODUCER_DRY_RUN: 'true' }));
      assert.equal(preview.dryRun, true);
      const missing = await admin.unsafe(`SELECT rolname FROM pg_catalog.pg_roles
        WHERE rolname IN ('${DISPATCH_PRODUCER_ROLE}','${FACT_PRODUCER_ROLE}')`);
      assert.equal(missing.length, 0);
      report.stages.push({ name: 'dry-run-rolls-back-new-logins', result: 'PASS' });

      const applied = await provisionPostgresProducerLogins(env(firstDispatch, firstFact));
      assert.equal(applied.dryRun, false);
      const catalog = await admin.unsafe(`SELECT r.rolname, r.rolcanlogin, r.rolinherit,
        r.rolsuper, r.rolcreaterole, r.rolconnlimit,
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
          WHERE m.roleid=r.oid OR m.member=r.oid) AS memberships
        FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('${DISPATCH_PRODUCER_ROLE}','${FACT_PRODUCER_ROLE}')
        ORDER BY r.rolname`);
      assert.equal(catalog.length, 2);
      for (const row of catalog) {
        assert.equal(row.rolcanlogin, true);
        assert.equal(row.rolinherit, false);
        assert.equal(row.rolsuper, false);
        assert.equal(row.rolcreaterole, false);
        assert.equal(row.rolconnlimit, 2);
        assert.equal(row.memberships, 0);
      }
      report.stages.push({ name: 'superuser-created-zero-membership', result: 'PASS',
        catalog });

      const dispatch = tracked(DISPATCH_PRODUCER_ROLE, firstDispatch);
      const fact = tracked(FACT_PRODUCER_ROLE, firstFact);
      const identitySql = `SELECT session_user, current_user,
        current_setting('transaction_timeout') AS transaction_timeout,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('lock_timeout') AS lock_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
        current_setting('search_path') AS search_path`;
      const [dispatchIdentity] = await dispatch.unsafe(identitySql);
      const [factIdentity] = await fact.unsafe(identitySql);
      for (const [role, identity] of [
        [DISPATCH_PRODUCER_ROLE, dispatchIdentity], [FACT_PRODUCER_ROLE, factIdentity],
      ]) {
        assert.equal(identity.session_user, role);
        assert.equal(identity.current_user, role);
        assert.equal(identity.transaction_timeout, '30s');
        assert.equal(identity.statement_timeout, '15s');
        assert.equal(identity.lock_timeout, '2s');
        assert.equal(identity.idle_timeout, '10s');
        assert.equal(identity.search_path, 'pg_catalog, pg_temp');
      }
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, firstFact, 'postgres', '28P01');
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, firstDispatch, 'postgres', '28P01');
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, 'wrong-password', 'postgres', '28P01');
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, 'wrong-password', 'postgres', '28P01');
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, firstDispatch, 'template1', '42501');
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, firstFact, 'template1', '42501');
      report.stages.push({ name: 'direct-login-defaults-and-cross-role-denials', result: 'PASS',
        identities: [dispatchIdentity, factIdentity], passwordDenialSqlstate: '28P01',
        otherDatabaseDenialSqlstate: '42501' });

      const repeated = await provisionPostgresProducerLogins(env(secondDispatch, secondFact));
      assert.equal(repeated.rotatedExistingPasswords, false);
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, secondDispatch, 'postgres', '28P01');
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, secondFact, 'postgres', '28P01');
      report.stages.push({ name: 'idempotent-run-preserves-existing-passwords', result: 'PASS' });

      const legacyFactPassword = credential();
      await admin.unsafe(`SET password_encryption = 'md5';
        ALTER ROLE ${FACT_PRODUCER_ROLE} PASSWORD '${legacyFactPassword}';
        RESET password_encryption;`).simple();
      await assert.rejects(provisionPostgresProducerLogins(env(secondDispatch, secondFact)),
        /SCRAM verifier; explicit password rotation is required/);
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, legacyFactPassword, 'postgres', '28P01');
      await admin.unsafe(`ALTER ROLE ${FACT_PRODUCER_ROLE} PASSWORD '${firstFact}'`);
      await admin.unsafe(`ALTER ROLE ${DISPATCH_PRODUCER_ROLE} PASSWORD NULL`);
      await assert.rejects(provisionPostgresProducerLogins(env(secondDispatch, secondFact)),
        /SCRAM verifier; explicit password rotation is required/);
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, firstDispatch, 'postgres', '28P01');
      report.stages.push({ name: 'existing-login-null-and-md5-verifiers-rejected', result: 'PASS' });

      const dryRotation = await provisionPostgresProducerLogins(env(secondDispatch, secondFact,
        { CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS: 'true',
          CINATOKEN_GATEWAY_PRODUCER_DRY_RUN: 'true' }));
      assert.equal(dryRotation.dryRun, true);
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, secondDispatch, 'postgres', '28P01');
      report.stages.push({ name: 'dry-run-rolls-back-password-rotation', result: 'PASS' });

      await dispatch.end({ timeout: 1 }); open.delete(dispatch);
      await fact.end({ timeout: 1 }); open.delete(fact);
      await provisionPostgresProducerLogins(env(secondDispatch, secondFact,
        { CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS: 'true' }));
      await rejectedLogin(cluster, DISPATCH_PRODUCER_ROLE, firstDispatch, 'postgres', '28P01');
      await rejectedLogin(cluster, FACT_PRODUCER_ROLE, firstFact, 'postgres', '28P01');
      const dispatchAfter = tracked(DISPATCH_PRODUCER_ROLE, secondDispatch);
      const factAfter = tracked(FACT_PRODUCER_ROLE, secondFact);
      assert.equal((await dispatchAfter.unsafe('SELECT current_user AS role'))[0].role,
        DISPATCH_PRODUCER_ROLE);
      assert.equal((await factAfter.unsafe('SELECT current_user AS role'))[0].role,
        FACT_PRODUCER_ROLE);
      report.stages.push({ name: 'explicit-password-rotation', result: 'PASS' });

      await dispatchAfter.end({ timeout: 1 }); open.delete(dispatchAfter);
      await factAfter.end({ timeout: 1 }); open.delete(factAfter);
      await admin.unsafe(`ALTER ROLE ${DISPATCH_PRODUCER_ROLE} NOLOGIN PASSWORD NULL;
        ALTER ROLE ${FACT_PRODUCER_ROLE} NOLOGIN PASSWORD NULL;`).simple();
      const thirdDispatch = credential(), thirdFact = credential();
      const transition = await provisionPostgresProducerLogins(env(thirdDispatch, thirdFact));
      assert.equal(transition.rotatedExistingPasswords, false);
      const dispatchTransition = tracked(DISPATCH_PRODUCER_ROLE, thirdDispatch);
      const factTransition = tracked(FACT_PRODUCER_ROLE, thirdFact);
      assert.equal((await dispatchTransition.unsafe('SELECT session_user AS role'))[0].role,
        DISPATCH_PRODUCER_ROLE);
      assert.equal((await factTransition.unsafe('SELECT session_user AS role'))[0].role,
        FACT_PRODUCER_ROLE);
      report.stages.push({ name: 'existing-nologin-roles-transition-to-direct-password-login',
        result: 'PASS' });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = summarize(error); throw error;
    } finally {
      await Promise.allSettled([...open].map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summarize(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      console.log('Native producer login evidence: ' + reportFile);
      console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
        stages: report.stages.map(stage => ({ name: stage.name, result: stage.result })) }));
      assert.equal(report.cleanup, 'PASS', 'Owned PostgreSQL fixture cleanup failed');
    }
  });

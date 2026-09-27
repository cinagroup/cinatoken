// Review-only negative proof for a seller-scoped credited-usage reader.
// Starts a fresh owned loopback PostgreSQL cluster. No remote connection.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const root = new URL('../../../', import.meta.url);
const migrationDir = new URL('packages/core/migrations-postgres/', root);
const reportPath = new URL(
  'docs/developers/architecture/implementation-evidence/C04-postgres-stats-auth-boundary-v346-results.json',
  root,
);
const sha256 = body => createHash('sha256').update(body).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 400) });

function connect(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-stats-auth-v346-${label}` } });
}

test('PG18 shared runtime can forge a portal-session seller identity',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6; formal PG73 and actual grant-postgres-runtime.ts',
      sourceSha256: {}, stages: [], limitations: [
        'Negative authorization proof only. It does not install or grant a stats reader.',
        'A separate read LOGIN alone is not a per-request seller identity; a claim minted from mutable portal_sessions is forgeable by the ordinary runtime.',
        'No independent claim signer, DB verification key, Admin all-seller grant, or production cutover is supplied.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = connect(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const runtime = connect(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      clients.push(migrator, runtime);
      await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrationDir), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe('INSERT INTO cinatoken_gateway.schema_migrations(version) VALUES ($1)', [name]);
        });
      }
      const sources = {
        nativeFixture: new URL(import.meta.url),
        runtimeGrant: new URL('scripts/db/cutover/grant-postgres-runtime.ts', root),
        portalAuth: new URL('packages/admin/lib/user-auth.ts', root),
        portalSessionHash: new URL('packages/admin/lib/auth.ts', root),
        statsReader: new URL('packages/core/migrations-proposals/postgres/shared-key-credited-usage-reader.sql', root),
      };
      report.sourceSha256 = { formalMigrationCorpus: sha256(corpus.join('\n')),
        ...Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, url]) =>
          [key, sha256(await readFile(url, 'utf8'))]))) };
      stage('exact-formal-pg73-installed');

      await grantPostgresRuntime({ DATABASE_URL:
        `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres` });
      const [rights] = await runtime.unsafe(`SELECT session_user, current_user,
        pg_catalog.has_table_privilege(current_user,
          'cinatoken_gateway.portal_sessions', 'SELECT') AS session_select,
        pg_catalog.has_table_privilege(current_user,
          'cinatoken_gateway.portal_sessions', 'INSERT') AS session_insert,
        pg_catalog.has_table_privilege(current_user,
          'cinatoken_gateway.portal_sessions', 'UPDATE') AS session_update,
        pg_catalog.has_table_privilege(current_user,
          'cinatoken_gateway.users', 'INSERT') AS users_insert`);
      assert.equal(rights.session_user, 'cinatoken_gateway_runtime');
      assert.equal(rights.current_user, 'cinatoken_gateway_runtime');
      assert.equal(rights.session_select, true);
      assert.equal(rights.session_insert, true);
      assert.equal(rights.session_update, true);
      assert.equal(rights.users_insert, true);
      stage('real-broad-grant-leaves-portal-session-and-user-writes-to-runtime');

      // A bearer token checked only by portal_sessions cannot independently
      // attest a seller while this role can create its own matching hash row.
      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users
        (id, email, external_system, external_user_id, status)
        VALUES ('victim-seller', 'victim@example.invalid', 'cinaauth',
          'victim-subject', 'active')`);
      const fakeToken = randomBytes(32).toString('hex');
      const fakeHash = sha256(fakeToken);
      await runtime.unsafe(`INSERT INTO cinatoken_gateway.portal_sessions
        (token_hash, subject, email, expires_at)
        VALUES ($1, 'victim-subject', 'victim@example.invalid',
          pg_catalog.clock_timestamp() + interval '1 hour')`, [fakeHash]);
      const [derived] = await runtime.unsafe(`SELECT u.id AS seller_user_id
        FROM cinatoken_gateway.portal_sessions AS p
        JOIN cinatoken_gateway.users AS u
          ON u.external_system = 'cinaauth' AND u.external_user_id = p.subject
        WHERE p.token_hash = $1 AND p.expires_at > pg_catalog.clock_timestamp()
          AND u.status <> 'disabled'`, [sha256(fakeToken)]);
      assert.equal(derived.seller_user_id, 'victim-seller');
      stage('runtime-can-mint-bearer-credential-for-existing-seller');

      const [setting] = await runtime.unsafe(`SELECT pg_catalog.set_config(
        'cinatoken.stats_seller_user_id', 'victim-seller', false) AS claimed_seller`);
      assert.equal(setting.claimed_seller, 'victim-seller');
      const [readBack] = await runtime.unsafe(`SELECT pg_catalog.current_setting(
        'cinatoken.stats_seller_user_id', true) AS claimed_seller`);
      assert.equal(readBack.claimed_seller, 'victim-seller');
      stage('caller-controlled-guc-cannot-authenticate-seller');

      // The v344 private reader is deliberately not installed here; its native
      // fixture separately proves 42501 for the ordinary runtime even after
      // grant rerun. We only verify the absent proposal never arrived via PG73.
      const [reader] = await migrator.unsafe(`SELECT
        pg_catalog.to_regprocedure(
          'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])')
          IS NULL AS absent`);
      assert.equal(reader.absent, true);
      stage('formal-pg73-has-no-executable-stats-reader');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorInfo(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
    if (failure) throw failure;
  });

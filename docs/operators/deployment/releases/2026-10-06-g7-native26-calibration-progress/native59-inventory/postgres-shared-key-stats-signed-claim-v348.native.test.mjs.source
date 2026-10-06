// Review-only signed seller-scope primitive. Fresh owned loopback PostgreSQL.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const root = new URL('../../../', import.meta.url);
const migrationDir = new URL('packages/core/migrations-postgres/', root);
const proposalPath = new URL('packages/core/migrations-proposals/postgres/shared-key-stats-signed-claim-v348.sql', root);
const reportPath = new URL('docs/developers/architecture/implementation-evidence/C04-stats-signed-claim-v348-results.json', root);
const sha256 = body => createHash('sha256').update(body).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null,
  constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 400) });

function connect(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-stats-claim-v348-${label}` } });
}

test('PG18 signed seller claim rejects runtime/session/GUC forgery and replay',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion,
      scope: 'owned PG18.6; formal PG73, real broad grant, review-only claim primitive',
      sourceSha256: {}, stages: [], limitations: [
        'No independent production issuer, secret provisioning or rotation, app binding, audited credited-usage reader, or admin claim is activated.',
        'The dedicated reader LOGIN only exercises claim verification here; this fixture does not authorize a statistics read.',
        'Nonce uniqueness is durable only after commit; an explicit rollback after disclosure permits reuse until the claim expires.',
        'Nonce rows are retained indefinitely in this proposal pending a reviewed expiry-safe retention policy.',
        'pgcrypto availability and lock/latency behavior need validation in the target PostgreSQL deployment.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const readerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_stats_reader LOGIN NOINHERIT PASSWORD '${readerPassword}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_stats_reader;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = connect(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const runtime = connect(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const reader = connect(cluster, 'cinatoken_gateway_stats_reader', readerPassword, 'reader');
      const concurrentReader = connect(cluster, 'cinatoken_gateway_stats_reader', readerPassword, 'concurrent-reader');
      clients.push(migrator, runtime, reader, concurrentReader);
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
      const proposal = await readFile(proposalPath, 'utf8');
      report.sourceSha256 = { formalMigrationCorpus: sha256(corpus.join('\n')),
        proposal: sha256(proposal),
        nativeFixture: sha256(await readFile(new URL(import.meta.url), 'utf8')),
        runtimeGrant: sha256(await readFile(new URL('scripts/db/cutover/grant-postgres-runtime.ts', root), 'utf8')) };
      stage('formal-pg73-installed');
      await grantPostgresRuntime({ DATABASE_URL:
        `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres` });
      stage('real-broad-runtime-grant-installed');
      await assert.rejects(migrator.begin(async tx => tx.unsafe(proposal).simple()),
        error => error?.constraint_name === 'shared_key_stats_claim_install');
      await cluster.admin.unsafe(`GRANT cinatoken_gateway_runtime
        TO cinatoken_gateway_stats_reader`);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_stats_claim_install='reviewed-v1'`);
        await tx.unsafe(proposal).simple();
      }), error => error?.constraint_name === 'shared_key_stats_claim_install');
      await cluster.admin.unsafe(`REVOKE cinatoken_gateway_runtime
        FROM cinatoken_gateway_stats_reader`);
      stage('default-off-and-reader-role-membership-install-denied');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_stats_claim_install='reviewed-v1'`);
        await tx.unsafe(proposal).simple();
      });
      stage('default-off-install-and-private-pgcrypto-schema');

      const secret = randomBytes(32);
      const secretHex = secret.toString('hex');
      await migrator.unsafe(`INSERT INTO cinatoken_stats_claim.keys
        (key_id,secret,not_before,not_after)
        VALUES ('issuer-v1',pg_catalog.decode($1,'hex'),
          pg_catalog.clock_timestamp()-interval '1 minute',
          pg_catalog.clock_timestamp()+interval '1 hour')`, [secretHex]);
      const expiry = () => Math.floor(Date.now() / 1000) + 120;
      const claim = (overrides = {}) => ({ keyId: 'issuer-v1', sellerId: 'seller-a',
        keyIds: ['key-a', 'key-b'], expiresEpoch: expiry(), nonce: randomUUID(),
        ...overrides });
      const payload = (c, audience = 'stats.read') =>
        `v1|${audience}|${c.keyId}|${c.sellerId}|${c.keyIds.join(',')}|${c.expiresEpoch}|${c.nonce}`;
      const signature = (c, audience) => createHmac('sha256', secret)
        .update(payload(c, audience), 'utf8').digest();
      const verify = (sql, c, sig = signature(c)) => sql.unsafe(`SELECT
        cinatoken_stats_claim.verify_seller_stats_claim(
          $1::text,$2::text,pg_catalog.string_to_array($3::text,','),
          $4::bigint,$5::uuid,$6::bytea) AS seller_id`,
        [c.keyId, c.sellerId, c.keyIds.join(','), c.expiresEpoch, c.nonce, sig]);
      const first = claim();
      assert.equal((await verify(reader, first))[0].seller_id, 'seller-a');
      await assert.rejects(verify(reader, first),
        error => error?.constraint_name === 'shared_key_stats_claim_replay');
      stage('independently-signed-seller-scope-consumed-once');

      const competing = claim();
      const competingResults = await Promise.allSettled([
        verify(reader, competing), verify(concurrentReader, competing),
      ]);
      assert.equal(competingResults.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(competingResults.filter(result => result.status === 'rejected'
        && result.reason?.constraint_name === 'shared_key_stats_claim_replay').length, 1);
      stage('concurrent-same-nonce-has-one-winner');

      const rolledBack = claim();
      await assert.rejects(reader.begin(async tx => {
        assert.equal((await verify(tx, rolledBack))[0].seller_id, 'seller-a');
        throw new Error('intentional read transaction rollback');
      }), /intentional read transaction rollback/);
      assert.equal((await verify(reader, rolledBack))[0].seller_id, 'seller-a');
      stage('explicit-read-transaction-rollback-allows-limited-reuse');

      const sellerTamper = claim();
      await assert.rejects(verify(reader, { ...sellerTamper, sellerId: 'seller-b' },
        signature(sellerTamper)),
      error => error?.constraint_name === 'shared_key_stats_claim_signature');
      const scopeTamper = claim();
      await assert.rejects(verify(reader, { ...scopeTamper, keyIds: ['key-a', 'key-c'] },
        signature(scopeTamper)),
      error => error?.constraint_name === 'shared_key_stats_claim_signature');
      const wrongAudience = claim();
      await assert.rejects(verify(reader, wrongAudience, signature(wrongAudience, 'stats.admin')),
        error => error?.constraint_name === 'shared_key_stats_claim_signature');
      const unordered = claim({ keyIds: ['key-b', 'key-a'] });
      await assert.rejects(verify(reader, unordered),
        error => error?.constraint_name === 'shared_key_stats_claim_scope');
      stage('seller-key-scope-audience-and-order-tampering-denied');

      const expired = claim({ expiresEpoch: Math.floor(Date.now() / 1000) - 1 });
      await assert.rejects(verify(reader, expired),
        error => error?.constraint_name === 'shared_key_stats_claim_expiry');
      const tooLong = claim({ expiresEpoch: Math.floor(Date.now() / 1000) + 3600 });
      await assert.rejects(verify(reader, tooLong),
        error => error?.constraint_name === 'shared_key_stats_claim_expiry');
      stage('expired-and-overlong-claims-denied');

      await assert.rejects(runtime.unsafe(`SELECT * FROM cinatoken_stats_claim.keys`),
        error => error?.code === '42501');
      await assert.rejects(reader.unsafe(`SELECT * FROM cinatoken_stats_claim.keys`),
        error => error?.code === '42501');
      await assert.rejects(reader.unsafe(`SELECT * FROM cinatoken_stats_claim.used_nonces`),
        error => error?.code === '42501');
      await assert.rejects(verify(runtime, claim()), error => error?.code === '42501');
      await assert.rejects(runtime.unsafe(`SET ROLE cinatoken_gateway_stats_reader`),
        error => error?.code === '42501');
      stage('ordinary-runtime-and-reader-direct-secret-access-denied');

      await migrator.unsafe(`UPDATE cinatoken_stats_claim.keys
        SET revoked_at=pg_catalog.clock_timestamp() WHERE key_id='issuer-v1'`);
      await assert.rejects(verify(reader, claim()),
        error => error?.constraint_name === 'shared_key_stats_claim_key');
      stage('migrator-revocation-stops-future-claims');

      await grantPostgresRuntime({ DATABASE_URL:
        `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres` });
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.has_schema_privilege(
        'cinatoken_gateway_runtime','cinatoken_stats_claim','USAGE') AS runtime_usage,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)',
          'EXECUTE') AS runtime_execute`))[0].runtime_usage, false);
      stage('current-runtime-grant-rerun-does-not-open-private-claim-schema');
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

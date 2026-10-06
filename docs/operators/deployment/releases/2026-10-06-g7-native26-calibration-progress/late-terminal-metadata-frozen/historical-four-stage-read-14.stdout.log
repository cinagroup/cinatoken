// Opt-in PostgreSQL 18.6 fixture. New owned loopback cluster only; no ambient
// database, provider, Queue, Worker, Hyperdrive or financial charge.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { buildPostgresReplayReservationBackfill } from './build-postgres-replay-reservation-backfill.mjs';
import { buildPostgresReplayRetentionCandidates } from './build-postgres-replay-retention-candidates.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_parent_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url)],
];
const baseUrl = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url);
const gateUrl = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const context = 'a'.repeat(64), requestHash = 'b'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function client(cluster, password, label, username = 'cinatoken_gateway_migrator') {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: `cinatoken-replay-${label}` }, onnotice() {} });
}
async function nowMs(sql, add = 0) {
  return Number((await sql.unsafe(`SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$1)::text AS ms`, [add]))[0].ms);
}
async function prepare(sql, id, expiry, attempt = 1) {
  return (await sql.unsafe(`SELECT ${schema}.prepare_request_dispatch_intent_v1(
    $1,$2,'replay-user','replay-key','replay-space','images.generations',$3,$4,$5,2) AS accepted`,
  [id, attempt, requestHash, context, expiry]))[0].accepted;
}
async function claim(sql, id, claimId) {
  return (await sql.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
    $1,1,'replay-user','replay-key','replay-space','images.generations',$2,$3,0,$4) AS accepted`,
  [id, requestHash, context, claimId]))[0].accepted;
}
async function activate(sql, setting, url) {
  const body = await readFile(url, 'utf8');
  return sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}
async function backfill(sql, source, limit = 1) {
  let afterRequestId = null, scanned = 0, inserted = 0, pages = 0;
  while (true) {
    const { batchSql } = buildPostgresReplayReservationBackfill({ source, afterRequestId, limit });
    const [result] = await sql.begin(async tx => {
      await tx.unsafe("SET LOCAL lock_timeout = '2s'");
      return tx.unsafe(batchSql);
    });
    pages++; scanned += result.scanned; inserted += result.reserved;
    if (!result.scanned) break;
    if (afterRequestId !== null) assert.ok(result.next_request_id > afterRequestId);
    afterRequestId = result.next_request_id;
  }
  return { source, scanned, inserted, pages };
}
async function review(sql, args) {
  const built = buildPostgresReplayRetentionCandidates(args);
  return sql.begin(async tx => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.unsafe(built.preflightSql).simple();
    return tx.unsafe(built.querySql);
  });
}

test('native PG18 replay reservation, bounded backfill, parent gate and retention classification',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-replay-reservations-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18.6; 73 formal migrations; review-only reservation and gate proposals',
      limitations: [
        'No source-history deletion or archival is authorized; delete_allowed remains false.',
        'The immutable reservation grows indefinitely until a separately reviewed replay horizon and retention policy exist.',
        'Lock duration and capacity on a representative production-size old database are not measured.',
        'The receipt-before-log check uses the migrator fixture with formal 0072 triggers; it does not install the optional legacy-log guard or exercise the dedicated financial consumer LOGIN.',
      ], sourceSha256: {}, stages: [] };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const password = randomBytes(24).toString('hex');
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, password, 'migrator');
      const holder = client(cluster, password, 'holder');
      const contender = client(cluster, password, 'contender');
      clients.push(migrator, holder, contender);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      for (const [name, url] of [['nativeTest', new URL(import.meta.url)],
        ['baseProposal', baseUrl], ['gateProposal', gateUrl],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['backfillGenerator', new URL('./build-postgres-replay-reservation-backfill.mjs', import.meta.url)],
        ['candidateGenerator', new URL('./build-postgres-replay-retention-candidates.mjs', import.meta.url)]]) {
        report.sourceSha256[name] = digest(await readFile(url));
      }
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('replay-user','replay-native@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('replay-space','personal','replay-user','Replay Native','replay-native','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('replay-key','replay-native-key','replay-user','replay-space');`).simple();
      for (const [setting, url] of proposals) await activate(migrator, setting, url);
      stage('formal-schema-and-parent-installed', { migrations: files.length });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      stage('ordinary-runtime-default-acl-installed-before-replay-expand');

      const producerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE replay_producer LOGIN PASSWORD '${producerPassword}';
        GRANT USAGE ON SCHEMA ${schema} TO replay_producer;`).simple();
      await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${schema}.prepare_request_dispatch_intent_v1(
        text,integer,text,text,text,text,text,text,bigint,integer) TO replay_producer`);
      const producer = client(cluster, producerPassword, 'producer', 'replay_producer');
      clients.push(producer);
      const [producerIdentity] = await producer.unsafe('SELECT session_user, current_user');
      assert.deepEqual(producerIdentity, { session_user: 'replay_producer', current_user: 'replay_producer' });
      await assert.rejects(producer.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('replay-producer-direct',1,'replay-user','replay-key','replay-space',
          'images.generations',$1,$2)`, [context, await nowMs(migrator, 60_000)]),
      error => error?.code === '42501');
      stage('real-producer-login-function-only-no-direct-intent-dml');

      const historical = 'replay-old-' + randomUUID();
      const oldClaim = randomUUID();
      const oldExpiry = await nowMs(migrator, 15_000);
      assert.equal(await prepare(migrator, historical, oldExpiry), true);
      assert.equal(await claim(migrator, historical, oldClaim), true);
      await migrator.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [historical]);
      const longLogId = 'z' + 'x'.repeat(1200);
      await migrator.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [longLogId]);
      // A default function ACL can grant an unrelated role EXECUTE on every
      // newly created trigger function. Isolate the new log-ID update guard:
      // the expand proposal must reject even when its older four functions
      // have had that extra grant removed inside the installation transaction.
      await cluster.admin.unsafe('CREATE ROLE replay_acl_probe NOLOGIN');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO replay_acl_probe`);
      try {
        const baseSql = await readFile(baseUrl, 'utf8');
        const aclBoundary = baseSql.lastIndexOf('DO $acl$');
        assert.ok(aclBoundary > 0, 'expand ACL audit boundary is present');
        await assert.rejects(migrator.begin(async tx => {
          await tx.unsafe("SET LOCAL cinatoken.request_dispatch_replay_reservations_activation = 'reviewed-v1'");
          await tx.unsafe(baseSql.slice(0, aclBoundary)).simple();
          await tx.unsafe(`REVOKE EXECUTE ON FUNCTION
            ${schema}.guard_request_dispatch_replay_insert(),
            ${schema}.reject_request_dispatch_replay_mutation(),
            ${schema}.reserve_request_dispatch_intent_id(),
            ${schema}.reserve_request_log_replay_id()
            FROM replay_acl_probe`);
          const [extraAcl] = await tx.unsafe(`SELECT pg_catalog.string_agg(p.proname, ',' ORDER BY p.proname) AS functions
            FROM pg_catalog.pg_proc p,
              LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
                pg_catalog.acldefault('f', p.proowner))) acl
            WHERE p.pronamespace='${schema}'::pg_catalog.regnamespace
              AND p.proname LIKE '%request%replay%'
              AND acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='replay_acl_probe')`);
          assert.equal(extraAcl.functions, 'guard_request_log_replay_id_update');
          await tx.unsafe(baseSql.slice(aclBoundary)).simple();
        }), /Replay reservation default ACL exposes a nonowner/);
      } finally {
        await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
          REVOKE EXECUTE ON FUNCTIONS FROM replay_acl_probe`);
      }
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_replay_tombstones') AS relation`))[0].relation, null);
      stage('expand-rejects-extra-execute-on-new-log-id-guard-and-rolls-back');
      await activate(migrator, 'cinatoken.request_dispatch_replay_reservations_activation', baseUrl);
      const directPassword = randomBytes(24).toString('hex');
      const logPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE replay_legacy_direct LOGIN PASSWORD '${directPassword}';
        CREATE ROLE replay_legacy_log LOGIN PASSWORD '${logPassword}';
        GRANT USAGE ON SCHEMA ${schema} TO replay_legacy_direct,replay_legacy_log;`).simple();
      await migrator.unsafe(`GRANT INSERT ON ${schema}.request_dispatch_intents TO replay_legacy_direct;
        GRANT SELECT ON ${schema}.request_dispatch_replay_tombstones TO replay_legacy_direct;
        GRANT INSERT ON ${schema}.api_key_request_logs TO replay_legacy_log;
        GRANT SELECT (id,workspace_id) ON ${schema}.api_keys TO replay_legacy_log;`).simple();
      const legacyDirect = client(cluster, directPassword, 'legacy-direct', 'replay_legacy_direct');
      const logWriter = client(cluster, logPassword, 'legacy-log', 'replay_legacy_log');
      clients.push(legacyDirect, logWriter);
      const transient = 'replay-transient-' + randomUUID();
      await assert.rejects(legacyDirect.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
          (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
          VALUES ($1,1,'replay-user','replay-key','replay-space','images.generations',$2,$3)`,
        [transient, context, await nowMs(migrator, 60_000)]);
        const [inside] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
          WHERE request_id=$1`, [transient]);
        assert.equal(inside.n, 1);
        throw new Error('fixture rollback after observing same-transaction reservation');
      }), /fixture rollback/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [transient]))[0].n, 0);
      await migrator.unsafe(`REVOKE INSERT ON ${schema}.request_dispatch_intents FROM replay_legacy_direct;
        REVOKE SELECT ON ${schema}.request_dispatch_replay_tombstones FROM replay_legacy_direct;`).simple();
      stage('pre-switch-direct-legacy-writer-reserves-without-tombstone-dml');
      await assert.rejects(activate(migrator,
        'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl),
      /backfill or parent gate contract incomplete/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.request_dispatch_requests'::regclass
          AND tgname='request_dispatch_requests_replay_reserve'`))[0].n, 0);
      const parentBatch = await backfill(migrator, 'parent');
      const intentBatch = await backfill(migrator, 'intent');
      const legacyBatch = await backfill(migrator, 'legacy_log');
      assert.equal(parentBatch.scanned, 1);
      assert.equal(parentBatch.inserted, 1);
      assert.equal(intentBatch.scanned, 1);
      assert.equal(intentBatch.inserted, 0);
      assert.equal(legacyBatch.scanned, 2);
      assert.equal(legacyBatch.inserted, 1);
      assert.equal(legacyBatch.pages, 3);
      stage('bounded-resumable-backfill-and-missing-row-gate-reject',
        { parentBatch, intentBatch, legacyBatch, longCursorBytes: Buffer.byteLength(longLogId) });

      const lateLog = 'a-replay-late-' + randomUUID();
      await logWriter.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [lateLog]);
      assert.equal((await migrator.unsafe(`SELECT first_source FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [lateLog]))[0].first_source, 'legacy_log');
      stage('late-low-sorting-legacy-log-reserved-after-cursor');

      // Model a pre-existing import/drift row that appeared below a saved
      // cursor without its registration. Normal log writers use the trigger;
      // this isolated superuser fixture verifies the final census fails closed.
      const missedLog = 'a-replay-missed-' + randomUUID();
      await cluster.admin.begin(async tx => {
        await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
        [missedLog]);
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [missedLog]))[0].n, 0);
      await assert.rejects(activate(migrator,
        'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl),
      /backfill or parent gate contract incomplete/);
      const recoveredLateBatch = await backfill(migrator, 'legacy_log');
      assert.equal(recoveredLateBatch.inserted, 1);
      stage('final-seven-source-census-detects-and-recovers-missed-low-id',
        { recoveredLateBatch });

      const producerBeforeGate = 'replay-producer-expand-' + randomUUID();
      assert.equal(await prepare(producer, producerBeforeGate, await nowMs(migrator, 60_000)), true);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [producerBeforeGate]))[0].n, 1);
      stage('producer-security-definer-pre-gate-reserves-in-same-commit');

      await migrator.unsafe(`ALTER TABLE ${schema}.api_key_request_logs
        DISABLE TRIGGER api_key_request_logs_replay_id_immutable`);
      await assert.rejects(activate(migrator,
        'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl),
      /backfill or parent gate contract incomplete/);
      await migrator.unsafe(`ALTER TABLE ${schema}.api_key_request_logs
        ENABLE TRIGGER api_key_request_logs_replay_id_immutable`);
      stage('gate-rejects-disabled-legacy-log-id-immutability');

      await holder.unsafe('BEGIN');
      try {
        await holder.unsafe(`LOCK TABLE ${schema}.request_dispatch_intents IN ROW EXCLUSIVE MODE`);
        await assert.rejects(activate(migrator,
          'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl),
        error => error?.code === '55P03');
      } finally { await holder.unsafe('ROLLBACK'); }
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.request_dispatch_requests'::regclass
          AND tgname='request_dispatch_requests_replay_reserve'`))[0].n, 0);
      await activate(migrator, 'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl);
      stage('gate-lock-timeout-atomic-rollback-then-activation');
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.request_dispatch_replay_tombstones',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.reserve_request_dispatch_intent_id()', 'EXECUTE') AS intent_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.reserve_request_log_replay_id()', 'EXECUTE') AS log_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.reserve_request_dispatch_parent_id()', 'EXECUTE') AS parent_execute`);
      assert.deepEqual(acl, { table_access: false, intent_execute: false,
        log_execute: false, parent_execute: false });
      const runtime = cluster.client('replay-runtime');
      await runtime.unsafe('SET ROLE cinatoken_gateway_runtime');
      await assert.rejects(runtime.unsafe(`SELECT request_id FROM ${schema}.request_dispatch_replay_tombstones`),
        error => error?.code === '42501');
      await assert.rejects(runtime.unsafe(`INSERT INTO ${schema}.request_dispatch_replay_tombstones
        (request_id,first_source) VALUES ('runtime-forged','intent')`),
      error => error?.code === '42501');
      await assert.rejects(runtime.unsafe(`SELECT ${schema}.reserve_request_dispatch_parent_id()`),
        error => error?.code === '42883' || error?.code === '42501');
      stage('runtime-grant-rerun-preserves-registry-and-function-denial', { acl });

      const postGateLog = 'a-replay-post-gate-' + randomUUID();
      await logWriter.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [postGateLog]);
      assert.equal((await migrator.unsafe(`SELECT first_source FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [postGateLog]))[0].first_source, 'legacy_log');
      const rewrittenId = `${postGateLog}-rewritten`;
      await assert.rejects(migrator.unsafe(`UPDATE ${schema}.api_key_request_logs
        SET id=$2,user_email='rewritten@example.invalid' WHERE id=$1`,
      [postGateLog, rewrittenId]), /Request log ID cannot be rewritten/);
      await migrator.unsafe(`UPDATE ${schema}.api_key_request_logs
        SET user_email='allowed@example.invalid' WHERE id=$1`, [postGateLog]);
      await migrator.unsafe(`UPDATE ${schema}.api_key_request_logs SET id=id WHERE id=$1`, [postGateLog]);
      const [immutableLog] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs
          WHERE id=$1 AND user_email='allowed@example.invalid') AS old_id,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$2) AS new_id,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_replay_tombstones
          WHERE request_id=$2) AS new_reservation`, [postGateLog, rewrittenId]);
      assert.deepEqual(immutableLog, { old_id: 1, new_id: 0, new_reservation: 0 });
      stage('post-gate-log-id-rewrite-rollback-preserves-other-column-update', immutableLog);
      await migrator.unsafe(`DELETE FROM ${schema}.api_key_request_logs WHERE id=$1`, [postGateLog]);
      await assert.rejects(logWriter.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [postGateLog]), /permanently reserved/);
      await assert.rejects(prepare(migrator, postGateLog, await nowMs(migrator, 60_000)),
        /permanently reserved/);
      stage('post-gate-log-writer-reserves-and-deleted-log-id-cannot-reopen');

      const producerAfterGate = 'replay-producer-switch-' + randomUUID();
      assert.equal(await prepare(producer, producerAfterGate, await nowMs(migrator, 60_000)), true);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [producerAfterGate]))[0].n, 1);
      stage('producer-security-definer-post-gate-reserves-before-intent');

      const concurrent = 'replay-concurrent-' + randomUUID();
      const concurrentExpiry = await nowMs(migrator, 60_000);
      const results = await Promise.all([
        prepare(holder, concurrent, concurrentExpiry),
        prepare(contender, concurrent, concurrentExpiry),
      ]);
      assert.deepEqual(results.sort(), [false, true]);
      const claimId = randomUUID();
      assert.equal(await claim(holder, concurrent, claimId), true);
      assert.equal(await claim(contender, concurrent, randomUUID()), false);
      await assert.rejects(logWriter.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id) VALUES ($1,'replay-user','replay-key','replay-space')`,
      [concurrent]), /permanently reserved/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [concurrent]))[0].n, 1);
      stage('concurrent-same-id-one-reservation-one-claim-no-financial-log-without-receipt');

      const crashId = 'replay-crash-' + randomUUID();
      const crashExpiry = await nowMs(migrator, 60_000);
      let ready;
      const reached = new Promise(resolve => { ready = resolve; });
      const interrupted = contender.begin(async tx => {
        assert.equal(await prepare(tx, crashId, crashExpiry), true);
        const [{ pid }] = await tx.unsafe('SELECT pg_backend_pid() AS pid');
        ready(pid);
        await tx.unsafe('SELECT pg_sleep(10)');
      });
      const pid = await reached;
      assert.equal((await cluster.admin.unsafe('SELECT pg_terminate_backend($1) AS stopped', [pid]))[0].stopped, true);
      await assert.rejects(interrupted);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [crashId]))[0].n, 0);
      assert.equal(await prepare(holder, crashId, crashExpiry), true);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [crashId]))[0].n, 1);
      stage('aborted-backend-rolls-back-reservation-and-retry-registers-once');

      const recordedAt = '2025-01-01T00:00:00.000Z';
      const payload = `{"dispatchClaimId":"${oldClaim}","intent":{"apiKeyId":"replay-key","attemptIndex":1,"contextSha256":"${context}","operation":"images.generations","requestId":"${historical}","userId":"replay-user","workspaceId":"replay-space"},"params":{},"recordedAtIso":"${recordedAt}","version":1}`;
      const payloadHash = digest(payload);
      const [fact] = await migrator.unsafe(`INSERT INTO ${schema}.request_usage_settlements
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,
        context_sha256,dispatch_claim_id,payload_version,payload_json,payload_sha256,recorded_at)
        VALUES ($1,1,'replay-user','replay-key','replay-space','images.generations',
          $2,$3,1,$4,$5,$6) RETURNING created_at_ms`,
      [historical, context, oldClaim, payload, payloadHash, recordedAt]);
      await migrator.unsafe(`INSERT INTO ${schema}.request_usage_recovery_jobs
        (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
        VALUES ($1,$2,$3,'replay-user','replay-space')`,
      [historical, payloadHash, fact.created_at_ms]);
      await assert.rejects(migrator.unsafe(`DELETE FROM ${schema}.request_dispatch_intents WHERE request_id=$1`, [historical]),
        /cannot be deleted or rewritten/);
      await assert.rejects(migrator.unsafe(`DELETE FROM ${schema}.request_dispatch_requests WHERE request_id=$1`, [historical]),
        /cannot be deleted or rewritten/);
      await assert.rejects(migrator.unsafe(`DELETE FROM ${schema}.request_dispatch_replay_tombstones WHERE request_id=$1`, [historical]),
        /cannot be deleted or rewritten/);
      await assert.rejects(migrator.unsafe(`TRUNCATE ${schema}.request_dispatch_replay_tombstones`),
        /cannot be deleted or rewritten/);
      await assert.rejects(migrator.unsafe(`UPDATE ${schema}.request_usage_settlements SET payload_json='{}'
        WHERE request_id=$1`, [historical]), /immutable/);
      const [financial] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS facts,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox WHERE request_id=$1) AS outbox,
        (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS jobs,
        (SELECT payload_sha256 FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS fact_hash`, [historical]);
      assert.deepEqual(financial, { facts: 1, outbox: 1, jobs: 1, fact_hash: payloadHash });
      const [fk] = await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_constraint
        WHERE conrelid='${schema}.request_usage_settlements'::regclass
          AND confrelid='${schema}.request_dispatch_intents'::regclass AND contype='f'`);
      assert.equal(fk.n, 1);
      stage('financial-fk-history-and-immutable-fact-preserved', financial);

      const financeId = 'replay-finance-' + randomUUID();
      const financeClaim = randomUUID();
      const leaseToken = randomUUID();
      const financeExpiry = await nowMs(migrator, 60_000);
      assert.equal(await prepare(migrator, financeId, financeExpiry), true);
      assert.equal(await claim(migrator, financeId, financeClaim), true);
      const financeRecordedAt = new Date().toISOString();
      const financeParams = { chargedCost: '0', shouldChargeBudget: false,
        requestLog: { modelId: 'fixture-model', providerId: 'fixture-provider',
          status: 'success', standardCost: '0', meteredCost: '0',
          inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      const financePayload = `{"dispatchClaimId":"${financeClaim}","intent":{"apiKeyId":"replay-key","attemptIndex":1,"contextSha256":"${context}","operation":"images.generations","requestId":"${financeId}","userId":"replay-user","workspaceId":"replay-space"},"params":${JSON.stringify(financeParams)},"recordedAtIso":"${financeRecordedAt}","version":1}`;
      const financeHash = digest(financePayload);
      const [financeFact] = await migrator.unsafe(`INSERT INTO ${schema}.request_usage_settlements
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,
        context_sha256,dispatch_claim_id,payload_version,payload_json,payload_sha256,recorded_at)
        VALUES ($1,1,'replay-user','replay-key','replay-space','images.generations',
          $2,$3,1,$4,$5,$6) RETURNING created_at_ms`,
      [financeId, context, financeClaim, financePayload, financeHash, financeRecordedAt]);
      await migrator.unsafe(`INSERT INTO ${schema}.request_usage_recovery_jobs
        (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
        VALUES ($1,$2,$3,'replay-user','replay-space')`,
      [financeId, financeHash, financeFact.created_at_ms]);
      const [leased] = await migrator.unsafe(`UPDATE ${schema}.request_usage_recovery_jobs
        SET state='leased',revision=revision+1,attempts=attempts+1,
          last_transition='claimed',lease_token=$2,lease_seconds=30
        WHERE request_id=$1 RETURNING state,revision,lease_expires_at_ms`,
      [financeId, leaseToken]);
      assert.equal(leased.state, 'leased');
      assert.equal(Number(leased.revision), 1);
      for (const [logUserId, logOperation] of [
        [null, 'images.generations'], ['replay-user', 'images.edits'],
      ]) {
        await assert.rejects(migrator.begin(async tx => {
          await tx.unsafe(`INSERT INTO ${schema}.request_usage_commit_receipts
            (request_id,payload_sha256,user_id,workspace_id,recorded_at,lease_token,lease_revision)
            VALUES ($1,$2,'replay-user','replay-space',$3,$4,1)`,
          [financeId, financeHash, financeRecordedAt, leaseToken]);
          await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs
            (id,user_id,api_key_id,workspace_id,request_operation)
            VALUES ($1,$2,'replay-key','replay-space',$3)`,
          [financeId, logUserId, logOperation]);
        }), /financial scope differs/);
      }
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1`, [financeId]))[0].n, 0);
      stage('receipt-present-wrong-user-or-operation-log-rejected-atomically');
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${schema}.request_usage_commit_receipts
          (request_id,payload_sha256,user_id,workspace_id,recorded_at,lease_token,lease_revision)
          VALUES ($1,$2,'replay-user','replay-space',$3,$4,1)`,
        [financeId, financeHash, financeRecordedAt, leaseToken]);
        await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,request_operation,created_at,
            model_id,provider_id,status,charged_cost,standard_cost,metered_cost,
            budget_charged_micros,input_tokens,output_tokens,total_tokens)
          VALUES ($1,'replay-user','replay-key','replay-space','images.generations',$2,
            'fixture-model','fixture-provider','success',0,0,0,0,0,0,0)`,
        [financeId, financeRecordedAt]);
        await tx.unsafe(`UPDATE ${schema}.request_usage_recovery_jobs
          SET state='committed',revision=revision+1,last_transition='committed',
            lease_token=NULL,lease_seconds=NULL WHERE request_id=$1`, [financeId]);
      });
      const [settled] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_replay_tombstones WHERE request_id=$1) AS reservations`,
      [financeId]);
      assert.deepEqual(settled, { receipts: 1, logs: 1, job_state: 'committed', reservations: 1 });
      stage('real-receipt-before-log-same-transaction-commit', settled);
      const remainingSources = [];
      for (const source of ['fact', 'outbox', 'job', 'receipt']) {
      const result = await backfill(migrator, source);
        assert.ok(result.scanned >= 1);
        assert.equal(result.inserted, 0);
        remainingSources.push(result);
      }
      stage('all-seven-source-backfill-statements-run-and-idempotent', { remainingSources });

      const clean = 'replay-clean-' + randomUUID();
      const cleanExpiry = await nowMs(migrator, 1_500);
      assert.equal(await prepare(migrator, clean, cleanExpiry), true);
      await delay(Math.max(0, cleanExpiry - await nowMs(migrator) + 30));
      const [classification] = await migrator.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
        $1,1,'replay-user','replay-key','replay-space','images.generations',$2,$3,0) AS changed`,
      [clean, requestHash, context]);
      assert.equal(classification.changed, true);
      await delay(Math.max(0, oldExpiry - await nowMs(migrator) + 30));
      const cutoffMs = await nowMs(migrator);
      const first = await review(migrator, { cutoffMs, limit: 1 });
      assert.equal(first.length, 1);
      const second = await review(migrator, { cutoffMs, limit: 1,
        afterExpiresAtMs: Number(first[0].expires_at_ms), afterRequestId: first[0].request_id });
      assert.equal(second.length, 1);
      const byId = Object.fromEntries([...first, ...second].map(row => [row.request_id, row]));
      assert.equal(byId[clean].review_bucket, 'pre_dispatch_expired_policy_review');
      assert.equal(byId[historical].review_bucket, 'claimed_history_hold');
      assert.ok(Object.values(byId).every(row => row.delete_allowed === false && row.reservation_present));
      stage('bounded-keyset-retention-review-never-authorizes-deletion',
        { rows: Object.values(byId).map(({ request_id, review_bucket, delete_allowed }) =>
          ({ request_id, review_bucket, delete_allowed })) });
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL';
      report.error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 700) };
    } finally {
      for (const sql of clients) await sql.end({ timeout: 1 }).catch(() => {});
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error).slice(0, 400); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ reportFile, status: report.status, cleanup: report.cleanup,
        stages: report.stages }, null, 2));
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

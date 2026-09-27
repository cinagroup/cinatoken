// Opt-in, owned PostgreSQL 18 fixture for the legacy-aware parent switch.
// These review-only proposals do not enable any production recovery writer.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildPostgresReplayReservationBackfill } from './build-postgres-replay-reservation-backfill.mjs';
import { buildRequestLegacyParentActivation } from './build-request-legacy-parent-activation.mjs';
import { buildRequestLegacyParentDefaultAclActivation } from './build-request-legacy-parent-default-acl-activation.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const definer = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const singleClaim = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const reservation = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url);
const legacyParent = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-legacy-parent-backfill.sql', import.meta.url);
const parentGate = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url);
const digest = body => createHash('sha256').update(body).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function client(cluster, username, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {} });
}

async function prepare(sql, requestId) {
  const [row] = await sql.unsafe(`SELECT ${schema}.prepare_request_dispatch_intent_v1(
    $1,1,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
    'images.generations',$2,$3,$4,2) AS accepted`,
  [requestId, 'a'.repeat(64), 'b'.repeat(64), Date.now() + 60_000]);
  return row.accepted;
}

test('legacy-aware parent activation reserves old IDs and admits only trusted new parents',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-legacy-parent-activation-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; review-only legacy-aware parent and replay reservation proposals',
      limitations: [
        'Synthetic history does not measure a production lock window or prove archive/retention policy.',
        'This critical catalog subset checks two replay-reservation triggers and source bodies, not every historical SQL statement or every possible trusted-migrator DDL form.',
        'No old request digest, original attempt budget or original deadline is inferred; old intents remain outside trusted parent rows.',
        'No runtime producer grant, provider send, Worker, Hyperdrive, Queue or remote database is activated.',
      ], sourceSha256: {}, stages: [] };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const [server] = await cluster.admin.unsafe(`SELECT current_setting('server_version_num')::integer AS version,
        current_setting('listen_addresses') AS address`);
      assert.ok(server.version >= 180000 && server.version < 190000);
      assert.equal(server.address, '127.0.0.1');
      report.serverVersionNum = server.version;
      const password = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const writerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE legacy_intent_writer LOGIN PASSWORD '${writerPassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, legacy_intent_writer;`).simple();
      const sql = client(cluster, 'cinatoken_gateway_migrator', password);
      const ledgerWriter = client(cluster, 'cinatoken_gateway_migrator', password);
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword);
      const oldWriter = client(cluster, 'legacy_intent_writer', writerPassword);
      clients.push(sql, ledgerWriter, runtime, oldWriter);
      await sql.unsafe(`CREATE TABLE ${schema}.schema_migrations(
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrationDir), 'utf8');
        corpus.push(`${name}\n${body}`);
        await sql.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const namedSql = {};
      for (const [name, url] of [
        ['definer', definer], ['singleClaim', singleClaim], ['reservation', reservation],
        ['legacyParent', legacyParent], ['parentGate', parentGate],
        ['nativeTest', new URL(import.meta.url)],
        ['activationGenerator', new URL('./build-request-legacy-parent-activation.mjs', import.meta.url)],
        ['activationBundle', new URL('./build-request-legacy-parent-default-acl-activation.mjs', import.meta.url)],
        ['reservationBackfillGenerator', new URL('./build-postgres-replay-reservation-backfill.mjs', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
      ]) { namedSql[name] = await readFile(url, 'utf8'); report.sourceSha256[name] = digest(namedSql[name]); }
      assert.equal(namedSql.legacyParent, (await buildRequestLegacyParentActivation()).sql);
      stage('formal-schema-runtime-grant-and-pinned-proposals', { migrations: files.length });

      await sql.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('legacy-parent-user','legacy-parent-activation@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('legacy-parent-space','personal','legacy-parent-user','Legacy Parent','legacy-parent','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('legacy-parent-key','legacy-parent-activation-key','legacy-parent-user','legacy-parent-space');
        INSERT INTO ${schema}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,request_operation,status,charged_cost)
          VALUES ('legacy-log-only','legacy-parent-user','legacy-parent-key','legacy-parent-space',
            'images.generations','success',0.01);`).simple();
      const legacyExpiry = Date.now() + 5_000;
      await sql.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('legacy-intent',1,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations',$1,$2)`, ['c'.repeat(64), legacyExpiry]);
      const oldClaimId = '11111111-1111-4111-8111-111111111111';
      const [oldClaim] = await sql.unsafe(`UPDATE ${schema}.request_dispatch_intents
        SET state='dispatch_claimed',revision=revision+1,dispatch_claim_id=$1
        WHERE request_id='legacy-intent' AND state='prepared'
        RETURNING state,dispatch_claim_id`, [oldClaimId]);
      assert.deepEqual(oldClaim, { state: 'dispatch_claimed', dispatch_claim_id: oldClaimId });
      const [oldBefore] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents) AS intents,
        (SELECT count(*)::integer FROM ${schema}.api_key_request_logs WHERE id='legacy-log-only') AS logs`);
      assert.deepEqual(oldBefore, { intents: 1, logs: 1 });
      stage('populated-0069-and-legacy-log-history', { oldBefore });

      for (const [setting, body] of [
        ['cinatoken.dispatch_intent_definer_activation', namedSql.definer],
        ['cinatoken.request_dispatch_single_claim_activation', namedSql.singleClaim],
        ['cinatoken.request_dispatch_replay_reservations_activation', namedSql.reservation],
      ]) await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
        await tx.unsafe(body).simple();
      });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const bundle = await buildRequestLegacyParentDefaultAclActivation({ activation: 'reviewed-v1' });
      report.sourceSha256.generatedActivationBundle = digest(bundle.sql);
      assert.equal(bundle.formalCorpusSha256, report.sourceSha256.formalMigrationCorpus);
      assert.equal(bundle.reservationSourceSha256, report.sourceSha256.reservation);
      const activate = () => sql.begin(tx => tx.unsafe(bundle.bodySql).simple());
      const parentAbsent = async () => assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      const rejectDrift = async () => {
        await assert.rejects(activate(), /Legacy parent replay reservation catalog differs from reviewed source/);
        await parentAbsent();
      };
      await ledgerWriter.unsafe('BEGIN');
      try {
        await ledgerWriter.unsafe(`UPDATE ${schema}.api_key_request_logs
          SET charged_cost=charged_cost WHERE id='legacy-log-only'`);
        await assert.rejects(activate(), error => error?.code === '55P03');
        await parentAbsent();
      } finally {
        await ledgerWriter.unsafe('ROLLBACK');
      }
      stage('legacy-log-write-lock-blocks-catalog-attestation-before-parent-ddl');
      await sql.unsafe(`ALTER TABLE ${schema}.request_dispatch_intents
        DISABLE TRIGGER request_dispatch_intents_replay_reserve`);
      await rejectDrift();
      await sql.unsafe(`ALTER TABLE ${schema}.request_dispatch_intents
        ENABLE TRIGGER request_dispatch_intents_replay_reserve`);
      stage('disabled-intent-reservation-trigger-rejected-before-parent-ddl');

      await sql.unsafe(`CREATE FUNCTION ${schema}.fixture_noop_replay_reserve()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path TO pg_catalog, pg_temp AS $$BEGIN RETURN NEW; END;$$;
        CREATE OR REPLACE TRIGGER api_key_request_logs_replay_reserve
          BEFORE INSERT ON ${schema}.api_key_request_logs
          FOR EACH ROW EXECUTE FUNCTION ${schema}.fixture_noop_replay_reserve();`).simple();
      await rejectDrift();
      await sql.unsafe(`CREATE OR REPLACE TRIGGER api_key_request_logs_replay_reserve
          BEFORE INSERT ON ${schema}.api_key_request_logs
          FOR EACH ROW EXECUTE FUNCTION ${schema}.reserve_request_log_replay_id();
        DROP FUNCTION ${schema}.fixture_noop_replay_reserve();`).simple();
      stage('rebound-log-reservation-trigger-rejected-before-parent-ddl');

      await sql.unsafe(`ALTER FUNCTION ${schema}.reserve_request_log_replay_id()
        SET search_path TO public`);
      await rejectDrift();
      await sql.unsafe(`ALTER FUNCTION ${schema}.reserve_request_log_replay_id()
        SET search_path TO pg_catalog, pg_temp`);
      stage('drifted-security-search-path-remains-visible-after-cost-lock');

      for (const name of ['reserve_request_dispatch_intent_id', 'reserve_request_log_replay_id']) {
        const [original] = await sql.unsafe(`SELECT pg_catalog.pg_get_functiondef(
          '${schema}.${name}()'::pg_catalog.regprocedure) AS ddl`);
        await sql.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.${name}()
          RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
          SET search_path TO pg_catalog, pg_temp AS $$BEGIN RETURN NEW; END;$$`);
        await rejectDrift();
        await sql.unsafe(original.ddl);
      }
      stage('noop-intent-and-log-reservation-function-bodies-rejected-before-parent-ddl');

      await sql.unsafe(`DELETE FROM ${schema}.schema_migrations
        WHERE version='0041_workspaces.sql'`);
      await assert.rejects(activate(), /Legacy parent formal migration ledger differs/);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      await sql.unsafe(`INSERT INTO ${schema}.schema_migrations(version)
        VALUES ('0041_workspaces.sql')`);
      await sql.unsafe(`INSERT INTO ${schema}.schema_migrations(version)
        VALUES ('9999_unreviewed.sql')`);
      await assert.rejects(activate(), /Legacy parent formal migration ledger differs/);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      await sql.unsafe(`DELETE FROM ${schema}.schema_migrations
        WHERE version='9999_unreviewed.sql'`);
      stage('missing-or-unreviewed-formal-version-blocks-switch-before-parent-ddl',
        { formalMigrations: bundle.formalMigrationCount,
          corpusSha256: bundle.formalCorpusSha256 });
      await assert.rejects(activate(), /Legacy request replay reservation backfill is incomplete/);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      stage('missing-intent-reservation-rolls-back-parent-and-gate');

      await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO legacy_intent_writer;
        GRANT INSERT (request_id,attempt_index,user_id,api_key_id,workspace_id,
          operation,context_sha256,expires_at_ms)
          ON ${schema}.request_dispatch_intents TO legacy_intent_writer;`).simple();
      const liveExpiry = Date.now() + 1_500;
      await oldWriter.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('legacy-live',1,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations',$1,$2)`, ['e'.repeat(64), liveExpiry]);
      const [liveReservation] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents
          WHERE request_id='legacy-live') AS intents,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_replay_tombstones
          WHERE request_id='legacy-live') AS reservations`);
      assert.deepEqual(liveReservation, { intents: 1, reservations: 1 });
      stage('nonowner-old-intent-writer-survives-expand-and-reserves-id', { liveReservation });

      const intentBatch = buildPostgresReplayReservationBackfill({
        source: 'intent', afterRequestId: null, limit: 1 });
      const [intentBackfill] = await sql.begin(tx => tx.unsafe(intentBatch.batchSql));
      assert.equal(intentBackfill.scanned, 1);
      assert.equal(intentBackfill.reserved, 1);
      assert.equal(intentBackfill.next_request_id, 'legacy-intent');
      await assert.rejects(activate(), /Legacy active dispatch intents must drain before parent switch/);
      await sleep(Math.max(0, Math.max(legacyExpiry, liveExpiry) - Date.now() + 50));
      const terminal = await sql.unsafe(`UPDATE ${schema}.request_dispatch_intents
        SET state=CASE state WHEN 'prepared' THEN 'expired_before_dispatch'
          ELSE 'outcome_unknown' END,revision=revision+1
        WHERE request_id IN ('legacy-intent','legacy-live')
          AND state IN ('prepared','dispatch_claimed')
        RETURNING request_id,state`);
      assert.equal(terminal.length, 2);
      assert.deepEqual(Object.fromEntries(terminal.map(row => [row.request_id, row.state])),
        { 'legacy-intent': 'outcome_unknown', 'legacy-live': 'expired_before_dispatch' });
      await assert.rejects(activate(), /Direct dispatch intent column writer privilege remains/);
      await sql.unsafe(`REVOKE INSERT (request_id,attempt_index,user_id,api_key_id,
        workspace_id,operation,context_sha256,expires_at_ms)
        ON ${schema}.request_dispatch_intents FROM legacy_intent_writer`);
      await assert.rejects(activate(), /Replay reservation backfill or parent gate contract incomplete/);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      stage('active-old-rows-and-column-writer-must-drain-before-switch', {
        intentBackfill, terminal: terminal.map(row => row.request_id) });
      stage('missing-log-only-reservation-rolls-back-parent-and-gate');

      const logBatch = buildPostgresReplayReservationBackfill({
        source: 'legacy_log', afterRequestId: null, limit: 1 });
      const [logBackfill] = await sql.begin(tx => tx.unsafe(logBatch.batchSql));
      assert.equal(logBackfill.scanned, 1);
      assert.equal(logBackfill.reserved, 1);
      assert.equal(logBackfill.next_request_id, 'legacy-log-only');
      const functionLockStatements = [
        `ALTER FUNCTION ${schema}.reserve_request_dispatch_intent_id()\n  COST 100;\n`,
        `ALTER FUNCTION ${schema}.reserve_request_log_replay_id()\n  COST 100;\n`,
      ];
      let withoutFunctionLocks = bundle.bodySql;
      for (const statement of functionLockStatements) {
        assert.equal(withoutFunctionLocks.split(statement).length, 2);
        withoutFunctionLocks = withoutFunctionLocks.replace(statement, '');
      }
      const replacement = `CREATE OR REPLACE FUNCTION ${schema}.reserve_request_log_replay_id()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path TO pg_catalog, pg_temp AS $$BEGIN RETURN NEW; END;$$`;
      const pausedRollback = new Error('fixture rollback after paused legacy parent bundle');
      const pauseBundle = async (body, check) => {
        const ready = deferred(), release = deferred();
        const pending = sql.begin(async tx => {
          await tx.unsafe(body).simple();
          ready.resolve();
          await release.promise;
          throw pausedRollback;
        });
        pending.catch(error => ready.reject(error));
        await ready.promise;
        try { await check(); }
        finally {
          release.resolve();
          await assert.rejects(pending, error => error === pausedRollback);
        }
      };
      // Negative control: table and advisory locks alone do not serialize a
      // second direct migrator's CREATE OR REPLACE FUNCTION.
      await pauseBundle(withoutFunctionLocks, async () => {
        const rollbackReplacement = new Error('fixture rollback after concurrent function replacement');
        await assert.rejects(ledgerWriter.begin(async tx => {
          await tx.unsafe(`SET LOCAL lock_timeout='500ms'`);
          await tx.unsafe(replacement);
          const [changed] = await tx.unsafe(`SELECT prosrc LIKE '%RETURN NEW;%' AS changed
            FROM pg_catalog.pg_proc WHERE oid='${schema}.reserve_request_log_replay_id()'::pg_catalog.regprocedure`);
          assert.equal(changed.changed, true);
          throw rollbackReplacement;
        }), error => error === rollbackReplacement);
      });
      await parentAbsent();
      stage('negative-control-table-locks-do-not-stop-concurrent-function-replacement');
      const blockedFunctionDdl = [];
      await pauseBundle(bundle.bodySql, async () => {
        for (const [name, statement] of [
          ['log-replace', replacement],
          ['intent-replace', replacement.replace('reserve_request_log_replay_id', 'reserve_request_dispatch_intent_id')],
          ['log-security', `ALTER FUNCTION ${schema}.reserve_request_log_replay_id() SECURITY INVOKER`],
        ]) {
          const start = performance.now();
          await assert.rejects(ledgerWriter.begin(async tx => {
            await tx.unsafe(`SET LOCAL lock_timeout='500ms'`);
            await tx.unsafe(statement);
          }), error => error?.code === '55P03');
          const boundedWaitMs = Math.round(performance.now() - start);
          assert.ok(boundedWaitMs >= 350 && boundedWaitMs < 3_000,
            `${name} lock wait ${boundedWaitMs}ms`);
          blockedFunctionDdl.push({ name, errorCode: '55P03', boundedWaitMs });
        }
      });
      await parentAbsent();
      stage('catalog-tuple-lock-blocks-second-migrator-function-replacement-until-rollback',
        { blockedFunctionDdl });
      const ledgerLock = 'LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;\n';
      assert.equal(bundle.bodySql.split(ledgerLock).length, 2);
      const withoutLedgerLock = bundle.bodySql.replace(ledgerLock, '');
      const fixtureRollback = new Error('fixture rollback after unlocked bundle reached end');
      await ledgerWriter.unsafe('BEGIN');
      let ledgerWriterOpen = true;
      let lockWaitMs;
      try {
        const deleted = await ledgerWriter.unsafe(`DELETE FROM ${schema}.schema_migrations
          WHERE version='0041_workspaces.sql' RETURNING version`);
        assert.equal(deleted.length, 1);
        // Negative control: an ordinary SELECT sees the last committed 0041
        // row while the other session's DELETE remains uncommitted. Roll back
        // the otherwise successful old bundle to keep this fixture isolated.
        await assert.rejects(sql.begin(async tx => {
          await tx.unsafe(withoutLedgerLock).simple();
          throw fixtureRollback;
        }), error => error === fixtureRollback);
        assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
          '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
        const start = performance.now();
        await assert.rejects(activate(), error => error?.code === '55P03');
        lockWaitMs = Math.round(performance.now() - start);
        assert.ok(lockWaitMs >= 1_200 && lockWaitMs < 5_000, `lock wait ${lockWaitMs}ms`);
        assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
          '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
        await ledgerWriter.unsafe('COMMIT');
        ledgerWriterOpen = false;
      } finally {
        if (ledgerWriterOpen) await ledgerWriter.unsafe('ROLLBACK');
      }
      await assert.rejects(activate(), /Legacy parent formal migration ledger differs/);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_requests') IS NULL AS absent`))[0].absent, true);
      await sql.unsafe(`INSERT INTO ${schema}.schema_migrations(version)
        VALUES ('0041_workspaces.sql')`);
      stage('concurrent-ledger-delete-blocks-switch-and-rolls-back', {
        negativeControl: 'unlocked bundle reached end against uncommitted delete; fixture rolled back',
        boundedLockError: '55P03', lockWaitMs,
        committedMissingVersion: 'rejected before parent DDL',
      });
      await activate();
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const [postSwitch] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents) AS old_intents,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_requests) AS parents,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_replay_tombstones) AS reservations,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents
          WHERE request_id='legacy-intent' AND state='outcome_unknown'
            AND dispatch_claim_id=$1) AS unknown_claims`, [oldClaimId]);
      assert.deepEqual(postSwitch, { old_intents: 2, parents: 0,
        reservations: 3, unknown_claims: 1 });
      stage('atomic-legacy-aware-parent-and-gate-switch', { intentBackfill, logBackfill, postSwitch });

      for (const oldId of ['legacy-intent', 'legacy-live', 'legacy-log-only']) {
        await assert.rejects(prepare(sql, oldId), /Request ID is permanently reserved/);
      }
      await assert.rejects(sql.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('legacy-intent',2,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations',$1,$2)`, ['d'.repeat(64), Date.now() + 60_000]),
      /Dispatch intent requires a live request parent/);
      assert.equal(await prepare(sql, 'new-trusted'), true);
      const [newRows] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_requests WHERE request_id='new-trusted') AS parent,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents WHERE request_id='new-trusted') AS intent,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_replay_tombstones WHERE request_id='new-trusted') AS reservation,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents WHERE request_id='legacy-intent') AS old_intent,
        (SELECT count(*)::integer FROM ${schema}.api_key_request_logs WHERE id='legacy-log-only') AS old_log`);
      assert.deepEqual(newRows, { parent: 1, intent: 1, reservation: 1, old_intent: 1, old_log: 1 });
      const [access] = await sql.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)',
          'EXECUTE') AS runtime_prepare,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.request_dispatch_requests','INSERT') AS runtime_parent_insert`);
      assert.deepEqual(access, { runtime_prepare: false, runtime_parent_insert: false });
      stage('old-ids-closed-new-trusted-parent-admitted', { newRows, access });

      await assert.rejects(runtime.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation,status,charged_cost)
        VALUES ('new-trusted','legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations','success',0.01)`),
      error => error.code === 'P0001');
      const [unpoisoned] = await sql.unsafe(`SELECT count(*)::integer AS n
        FROM ${schema}.api_key_request_logs WHERE id='new-trusted'`);
      assert.equal(unpoisoned.n, 0);
      stage('ordinary-log-cannot-preempt-new-parent-financial-receipt');

      await runtime.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation,status,charged_cost)
        VALUES ('late-legacy-log','legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations','success',0.01)`);
      const [late] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.api_key_request_logs WHERE id='late-legacy-log') AS logs,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_replay_tombstones
          WHERE request_id='late-legacy-log') AS reservations`);
      assert.deepEqual(late, { logs: 1, reservations: 1 });
      await assert.rejects(prepare(sql, 'late-legacy-log'), /Request ID is permanently reserved/);
      await assert.rejects(runtime.unsafe(`INSERT INTO ${schema}.request_dispatch_replay_tombstones
        (request_id,first_source) VALUES ('runtime-direct','legacy_log')`),
      error => error.code === '42501');
      stage('late-ordinary-log-reserved-without-direct-runtime-access', { late });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error);
      throw error;
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { report.cleanupDetails = await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      assert.equal(report.cleanup, 'PASS', `owned fixture cleanup failed; report=${reportFile}`);
    }
  });

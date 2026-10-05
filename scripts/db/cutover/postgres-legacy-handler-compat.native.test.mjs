// Owned loopback PostgreSQL fixture for ordinary pre-recovery writer and reader
// compatibility across the review-only replay parent switch. No ambient DB URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { createPostgresRequestLogsRepository } from '../../../packages/core/src/db/postgres/request-logs.impl.ts';
import { buildPostgresReplayReservationBackfill } from './build-postgres-replay-reservation-backfill.mjs';
import { createPg73LegacyParentBuilderFixture } from './pg73-legacy-parent-builder-fixture.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_replay_reservations_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url)],
];
const sha = body => createHash('sha256').update(body).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 500) });

function runtimeClient(cluster, username, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    onnotice() {}, connection: { search_path: `${schema}, public` } });
}

function ordinaryParams() {
  const id = `gen-${randomUUID()}`;
  return { userId: 'user', shouldChargeBudget: false, beforeSpent: 0, chargedCost: 0,
    audit: { apiKeyId: 'key', eventType: 'usage_charge', actorType: 'system',
      beforeSpent: 0, requestLogId: id, source: 'gateway_usage' },
    requestLog: { id, userId: 'user', apiKeyId: 'key', workspaceId: 'personal:user',
      userEmail: 'legacy-compat@example.invalid', modelId: 'synthetic/image',
      providerId: 'synthetic-provider', providerModelName: 'synthetic-image',
      modelName: 'Synthetic Image', providerName: 'Synthetic', requestBody: null,
      upstreamRequestBody: null, requestProtocol: 'openai', upstreamProtocol: 'openai',
      requestOperation: 'images.generations', upstreamOperation: 'images.generations',
      inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, totalTokens: 11, meteredCost: 0, standardCost: 0,
      chargedCost: 0, routeGroup: 'default', status: 'success', latencyMs: 10,
      errorMessage: null, rawUsage: '{"images":1}', outputImageCount: 1,
      billingKind: 'image_per_image', providerAttempts: [] } };
}

test('ordinary writer and legacy readers survive replay parent switch',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-legacy-handler-compat-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL; unchanged request-log repository and current two-argument ordinary critical writer; review-only parent switch',
      limitations: [
        'Current repository and ordinary writer code are exercised directly; this is not an archived deployed Worker binary.',
        'One synthetic tenant and two ordinary requests do not prove all old routes, production traffic or a maintenance lock window.',
        'No real Worker, Hyperdrive, Queue, provider send, remote SQL, retention or contract migration is exercised.',
      ], sourceSha256: {}, stages: [] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let builderFixture = null;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
      const migrator = runtimeClient(cluster, 'cinatoken_gateway_migrator', migratorPassword);
      const runtime = runtimeClient(cluster, 'cinatoken_gateway_runtime', runtimePassword);
      clients.push(migrator, runtime);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
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
      report.sourceSha256.formalMigrationCorpus = sha(corpus.join('\n'));
      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)],
        ['criticalWriter', new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)],
        ['requestLogsRepository', new URL('../../../packages/core/src/db/postgres/request-logs.impl.ts', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['replayBackfill', new URL('./build-postgres-replay-reservation-backfill.mjs', import.meta.url)],
        ['parentActivation', new URL('./build-request-legacy-parent-default-acl-activation.mjs', import.meta.url)],
      ]) report.sourceSha256[key] = sha(await readFile(url));
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('user','legacy-compat@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('personal:user','personal','user','Personal','personal','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('key','legacy-compat-hashref','user','personal:user');`).simple();
      await runtime.unsafe(`SET search_path TO ${schema}, public`);
      const database = { driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }) };
      const logs = createPostgresRequestLogsRepository(database);
      stage('formal-expand-and-runtime-session', { migrations: files.length,
        sessionRole: (await runtime.unsafe('SELECT current_user AS role'))[0].role });

      const before = ordinaryParams();
      await insertRequestUsageAndChargeTxPg(database, before);
      const id = before.requestLog.id;
      const dateRange = { startDate: '2020-01-01T00:00:00.000Z', endDate: '2100-01-01T00:00:00.000Z',
        userId: 'user', workspaceId: 'personal:user' };
      const ownerBefore = await logs.getRequestLogByIdForOwner({ id, userId: 'user', workspaceId: 'personal:user' });
      assert.equal(ownerBefore?.id, id);
      assert.equal(await logs.getRequestLogByIdForOwner({ id, userId: 'other', workspaceId: 'personal:user' }), null);
      assert.equal(await logs.getRequestLogByIdForOwner({ id, userId: 'user', workspaceId: 'other' }), null);
      const listBefore = await logs.getRequestLogs({ userId: 'user', workspaceId: 'personal:user' });
      const statsBefore = await logs.getRequestStatsByRange(dateRange);
      assert.equal(listBefore.total, 1);
      assert.equal(listBefore.logs[0].id, id);
      assert.equal(statsBefore.totalRequests, 1);
      assert.equal(statsBefore.totalTokens, 11);
      stage('ordinary-two-argument-writer-and-owner-admin-stats-readers-before-switch',
        { requestId: id, listed: listBefore.total, tokens: statsBefore.totalTokens, ownerScoped: true });

      for (const [setting, url] of proposals) {
        const body = await readFile(url, 'utf8');
        report.sourceSha256[setting] = sha(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      const backfill = buildPostgresReplayReservationBackfill({ source: 'legacy_log', afterRequestId: null, limit: 10 });
      const [page] = await migrator.begin(tx => tx.unsafe(backfill.batchSql));
      assert.deepEqual({ scanned: page.scanned, reserved: page.reserved, next: page.next_request_id },
        { scanned: 1, reserved: 1, next: id });
      builderFixture = await createPg73LegacyParentBuilderFixture();
      report.pg73BuilderManifest = builderFixture.manifest;
      const bundle = await builderFixture.build({ activation: 'reviewed-v1' });
      report.sourceSha256.activationBundle = sha(bundle.sql);
      await migrator.begin(tx => tx.unsafe(bundle.bodySql).simple());
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      const [oldReservation] = await migrator.unsafe(`SELECT first_source FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [id]);
      assert.equal(oldReservation.first_source, 'legacy_log');
      stage('bounded-legacy-backfill-and-atomic-parent-switch', { scanned: page.scanned,
        firstSource: oldReservation.first_source });

      const after = ordinaryParams();
      await insertRequestUsageAndChargeTxPg(database, after);
      const afterId = after.requestLog.id;
      const [lateReservation] = await migrator.unsafe(`SELECT first_source FROM ${schema}.request_dispatch_replay_tombstones
        WHERE request_id=$1`, [afterId]);
      assert.equal(lateReservation.first_source, 'legacy_log');
      const oldOwnerAfter = await logs.getRequestLogByIdForOwner({ id, userId: 'user', workspaceId: 'personal:user' });
      const newOwnerAfter = await logs.getRequestLogByIdForOwner({ id: afterId, userId: 'user', workspaceId: 'personal:user' });
      assert.deepEqual(oldOwnerAfter, ownerBefore);
      assert.equal(newOwnerAfter?.id, afterId);
      const listAfter = await logs.getRequestLogs({ userId: 'user', workspaceId: 'personal:user' });
      const statsAfter = await logs.getRequestStatsByRange(dateRange);
      assert.equal(listAfter.total, 2);
      assert.deepEqual(new Set(listAfter.logs.map(row => row.id)), new Set([id, afterId]));
      assert.equal(statsAfter.totalRequests, 2);
      assert.equal(statsAfter.totalTokens, 22);
      stage('ordinary-two-argument-writer-and-readers-after-switch', { oldRequestId: id,
        newRequestId: afterId, listed: listAfter.total, tokens: statsAfter.totalTokens,
        oldGenerationProjectionUnchanged: true, lateReservation: lateReservation.first_source });

      const colliding = ordinaryParams();
      const collisionId = colliding.requestLog.id;
      const [parent] = await migrator.unsafe(`SELECT ${schema}.prepare_request_dispatch_intent_v1(
        $1,1,'user','key','personal:user','images.generations',$2,$3,$4,2) AS accepted`,
      [collisionId, 'a'.repeat(64), 'b'.repeat(64), Date.now() + 60_000]);
      assert.equal(parent.accepted, true);
      const [prior] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs) AS logs,
        (SELECT count(*)::int FROM ${schema}.public_model_daily_stats) AS stats`);
      let collisionError;
      await assert.rejects(insertRequestUsageAndChargeTxPg(database, colliding), error => {
        const serverError = error.cause ?? error;
        collisionError = errorSummary(serverError);
        return serverError.code === 'P0001'
          && /receipt|financial|trusted|parent|request/i.test(serverError.message);
      });
      const [post] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs) AS logs,
        (SELECT count(*)::int FROM ${schema}.public_model_daily_stats) AS stats`);
      assert.deepEqual(post, prior);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${schema}.api_key_request_logs
        WHERE id=$1`, [collisionId]))[0].n, 0);
      stage('ordinary-critical-writer-parent-collision-rolls-back', { prior, post,
        collisionError, trustedParentRetained: true });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error);
      throw error;
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { report.cleanupDetails = await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      try { await builderFixture?.cleanup(); report.pg73BuilderCleanup = 'PASS'; }
      catch (error) { report.pg73BuilderCleanup = 'FAIL'; report.pg73BuilderCleanupError = errorSummary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      assert.equal(report.pg73BuilderCleanup, 'PASS', `owned builder fixture cleanup failed; report=${reportFile}`);
      assert.equal(report.cleanup, 'PASS', `owned fixture cleanup failed; report=${reportFile}`);
    }
  });

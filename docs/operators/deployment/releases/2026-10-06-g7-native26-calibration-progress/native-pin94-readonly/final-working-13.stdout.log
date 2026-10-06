// Owned loopback PostgreSQL fixture for a populated pre-recovery database.
// Never uses DATABASE_URL or an existing PostgreSQL data directory.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createPostgresApiKeysRepository } from '../../../packages/core/src/db/postgres/api-keys.impl.ts';
import { createPostgresRequestLogsRepository } from '../../../packages/core/src/db/postgres/request-logs.impl.ts';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const g = 'cinatoken_gateway';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardUrl = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const intentProposalUrl = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const outboxProposalUrl = new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const errorSummary = error => ({ name: error?.name ?? null, code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 500) });

function localClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: `cinatoken-native-${label}` }, onnotice() {} });
}

async function legacySnapshot(sql) {
  const [row] = await sql.unsafe(`SELECT count(*)::int AS count,
      pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(log)::text,
        E'\\n' ORDER BY log.id)) AS digest,
      count(*) FILTER (WHERE workspace_id='personal:user')::int AS attributed
    FROM ${g}.api_key_request_logs log WHERE id LIKE 'legacy-%'`);
  return row;
}

async function ordinaryWrite(sql, label) {
  const id = `ordinary-${label}-${randomUUID()}`;
  await sql.begin(async tx => {
    await tx.unsafe(`UPDATE ${g}.users SET budget_spent=budget_spent+0.01 WHERE id='user'`);
    await tx.unsafe(`INSERT INTO ${g}.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,request_operation,status,charged_cost)
      VALUES ($1,'user','key','personal:user','images.generations','success',0.01)`, [id]);
  });
  const [row] = await sql.unsafe(`SELECT log.id, log.charged_cost::text AS charged_cost,
      u.budget_spent::text AS budget_spent
    FROM ${g}.api_key_request_logs log CROSS JOIN ${g}.users u
    WHERE log.id=$1 AND u.id='user'`, [id]);
  assert.equal(row?.id, id);
  assert.equal(row.charged_cost, '0.010000');
  return row;
}

async function observeMigrationWait(admin, waiterPid, holderPid) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const [row] = await admin.unsafe(`SELECT wait_event_type, wait_event,
      $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS held_by_writer
      FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [waiterPid, holderPid]);
    if (row?.wait_event_type === 'Lock' && row.held_by_writer) return row;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('0069 did not wait behind the old writer');
}

async function keysetCensus(sql, cursor, limit) {
  const rows = await sql.unsafe(`SELECT id FROM ${g}.api_key_request_logs
    WHERE id LIKE 'legacy-%' AND id COLLATE "C" > $1 COLLATE "C"
    ORDER BY id COLLATE "C" LIMIT $2`, [cursor, limit]);
  return { count: rows.length, cursor: rows.at(-1)?.id ?? cursor };
}

test('native populated 0067 database upgrades through formal recovery migrations with old traffic intact',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-old-database-upgrade-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL; synthetic populated 0040/0067 database; review-only guard and producer proposals',
      limitations: [
        'Synthetic rows and local timing do not establish a production maintenance window or representative traffic.',
        'Keyset census is read-only; no recovery backfill, retention, archival or contract migration exists.',
        'The old write probe uses its actual tables and transaction, not the full production request handler.',
      ], stages: [], sourceSha256: {} };
    const clients = [];
    const ownClient = (user, password, label) => {
      const sql = localClient(cluster, user, password, label); clients.push(sql); return sql;
    };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    try {
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 180000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
      const migrator = ownClient('cinatoken_gateway_migrator', migratorPassword, 'old-migrator');
      const upgrade = ownClient('cinatoken_gateway_migrator', migratorPassword, 'old-upgrade');
      const writer = ownClient('cinatoken_gateway_runtime', runtimePassword, 'old-held-writer');
      const ordinary = ownClient('cinatoken_gateway_runtime', runtimePassword, 'old-traffic');
      const oldReader = ownClient('cinatoken_gateway_runtime', runtimePassword, 'old-reader');
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      assert.equal(files[66], '0067_batch_jobs.sql');
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const bodies = new Map();
      for (const name of files) bodies.set(name, await readFile(new URL(name, migrationDir), 'utf8'));
      report.sourceSha256.formalMigrationCorpus = sha256(files.map(name => `${name}\n${bodies.get(name)}`).join('\n'));
      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)], ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['apiKeysRepository', new URL('../../../packages/core/src/db/postgres/api-keys.impl.ts', import.meta.url)],
        ['requestLogsRepository', new URL('../../../packages/core/src/db/postgres/request-logs.impl.ts', import.meta.url)],
        ['optionalGuard', guardUrl], ['intentProposal', intentProposalUrl], ['outboxProposal', outboxProposalUrl],
      ]) report.sourceSha256[key] = sha256(await readFile(url));
      async function apply(name, client = migrator) {
        await client.begin(async tx => {
          await tx.unsafe(bodies.get(name)).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }

      for (const name of files.slice(0, 40)) await apply(name);
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max,budget_spent)
        VALUES ('user','native-old-upgrade@example.invalid',10,1);
        INSERT INTO ${g}.api_keys(id,key,user_id)
        VALUES ('key','hashref:sha256:${'a'.repeat(64)}','user');
        INSERT INTO ${g}.api_key_request_logs
          (id,user_id,api_key_id,request_operation,status,charged_cost)
        SELECT 'legacy-' || pg_catalog.lpad(n::text,4,'0'),'user','key',
          'images.generations','success',0.01
        FROM pg_catalog.generate_series(1,512) n`).simple();
      stage('pre-workspace-old-data', { migrationHead: files[39], legacyLogs: 512 });

      for (const name of files.slice(40, 67)) await apply(name);
      await migrator.unsafe(`INSERT INTO ${g}.workspaces
        (id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('second-workspace','personal','user','Second','second','active');
        INSERT INTO ${g}.workspace_budgets(id,workspace_id,reset_interval,limit_micros)
        VALUES ('old-budget','personal:user','daily',2000000),
          ('second-budget','second-workspace','daily',3000000)`);
      const before = await legacySnapshot(migrator);
      assert.deepEqual(before, { count: 512, digest: before.digest, attributed: 512 });
      assert.match(before.digest, /^[0-9a-f]{32}$/);
      const [preHead] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${g}.schema_migrations`);
      assert.equal(preHead.n, 67);
      const [preBudget] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${g}.workspace_budgets`);
      assert.equal(preBudget.n, 2);
      stage('historical-workspace-backfill-and-0067-head', { migrations: preHead.n,
        legacySnapshot: before, workspaceBudgets: preBudget.n });

      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${g} TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${g}.users,${g}.api_keys,${g}.workspaces,
          ${g}.workspace_budgets,${g}.api_key_request_logs TO cinatoken_gateway_runtime;
        GRANT UPDATE (budget_spent) ON ${g}.users TO cinatoken_gateway_runtime;
        GRANT INSERT ON ${g}.api_key_request_logs TO cinatoken_gateway_runtime;`).simple();
      // Before 0068, the historical trigger resolves its unqualified api_keys
      // through the caller's search_path. The old app session supplies that path.
      await writer.unsafe(`SET search_path TO ${g}, public`);
      await ordinary.unsafe(`SET search_path TO ${g}, public`);
      await oldReader.unsafe(`SET search_path TO ${g}, public`);
      const requestLogs = createPostgresRequestLogsRepository({ raw: oldReader });
      const oldBefore = await ordinaryWrite(ordinary, 'before-0068');
      assert.equal(oldBefore.budget_spent, '1.010000');
      const readerBefore = await requestLogs.getRequestLogsByKeyId('key', 1, 10);
      assert.equal(readerBefore.total, 513);
      assert.equal(readerBefore.logs.length, 10);
      stage('ordinary-reader-writer-before-upgrade', { budgetSpent: oldBefore.budget_spent,
        readerTotal: readerBefore.total });

      await apply(files[67]);
      // 0068 pins the function's path, so the subsequent old writer no longer
      // depends on its session path (including during the contested migration).
      await writer.unsafe('SET search_path TO public, pg_temp');
      await ordinary.unsafe('SET search_path TO public, pg_temp');
      const heldReady = Promise.withResolvers(), releaseHeld = Promise.withResolvers();
      const held = writer.begin(async tx => {
        await tx.unsafe(`UPDATE ${g}.users SET budget_spent=budget_spent WHERE id='user'`);
        heldReady.resolve((await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
        await releaseHeld.promise;
      });
      held.catch(heldReady.reject);
      const holderPid = await heldReady.promise;
      const waiterPid = (await upgrade.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      const started = performance.now();
      const blocked = apply(files[68], upgrade);
      blocked.catch(() => {});
      let waitEvidence, trafficDuringWait;
      try {
        waitEvidence = await observeMigrationWait(admin, waiterPid, holderPid);
        const trafficId = `ordinary-during-0069-lock-${randomUUID()}`;
        await ordinary.unsafe(`INSERT INTO ${g}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,request_operation,status,charged_cost)
          VALUES ($1,'user','key','personal:user','images.generations','success',0)`, [trafficId]);
        [trafficDuringWait] = await ordinary.unsafe(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs
          WHERE id=$1`, [trafficId]);
        assert.equal(trafficDuringWait.n, 1);
        await assert.rejects(blocked, error => error.code === '55P03');
      } finally {
        releaseHeld.resolve();
        await held;
      }
      const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
      assert.ok(elapsedMs >= 1500 && elapsedMs < 6500, `0069 lock timeout ${elapsedMs}ms`);
      const [rolledBack] = await migrator.unsafe(`SELECT
        to_regclass('${g}.request_dispatch_intents') IS NULL AS table_absent,
        NOT EXISTS(SELECT 1 FROM ${g}.schema_migrations WHERE version=$1) AS migration_absent`, [files[68]]);
      assert.deepEqual(rolledBack, { table_absent: true, migration_absent: true });
      stage('0069-lock-timeout-rolls-back-and-old-traffic-progresses', {
        sqlState: '55P03', elapsedMs, waitEvidence, trafficDuringWait, rolledBack });

      for (const name of files.slice(68)) await apply(name);
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      const after = await legacySnapshot(migrator);
      assert.deepEqual(after, before, '0068-0073 must not rewrite existing request logs');
      const [postHead] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${g}.schema_migrations`);
      assert.equal(postHead.n, 73);
      const [recoveryCounts] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${g}.request_dispatch_intents) AS intents,
        (SELECT count(*)::int FROM ${g}.request_usage_settlements) AS facts,
        (SELECT count(*)::int FROM ${g}.request_usage_recovery_jobs) AS jobs,
        (SELECT count(*)::int FROM ${g}.request_usage_commit_receipts) AS receipts`);
      assert.deepEqual(recoveryCounts, { intents: 0, facts: 0, jobs: 0, receipts: 0 });
      stage('expand-only-preserves-legacy-rows', { migrations: postHead.n,
        legacySnapshot: after, recoveryCounts });

      const oldAfter = await ordinaryWrite(ordinary, 'after-0073');
      assert.equal(oldAfter.budget_spent, '1.020000');
      const readerAfter = await requestLogs.getRequestLogsByKeyId('key', 1, 10);
      assert.equal(readerAfter.total, readerBefore.total + 2);
      assert.equal(readerAfter.logs.length, 10);
      const [runtimeAccess] = await admin.unsafe(`SELECT
        has_table_privilege('cinatoken_gateway_runtime','${g}.api_key_request_logs','INSERT') AS old_write,
        has_table_privilege('cinatoken_gateway_runtime','${g}.request_dispatch_intents','SELECT') AS recovery_read,
        has_table_privilege('cinatoken_gateway_runtime','${g}.request_usage_settlements','INSERT') AS fact_write`);
      assert.deepEqual(runtimeAccess, { old_write: true, recovery_read: false, fact_write: false });
      stage('old-reader-writer-after-formal-expand', { budgetSpent: oldAfter.budget_spent,
        readerTotal: readerAfter.total, runtimeAccess });

      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(guardUrl, 'utf8')).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.unsafe("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(intentProposalUrl, 'utf8')).simple();
        await tx.unsafe(await readFile(outboxProposalUrl, 'utf8')).simple();
      });
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      const oldAfterSwitch = await ordinaryWrite(ordinary, 'after-guard');
      assert.equal(oldAfterSwitch.budget_spent, '1.030000');
      const readerAfterGuard = await requestLogs.getRequestLogsByKeyId('key', 1, 10);
      assert.equal(readerAfterGuard.total, readerAfter.total + 1);
      assert.deepEqual(await legacySnapshot(migrator), before);
      stage('reviewed-guard-and-proposals-retain-ordinary-path', {
        budgetSpent: oldAfterSwitch.budget_spent, readerTotal: readerAfterGuard.total,
        originalLegacyDigestUnchanged: true });

      let cursor = '', scanned = 0, firstPassBatches = 0, resumedBatches = 0;
      for (let i = 0; i < 2; i++) {
        const page = await keysetCensus(ordinary, cursor, 73);
        assert.equal(page.count, 73);
        cursor = page.cursor; scanned += page.count; firstPassBatches++;
      }
      const persistedCursor = cursor;
      for (;;) {
        const page = await keysetCensus(ordinary, cursor, 73);
        if (page.count === 0) break;
        cursor = page.cursor; scanned += page.count; resumedBatches++;
      }
      assert.equal(scanned, 512);
      assert.equal((await keysetCensus(ordinary, cursor, 73)).count, 0);
      assert.deepEqual(await legacySnapshot(migrator), before);
      stage('read-only-keyset-census-resumes', { rows: scanned, pageLimit: 73,
        firstPassBatches, resumedBatches, persistedCursor, finalCursor: cursor,
        backfillPerformed: false });

      // Two fresh keys have no request logs or active budget reservations. The
      // existing hard-delete API should delete the control key; a new intent
      // referencing the other key is then the only difference.
      await migrator.unsafe(`INSERT INTO ${g}.api_keys(id,key,key_hash,user_id,workspace_id)
        VALUES ('clean-control','hashref:sha256:${'b'.repeat(64)}','sha256:${'b'.repeat(64)}','user','personal:user'),
          ('management-control','hashref:sha256:${'c'.repeat(64)}','sha256:${'c'.repeat(64)}','user','personal:user'),
          ('clean-intent','hashref:sha256:${'d'.repeat(64)}','sha256:${'d'.repeat(64)}','user','personal:user')`);
      const [cleanPreconditions] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${g}.api_key_request_logs
          WHERE api_key_id IN ('clean-control','management-control','clean-intent')) AS old_logs,
        (SELECT count(*)::int FROM ${g}.user_budget_reservations
          WHERE api_key_id IN ('clean-control','management-control','clean-intent')
            AND state IN ('reserved','dispatched')) AS user_reservations,
        (SELECT count(*)::int FROM ${g}.guardrail_budget_reservations
          WHERE scope_type='api_key' AND scope_id IN ('clean-control','management-control','clean-intent')
            AND state IN ('reserved','dispatched')) AS guardrail_reservations`);
      assert.deepEqual(cleanPreconditions,
        { old_logs: 0, user_reservations: 0, guardrail_reservations: 0 });
      const apiKeys = createPostgresApiKeysRepository({ driver: 'postgres', raw: migrator,
        drizzle: drizzle(migrator, { schema: pgCoreSchema }) });
      assert.equal(await apiKeys.deleteApiKeyHard('clean-control', 'unused'), true);
      const managementScope = { accountType: 'personal', personalOwnerUserId: 'user',
        organizationId: null };
      assert.equal(await apiKeys.deleteByHashForManagement({ ...managementScope,
        keyHash: `sha256:${'c'.repeat(64)}` }), true);
      const [controlRemaining] = await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${g}.api_keys WHERE id IN ('clean-control','management-control')`);
      assert.equal(controlRemaining.n, 0);
      stage('clean-key-existing-hard-delete-control', { cleanPreconditions,
        existingHardDeleteRemovedControl: true, existingManagementDeleteRemovedControl: true });

      const expiresAtMs = Date.now() + 60_000;
      await assert.rejects(migrator.unsafe(`INSERT INTO ${g}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('bad id',1,'user','clean-intent','personal:user','images.generations',$1,$2)`,
      ['a'.repeat(64), expiresAtMs]), error => error.code === '23514');
      await migrator.unsafe(`INSERT INTO ${g}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('new-intent',1,'user','clean-intent','personal:user','images.generations',$1,$2)`,
      ['a'.repeat(64), expiresAtMs]);
      let foreignKeyError;
      await assert.rejects(migrator.unsafe(`DELETE FROM ${g}.api_keys WHERE id='clean-intent'`),
        error => {
          foreignKeyError = { code: error.code, constraintName: error.constraint_name,
            schemaName: error.schema_name, tableName: error.table_name };
          return ['23001', '23503'].includes(error.code)
            && error.constraint_name === 'request_dispatch_intents_api_key_id_fkey';
        });
      assert.equal(await apiKeys.deleteApiKeyHard('clean-intent', 'unused'), false);
      assert.equal(await apiKeys.deleteByHashForManagement({ ...managementScope,
        keyHash: `sha256:${'d'.repeat(64)}` }), false);
      const [cleanStillUnreferenced] = await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${g}.api_key_request_logs WHERE api_key_id='clean-intent'`);
      assert.equal(cleanStillUnreferenced.n, 0);
      const [retained] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${g}.api_keys WHERE id='clean-intent') AS clean_key_rows,
        (SELECT count(*)::int FROM ${g}.request_dispatch_intents) AS intents,
        (SELECT count(*)::int FROM ${g}.api_key_request_logs WHERE id LIKE 'legacy-%') AS old_logs`);
      assert.deepEqual(retained, { clean_key_rows: 1, intents: 1, old_logs: 512 });
      stage('new-constraints-reject-invalid-id-and-clean-key-delete', {
        invalidIntentSqlState: '23514', foreignKeyError,
        hardDeleteResult: false, managementDeleteResult: false, retained,
        cleanKeyHasNoLegacyLog: true });

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

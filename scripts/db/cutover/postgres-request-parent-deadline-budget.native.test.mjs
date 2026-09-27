// Opt-in, review-only PostgreSQL 18 native proposal check. This starts a new
// owned loopback cluster and never accepts an ambient database connection.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const schema = 'cinatoken_gateway';
const parentTable = `${schema}.request_dispatch_requests`;
const intentTable = `${schema}.request_dispatch_intents`;
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const definerProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const oneClaimProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const sha256 = body => createHash('sha256').update(body).digest('hex');
const routeA = 'a'.repeat(64), routeB = 'b'.repeat(64), requestHash = 'c'.repeat(64);

function localClient(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

function prepareArgs(requestId, attemptIndex, expiry, maxAttempts = 2, context = routeA) {
  return [requestId, attemptIndex, 'parent-user', 'parent-key', 'parent-space',
    'images.generations', requestHash, context, expiry, maxAttempts];
}
function claimArgs(requestId, attemptIndex, claimId, context = routeA, revision = 0) {
  return [requestId, attemptIndex, 'parent-user', 'parent-key', 'parent-space',
    'images.generations', requestHash, context, revision, claimId];
}
async function prepare(sql, args) {
  const [row] = await sql.unsafe(`SELECT ${schema}.prepare_request_dispatch_intent_v1(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`, args);
  return row.accepted;
}
async function claim(sql, args) {
  const [row] = await sql.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`, args);
  return row.accepted;
}
async function classify(sql, requestId, attemptIndex, context, revision) {
  const [row] = await sql.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
    $1,$2,$3,$4,$5,$6,$7,$8,$9) AS changed`, [requestId, attemptIndex,
    'parent-user', 'parent-key', 'parent-space', 'images.generations',
    requestHash, context, revision]);
  return row.changed;
}
async function parent(sql, requestId) {
  const [row] = await sql.unsafe(`SELECT original_created_at_ms::text AS created,
    expires_at_ms::text AS expiry, max_attempts, prepared_count, claim_count,
    first_claim_id FROM ${parentTable} WHERE request_id=$1`, [requestId]);
  return row;
}
async function nowMs(sql, delta = 0) {
  const [row] = await sql.unsafe(`SELECT
    (floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + $1)::text AS ms`, [delta]);
  return Number(row.ms);
}
function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500) };
}

test('native request parent freezes scope, deadline and total attempts across sessions',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), 'report-request-parent-' + randomUUID() + '.json');
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18.6; review-only SQL; no runtime producer or origin',
      limitations: [
        'Uses synthetic empty-schema fixtures; no production data, old-database lock duration, or backfill is proven.',
        'No production repository or Worker is activated; the existing TypeScript repository is incompatible with the parent lock order.',
        'No provider I/O, lost COMMIT acknowledgement, direct-grant remediation, or retention is exercised.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let error;
    try {
      const [definerSql, oneClaimSql, parentSql] = await Promise.all([
        readFile(definerProposal, 'utf8'), readFile(oneClaimProposal, 'utf8'),
        readFile(parentProposal, 'utf8')]);
      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)], ['definerProposal', definerProposal],
        ['singleClaimProposal', oneClaimProposal], ['parentProposal', parentProposal],
        ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
      ]) report.sourceSha256[key] = sha256(await readFile(url));
      assert.equal(report.sourceSha256.parentProposal, sha256(parentSql),
        'The parent proposal changed while the test was loading it');
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 180000 && server.version_num < 190000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;

      const password = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE ROLE intent_producer NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = localClient(cluster, password, 'parent-migrate');
      const holder = localClient(cluster, password, 'parent-holder');
      const contender = localClient(cluster, password, 'parent-contender');
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
      report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('parent-user','parent-native@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('parent-space','personal','parent-user','Parent Native','parent-native','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('parent-key','parent-native-key','parent-user','parent-space');`).simple();
      stage('formal-schema', { formalMigrations: files.length });

      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.unsafe(definerSql).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
        await tx.unsafe(oneClaimSql).simple();
      });
      stage('v320-claim-authorization-and-index-installed');

      const activateParent = () => migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1'");
        await tx.unsafe(parentSql).simple();
      });
      await assert.rejects(migrator.begin(tx => tx.unsafe(parentSql).simple()),
        /Explicit request dispatch parent activation assertion is missing/);
      assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regclass($1) AS rel`, [parentTable]))[0].rel, null);
      stage('missing-activation-rejected-without-parent');

      const oldId = 'old-' + randomUUID();
      await migrator.unsafe(`INSERT INTO ${intentTable}
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ($1,1,'parent-user','parent-key','parent-space','images.generations',$2,$3)`,
      [oldId, routeA, await nowMs(migrator, 60_000)]);
      await assert.rejects(activateParent(), /Existing dispatch intents need separately reviewed request backfill/);
      assert.equal((await admin.unsafe(`SELECT count(*)::int AS n FROM ${intentTable} WHERE request_id=$1`, [oldId]))[0].n, 1);
      assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regclass($1) AS rel`, [parentTable]))[0].rel, null);
      stage('old-intent-preflight-refuses-backfill-and-rolls-back');
      assert.equal((await migrator.unsafe(`DELETE FROM ${intentTable} WHERE request_id=$1 RETURNING request_id`, [oldId])).length, 1);

      await migrator.unsafe(`GRANT INSERT ON ${intentTable} TO intent_producer`);
      await assert.rejects(activateParent(), /Direct dispatch intent writer privilege remains/);
      assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regclass($1) AS rel`, [parentTable]))[0].rel, null);
      stage('direct-writer-grant-preflight-refuses-install');
      await migrator.unsafe(`REVOKE INSERT ON ${intentTable} FROM intent_producer`);

      // A schema-scoped default ACL is copied onto each new SECURITY DEFINER
      // function. Revoking PUBLIC alone would leave this producer EXECUTE grant.
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO intent_producer`);
      await assert.rejects(activateParent(), /New request parent function ACL exposes a nonowner/);
      assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regclass($1) AS rel`, [parentTable]))[0].rel, null);
      const [functionsAfterRollback] = await admin.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_proc
        WHERE pronamespace='${schema}'::pg_catalog.regnamespace
          AND proname IN ('prepare_request_dispatch_intent_v1',
            'claim_request_dispatch_intent_v1', 'classify_request_dispatch_intent_v1')`);
      assert.equal(functionsAfterRollback.n, 0);
      stage('default-function-execute-grant-refuses-atomic-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        REVOKE EXECUTE ON FUNCTIONS FROM intent_producer`);
      await activateParent();
      assert.notEqual((await admin.unsafe(`SELECT pg_catalog.to_regclass($1) AS rel`, [parentTable]))[0].rel, null);
      const [access] = await admin.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_table_write,
        pg_catalog.has_table_privilege('intent_producer',$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS producer_table_write,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',$2,'INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_intent_write,
        pg_catalog.has_table_privilege('intent_producer',$2,'INSERT,UPDATE,DELETE,TRUNCATE') AS producer_intent_write`,
      [parentTable, intentTable]);
      assert.deepEqual(access, { runtime_table_write: false, producer_table_write: false,
        runtime_intent_write: false, producer_intent_write: false });
      const functions = await admin.unsafe(`SELECT p.proname,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',p.oid,'EXECUTE') AS runtime_execute,
        pg_catalog.has_function_privilege('intent_producer',p.oid,'EXECUTE') AS producer_execute
        FROM pg_catalog.pg_proc p WHERE p.pronamespace='${schema}'::pg_catalog.regnamespace
          AND p.proname IN ('prepare_request_dispatch_intent_v1',
            'claim_request_dispatch_intent_v1', 'classify_request_dispatch_intent_v1')
        ORDER BY p.proname`);
      assert.deepEqual(functions.map(({ proname }) => proname), [
        'claim_request_dispatch_intent_v1', 'classify_request_dispatch_intent_v1',
        'prepare_request_dispatch_intent_v1']);
      for (const fn of functions) {
        assert.equal(fn.runtime_execute, false);
        assert.equal(fn.producer_execute, false);
      }
      stage('parent-installed-without-runtime-or-producer-grants', { access, functions });

      const excessive = 'too-many-' + randomUUID();
      await assert.rejects(prepare(migrator, prepareArgs(excessive, 1, await nowMs(migrator, 60_000), 4)),
        /max_attempts|attempt|check constraint/i);
      assert.equal(await parent(migrator, excessive), undefined);
      const tooLong = 'too-long-' + randomUUID();
      await assert.rejects(prepare(migrator, prepareArgs(tooLong, 1, await nowMs(migrator, 301_000))),
        /Dispatch request V1 attempt or time ceiling exceeded/);
      assert.equal(await parent(migrator, tooLong), undefined);
      stage('v1-hard-attempt-and-five-minute-ceilings');

      const frozen = 'frozen-' + randomUUID(), expiry = await nowMs(migrator, 90_000);
      assert.equal(await prepare(migrator, prepareArgs(frozen, 1, expiry)), true);
      const first = await parent(migrator, frozen);
      assert.ok(Number(first.created) > 0 && Number(first.created) <= await nowMs(migrator));
      assert.equal(first.expiry, String(expiry));
      assert.equal(first.prepared_count, 1);
      assert.equal(await prepare(migrator, prepareArgs(frozen, 1, expiry)), false);
      assert.deepEqual(await parent(migrator, frozen), first);
      await assert.rejects(prepare(migrator, prepareArgs(frozen, 2, expiry + 1)),
        /frozen scope, deadline or attempt budget differs/);
      await assert.rejects(prepare(migrator, prepareArgs(frozen, 2, expiry, 3)),
        /frozen scope, deadline or attempt budget differs/);
      const wrongDigest = prepareArgs(frozen, 2, expiry); wrongDigest[6] = 'd'.repeat(64);
      await assert.rejects(prepare(migrator, wrongDigest), /frozen scope, deadline or attempt budget differs/);
      const wrongKey = prepareArgs(frozen, 2, expiry); wrongKey[3] = 'another-key';
      await assert.rejects(prepare(migrator, wrongKey), /frozen scope, deadline or attempt budget differs/);
      assert.equal(await prepare(migrator, prepareArgs(frozen, 2, expiry - 1_000, 2, routeB)), true);
      await assert.rejects(prepare(migrator, prepareArgs(frozen, 3, expiry - 1_000)),
        /frozen scope, deadline or attempt budget differs/);
      const frozenAfter = await parent(migrator, frozen);
      assert.equal(frozenAfter.created, first.created);
      assert.equal(frozenAfter.expiry, first.expiry);
      assert.equal(frozenAfter.max_attempts, 2);
      assert.equal(frozenAfter.prepared_count, 2);
      stage('scope-deadline-and-budget-frozen-with-route-specific-sibling', { parent: frozenAfter });

      const holderPid = (await holder.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      const contenderPid = (await contender.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      async function expectParentWait() {
        for (let n = 0; n < 120; n++) {
          const [row] = await admin.unsafe(`SELECT wait_event_type,wait_event,
            $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS blocked_by_holder
            FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [contenderPid, holderPid]);
          if (row?.wait_event_type === 'Lock' && row.blocked_by_holder) return row;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Sibling operation did not wait behind the parent transaction');
      }
      async function race(label, operation, rollbackFirst) {
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const requestId = `${label}-${randomUUID()}`;
        const deadline = await nowMs(migrator, 90_000);
        if (operation === 'claim') {
          assert.equal(await prepare(migrator, prepareArgs(requestId, 1, deadline)), true);
          assert.equal(await prepare(migrator, prepareArgs(requestId, 2, deadline, 2, routeB)), true);
        }
        const firstArgs = operation === 'claim'
          ? claimArgs(requestId, 1, randomUUID()) : prepareArgs(requestId, 1, deadline);
        const secondArgs = operation === 'claim'
          ? claimArgs(requestId, 2, randomUUID(), routeB) : prepareArgs(requestId, 2, deadline, 2, routeB);
        const pendingHolder = holder.begin(async tx => {
          const accepted = operation === 'claim' ? await claim(tx, firstArgs) : await prepare(tx, firstArgs);
          assert.equal(accepted, true);
          entered.resolve();
          await release.promise;
          if (rollbackFirst) throw new Error('fixture rollback before parent transaction COMMIT');
        });
        pendingHolder.catch(entered.reject);
        await entered.promise;
        const pendingContender = (operation === 'claim'
          ? claim(contender, secondArgs) : prepare(contender, secondArgs));
        let wait;
        try { wait = await expectParentWait(); }
        finally { release.resolve(); }
        if (rollbackFirst) await assert.rejects(pendingHolder, /fixture rollback/);
        else await pendingHolder;
        const accepted = await pendingContender;
        const state = await parent(migrator, requestId);
        if (operation === 'claim') {
          assert.equal(accepted, rollbackFirst);
          assert.equal(state.claim_count, 1);
          assert.equal(state.prepared_count, 2);
        } else {
          assert.equal(accepted, true);
          assert.equal(state.prepared_count, rollbackFirst ? 1 : 2);
          assert.equal(state.claim_count, 0);
        }
        return { wait, firstTransactionRolledBack: rollbackFirst,
          contenderAccepted: accepted, preparedCount: state.prepared_count,
          claimCount: state.claim_count };
      }
      stage('concurrent-sibling-prepare-waits-for-commit', await race('prepare-commit', 'prepare', false));
      stage('concurrent-sibling-prepare-waits-for-rollback', await race('prepare-rollback', 'prepare', true));
      stage('concurrent-sibling-claim-one-grant', await race('claim-commit', 'claim', false));
      stage('concurrent-sibling-claim-after-rollback', await race('claim-rollback', 'claim', true));

      const unknownId = 'unknown-' + randomUUID(), shortExpiry = await nowMs(migrator, 1_500);
      assert.equal(await prepare(migrator, prepareArgs(unknownId, 1, shortExpiry)), true);
      assert.equal(await prepare(migrator, prepareArgs(unknownId, 2, shortExpiry, 2, routeB)), true);
      const claimId = randomUUID();
      assert.equal(await claim(migrator, claimArgs(unknownId, 1, claimId)), true);
      await migrator.unsafe('SELECT pg_catalog.pg_sleep(1.7)');
      assert.equal(await classify(migrator, unknownId, 1, routeA, 1), true);
      const [unknownAttempt] = await migrator.unsafe(`SELECT state,dispatch_claim_id FROM ${intentTable}
        WHERE request_id=$1 AND attempt_index=1`, [unknownId]);
      assert.deepEqual(unknownAttempt, { state: 'outcome_unknown', dispatch_claim_id: claimId });
      assert.equal(await claim(migrator, claimArgs(unknownId, 2, randomUUID(), routeB)), false);
      const unknownParent = await parent(migrator, unknownId);
      assert.equal(unknownParent.claim_count, 1);
      assert.equal(unknownParent.first_claim_id, claimId);
      stage('outcome-unknown-permanently-consumes-parent-claim', { parent: unknownParent,
        firstAttemptState: unknownAttempt.state });

      const rolledId = 'rolled-' + randomUUID();
      await assert.rejects(migrator.begin(async tx => {
        const deadline = await nowMs(tx, 90_000);
        assert.equal(await prepare(tx, prepareArgs(rolledId, 1, deadline)), true);
        assert.equal(await claim(tx, claimArgs(rolledId, 1, randomUUID())), true);
        throw new Error('fixture rolls back prepared parent and claim');
      }), /fixture rolls back/);
      assert.equal(await parent(migrator, rolledId), undefined);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${intentTable} WHERE request_id=$1`, [rolledId]))[0].n, 0);
      stage('transaction-rollback-removes-parent-intent-and-claim');

      assert.equal(sha256(await readFile(parentProposal)), report.sourceSha256.parentProposal,
        'The parent proposal changed during the native run');
      report.status = 'PASS';
    } catch (cause) {
      error = cause;
      report.status = 'FAIL'; report.fatal = errorSummary(cause);
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (cause) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(cause); error ??= cause; }
      if (report.status === 'PASS' && report.cleanup === 'PASS') {
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        console.log('Native request parent evidence: ' + reportFile);
        console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
          stages: report.stages.map(value => value.name) }, null, 2));
      }
    }
    if (error) throw error;
  });

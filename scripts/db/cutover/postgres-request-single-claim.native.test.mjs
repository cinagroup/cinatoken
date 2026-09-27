// Opt-in PG17+ multi-session check of the review-only request claim gate.
// Starts only an owned loopback cluster; never uses an ambient DATABASE_URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';

const schema = 'cinatoken_gateway';
const table = `${schema}.request_dispatch_intents`;
const proposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const authProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const sha256 = body => createHash('sha256').update(body).digest('hex');

function localClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}
function ref(requestId, attemptIndex) {
  return { requestId, attemptIndex, userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
    operation: 'images.generations', contextSha256: (attemptIndex === 1 ? 'a' : 'b').repeat(64) };
}
function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 400) };
}

test('native one durable dispatch claim per request across sessions', { timeout: 240_000 }, async () => {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-request-single-claim-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
    scope: 'owned loopback PG; review-only partial unique index, no production dispatcher or origin',
    limitations: ['One durable claim forbids even a later known nonbillable failover until a separately reviewed resolution protocol exists.',
      'The index is outside formal migrations and its representative old-database lock/duplicate remediation is unverified.'],
    stages: [], sourceSha256: {} };
  const clients = [];
  const ownClient = (username, password, label) => {
    const client = localClient(cluster, username, password, label);
    clients.push(client); return client;
  };
  const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
  try {
    for (const [key, url] of [
      ['nativeTest', new URL(import.meta.url)], ['indexProposal', proposal],
      ['claimAuthorizationProposal', authProposal],
      ['dispatchRepository', new URL('../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts', import.meta.url)],
      ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ]) report.sourceSha256[key] = sha256(await readFile(url));
    const { admin } = cluster;
    const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 170000);
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const password = randomBytes(24).toString('hex');
    await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
      CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
      CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
    const migrator = ownClient('cinatoken_gateway_migrator', password, 'single-claim-migrate');
    const holder = ownClient('cinatoken_gateway_migrator', password, 'single-claim-holder');
    const contender = ownClient('cinatoken_gateway_migrator', password, 'single-claim-contender');
    const contenderRepo = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: contender });
    const migratorRepo = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
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
        VALUES ('user','single-claim@example.invalid',10,0);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('workspace','personal','user','Single Claim','single-claim','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('key','single-claim-key','user','workspace');`).simple();
    stage('formal-existing-schema', { formalMigrations: files.length });

    // Confirm the concrete old-schema counterexample before installing the candidate.
    const oldId = 'old-schema-' + randomUUID();
    const oldA = ref(oldId, 1), oldB = ref(oldId, 2), oldExpiry = Date.now() + 120_000;
    await migratorRepo.prepare(oldA, oldExpiry);
    await migratorRepo.prepare(oldB, oldExpiry);
    assert.equal(await migratorRepo.claim(oldA, 0, randomUUID()), 'granted');
    assert.equal(await contenderRepo.claim(oldB, 0, randomUUID()), 'granted');
    const [oldCount] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}
      WHERE request_id=$1 AND dispatch_claim_id IS NOT NULL`, [oldId]);
    assert.equal(oldCount.n, 2);
    stage('old-schema-cross-attempt-counterexample', { durableClaimsForOneRequest: oldCount.n });

    const activate = async () => migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(proposal, 'utf8')).simple();
    });
    let duplicateError;
    await assert.rejects(activate(), error => {
      duplicateError = errorSummary(error);
      return /Preexisting multiple dispatch claims for one request/.test(String(error?.message));
    });
    const [absent] = await admin.unsafe(`SELECT pg_catalog.to_regclass(
      '${schema}.request_dispatch_intents_one_claim_per_request') IS NULL AS missing`);
    assert.equal(absent.missing, true);
    const [unchanged] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}
      WHERE request_id=$1 AND dispatch_claim_id IS NOT NULL`, [oldId]);
    assert.equal(unchanged.n, 2);
    stage('candidate-rejects-existing-duplicate', { error: duplicateError,
      existingClaimsPreserved: unchanged.n, indexAbsentAfterRollback: true });

    // Only this disposable fixture drops its two synthetic collision rows.
    const removed = await migrator.unsafe(`DELETE FROM ${table} WHERE request_id=$1 RETURNING request_id`, [oldId]);
    assert.equal(removed.length, 2);
    let triggerShapeError;
    await assert.rejects(migrator.begin(async tx => {
      await tx.unsafe(`DROP TRIGGER request_dispatch_intents_guard ON ${table};
        CREATE TRIGGER request_dispatch_intents_guard BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${schema}.guard_request_dispatch_intent();`).simple();
      await tx.unsafe("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(proposal, 'utf8')).simple();
    }), error => {
      triggerShapeError = errorSummary(error);
      return /Request dispatch intent guard binding differs/.test(String(error?.message));
    });
    const [absentAfterShape] = await admin.unsafe(`SELECT pg_catalog.to_regclass(
      '${schema}.request_dispatch_intents_one_claim_per_request') IS NULL AS missing`);
    assert.equal(absentAfterShape.missing, true);
    stage('candidate-rejects-trigger-shape-drift', { error: triggerShapeError,
      indexAbsentAfterRollback: absentAfterShape.missing });
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(authProposal, 'utf8')).simple();
    });
    const [definer] = await admin.unsafe(`SELECT p.prosecdef AS security_definer,
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime',p.oid,'EXECUTE') AS runtime_execute
      FROM pg_catalog.pg_proc p WHERE p.oid=
      'cinatoken_gateway.guard_request_dispatch_intent()'::pg_catalog.regprocedure`);
    assert.deepEqual(definer, { security_definer: true, runtime_execute: false });
    stage('claim-authorization-definer-installed', { definer });
    await activate();
    const [index] = await admin.unsafe(`SELECT i.indisunique AS unique, i.indisvalid AS valid,
      pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_catalog.pg_index i WHERE i.indexrelid=
      '${schema}.request_dispatch_intents_one_claim_per_request'::pg_catalog.regclass`);
    assert.equal(index.unique, true);
    assert.equal(index.valid, true);
    assert.match(index.predicate, /dispatch_claim_id IS NOT NULL/);
    stage('review-only-index-installed', { index });

    const holderPid = (await holder.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    const contenderPid = (await contender.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    async function expectWait() {
      for (let n = 0; n < 120; n++) {
        const [row] = await admin.unsafe(`SELECT wait_event_type,wait_event,
          $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS blocked_by_holder
          FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [contenderPid, holderPid]);
        if (row?.wait_event_type === 'Lock' && row.blocked_by_holder) return row;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Sibling claim did not wait behind the first uncommitted claim');
    }
    async function exercise(label, rollbackFirst) {
      const requestId = `${label}-${randomUUID()}`;
      const first = ref(requestId, 1), second = ref(requestId, 2);
      const expiry = Date.now() + 120_000;
      await migratorRepo.prepare(first, expiry);
      await migratorRepo.prepare(second, expiry);
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const claimId = randomUUID();
      const pendingHolder = holder.begin(async tx => {
        await tx.unsafe(`SELECT request_id FROM ${table} WHERE request_id=$1 AND attempt_index=1 FOR UPDATE`, [requestId]);
        const rows = await tx.unsafe(`UPDATE ${table}
          SET state='dispatch_claimed',revision=revision+1,dispatch_claim_id=$2
          WHERE request_id=$1 AND attempt_index=1 AND state='prepared' RETURNING request_id`, [requestId, claimId]);
        assert.equal(rows.length, 1);
        entered.resolve();
        await release.promise;
        if (rollbackFirst) throw new Error('fixture rollback before first claim COMMIT');
      });
      pendingHolder.catch(entered.reject);
      await entered.promise;
      const pendingContender = contenderRepo.claim(second, 0, randomUUID()).then(
        value => ({ state: 'resolved', value }),
        error => ({ state: 'rejected', error }));
      let wait;
      try { wait = await expectWait(); }
      finally { release.resolve(); }
      if (rollbackFirst) await assert.rejects(pendingHolder, /fixture rollback/);
      else await pendingHolder;
      const outcome = await pendingContender;
      const firstRow = await migratorRepo.inspect(first), secondRow = await migratorRepo.inspect(second);
      if (rollbackFirst) {
        assert.deepEqual(outcome, { state: 'resolved', value: 'granted' });
        assert.equal(firstRow.state, 'prepared');
        assert.equal(secondRow.state, 'dispatch_claimed');
      } else {
        assert.equal(outcome.state, 'rejected');
        assert.ok(outcome.error instanceof PostgresDispatchClaimUncertainError);
        assert.equal(firstRow.state, 'dispatch_claimed');
        assert.equal(secondRow.state, 'prepared');
      }
      const [count] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}
        WHERE request_id=$1 AND dispatch_claim_id IS NOT NULL`, [requestId]);
      assert.equal(count.n, 1);
      return { rollbackFirst, wait, firstState: firstRow.state, secondState: secondRow.state,
        contender: outcome.state === 'rejected' ? errorSummary(outcome.error) : outcome.value,
        durableClaimsForOneRequest: count.n };
    }
    stage('concurrent-first-commit-blocks-sibling', await exercise('first-commits', false));
    stage('concurrent-first-rollback-allows-sibling', await exercise('first-rolls-back', true));

    const expiryId = 'expired-before-send-' + randomUUID();
    const expired = ref(expiryId, 1), later = ref(expiryId, 2);
    await migratorRepo.prepare(expired, Date.now() + 350);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await migratorRepo.classifyOverdue(expired, 0), true);
    assert.equal((await migratorRepo.inspect(expired)).state, 'expired_before_dispatch');
    await migratorRepo.prepare(later, Date.now() + 120_000);
    assert.equal(await migratorRepo.claim(later, 0, randomUUID()), 'granted');
    stage('expired-before-dispatch-does-not-consume-claim', {
      firstState: 'expired_before_dispatch', secondState: 'dispatch_claimed' });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.fatal = errorSummary(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native request single-claim evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
      stages: report.stages.map(stage => stage.name) }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
  }
});

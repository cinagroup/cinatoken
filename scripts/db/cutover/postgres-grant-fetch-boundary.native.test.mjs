// Opt-in LOCAL-ONLY composition test: native PG claim -> Images driver fetch.
// This fixture does not register a production dispatcher or contact an origin.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { proxyImageGenerations } from '../../../packages/proxy/src/services/proxy.ts';
import { RequestBudgetAdmissionError } from '../../../packages/proxy/src/services/request-budget-admission.ts';
import { GatewayErrorCode } from '../../../packages/proxy/src/services/gateway-error-codes.ts';
import { resetProviderCircuitStateForTests } from '../../../packages/proxy/src/services/provider-circuit-breaker.ts';

const schema = 'cinatoken_gateway';
const table = `${schema}.request_dispatch_intents`;
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const authProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const indexProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function localClient(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

function identity(requestId, attemptIndex) {
  return { requestId, attemptIndex, userId: 'user', apiKeyId: 'key',
    workspaceId: 'workspace', operation: 'images.generations',
    contextSha256: (attemptIndex === 1 ? 'a' : 'b').repeat(64) };
}

function route(providerId, priority) {
  return { targetId: 'target-' + providerId, modelSurfaceId: 'surface-image',
    routePoolId: 'pool-image', providerId, providerName: providerId,
    providerModelName: 'gpt-image-1', upstreamProtocol: 'openai',
    upstreamOperation: 'images.generations', adapter: 'passthrough',
    providerEndpoints: { openai: { base: `https://${providerId}.example.invalid/v1` } },
    providerApiKey: 'sk-test-' + providerId, providerSharedChannelType: null,
    priceOverrideRaw: null, routeMeteredProfileJson: null,
    routeChargedProfileJson: null, customParams: null, routeGroup: 'default',
    routePriority: priority, routeWeight: 1, providerKeyId: providerId,
    providerKeyLabel: providerId, providerKeyFingerprint: 'fixture-' + providerId };
}

function claimAdmission(repo, ref, observations, expectedRevision = 0) {
  return async () => {
    let result;
    try { result = await repo.claim(ref, expectedRevision, randomUUID()); }
    catch (cause) {
      observations.push(cause instanceof PostgresDispatchClaimUncertainError ? 'uncertain' : 'error');
      throw new RequestBudgetAdmissionError({ code: GatewayErrorCode.guardrailBlocked,
        message: 'Dispatch claim could not be confirmed', cause });
    }
    observations.push(result);
    if (result !== 'granted') throw new RequestBudgetAdmissionError({
      code: GatewayErrorCode.guardrailBlocked,
      message: 'Dispatch claim was denied',
    });
  };
}

function imageOptions(repo, ref, observations, fetchImpl, expectedRevision = 0) {
  return { affinityKey: 'fixture-user|image', tierKeyPrefix: 'fixture-image',
    strategy: 'weight_priority', stopAfterFirstGrantedDispatch: true,
    beforeUpstreamDispatch: claimAdmission(repo, ref, observations, expectedRevision),
    image: { fetchImpl } };
}

async function runImage(repo, ref, observations, fetchImpl, expectedRevision = 0) {
  resetProviderCircuitStateForTests();
  return proxyImageGenerations({}, [route('first', 2), route('second', 1)],
    { prompt: 'local fixture', n: 1 }, undefined,
    imageOptions(repo, ref, observations, fetchImpl, expectedRevision));
}

function summarize(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 400) };
}

test('native committed claim gates the actual Images fetch boundary', { timeout: 240_000 }, async () => {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-grant-fetch-boundary-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', cleanup: 'PENDING',
    scope: 'owned loopback PostgreSQL with actual proxyImageGenerations and Images driver; fake fetch, no origin',
    limitations: [
      'The claim-to-admission error mapping is fixture-only; no production route enables these proposals.',
      'The delayed acknowledgement is a client wrapper after a real COMMIT, not a wire-level lost packet.',
      'This proves the Images generations path only, not edits, text, all Workers, or accounting settlement.',
    ], binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [] };
  const clients = [];
  const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
  try {
    for (const [key, url] of [
      ['nativeTest', new URL(import.meta.url)], ['claimRepository', new URL('../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts', import.meta.url)],
      ['authProposal', authProposal], ['singleClaimProposal', indexProposal],
      ['proxy', new URL('../../../packages/proxy/src/services/proxy.ts', import.meta.url)],
      ['failover', new URL('../../../packages/proxy/src/services/failover-dispatch.ts', import.meta.url)],
      ['imagesDriver', new URL('../../../packages/proxy/src/services/egress/openai-images-driver.ts', import.meta.url)],
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
    const migrator = localClient(cluster, password, 'grant-fetch-migrate');
    const competitor = localClient(cluster, password, 'grant-fetch-competitor');
    clients.push(migrator, competitor);
    const repository = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
    const competitorRepo = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: competitor });
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
    report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
    await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('user','grant-fetch@example.invalid',10,0);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('workspace','personal','user','Grant Fetch','grant-fetch','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('key','grant-fetch-key','user','workspace');`).simple();
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(authProposal, 'utf8')).simple();
    });
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(indexProposal, 'utf8')).simple();
    });
    const [index] = await admin.unsafe(`SELECT i.indisunique AS unique, i.indisvalid AS valid
      FROM pg_catalog.pg_index i WHERE i.indexrelid=
      '${schema}.request_dispatch_intents_one_claim_per_request'::pg_catalog.regclass`);
    assert.deepEqual(index, { unique: true, valid: true });
    stage('formal-schema-and-review-only-proposals', { formalMigrations: files.length, index });

    // Delay only the client-visible result of a real committed transaction.
    // The driver must not call fetch until the repository resolves "granted".
    const committed = Promise.withResolvers(), acknowledge = Promise.withResolvers();
    const delayedRaw = { unsafe: (...args) => migrator.unsafe(...args),
      begin: async callback => {
        const result = await migrator.begin(callback);
        committed.resolve();
        await acknowledge.promise;
        return result;
      } };
    const delayedRepo = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: delayedRaw });
    const first = identity('ack-' + randomUUID(), 1);
    await repository.prepare(first, Date.now() + 120_000);
    const fetches = [], admissions = [];
    const responseBody = { error: { message: 'upstream unavailable' },
      usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } };
    const fetchImpl = async (url, init) => {
      const [claim] = await admin.unsafe(`SELECT state,dispatch_claim_id IS NOT NULL AS claimed
        FROM ${table} WHERE request_id=$1 AND attempt_index=1`, [first.requestId]);
      assert.deepEqual(claim, { state: 'dispatch_claimed', claimed: true });
      fetches.push({ url: String(url), method: init.method, redirect: init.redirect });
      return Response.json(responseBody, { status: 503, headers: { 'x-request-id': 'upstream-first' } });
    };
    let settled = false;
    const pending = runImage(delayedRepo, first, admissions, fetchImpl).finally(() => { settled = true; });
    try {
      await committed.promise;
      const [claim] = await admin.unsafe(`SELECT state,dispatch_claim_id IS NOT NULL AS claimed
        FROM ${table} WHERE request_id=$1 AND attempt_index=1`, [first.requestId]);
      assert.deepEqual(claim, { state: 'dispatch_claimed', claimed: true });
      assert.equal(fetches.length, 0);
      assert.equal(settled, false);
      stage('committed-but-unacknowledged-claim-zero-fetch', { durableState: claim.state,
        providerFetches: fetches.length });
    } finally { acknowledge.resolve(); }
    const firstResult = await pending;
    assert.deepEqual(admissions, ['granted']);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].method, 'POST');
    assert.equal(fetches[0].redirect, 'manual');
    assert.match(fetches[0].url, /^https:\/\/first\.example\.invalid\/v1\/images\/generations$/);
    assert.equal(firstResult.response.status, 503);
    assert.deepEqual(await firstResult.response.json(), responseBody);
    assert.equal(firstResult.chosenRoute.providerId, 'first');
    assert.equal(firstResult.upstreamRequestId, 'upstream-first');
    const usage = await firstResult.usagePromise;
    assert.equal(usage.input_tokens, 3);
    assert.equal(usage.output_tokens, 7);
    assert.equal(usage.total_tokens, 10);
    assert.equal(firstResult.dispatchBudget.permitsConsumed, 1);
    assert.equal(firstResult.dispatchAttempts.length, 1);
    assert.equal(firstResult.meta.failoverForbidden, true);
    stage('acknowledged-grant-one-fetch-preserves-known-non-2xx', {
      providerFetches: fetches.length, responseStatus: firstResult.response.status,
      chosenProviderId: firstResult.chosenRoute.providerId, usageTotalTokens: usage.total_tokens });

    const denied = identity('denied-' + randomUUID(), 1);
    await repository.prepare(denied, Date.now() + 120_000);
    const deniedCalls = [], deniedAdmissions = [];
    const deniedResult = await runImage(repository, denied, deniedAdmissions,
      async () => { deniedCalls.push('fetch'); throw new Error('unexpected fetch'); }, 1);
    assert.deepEqual(deniedAdmissions, ['not_granted']);
    assert.equal(deniedCalls.length, 0);
    assert.equal(deniedResult.response.status, 403);
    assert.equal(deniedResult.meta.failoverForbidden, true);
    assert.equal(deniedResult.chosenRoute.providerId, 'first');
    assert.equal((await repository.inspect(denied)).state, 'prepared');
    stage('denied-stale-revision-zero-fetch-no-fallback', { providerFetches: 0,
      responseStatus: deniedResult.response.status });

    // The database COMMIT succeeds but the caller observes an error instead
    // of its acknowledgement. Repository must surface uncertainty; the driver
    // and failover bridge must remain pre-fetch.
    const uncertain = identity('uncertain-' + randomUUID(), 1);
    await repository.prepare(uncertain, Date.now() + 120_000);
    const lostAckRaw = { unsafe: (...args) => migrator.unsafe(...args),
      begin: async callback => {
        await migrator.begin(callback);
        throw new Error('fixture lost COMMIT acknowledgement');
      } };
    const lostAckRepo = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: lostAckRaw });
    const uncertainCalls = [], uncertainAdmissions = [];
    const uncertainResult = await runImage(lostAckRepo, uncertain, uncertainAdmissions,
      async () => { uncertainCalls.push('fetch'); throw new Error('unexpected fetch'); });
    assert.deepEqual(uncertainAdmissions, ['uncertain']);
    assert.equal(uncertainCalls.length, 0);
    assert.equal(uncertainResult.response.status, 403);
    assert.equal(uncertainResult.meta.failoverForbidden, true);
    assert.equal((await repository.inspect(uncertain)).state, 'dispatch_claimed');
    stage('lost-commit-ack-zero-fetch-no-fallback', { durableState: 'dispatch_claimed',
      providerFetches: 0, responseStatus: uncertainResult.response.status });

    // Two independent request handlers race different attempt rows with the
    // same request_id. The partial unique index grants one committed claim.
    const sharedId = 'concurrent-' + randomUUID();
    const siblingA = identity(sharedId, 1), siblingB = identity(sharedId, 2);
    const expiry = Date.now() + 120_000;
    await repository.prepare(siblingA, expiry);
    await competitorRepo.prepare(siblingB, expiry);
    const competingFetches = [], aAdmissions = [], bAdmissions = [];
    const competingFetch = async (url) => {
      competingFetches.push(String(url));
      return Response.json(responseBody, { status: 503 });
    };
    const [a, b] = await Promise.all([
      runImage(repository, siblingA, aAdmissions, competingFetch),
      runImage(competitorRepo, siblingB, bAdmissions, competingFetch),
    ]);
    assert.deepEqual([a.response.status, b.response.status].sort(), [403, 503]);
    assert.equal(competingFetches.length, 1);
    assert.deepEqual([aAdmissions[0], bAdmissions[0]].sort(), ['granted', 'uncertain']);
    const [count] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}
      WHERE request_id=$1 AND dispatch_claim_id IS NOT NULL`, [sharedId]);
    assert.equal(count.n, 1);
    stage('concurrent-sibling-handlers-at-most-one-fetch', { providerFetches: 1,
      durableClaims: count.n, responseStatuses: [a.response.status, b.response.status].sort() });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.fatal = summarize(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summarize(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native grant-fetch evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
      stages: report.stages.map(value => value.name) }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
  }
});

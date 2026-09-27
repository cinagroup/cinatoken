// Opt-in local composition test. No production factory or origin is activated.
// Budget repositories are in-memory witnesses, while the request parent and
// dispatch claim use a new owned PostgreSQL cluster and real COMMITs.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createParentDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.ts';
import { PostgresDispatchClaimUncertainError } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { createRouteAwareBudgetAdmission, RequestBudgetAdmissionError } from '../../../packages/proxy/src/services/request-budget-admission.ts';
import { GatewayErrorCode } from '../../../packages/proxy/src/services/gateway-error-codes.ts';
import { proxyImageGenerations } from '../../../packages/proxy/src/services/proxy.ts';
import { resetProviderCircuitStateForTests } from '../../../packages/proxy/src/services/provider-circuit-breaker.ts';

const schema = 'cinatoken_gateway';
const parentTable = `${schema}.request_dispatch_requests`;
const intentTable = `${schema}.request_dispatch_intents`;
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const authProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const indexProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function localClient(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

function route(providerId, priority) {
  return { targetId: `target-${providerId}`, modelSurfaceId: 'surface-image',
    routePoolId: 'pool-image', providerId, providerName: providerId,
    providerModelName: 'gpt-image-1', upstreamProtocol: 'openai',
    upstreamOperation: 'images.generations', adapter: 'passthrough',
    providerEndpoints: { openai: { base: `https://${providerId}.example.invalid/v1` } },
    providerApiKey: `sk-test-${providerId}`, providerSharedChannelType: null,
    priceOverrideRaw: null, routeMeteredProfileJson: null,
    routeChargedProfileJson: null, customParams: null, routeGroup: 'default',
    routePriority: priority, routeWeight: 1, providerKeyId: providerId,
    providerKeyLabel: providerId, providerKeyFingerprint: `fixture-${providerId}` };
}

function identity(requestId, attemptIndex) {
  return { requestId, attemptIndex, userId: 'parent-budget-user',
    apiKeyId: 'parent-budget-key', workspaceId: 'parent-budget-space',
    operation: 'images.generations',
    requestSha256: sha256('synthetic canonical request for ' + requestId),
    contextSha256: sha256(`route-${attemptIndex} for ${requestId}`) };
}

function fakeBudgetRepositories(trace) {
  const state = { ordinary: 'none', guardrail: 'none' };
  const repos = {
    userBudgets: {
      async expireBefore() { return 0; },
      async reserve(params) {
        assert.equal(state.ordinary, 'none');
        assert.equal(params.reservedMicros, 250_000);
        state.ordinary = 'reserved'; trace.push('ordinary:reserve');
        return { status: 'reserved', reservation: {
          requestId: params.requestId, userId: params.userId,
          apiKeyId: params.apiKeyId, budgetEpoch: params.expectedBudgetEpoch,
          limitMicros: 10_000_000, reservedMicros: params.reservedMicros } };
      },
      async markDispatched() {
        assert.equal(state.ordinary, 'reserved');
        assert.equal(state.guardrail, 'dispatched');
        state.ordinary = 'dispatched'; trace.push('ordinary:dispatch'); return true;
      },
      async release() {
        assert.equal(state.ordinary, 'reserved');
        state.ordinary = 'released'; trace.push('ordinary:release'); return 1;
      },
      async forfeitDispatched() { assert.fail('No fake ordinary forfeit is expected'); },
    },
    guardrailBudgets: {
      async expireBefore() { return 0; },
      async reserveMany(params) {
        assert.equal(state.ordinary, 'reserved');
        assert.equal(state.guardrail, 'none');
        assert.equal(params.reservedMicros, 250_000);
        state.guardrail = 'reserved'; trace.push('guardrail:reserve');
        return { status: 'reserved', reservationCount: 1 };
      },
      async extendDispatched() { assert.fail('No fake guardrail extension is expected'); },
      async markDispatched() {
        assert.equal(state.guardrail, 'reserved');
        state.guardrail = 'dispatched'; trace.push('guardrail:dispatch'); return true;
      },
      async releaseMany() {
        assert.equal(state.guardrail, 'reserved');
        state.guardrail = 'released'; trace.push('guardrail:release'); return 1;
      },
      async forfeitMany() { assert.fail('No fake guardrail forfeit is expected'); },
    },
  };
  return { repos, state };
}

async function budgetAdmission(repos, requestId) {
  const now = new Date();
  return createRouteAwareBudgetAdmission(repos, {
    ordinary: { requestId, userId: 'parent-budget-user', apiKeyId: 'parent-budget-key',
      budgetMax: 10, expectedBudgetEpoch: 1, estimatedChargedCost: 0.25, now },
    guardrail: { intents: [{ workspaceId: 'parent-budget-space',
      assignmentId: 'parent-budget-assignment', guardrailId: 'parent-budget-guardrail',
      guardrailVersion: 1, scopeType: 'user', scopeId: 'parent-budget-user',
      period: 'daily', periodStart: '2026-09-24T00:00:00.000Z',
      periodEnd: '2026-09-25T00:00:00.000Z', limitMicros: 10_000_000 }],
      reservedMicros: 250_000, now },
    privateByokGatewayKey: { includeInLimit: false, reservedMicros: 250_000 },
  });
}

// The wrapper observes a real transaction commit. Its optional delay or loss
// affects only the client-visible acknowledgement after that commit.
function observedRepository(client, trace, { claimGate, claimCommitted, loseClaimAck = false } = {}) {
  const raw = {
    unsafe: (...args) => client.unsafe(...args),
    begin: async callback => {
      let kind;
      const result = await client.begin(tx => callback({ unsafe(query, params) {
        kind = query.includes('claim_request_dispatch_intent_v1') ? 'claim'
          : query.includes('prepare_request_dispatch_intent_v1') ? 'prepare' : 'other';
        trace.push(`${kind}:sql`);
        return tx.unsafe(query, params);
      } }));
      assert.ok(kind === 'prepare' || kind === 'claim');
      trace.push(`${kind}:durable_commit`);
      if (kind === 'claim') {
        claimCommitted?.resolve();
        if (claimGate) await claimGate.promise;
        if (loseClaimAck) throw new Error('fixture lost client-visible claim COMMIT acknowledgement');
      }
      trace.push(`${kind}:commit_ack`);
      return result;
    },
  };
  return createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw });
}

function denied(message, cause) {
  return new RequestBudgetAdmissionError({ code: GatewayErrorCode.guardrailBlocked,
    message, cause });
}

async function runImage({ repo, ref, deadline, trace, budget, fetchImpl }) {
  resetProviderCircuitStateForTests();
  const admission = await budgetAdmission(budget.repos, ref.requestId);
  const beforeUpstreamDispatch = async selectedRoute => {
    const ticket = await admission.prepareSingleGrant(selectedRoute);
    try { await repo.prepare(ref, deadline, 2); }
    catch (cause) {
      // A preparation result grants no dispatch right, even when its ACK is lost.
      await ticket.releaseAfterDefiniteNoClaim();
      throw denied('Dispatch intent preparation failed', cause);
    }
    let claim;
    try { claim = await repo.claim(ref, 0, randomUUID()); }
    catch (cause) {
      if (!(cause instanceof PostgresDispatchClaimUncertainError)) throw cause;
      ticket.holdAfterUncertainClaim();
      trace.push('claim:uncertain');
      throw denied('Dispatch claim acknowledgement uncertain', cause);
    }
    if (claim !== 'granted') {
      trace.push('claim:not_granted');
      await ticket.releaseAfterDefiniteNoClaim();
      throw denied('Dispatch claim not granted');
    }
    trace.push('claim:granted');
    await ticket.markAfterCommittedClaim();
  };
  const result = await proxyImageGenerations({}, [route('first', 2), route('second', 1)],
    { prompt: 'local composition fixture', n: 1 }, undefined,
    { affinityKey: 'fixture-user|image', tierKeyPrefix: 'fixture-image',
      strategy: 'weight_priority', stopAfterFirstGrantedDispatch: true,
      beforeUpstreamDispatch, image: { fetchImpl } });
  return { result, admission };
}

function assertOrder(trace, expected) {
  let cursor = -1;
  for (const event of expected) {
    const next = trace.indexOf(event, cursor + 1);
    assert.ok(next > cursor, `Expected ${event} after ${trace[cursor]} in ${trace.join(', ')}`);
    cursor = next;
  }
}

async function parentState(sql, requestId) {
  const [row] = await sql.unsafe(`SELECT max_attempts,prepared_count,claim_count,
    first_claim_id FROM ${parentTable} WHERE request_id=$1`, [requestId]);
  return row;
}

function summary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 400) };
}

test('native parent claim and budget ticket gate the Images fetch boundary',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-parent-budget-fetch-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL with actual parent adapter, budget coordinator and Images generations driver; fake budgets and fetch',
      limitations: [
        'Budget repositories are in-memory witnesses; no financial settlement, recovery reconciliation or production budget persistence is proven.',
        'The request digest is synthetic and not derived from an authenticated canonical HTTP request.',
        'The claim ACK delay and loss are wrapper simulations after a real COMMIT, not network packet loss.',
        'Only Images generations is exercised. No production factory, runtime EXECUTE grant or real origin is activated.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let error;
    try {
      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)],
        ['parentAdapter', new URL('../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.ts', import.meta.url)],
        ['budgetAdmission', new URL('../../../packages/proxy/src/services/request-budget-admission.ts', import.meta.url)],
        ['authProposal', authProposal], ['singleClaimProposal', indexProposal],
        ['parentProposal', parentProposal],
        ['proxy', new URL('../../../packages/proxy/src/services/proxy.ts', import.meta.url)],
        ['failover', new URL('../../../packages/proxy/src/services/failover-dispatch.ts', import.meta.url)],
        ['imagesDriver', new URL('../../../packages/proxy/src/services/egress/openai-images-driver.ts', import.meta.url)],
        ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
      ]) report.sourceSha256[key] = sha256(await readFile(url));
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 180000 && server.version_num < 190000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;

      const password = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = localClient(cluster, password, 'parent-budget-fetch');
      clients.push(migrator);
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
          VALUES ('parent-budget-user','parent-budget@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('parent-budget-space','personal','parent-budget-user','Parent Budget','parent-budget','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('parent-budget-key','parent-budget-secret','parent-budget-user','parent-budget-space');`).simple();
      for (const [setting, url] of [
        ['cinatoken.dispatch_intent_definer_activation', authProposal],
        ['cinatoken.request_dispatch_single_claim_activation', indexProposal],
        ['cinatoken.request_dispatch_parent_activation', parentProposal],
      ]) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      const [index] = await admin.unsafe(`SELECT i.indisunique AS unique, i.indisvalid AS valid
        FROM pg_catalog.pg_index i WHERE i.indexrelid=
        '${schema}.request_dispatch_intents_one_claim_per_request'::pg_catalog.regclass`);
      assert.deepEqual(index, { unique: true, valid: true });
      stage('formal-schema-and-three-review-only-proposals', { formalMigrations: files.length, index });

      const requestId = `budget-fetch-${randomUUID()}`;
      const first = identity(requestId, 1);
      const deadline = Date.now() + 90_000;
      const firstTrace = [], firstBudget = fakeBudgetRepositories(firstTrace);
      const committed = Promise.withResolvers(), acknowledge = Promise.withResolvers();
      const firstRepo = observedRepository(migrator, firstTrace,
        { claimCommitted: committed, claimGate: acknowledge });
      const fetches = [];
      const responseBody = { error: { message: 'upstream unavailable' },
        usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } };
      const fetchImpl = async (url, init) => {
        const [attempt] = await admin.unsafe(`SELECT state,dispatch_claim_id IS NOT NULL AS claimed
          FROM ${intentTable} WHERE request_id=$1 AND attempt_index=1`, [requestId]);
        assert.deepEqual(attempt, { state: 'dispatch_claimed', claimed: true });
        assert.deepEqual([firstBudget.state.ordinary, firstBudget.state.guardrail],
          ['dispatched', 'dispatched']);
        firstTrace.push('fetch');
        fetches.push({ url: String(url), method: init.method, redirect: init.redirect });
        return Response.json(responseBody, { status: 503,
          headers: { 'x-request-id': 'parent-budget-first' } });
      };
      let settled = false;
      const pending = runImage({ repo: firstRepo, ref: first, deadline,
        trace: firstTrace, budget: firstBudget, fetchImpl }).finally(() => { settled = true; });
      try {
        await committed.promise;
        assert.deepEqual(firstBudget.state, { ordinary: 'reserved', guardrail: 'reserved' });
        assert.equal(fetches.length, 0);
        assert.equal(settled, false);
        assert.equal((await parentState(admin, requestId)).claim_count, 1);
        assert.ok(!firstTrace.includes('claim:commit_ack'));
        assert.ok(!firstTrace.includes('ordinary:dispatch'));
        stage('durable-claim-before-client-ack-holds-both-reservations-zero-fetch',
          { durableClaims: 1, providerFetches: 0, budgetState: { ...firstBudget.state } });
      } finally { acknowledge.resolve(); }
      const firstRun = await pending;
      assert.deepEqual(firstBudget.state, { ordinary: 'dispatched', guardrail: 'dispatched' });
      assertOrder(firstTrace, ['ordinary:reserve', 'guardrail:reserve',
        'prepare:sql', 'prepare:commit_ack', 'claim:sql', 'claim:commit_ack',
        'guardrail:dispatch', 'ordinary:dispatch', 'fetch']);
      assert.equal(fetches.length, 1);
      assert.equal(fetches[0].method, 'POST');
      assert.equal(fetches[0].redirect, 'manual');
      assert.match(fetches[0].url, /^https:\/\/first\.example\.invalid\/v1\/images\/generations$/u);
      assert.equal(firstRun.result.response.status, 503);
      assert.deepEqual(await firstRun.result.response.json(), responseBody);
      assert.equal(firstRun.result.chosenRoute.providerId, 'first');
      assert.equal(firstRun.result.upstreamRequestId, 'parent-budget-first');
      const usage = await firstRun.result.usagePromise;
      assert.equal(usage.total_tokens, 10);
      assert.equal(firstRun.result.dispatchBudget.permitsConsumed, 1);
      assert.equal(firstRun.result.dispatchAttempts.length, 1);
      assert.equal(firstRun.result.meta.failoverForbidden, true);
      stage('acknowledged-parent-grant-marks-both-budgets-before-one-fetch',
        { eventOrder: firstTrace, providerFetches: 1, responseStatus: 503,
          providerId: 'first', usageTotalTokens: usage.total_tokens });

      const sibling = identity(requestId, 2);
      const siblingTrace = [], siblingBudget = fakeBudgetRepositories(siblingTrace);
      const siblingRepo = observedRepository(migrator, siblingTrace);
      const siblingFetches = [];
      const siblingRun = await runImage({ repo: siblingRepo, ref: sibling, deadline,
        trace: siblingTrace, budget: siblingBudget,
        fetchImpl: async () => { siblingFetches.push('fetch'); throw new Error('Unexpected sibling fetch'); } });
      assert.equal(siblingRun.result.response.status, 403);
      assert.equal(siblingRun.result.meta.failoverForbidden, true);
      assert.equal(siblingFetches.length, 0);
      assert.deepEqual(siblingBudget.state, { ordinary: 'released', guardrail: 'released' });
      assertOrder(siblingTrace, ['ordinary:reserve', 'guardrail:reserve',
        'prepare:sql', 'prepare:commit_ack', 'claim:sql', 'claim:commit_ack',
        'claim:not_granted', 'guardrail:release', 'ordinary:release']);
      assert.ok(!siblingTrace.includes('ordinary:dispatch'));
      const siblingParent = await parentState(admin, requestId);
      assert.equal(siblingParent.prepared_count, 2);
      assert.equal(siblingParent.claim_count, 1);
      const [durableClaims] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${intentTable}
        WHERE request_id=$1 AND dispatch_claim_id IS NOT NULL`, [requestId]);
      assert.equal(durableClaims.n, 1);
      stage('definitive-sibling-no-claim-releases-both-budgets-zero-fetch',
        { eventOrder: siblingTrace, preparedAttempts: siblingParent.prepared_count,
          durableClaims: durableClaims.n, providerFetches: 0 });

      const lostRequestId = `budget-lost-${randomUUID()}`;
      const lostRef = identity(lostRequestId, 1);
      const lostTrace = [], lostBudget = fakeBudgetRepositories(lostTrace);
      const lostRepo = observedRepository(migrator, lostTrace, { loseClaimAck: true });
      const lostFetches = [];
      const lostRun = await runImage({ repo: lostRepo, ref: lostRef,
        deadline: Date.now() + 90_000, trace: lostTrace, budget: lostBudget,
        fetchImpl: async () => { lostFetches.push('fetch'); throw new Error('Unexpected lost-ACK fetch'); } });
      assert.equal(lostRun.result.response.status, 403);
      assert.equal(lostRun.result.meta.failoverForbidden, true);
      assert.equal(lostFetches.length, 0);
      assert.deepEqual(lostBudget.state, { ordinary: 'reserved', guardrail: 'reserved' });
      assertOrder(lostTrace, ['ordinary:reserve', 'guardrail:reserve',
        'prepare:commit_ack', 'claim:durable_commit', 'claim:uncertain']);
      assert.ok(!lostTrace.includes('claim:commit_ack'));
      assert.ok(!lostTrace.includes('guardrail:dispatch'));
      assert.ok(!lostTrace.includes('ordinary:dispatch'));
      assert.ok(!lostTrace.includes('guardrail:release'));
      assert.ok(!lostTrace.includes('ordinary:release'));
      assert.equal((await parentState(admin, lostRequestId)).claim_count, 1);
      stage('simulated-lost-claim-ack-holds-both-budgets-zero-fetch',
        { eventOrder: lostTrace, durableClaims: 1, providerFetches: 0 });

      for (const [key, url] of [
        ['parentAdapter', new URL('../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.ts', import.meta.url)],
        ['budgetAdmission', new URL('../../../packages/proxy/src/services/request-budget-admission.ts', import.meta.url)],
        ['parentProposal', parentProposal],
      ]) assert.equal(sha256(await readFile(url)), report.sourceSha256[key],
        `${key} changed during the native run`);
      report.status = 'PASS';
    } catch (cause) {
      error = cause;
      report.status = 'FAIL'; report.fatal = summary(cause);
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (cause) { report.cleanup = 'FAIL'; report.cleanupError = summary(cause); error ??= cause; }
      if (report.status === 'PASS' && report.cleanup === 'PASS') {
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        console.log('Native parent budget fetch evidence: ' + reportFile);
        console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
          stages: report.stages.map(value => value.name) }, null, 2));
      }
    }
    if (error) throw error;
  });

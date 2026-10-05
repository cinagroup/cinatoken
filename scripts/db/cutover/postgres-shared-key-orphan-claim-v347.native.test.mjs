// Review-only, owned PG18.6 negative fixture. A quote claim is durable before
// egress; neither its age nor its presence proves a send or billable usage.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';
import { claimPostgresSharedKeyQuoteAttempt,
  createSharedKeyQuoteAttemptCapture } from '../../../packages/proxy/src/services/shared-key-quote-attempt.ts';
import { failoverDispatch } from '../../../packages/proxy/src/services/failover-dispatch.ts';
import { RequestBudgetAdmissionError } from '../../../packages/proxy/src/services/request-budget-admission.ts';
import { GatewayErrorCode } from '../../../packages/proxy/src/services/gateway-error-codes.ts';
import { RequestExecutionStoppedError } from '../../../packages/proxy/src/services/request-deadline.ts';
import { EMPTY_USAGE } from '../../../packages/proxy/src/services/proxy.ts';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const economic = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const quoteProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url);
const attemptProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url);
const outboxProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null,
  constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 350) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-orphan-v347-${label}` } });
}

async function install(sql, body, activation) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL cinatoken.${activation} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

const route = {
  targetId: 'orphan-target', modelSurfaceId: null, routePoolId: 'orphan-pool',
  providerId: 'orphan-provider', providerName: 'orphan-provider',
  providerModelName: 'orphan-model', upstreamProtocol: 'openai',
  upstreamOperation: 'chat', adapter: 'passthrough',
  providerEndpoints: { openai: { base: 'https://example.invalid/v1' } },
  providerApiKey: 'synthetic-secret', providerSharedChannelType: null,
  priceOverrideRaw: null, routeMeteredProfileJson: null,
  routeChargedProfileJson: null, customParams: null, routingMetadata: null,
  routeGroup: 'default', routePriority: 0, routeWeight: 1,
  providerKeyId: 'sharedkey:orphan-key', providerKeyLabel: 'orphan-key',
  providerKeyFingerprint: 'synthetic-fingerprint',
};
const dispatchOptions = { affinityKey: 'orphan-request', tierKeyPrefix: 'orphan-tier',
  strategy: 'weight_priority', delegateBeforeUpstreamDispatchToDriver: true };

test('native PG18 quote claims survive pre-send errors and post-send loss without economic facts',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-shared-key-orphan-claim-v347-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion,
      scope: 'owned PG18.6; PG73 + review-only quote/claim/outbox; synthetic identities only',
      stages: [], sourceSha256: {}, limitations: [
        'No durable pre-send admission or physical send observation is written by this quote claim.',
        'The test deliberately abandons the request-local recorder after selected dispatch paths; it does not assert all normal Chat responses are orphaned.',
        'No buyer charge, provider cost, seller earning, recovery settlement, Workers/Hyperdrive or production activation is performed.',
        'A scan cutoff is not a commit-safe cursor: a claim can commit after a scan with a pre-cutoff claimed_at.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const producerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${producerPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, cinatoken_gateway_shared_quote_attempt_producer;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const producer = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', producerPassword, 'producer');
      const producer2 = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', producerPassword, 'producer2');
      clients.push(migrator, producer, producer2);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      stage('formal-pg73-installed', { migrations: files.length });
      const quoteBody = await readFile(quoteProposal, 'utf8');
      const attemptBody = await readFile(attemptProposal, 'utf8');
      const outboxBody = await readFile(outboxProposal, 'utf8');
      report.sourceSha256 = { formalMigrationCorpus: sha(corpus.join('\n')),
        quoteProposal: sha(quoteBody), attemptProposal: sha(attemptBody),
        outboxProposal: sha(outboxBody),
        nativeTest: sha(await readFile(new URL(import.meta.url))) };
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(quoteBody).simple();
      });
      await install(migrator, attemptBody, 'shared_quote_attempt_activation');
      await install(migrator, outboxBody, 'shared_key_economic_outbox_activation');
      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email)
        VALUES ('orphan-seller','seller@example.invalid');
        INSERT INTO ${gateway}.shared_keys
        (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
        VALUES ('orphan-key','orphan-seller','openai','synthetic-key','synthetic-fp','active');
        INSERT INTO ${quotes}.shared_key_quote_versions
        (version_id,shared_key_id,seller_user_id,input_price_per_million,
          output_price_per_million,cache_read_price_per_million,
          cache_write_price_per_million,commission_rate,currency,price_unit,
          billing_mode,entitlement_version)
        VALUES ('orphan-version','orphan-key','orphan-seller',1.25,2.5,0.1,0.2,
          0.1,'USD','per_million_tokens','shared_seller_key','synthetic-entitlement');
        INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('orphan-transition','orphan-key',NULL,'activate',
          'orphan-version','orphan-seller');`).simple();
      stage('review-only-quote-claim-and-outbox-installed-with-synthetic-head');

      const capture = id => createSharedKeyQuoteAttemptCapture(id,
        attempt => claimPostgresSharedKeyQuoteAttempt(producer, attempt));
      const absent = async id => {
        const row = (await migrator.unsafe(`SELECT
          (SELECT count(*)::int FROM ${gateway}.api_key_request_logs WHERE id=$1) AS logs,
          (SELECT count(*)::int FROM ${economic}.shared_key_economic_events
            WHERE request_log_id=$1) AS events,
          (SELECT count(*)::int FROM ${gateway}.shared_key_earnings
            WHERE request_log_id=$1) AS legacy_earnings`, [id]))[0];
        assert.deepEqual(row, { logs: 0, events: 0, legacy_earnings: 0 });
      };
      let sends = 0;
      const denied = capture('orphan-budget-denied');
      const deniedResult = await failoverDispatch({}, [route], 'openai',
        async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
          await beforeFetch?.(); sends++;
          return { response: new Response('unexpected'),
            usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
        }, undefined, { ...dispatchOptions, quoteAttemptCapture: denied,
          beforeUpstreamDispatch: async () => { throw new RequestBudgetAdmissionError({
            code: GatewayErrorCode.budgetExceeded, message: 'Synthetic denial' }); } });
      assert.equal(deniedResult.response.status, 402);
      assert.equal(sends, 0);
      assert.deepEqual(denied.handoff().transport.map(x => x.stage), ['claimed_only']);
      await absent('orphan-budget-denied');
      stage('post-claim-budget-denial-is-pre-send-and-has-no-durable-economic-fact');

      const localFailure = capture('orphan-local-error');
      await assert.rejects(failoverDispatch({}, [route], 'openai',
        async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
          await beforeFetch?.(); sends++;
          return { response: new Response('unexpected'),
            usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
        }, undefined, { ...dispatchOptions, quoteAttemptCapture: localFailure,
          beforeUpstreamDispatch: async () => { throw new Error('synthetic durable admission failure'); } }),
      /synthetic durable admission failure/);
      assert.equal(sends, 0);
      assert.deepEqual(localFailure.handoff().transport.map(x => x.stage), ['claimed_only']);
      await absent('orphan-local-error');
      stage('post-claim-local-exception-bubbles-before-recorder-and-leaves-reference');

      const unknownAck = createSharedKeyQuoteAttemptCapture('orphan-ack-unknown',
        async attempt => {
          // The database COMMIT happened, but the caller did not receive a
          // usable acknowledgement. It must stop rather than send or retry.
          await claimPostgresSharedKeyQuoteAttempt(producer, attempt);
          throw new Error('synthetic lost commit acknowledgement');
        });
      await assert.rejects(failoverDispatch({}, [route], 'openai',
        async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
          await beforeFetch?.(); sends++;
          return { response: new Response('unexpected'),
            usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
        }, undefined, { ...dispatchOptions, quoteAttemptCapture: unknownAck,
          beforeUpstreamDispatch: async () => {} }),
      /synthetic lost commit acknowledgement/);
      assert.equal(sends, 0);
      assert.equal(unknownAck.references().length, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts
        WHERE request_log_id='orphan-ack-unknown'`))[0].n, 1);
      await absent('orphan-ack-unknown');
      stage('commit-acknowledgement-loss-leaves-durable-claim-with-no-request-local-reference');

      const timeout = capture('orphan-after-send-timeout');
      await assert.rejects(failoverDispatch({}, [route], 'openai',
        async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
          await beforeFetch?.(); sends++;
          throw new RequestExecutionStoppedError('deadline_exceeded');
        }, undefined, { ...dispatchOptions, quoteAttemptCapture: timeout,
          beforeUpstreamDispatch: async () => {} }), RequestExecutionStoppedError);
      assert.equal(sends, 1);
      assert.deepEqual(timeout.handoff().transport.map(x => x.stage), ['transport_ambiguous']);
      await absent('orphan-after-send-timeout');
      stage('post-permit-deadline-leaves-ambiguous-claim-without-log-or-event');

      const lostRecorder = capture('orphan-after-headers');
      const response = await failoverDispatch({}, [route], 'openai',
        async (_candidate, _signal, _timing, _attempt, beforeFetch, _aux, headers) => {
          await beforeFetch?.(); sends++; headers?.(200);
          return { response: new Response('synthetic provider result', { status: 200 }),
            usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
        }, undefined, { ...dispatchOptions, quoteAttemptCapture: lostRecorder,
          beforeUpstreamDispatch: async () => {} });
      assert.equal(response.response.status, 200);
      assert.equal(sends, 2);
      assert.deepEqual(lostRecorder.handoff().transport.map(x => x.stage), ['upstream_headers_observed']);
      // Simulate process loss before its request-local background recorder runs.
      await absent('orphan-after-headers');
      stage('observed-200-still-has-no-persisted-send-usage-or-economic-event-after-recorder-loss');

      const ids = ['orphan-budget-denied', 'orphan-local-error', 'orphan-ack-unknown',
        'orphan-after-send-timeout', 'orphan-after-headers'];
      const census = await migrator.unsafe(`SELECT a.request_log_id,
          count(*)::int AS attempts,
          bool_and(l.id IS NULL AND e.event_id IS NULL) AS no_settlement
        FROM ${quotes}.shared_key_dispatch_quote_attempts a
        LEFT JOIN ${gateway}.api_key_request_logs l ON l.id=a.request_log_id
        LEFT JOIN ${economic}.shared_key_economic_events e ON e.request_log_id=a.request_log_id
        WHERE a.request_log_id LIKE 'orphan-%'
        GROUP BY a.request_log_id ORDER BY a.request_log_id`);
      assert.deepEqual(census.map(x => x.request_log_id).sort(), [...ids].sort());
      assert.ok(census.every(x => x.attempts === 1 && x.no_settlement === true));
      stage('migrator-census-finds-all-unsettled-claims-without-classifying-send-or-charge',
        { claims: census.length });

      let releaseHeld;
      let didInsert;
      const held = new Promise(resolve => { didInsert = resolve; });
      const release = new Promise(resolve => { releaseHeld = resolve; });
      const heldId = randomUUID();
      const heldTx = producer2.begin(async tx => {
        await tx.unsafe(`SELECT * FROM ${quotes}.claim_shared_key_dispatch_quote_attempt(
          $1::uuid,'orphan-late-commit',1,'orphan-key','orphan-target')`, [heldId]);
        didInsert();
        await release;
      });
      await held;
      const cutoff = (await migrator.unsafe('SELECT clock_timestamp() AS cutoff'))[0].cutoff;
      const before = await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts
        WHERE request_log_id='orphan-late-commit' AND claimed_at <= $1`, [cutoff]);
      assert.equal(before[0].n, 0);
      releaseHeld();
      await heldTx;
      const after = await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts
        WHERE request_log_id='orphan-late-commit' AND claimed_at <= $1`, [cutoff]);
      assert.equal(after[0].n, 1);
      await absent('orphan-late-commit');
      stage('late-commit-claim-crosses-claimed-at-watermark-and-requires-rescan');

      await assert.rejects(migrator.unsafe(`INSERT INTO ${economic}.shared_key_economic_events
        (event_id,request_log_id,event_type,event_version,buyer_user_id,
          buyer_api_key_id,workspace_id,buyer_charge_basis,buyer_usage_certainty,
          buyer_charged_cost,buyer_budget_charged_micros,buyer_input_tokens,
          buyer_output_tokens,buyer_cache_read_tokens,buyer_cache_write_tokens,
          attempt_count,event_certainty)
        VALUES ('orphan-after-headers','orphan-after-headers',
          'shared_key_usage_settled',1,'imaginary-buyer','imaginary-api-key',
          'imaginary-workspace','none','unknown',0,0,0,0,0,0,1,'unresolved')`),
      error => error?.code === '23514'
        && error?.constraint_name === 'shared_key_economic_log_required');
      await absent('orphan-after-headers');
      stage('event-writer-rejects-retroactive-no-log-orphan-adoption');

      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL'; report.error = errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorInfo(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key orphan claim report: ' + reportPath);
    }
    if (failure) throw failure;
  });

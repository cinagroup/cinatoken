// Review-only PG18.6 fixture. Fresh owned loopback cluster and synthetic facts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '@octafuse/core';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { createPostgresRepositories } from '../../../packages/core/src/storage/repositories-postgres.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { EMPTY_USAGE } from '../../../packages/proxy/src/services/proxy.ts';
import { handleChatCompletion } from '../../../packages/proxy/src/routes/v1/chat.ts';
import { drainNodeBackgroundWork } from '../../../packages/proxy/src/runtime/schedule-background-work.ts';
import {
  claimPostgresSharedKeyQuoteAttempt,
  createPostgresSharedKeyEconomicProducer,
  createSharedKeyQuoteAttemptCapture,
} from '../../../packages/proxy/src/services/shared-key-quote-attempt.ts';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const outbox = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation'],
];
const buyerSuccessors = [
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation'],
  ['buyer-critical-writer-privilege-split-v346.sql', 'buyer_settlement_privilege_split'],
  ['shared-key-economic-producer-buyer-login-v347.sql',
    'shared_key_economic_buyer_login_activation'],
];
const sha = value => createHash('sha256').update(value).digest('hex');
const client = (cluster, username, password, label) => postgres({
  host: '127.0.0.1', port: cluster.port, database: 'postgres',
  username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
  connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
  onnotice() {}, connection: { application_name: `cinatoken-economic-producer-v2-aggregate-proof-${label}` },
});
async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause?.code, code, String(cause));
    if (constraint) assert.equal(cause?.constraint_name, constraint, String(cause));
    return true;
  });
}
function outcome(id, claim, overrides = {}) {
  return { attemptId: claim.attempt_id, requestLogId: id,
    attemptIndex: claim.attempt_index, sharedKeyId: claim.shared_key_id,
    transitionId: claim.transition_id, quoteVersionId: claim.quote_version_id,
    usageCertainty: 'actual', inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    providerCostCertainty: 'actual', providerCostMicros: 2000,
    evidenceKind: 'provider_usage', evidenceSha256: 'a'.repeat(64),
    observedAtIso: new Date().toISOString(), ...overrides };
}
function charge(id, attempt, { version = 2, basis = 'actual',
  mode, chargedCost = 0.01 } = {}) {
  const params = chargeParams(id, chargedCost);
  params.requestLog = { ...params.requestLog, userId: 'v2-buyer',
    apiKeyId: 'v2-api-key', workspaceId: 'v2-workspace',
    inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  params.userId = 'v2-buyer';
  params.beforeSpent = 0;
  params.audit = { ...params.audit, apiKeyId: 'v2-api-key', beforeSpent: 0 };
  if (mode) params.userBudgetSettlement = { requestId: id,
    mode, reason: `fixture-${mode}` };
  params.economicOutbox = {
    ...(version === 2 ? { eventVersion: 2 } : {}),
    buyerChargeBasis: basis,
    buyerUsageCertainty: basis === 'reserved' ? 'unknown' : 'actual',
    attempts: [attempt],
  };
  return params;
}
function payload(attempts) {
  return JSON.stringify(attempts.map(a => ({ attempt_id: a.attemptId,
    attempt_index: a.attemptIndex, shared_key_id: a.sharedKeyId,
    transition_id: a.transitionId, quote_version_id: a.quoteVersionId,
    usage_certainty: a.usageCertainty, input_tokens: a.inputTokens,
    output_tokens: a.outputTokens, cache_read_tokens: a.cacheReadTokens,
    cache_write_tokens: a.cacheWriteTokens,
    provider_cost_certainty: a.providerCostCertainty,
    provider_cost_micros: a.providerCostMicros, evidence_kind: a.evidenceKind,
    evidence_sha256: a.evidenceSha256, observed_at: a.observedAtIso })));
}
function endpointPricing() {
  return {
    id: 'fixture-endpoint-v2', modelId: 'fixture/model', providerId: 'fixture-provider',
    providerSlug: 'openai', selectorSlug: 'openai', endpointClass: 'standard',
    region: null, contextLength: 128000, maxPromptTokens: null,
    maxCompletionTokens: 8192, quantization: null, supportedParameters: [],
    pricing: { currency: 'USD', prompt: '0.000001', completion: '0.000001' },
    capabilities: { implicit_caching: null, voice_cloning: null,
      tool_choice: { auto: true, function: true, none: true, required: true } },
    imageCapabilities: null, evidenceUrl: 'https://evidence.example/fixture-endpoint-v2',
    verifiedBy: 'fixture', verifiedAt: '2026-09-25T00:00:00.000Z',
    expiresAt: '2027-09-25T00:00:00.000Z',
  };
}

test('native PG18 v2 aggregate-proof activation successor preserves economic producer contracts',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-economic-producer-v2-aggregate-proof-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Successor supplies the current exact aggregate budget-proof opt-in for the original budget-denied Chat case; production gates and role grants are unchanged.',
        'The predecessor sent-unknown/non-shared-actual case is a rejection under the current guard. A distinct claim-only shared attempt supplies the legal actual-debit positive; 20 stages replace the historical 19-stage scope.',
        'The recordUsage adapter is review-only and is not bound to shipped app activation.',
        'The local direct buyer LOGIN does not prove Workers or Hyperdrive transaction identity.',
        'The owned 402 wire fixture temporarily grants the old runtime ordinary-admission columns, then revokes and verifies them; a dedicated production admission identity is still an open gate.',
        'This combined regression installs v344 after earlier synthetic v2 compatibility events; a production cutover must install the receipt before any v2 traffic and separately review historical synthetic rows.',
        'The adapter-stage provider usage is synthetic and its provider cost stays unknown.',
        'Early returns, terminal failures and unverified non-shared usage are not yet durably settled.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const buyerPassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${buyerPassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE ROLE producer_v2_acl_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement,
          cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const buyer = client(cluster, 'cinatoken_gateway_buyer_settlement',
        buyerPassword, 'buyer');
      const quoteProducer = client(cluster,
        'cinatoken_gateway_shared_quote_attempt_producer', quotePassword, 'quote');
      clients.push(migrator, runtime, buyer, quoteProducer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const formal = await listPg73Migrations();
      assert.equal(formal.length, 73);
      const corpus = [];
      for (const name of formal) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(name + '\n' + body);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha(corpus.join('\n'));
      stage('formal-pg73-installed');
      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${gateway} TO cinatoken_gateway_runtime;
        GRANT SELECT, UPDATE ON ${gateway}.api_keys,${gateway}.users,
          ${gateway}.guardrail_budget_windows TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT ON ${gateway}.api_key_request_logs
          TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.system_config TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.public_model_daily_stats
          TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.guardrail_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT SELECT, UPDATE ON ${gateway}.user_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT INSERT ON ${gateway}.user_audit_logs,
          ${gateway}.provider_attempt_availability TO cinatoken_gateway_runtime;`).simple();
      const bodies = [];
      for (const [name] of proposals) {
        const body = await readFile(new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,
          import.meta.url), 'utf8');
        report.sourceSha256[name] = sha(body);
        bodies.push(body);
      }
      report.sourceSha256.criticalWriter = sha(await readFile(new URL(
        '../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)));
      report.sourceSha256.outboxInputTypes = sha(await readFile(new URL(
        '../../../packages/core/src/db/shared-key-economic-outbox-types.ts', import.meta.url)));
      report.sourceSha256.nativeTest = sha(await readFile(new URL(import.meta.url)));
      report.sourceSha256.predecessorNative = sha(await readFile(new URL(
        './postgres-shared-key-economic-producer-v2.native.test.mjs', import.meta.url)));
      report.sourceSha256.aggregateBudgetProof = sha(await readFile(new URL(
        '../../../packages/proxy/src/services/authenticated-chat-budget-proof.ts', import.meta.url)));
      report.sourceSha256.coreNodeBundle = sha(await readFile(new URL(
        '../../../packages/core/dist/index.js', import.meta.url)));
      report.sourceSha256.usageTracker = sha(await readFile(new URL(
        '../../../packages/proxy/src/services/usage-tracker.ts', import.meta.url)));
      report.sourceSha256.quoteAttemptBridge = sha(await readFile(new URL(
        '../../../packages/proxy/src/services/shared-key-quote-attempt.ts', import.meta.url)));
      report.sourceSha256.providerUsageFacts = sha(await readFile(new URL(
        '../../../packages/proxy/src/services/provider-usage-facts.ts', import.meta.url)));
      report.sourceSha256.chatRoute = sha(await readFile(new URL(
        '../../../packages/proxy/src/routes/v1/chat.ts', import.meta.url)));
      report.sourceSha256.failoverDispatch = sha(await readFile(new URL(
        '../../../packages/proxy/src/services/failover-dispatch.ts', import.meta.url)));
      for (let i = 0; i < proposals.length - 1; i++) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${proposals[i][1]} = 'reviewed-${i === 0 ? 'v2' : 'v1'}'`);
          await tx.unsafe(bodies[i]).simple();
        });
      }
      stage('quote-dispatch-v1-producer-consumer-and-v2-debit-installed');
      const activate = () => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-1)[1]} = 'reviewed-v1'`);
        await tx.unsafe(bodies.at(-1)).simple();
      });
      await assert.rejects(migrator.begin(tx => tx.unsafe(bodies.at(-1)).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER FUNCTION ${outbox}.write_shared_key_economic_event(
          text,text,text,jsonb,text) SECURITY INVOKER`);
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-1)[1]} = 'reviewed-v1'`);
        await tx.unsafe(bodies.at(-1)).simple();
      }), /activation or dependency differs/u);
      stage('default-off-and-v1-producer-catalog-drift-roll-back-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT EXECUTE ON FUNCTIONS TO producer_v2_acl_probe;`).simple();
      await assert.rejects(activate(), /default ACL differs/u);
      assert.equal((await migrator.unsafe(`SELECT to_regprocedure(
        '${outbox}.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)')
        IS NULL AS absent`))[0].absent, true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE EXECUTE ON FUNCTIONS FROM producer_v2_acl_probe;`).simple();
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT SELECT ON TABLES TO producer_v2_acl_probe;`).simple();
      await assert.rejects(activate(), /default ACL differs/u);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE SELECT ON TABLES FROM producer_v2_acl_probe;`).simple();
      stage('third-role-default-function-and-table-grants-roll-back-install');
      await activate();
      const producer = `${outbox}.write_shared_key_economic_event_v2`;
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_economic_events`),
        '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_buyer_settlement_tx_markers`),
        '42501');
      stage('v2-producer-installed-with-execute-only-privilege');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('v2-seller','seller-v2@example.invalid'),
          ('v2-buyer','buyer-v2@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('v2-workspace','personal','v2-buyer','Default','default',
            true,'personal:v2-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('v2-api-key','synthetic-key','v2-buyer','v2-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('v2-key','v2-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('v2-seller');
        INSERT INTO ${quotes}.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('v2-q1','v2-key','v2-seller',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v1');
        INSERT INTO ${quotes}.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('v2-t1','v2-key',NULL,'activate','v2-q1','v2-seller');`).simple();
      const claim = async id => (await quoteProducer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,1,'v2-key','synthetic-target')`,
      [randomUUID(), id]))[0];
      const db = { driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }) };
      const eventRow = async id => (await migrator.unsafe(`SELECT
        event_version,buyer_charge_basis,buyer_budget_charged_micros::text AS guardrail,
        buyer_debit_micros::text AS debit FROM ${outbox}.shared_key_economic_events
        WHERE event_id=$1`, [id]))[0];
      const spent = async () => (await migrator.unsafe(`SELECT budget_spent::text AS spent
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].spent;
      stage('fixture-identities-and-pinned-quote-installed');

      const actualId = `v2-${randomUUID()}`;
      const actual = outcome(actualId, await claim(actualId));
      const actualInput = charge(actualId, actual);
      await insertRequestUsageAndChargeTxPg(db, actualInput);
      await insertRequestUsageAndChargeTxPg(db, actualInput);
      assert.deepEqual(await eventRow(actualId), {
        event_version: 2, buyer_charge_basis: 'actual',
        guardrail: '10000', debit: '10000',
      });
      assert.equal(await spent(), '0.010000');
      stage('v2-actual-debit-and-idempotent-critical-writer-replay');

      const reservedId = `v2-${randomUUID()}`;
      const reserved = outcome(reservedId, await claim(reservedId));
      await migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'v2-buyer','v2-api-key',0,1000000,
          20000,'dispatched',now()+interval '1 day',now(),now())`, [reservedId]);
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=20000 WHERE id='v2-buyer'`);
      const reservedInput = charge(reservedId, reserved,
        { basis: 'reserved', mode: 'reserved' });
      await insertRequestUsageAndChargeTxPg(db, reservedInput);
      await insertRequestUsageAndChargeTxPg(db, reservedInput);
      assert.deepEqual(await eventRow(reservedId), {
        event_version: 2, buyer_charge_basis: 'reserved',
        guardrail: '10000', debit: '20000',
      });
      assert.deepEqual((await migrator.unsafe(`SELECT state,settled_micros::text AS debit
        FROM ${gateway}.user_budget_reservations WHERE request_id=$1`, [reservedId]))[0],
      { state: 'expired', debit: '20000' });
      assert.equal(await spent(), '0.030000');
      stage('v2-reserved-ceiling-differs-from-guardrail-without-double-debit');

      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'reserved','unknown',
        10000,$2::jsonb,'verify')`, [reservedId, payload([reserved])]),
      '23514', 'shared_key_economic_producer_buyer');
      assert.equal((await runtime.unsafe(`SELECT ${producer}($1,'reserved','unknown',
        20000,$2::jsonb,'verify') AS outcome`, [reservedId, payload([reserved])]))[0].outcome,
      'verified');
      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'reserved','unknown',
        20000,$2::jsonb,'create')`, [reservedId, payload([reserved])]),
      '23514', 'shared_key_economic_producer_tx');
      stage('v2-replay-verifies-exact-debit-and-cannot-recreate-post-commit');

      const v1Id = `v1-${randomUUID()}`;
      const v1 = outcome(v1Id, await claim(v1Id));
      await insertRequestUsageAndChargeTxPg(db, charge(v1Id, v1, { version: 1 }));
      assert.deepEqual(await eventRow(v1Id), {
        event_version: 1, buyer_charge_basis: 'actual',
        guardrail: '10000', debit: null,
      });
      stage('existing-v1-five-argument-producer-still-works');

      const badId = `v2-${randomUUID()}`;
      const bad = outcome(badId, await claim(badId), { quoteVersionId: 'wrong-version' });
      await expectCode(insertRequestUsageAndChargeTxPg(db, charge(badId, bad)),
        '23514', 'shared_key_economic_producer_attempt');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [badId]))[0].n, 0);
      stage('invalid-outcome-rolls-back-buyer-log-budget-and-event');

      // The earlier v2 compatibility checks intentionally run under the old
      // runtime writer. This later chain proves the live recordUsage bridge
      // after financial writes and v2 EXECUTE move to the direct buyer LOGIN.
      for (const [name, activation] of buyerSuccessors) {
        const body = await readFile(new URL(
          `../../../packages/core/migrations-proposals/postgres/${name}`,
          import.meta.url), 'utf8');
        report.sourceSha256[name] = sha(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${activation} = 'reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      const buyerDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_spent=budget_spent+1 WHERE id='v2-buyer'`), '42501');
      stage('receipt-and-buyer-login-successors-move-financial-writes-off-runtime');

      const repositories = createPostgresRepositories(db);
      let legacyLookupCalls = 0;
      const observedRepositories = {
        ...repositories,
        sharedKeys: {
          ...repositories.sharedKeys,
          getSharedKeyById: async () => {
            legacyLookupCalls += 1;
            throw new Error('Legacy seller settlement must not run');
          },
        },
      };
      const economicAdapter = createPostgresSharedKeyEconomicProducer(buyerDb);
      const bridgeUsage = { ...EMPTY_USAGE, input_tokens: 10, output_tokens: 5,
        total_tokens: 15,
        raw_usage: '{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}' };
      const capture = id => createSharedKeyQuoteAttemptCapture(id,
        input => claimPostgresSharedKeyQuoteAttempt(quoteProducer, input));
      const claimObserved = async id => {
        const observed = capture(id);
        const selected = await observed.beforeFetch({
          providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
        });
        assert.ok(selected);
        observed.fetchBoundaryPermitted(selected);
        observed.upstreamHeadersObserved(selected, 200);
        assert.equal(await observed.observeProviderUsage(selected, bridgeUsage), true);
        return { observed, selected };
      };
      const bridgeParams = id => ({
        request_log_id: id, api_key_id: 'v2-api-key', workspace_id: 'v2-workspace',
        user_id: 'v2-buyer', user_email: 'buyer-v2@example.invalid',
        model_id: 'fixture/model', provider_id: 'fixture-provider',
        request_protocol: 'openai', request_operation: 'chat',
        upstream_protocol: 'openai', upstream_operation: 'chat',
        route_target_id: 'synthetic-target', route_group: 'default',
        status: 'success', provider_key_id: 'sharedkey:v2-key',
        endpoint_pricing_snapshot: endpointPricing(), usage: bridgeUsage,
      });
      const bridgeId = `v2-bridge-${randomUUID()}`;
      const bridge = await claimObserved(bridgeId);
      const beforeBridgeSpent = Number(await spent());
      await economicAdapter.recordUsageAndOutbox(observedRepositories,
        bridgeParams(bridgeId), bridge.observed.handoff(), bridge.selected);
      const bridgeLog = (await migrator.unsafe(`SELECT charged_cost::text AS charge,
        budget_charged_micros::text AS guardrail FROM ${gateway}.api_key_request_logs
        WHERE id=$1`, [bridgeId]))[0];
      const bridgeEvent = await eventRow(bridgeId);
      assert.ok(bridgeLog);
      assert.equal(bridgeEvent?.event_version, 2);
      assert.equal(bridgeEvent?.buyer_charge_basis, 'actual');
      assert.equal(bridgeEvent?.debit, bridgeLog.guardrail);
      assert.equal(Math.round((Number(await spent()) - beforeBridgeSpent) * 1_000_000),
        Math.round(Number(bridgeLog.charge) * 1_000_000));
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.shared_key_earnings WHERE request_log_id=$1`, [bridgeId]))[0].n, 0);
      assert.equal(legacyLookupCalls, 0);
      stage('real-record-usage-atomically-writes-buyer-log-and-v2-event-without-legacy-seller');

      const deniedId = `v2-bridge-${randomUUID()}`;
      const deniedCapture = capture(deniedId);
      const deniedReference = await deniedCapture.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(deniedReference);
      assert.deepEqual(deniedCapture.handoff().transport.map(row => row.stage),
        ['claimed_only']);
      const beforeDeniedSpent = await spent();
      await economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(deniedId), status: 'error', usage: EMPTY_USAGE,
        charge_on_error: false,
      }, deniedCapture.handoff(), deniedReference);
      assert.deepEqual(await eventRow(deniedId), {
        event_version: 2, buyer_charge_basis: 'none',
        guardrail: '0', debit: '0',
      });
      assert.deepEqual((await migrator.unsafe(`SELECT usage_certainty,
        provider_cost_certainty, input_tokens FROM
        ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1`,
      [deniedId]))[0], {
        usage_certainty: 'unknown', provider_cost_certainty: 'unknown',
        input_tokens: null,
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [deniedId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT charged_cost::text AS charged FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [deniedId]))[0].charged,
      '0.000000');
      assert.equal(await spent(), beforeDeniedSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('pre-send-budget-denial-claim-persists-v2-none-without-reservation-or-debit');

      // Route handler loopback: the ordinary user budget is exhausted before
      // reserve inserts a row. The selected quote claim must survive the 402
      // dispatch result and reach the asynchronous recordUsage bridge.
      await migrator.unsafe(`UPDATE ${gateway}.users SET budget_max=0
        WHERE id='v2-buyer'`);
      await migrator.unsafe(`GRANT SELECT ON ${gateway}.workspaces,
        ${gateway}.workspace_budgets TO cinatoken_gateway_runtime`);
      const chatRouteRow = {
        id: 'synthetic-target', model_id: 'fixture/model',
        provider_id: 'fixture-provider', provider_model_name: 'fixture-model',
        priority: 1, status: 'active', route_group: 'default', weight: 1,
        price_override: null, custom_params: null,
        upstream_protocol: 'openai', upstream_operation: 'chat',
        adapter: 'passthrough', routing_metadata: null,
      };
      const chatProviderRow = {
        id: 'fixture-provider', name: 'fixture-provider', api_key: 'synthetic-own-key',
        endpoints: JSON.stringify({ openai: { base: 'https://example.invalid/v1' } }),
        shared_channel_type: 'openai', status: 'active', description: null,
      };
      const chatEndpoint = {
        id: 'fixture-endpoint-v2', model_id: chatRouteRow.model_id,
        provider_id: chatProviderRow.id, provider_slug: 'openai', tag: 'test',
        endpoint_class: 'standard', region: null, context_length: 128000,
        max_prompt_tokens: null, max_completion_tokens: 8192,
        quantization: null, supported_parameters: '[]',
        pricing: JSON.stringify({ currency: 'USD', prompt: '0.000001',
          completion: '0.000001' }), supports_implicit_caching: false,
        supports_voice_cloning: false,
        supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
        image_capabilities: '{}', evidence_url: 'https://evidence.example/chat',
        verified_by: 'fixture', verified_at: new Date().toISOString(),
        expires_at: '2027-09-25T00:00:00.000Z', status: 'verified',
        route_target_id: 'synthetic-target',
        subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
          chatRouteRow, chatProviderRow),
      };
      const chatModel = {
        id: 'fixture/model', display_name: 'fixture/model', vendor: 'fixture',
        context_window: 128000, max_tokens: 8192, pricing_profile: null,
        tags: '[]', description: null, metadata: null,
        input_modalities: '["text"]', output_modalities: '["text"]',
        released_at: null, route_policy: '{"strategy":"weight_priority"}',
      };
      const chatSharedKey = {
        id: 'v2-key', sellerUserId: 'v2-seller', channelType: 'openai',
        apiKey: 'synthetic-upstream-key', keyFingerprint: 'synthetic-fingerprint',
        label: 'fixture', status: 'active', sellerPriority: 0, weight: 1,
        inputPrice: 1.25, outputPrice: 2.5, cacheReadPrice: 0.1,
        cacheWritePrice: 0.2, validatedAt: null, lastUsedAt: null,
        lastFailureAt: null, failureReason: null, servedInputTokens: 0,
        servedOutputTokens: 0, earnedTotal: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const chatRepositories = {
        ...observedRepositories,
        guardrails: { ...observedRepositories.guardrails,
          getEffectiveForRequest: async () => [] },
        modelRouting: { ...observedRepositories.modelRouting,
          getModelById: async id => id === chatModel.id ? chatModel : null,
          getModelRoutesByModelId: async id => id === chatModel.id
            ? [chatRouteRow] : [],
          resolveModelSurface: async () => null },
        providers: { ...observedRepositories.providers,
          getProvidersByIds: async ids => ids.includes(chatProviderRow.id)
            ? [chatProviderRow] : [] },
        modelEndpoints: { ...observedRepositories.modelEndpoints,
          listRuntimeBindingsByRouteTargetIds: async ids =>
            ids.includes(chatRouteRow.id) ? [chatEndpoint] : [] },
        routeDataPolicies: { ...observedRepositories.routeDataPolicies,
          getByRouteTargetIds: async () => [] },
        sharedKeys: { ...observedRepositories.sharedKeys,
          listActiveSharedKeysByChannel: async channel =>
            channel === 'openai' ? [chatSharedKey] : [] },
        byokKeys: { ...observedRepositories.byokKeys,
          listActiveForRequest: async () => [],
          shouldSuppressSharedCapacityForRequest: async () => false },
        requestLogs: { ...observedRepositories.requestLogs,
          getRecentRoutePerformanceSamples: async () => [],
          getRouteAvailabilityAggregates: async () => [] },
      };
      const deniedChatId = `v2-chat-${randomUUID()}`;
      // v346 removes the old runtime admission writes. The dedicated
      // admission authority is a separate open gate; lend only this owned
      // fixture the old admission columns to preserve the 402 wire proof.
      await migrator.unsafe(`GRANT INSERT,UPDATE ON ${gateway}.user_budget_reservations
        TO cinatoken_gateway_runtime;
        GRANT UPDATE (budget_reserved_micros,updated_at) ON ${gateway}.users
        TO cinatoken_gateway_runtime;`).simple();
      const chatApp = new Hono();
      chatApp.post('/v1/chat/completions', c => {
        c.set('repositories', chatRepositories);
        c.set('apiKey', {
          keyId: 'v2-api-key', apiKeyHash: 'a'.repeat(64),
          userId: 'v2-buyer', workspaceId: 'v2-workspace',
          userEmail: 'buyer-v2@example.invalid', budgetMax: 0,
          budgetSpent: Number(beforeDeniedSpent), budgetEpoch: 0,
          budgetPeriod: 'none', budgetResetAt: null,
          metadata: null, chargedCostFactors: null,
          includeByokInLimit: false,
        });
        c.set('generationId', deniedChatId);
        c.set('requestBodyLoggingMode', 'off');
        c.set('sharedKeyEconomicProducer', economicAdapter);
        return handleChatCompletion(c);
      });
      const originalFetch = globalThis.fetch;
      let upstreamSends = 0;
      let chatResponse;
      try {
        globalThis.fetch = async () => {
          upstreamSends += 1;
          throw new Error('Budget-blocked Chat must not send upstream');
        };
        chatResponse = await chatApp.request(
          'http://localhost/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'fixture/model',
              messages: [{ role: 'user', content: 'blocked before send' }],
              max_tokens: 16 }),
          }, {
            SHARED_KEY_QUOTE_ATTEMPTS_ENABLED: 'reviewed-v1',
            AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
            QUOTE_ATTEMPT_HYPERDRIVE: { connectionString:
              `postgresql://cinatoken_gateway_shared_quote_attempt_producer:${quotePassword}`
                + `@127.0.0.1:${cluster.port}/postgres?sslmode=disable` },
          });
        await drainNodeBackgroundWork();
      } finally {
        globalThis.fetch = originalFetch;
      }
      await migrator.unsafe(`REVOKE INSERT,UPDATE ON ${gateway}.user_budget_reservations
        FROM cinatoken_gateway_runtime;
        REVOKE UPDATE (budget_reserved_micros,updated_at) ON ${gateway}.users
        FROM cinatoken_gateway_runtime;`).simple();
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros+1
        WHERE id='v2-buyer'`), '42501');
      assert.equal(chatResponse.status, 402, await chatResponse.text());
      assert.equal(upstreamSends, 0);
      assert.deepEqual(await eventRow(deniedChatId), {
        event_version: 2, buyer_charge_basis: 'none',
        guardrail: '0', debit: '0',
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [deniedChatId]))[0].n, 1);
      assert.equal((await migrator.unsafe(`SELECT provider_key_id FROM
        ${gateway}.api_key_request_logs WHERE id=$1`,
      [deniedChatId]))[0].provider_key_id, 'sharedkey:v2-key');
      assert.deepEqual((await migrator.unsafe(`SELECT usage_certainty,
        provider_cost_certainty, input_tokens FROM
        ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1`,
      [deniedChatId]))[0], {
        usage_certainty: 'unknown', provider_cost_certainty: 'unknown',
        input_tokens: null,
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [deniedChatId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts WHERE request_log_id=$1`,
      [deniedChatId]))[0].n, 1);
      assert.equal(await spent(), beforeDeniedSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('real-chat-handler-budget-402-hands-claimed-only-reference-to-zero-debit-v2-event');

      const releasedId = `v2-bridge-${randomUUID()}`;
      const releasedCapture = capture(releasedId);
      const releasedReference = await releasedCapture.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(releasedReference);
      await migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'v2-buyer','v2-api-key',0,1000000,
          100,0,'released',now()+interval '1 day',now(),now())`, [releasedId]);
      const beforeReleasedSpent = await spent();
      await expectCode(economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(releasedId), status: 'error', usage: EMPTY_USAGE,
        charge_on_error: false,
      }, releasedCapture.handoff(), releasedReference),
      '23514', 'shared_key_economic_producer_buyer');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [releasedId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_events WHERE event_id=$1`, [releasedId]))[0].n, 0);
      assert.equal(await spent(), beforeReleasedSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('released-ordinary-reservation-rejects-v2-none-and-remains-open-gate');

      // Preserve the original sent-unknown input as a real production-guard
      // negative. No synthetic reserve or relaxed SQL authority legitimizes it.
      const sentUnknownId = `v2-bridge-${randomUUID()}`;
      const sentUnknown = capture(sentUnknownId);
      const sentReference = await sentUnknown.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(sentReference);
      sentUnknown.fetchBoundaryPermitted(sentReference);
      sentUnknown.upstreamHeadersObserved(sentReference, 429);
      const financialSnapshot = async () => {
        const tables = await migrator.unsafe(`SELECT n.nspname AS schema_name, c.relname AS table_name
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('${gateway}','${quotes}','${outbox}') AND c.relkind IN ('r','p')
          ORDER BY n.nspname,c.relname`);
        for (const required of [`${gateway}.users`, `${gateway}.api_keys`,
          `${gateway}.api_key_request_logs`, `${gateway}.user_budget_reservations`,
          `${gateway}.user_audit_logs`, `${gateway}.shared_key_earnings`,
          `${gateway}.user_earnings`, `${gateway}.portal_ledger_entries`,
          `${outbox}.shared_key_economic_events`, `${outbox}.shared_key_economic_event_attempts`])
          assert.ok(tables.some(row => `${row.schema_name}.${row.table_name}` === required), required);
        const images = [];
        for (const row of tables) {
          const quoted = value => '"' + value.replaceAll('"', '""') + '"';
          const [image] = await migrator.unsafe(`SELECT md5(COALESCE(string_agg(
            row_to_json(snapshot_row)::text, E'\\n' ORDER BY row_to_json(snapshot_row)::text),'')) AS digest
            FROM ${quoted(row.schema_name)}.${quoted(row.table_name)} snapshot_row`);
          images.push({ schema: row.schema_name, table: row.table_name, digest: image.digest });
        }
        return images;
      };
      const beforeSentUnknown = await financialSnapshot();
      await assert.rejects(economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(sentUnknownId),
        provider_key_id: 'provider-key:private',
        route_target_id: 'synthetic-nonshared',
      }, sentUnknown.handoff(), null),
      { message: 'Potentially billable unknown shared-key attempt requires reserved buyer debit' });
      assert.deepEqual(await financialSnapshot(), beforeSentUnknown);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts WHERE request_log_id=$1`, [sentUnknownId]))[0].n, 1);
      assert.equal(legacyLookupCalls, 0);
      stage('sent-unknown-shared-attempt-rejects-unreserved-nonshared-actual-without-financial-mutation',
        { allManagedTableImagesUnchanged: true, tableImages: beforeSentUnknown.length,
          earlierSharedTransport: 'upstream_headers_observed', httpStatus: 429 });

      // A separate quoted attempt that has not passed the fetch permit can stay
      // unknown while actual usage belongs to a later non-shared route.
      const nonSharedId = `v2-bridge-${randomUUID()}`;
      assert.notEqual(nonSharedId, sentUnknownId);
      const earlierShared = capture(nonSharedId);
      const earlierReference = await earlierShared.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(earlierReference);
      assert.equal(earlierShared.handoff().transport[0]?.stage, 'claimed_only');
      assert.equal(earlierShared.handoff().transport[0]?.upstreamHttpStatus, null);
      const beforeNonSharedSpent = Number(await spent());
      await economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(nonSharedId),
        provider_key_id: 'provider-key:private',
        route_target_id: 'synthetic-nonshared',
      }, earlierShared.handoff(), null);
      const nonSharedEvent = await eventRow(nonSharedId);
      assert.equal(nonSharedEvent?.buyer_charge_basis, 'actual');
      const [nonSharedLog] = await migrator.unsafe(`SELECT charged_cost::text AS charge,
        budget_charged_micros::text AS guardrail, provider_key_id, route_target_id,
        input_tokens,output_tokens FROM ${gateway}.api_key_request_logs WHERE id=$1`, [nonSharedId]);
      assert.ok(nonSharedLog);
      assert.equal(nonSharedLog.provider_key_id, 'provider-key:private');
      assert.equal(nonSharedLog.route_target_id, 'synthetic-nonshared');
      assert.equal(nonSharedLog.input_tokens, 10);
      assert.equal(nonSharedLog.output_tokens, 5);
      assert.equal(nonSharedLog.charge, '0.000015');
      assert.equal(nonSharedEvent.debit, '15');
      assert.equal(nonSharedEvent.guardrail, nonSharedLog.guardrail);
      assert.equal(Math.round((Number(await spent()) - beforeNonSharedSpent) * 1_000_000), 15);
      assert.deepEqual((await migrator.unsafe(`SELECT usage_certainty,
        provider_cost_certainty FROM ${outbox}.shared_key_economic_event_attempts
        WHERE event_id=$1`, [nonSharedId]))[0], {
        usage_certainty: 'unknown', provider_cost_certainty: 'unknown',
      });
      assert.equal(legacyLookupCalls, 0);
      stage('non-shared-terminal-buyer-actual-preserves-earlier-shared-unknown',
        { earlierSharedTransport: 'claimed_only', distinctFromSentUnknown: true,
          buyerDebitMicros: 15, observedBuyerCounterDeltaMicros: 15 });

      const zeroId = `v2-bridge-${randomUUID()}`;
      const zeroCapture = capture(zeroId);
      const zeroReference = await zeroCapture.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(zeroReference);
      zeroCapture.fetchBoundaryPermitted(zeroReference);
      zeroCapture.upstreamHeadersObserved(zeroReference, 200);
      const zeroUsage = { ...EMPTY_USAGE,
        raw_usage: '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}' };
      assert.equal(await zeroCapture.observeProviderUsage(zeroReference, zeroUsage), true);
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_max=1 WHERE id='v2-buyer'`);
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,1000000,
            100,'dispatched',now()+interval '1 day',now(),now())`, [zeroId]);
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros+100
          WHERE id='v2-buyer'`);
      });
      const beforeZeroSpent = await spent();
      await economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(zeroId), usage: zeroUsage,
        ordinary_budget_settlement: {
          requestId: zeroId, budgetEpoch: 0,
          reservedMicros: 100, unknownCost: false,
        },
      }, zeroCapture.handoff(), zeroReference);
      assert.deepEqual(await eventRow(zeroId), {
        event_version: 2, buyer_charge_basis: 'actual',
        guardrail: '0', debit: '0',
      });
      assert.deepEqual((await migrator.unsafe(`SELECT state,
        settled_micros::text AS settled FROM ${gateway}.user_budget_reservations
        WHERE request_id=$1`, [zeroId]))[0], {
        state: 'settled', settled: '0',
      });
      assert.equal(await spent(), beforeZeroSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('provider-reported-zero-settles-ordinary-reservation-as-actual-zero');

      const rollbackId = `v2-bridge-${randomUUID()}`;
      const rollback = await claimObserved(rollbackId);
      const original = rollback.observed.handoff();
      const wrongReference = { ...rollback.selected, quoteVersionId: 'wrong-version' };
      const wrongHandoff = {
        quoteAttempts: [wrongReference],
        transport: [{ ...original.transport[0], reference: wrongReference }],
        economicOutcomes: [{ ...original.economicOutcomes[0],
          quoteVersionId: 'wrong-version' }],
      };
      const beforeRollbackSpent = await spent();
      await expectCode(economicAdapter.recordUsageAndOutbox(observedRepositories,
        bridgeParams(rollbackId), wrongHandoff, wrongReference),
      '23514', 'shared_key_economic_producer_attempt');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [rollbackId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_events WHERE event_id=$1`, [rollbackId]))[0].n, 0);
      assert.equal(await spent(), beforeRollbackSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('real-record-usage-failed-event-rolls-back-buyer-and-never-runs-legacy-seller');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 3500) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(`economic-producer-v2-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

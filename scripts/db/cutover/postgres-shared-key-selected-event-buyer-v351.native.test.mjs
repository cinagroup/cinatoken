// Review-only PG18.6 fixture. Fresh owned loopback cluster and synthetic facts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '@octafuse/core';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { createPostgresRepositories } from '../../../packages/core/src/storage/repositories-postgres.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
import { EMPTY_USAGE } from '../../../packages/proxy/src/services/proxy.ts';
import {
  GATEWAY_ERROR_CODE_HEADER,
  GatewayErrorCode,
} from '../../../packages/proxy/src/services/gateway-error-codes.ts';
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
  onnotice() {}, connection: { application_name: `cinatoken-economic-producer-v2-${label}` },
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

test('v351 selected shared-key gate composes with real buyer LOGIN recordUsage producer',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-selected-event-buyer-v351-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'The v351 gate is review-only; no deployed Worker path or real Hyperdrive identity is exercised.',
        'The selected ID belongs to a typed attempt but is not proven to be the final route outcome by this database gate.',
        'The v357 overlay pins an exact selected attempt in the buyer log, but only the credential holder can prove which route was physically sent.',
        'Earlier shared-key sends with a non-shared final provider key still rely on the v339 quote claim and pre-send pool gate.',
        'The recordUsage adapter is review-only and is not bound to shipped app activation.',
        'The local direct buyer LOGIN does not prove Workers or Hyperdrive transaction identity.',
        'The owned 402 wire fixture temporarily grants the old runtime ordinary-admission columns, then revokes and verifies them; a dedicated production admission identity is still an open gate.',
        'This combined regression installs v344 after earlier synthetic v2 compatibility events; a production cutover must install the receipt before any v2 traffic and separately review historical synthetic rows.',
        'The adapter-stage provider usage is synthetic and its provider cost stays unknown.',
        'Early returns, terminal failures and unverified non-shared usage are not yet durably settled.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
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
      const formal = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
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
      const selectedGateName = 'shared-key-selected-event-gate-v351.sql';
      const selectedGate = await readFile(new URL(
        `../../../packages/core/migrations-proposals/postgres/${selectedGateName}`,
        import.meta.url), 'utf8');
      report.sourceSha256[selectedGateName] = sha(selectedGate);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_selected_event_gate_activation = 'reviewed-v1'");
        await tx.unsafe(selectedGate).simple();
      });
      stage('selected-shared-key-event-gate-installs-after-buyer-login-successors');
      const buyerDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_spent=budget_spent+1 WHERE id='v2-buyer'`), '42501');
      stage('receipt-and-buyer-login-successors-move-financial-writes-off-runtime');

      const legacySelectedId = `selected-legacy-${randomUUID()}`;
      const legacySelected = chargeParams(legacySelectedId, 0.01);
      legacySelected.requestLog = { ...legacySelected.requestLog,
        userId: 'v2-buyer', apiKeyId: 'v2-api-key', workspaceId: 'v2-workspace',
        providerKeyId: 'sharedkey:v2-key' };
      legacySelected.userId = 'v2-buyer';
      legacySelected.audit = { ...legacySelected.audit,
        apiKeyId: 'v2-api-key', beforeSpent: Number(await spent()) };
      const beforeLegacySpent = await spent();
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb, legacySelected),
        '23514', 'shared_key_selected_event_required_v351');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [legacySelectedId]))[0].n, 0);
      assert.equal(await spent(), beforeLegacySpent);
      stage('real-buyer-critical-writer-without-outbox-cannot-commit-selected-shared-log');

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
      assert.equal((await migrator.unsafe(`SELECT provider_key_id FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [bridgeId]))[0].provider_key_id,
      'sharedkey:v2-key');
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
      // v346 removes the old runtime admission writes. The dedicated
      // admission authority is a separate open gate; lend only this owned
      // fixture the old admission columns to preserve the 402 wire proof.
      await migrator.unsafe(`GRANT INSERT,UPDATE ON ${gateway}.user_budget_reservations
        TO cinatoken_gateway_runtime;
        GRANT UPDATE (budget_reserved_micros,updated_at) ON ${gateway}.users
        TO cinatoken_gateway_runtime;`).simple();
      const chatHandoffs = new Map();
      const observingEconomicAdapter = {
        async recordUsageAndOutbox(repos, usage, handoff, selectedReference) {
          chatHandoffs.set(usage.request_log_id, { handoff, selectedReference });
          return economicAdapter.recordUsageAndOutbox(
            repos, usage, handoff, selectedReference);
        },
      };
      const chatApp = new Hono();
      chatApp.post('/v1/chat/completions', c => {
        c.set('repositories', chatRepositories);
        c.set('apiKey', {
          keyId: 'v2-api-key', apiKeyHash: 'a'.repeat(64),
          userId: 'v2-buyer', workspaceId: 'v2-workspace',
          userEmail: 'buyer-v2@example.invalid', budgetMax: chatBudgetMax,
          budgetSpent: Number(beforeDeniedSpent), budgetEpoch: 0,
          budgetPeriod: 'none', budgetResetAt: null,
          metadata: null, chargedCostFactors: null,
          includeByokInLimit: false,
        });
        c.set('generationId', deniedChatId);
        c.set('requestBodyLoggingMode', 'off');
        c.set('sharedKeyEconomicProducer', observingEconomicAdapter);
        return handleChatCompletion(c);
      });
      const originalFetch = globalThis.fetch;
      let upstreamSends = 0;
      let deniedChatId;
      let chatBudgetMax;
      const originalChatPricing = chatEndpoint.pricing;
      try {
        globalThis.fetch = async () => {
          upstreamSends += 1;
          throw new Error('Budget-blocked Chat must not send upstream');
        };
        for (const scenario of [
          { name: 'exhausted-finite', budgetMax: 0, zeroQuote: false },
          { name: 'unlimited', budgetMax: null, zeroQuote: false },
          { name: 'zero-aggregate-quote', budgetMax: 1, zeroQuote: true },
        ]) {
          deniedChatId = `v2-chat-${randomUUID()}`;
          chatBudgetMax = scenario.budgetMax;
          chatEndpoint.pricing = scenario.zeroQuote
            ? JSON.stringify({ currency: 'USD', prompt: '0', completion: '0' })
            : originalChatPricing;
          await migrator.unsafe(`UPDATE ${gateway}.users SET budget_max=$1
            WHERE id='v2-buyer'`, [scenario.budgetMax]);
          const beforeScenarioSpent = await spent();
          const beforeScenarioSends = upstreamSends;
          const chatResponse = await chatApp.request(
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
          const chatBodyText = await chatResponse.text();
          assert.equal(chatResponse.status, 402,
            `${scenario.name}: ${chatBodyText}`);
          assert.equal(chatResponse.headers.get(GATEWAY_ERROR_CODE_HEADER),
            GatewayErrorCode.budgetExceeded, scenario.name);
          assert.equal(JSON.parse(chatBodyText).code,
            GatewayErrorCode.budgetExceeded, scenario.name);
          await drainNodeBackgroundWork();
          assert.equal(upstreamSends, beforeScenarioSends, scenario.name);
          const observed = chatHandoffs.get(deniedChatId);
          assert.ok(observed, scenario.name);
          assert.equal(observed.handoff.quoteAttempts.length, 1, scenario.name);
          assert.equal(observed.handoff.transport[0]?.stage, 'claimed_only', scenario.name);
          assert.equal(observed.handoff.transport[0]?.upstreamHttpStatus, null,
            scenario.name);
          assert.equal(observed.selectedReference?.attemptId,
            observed.handoff.quoteAttempts[0]?.attemptId, scenario.name);
          assert.deepEqual(await eventRow(deniedChatId), {
            event_version: 2, buyer_charge_basis: 'none',
            guardrail: '0', debit: '0',
          }, scenario.name);
          assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
            ${gateway}.api_key_request_logs WHERE id=$1`, [deniedChatId]))[0].n, 1,
          scenario.name);
          assert.equal((await migrator.unsafe(`SELECT provider_key_id FROM
            ${gateway}.api_key_request_logs WHERE id=$1`,
          [deniedChatId]))[0].provider_key_id, 'sharedkey:v2-key', scenario.name);
          assert.deepEqual((await migrator.unsafe(`SELECT usage_certainty,
            provider_cost_certainty, input_tokens FROM
            ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1`,
          [deniedChatId]))[0], {
            usage_certainty: 'unknown', provider_cost_certainty: 'unknown',
            input_tokens: null,
          }, scenario.name);
          assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
            ${gateway}.user_budget_reservations WHERE request_id=$1`,
          [deniedChatId]))[0].n, 0, scenario.name);
          assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
            ${quotes}.shared_key_dispatch_quote_attempts WHERE request_log_id=$1`,
          [deniedChatId]))[0].n, 1, scenario.name);
          assert.equal(await spent(), beforeScenarioSpent, scenario.name);
          stage(`real-chat-${scenario.name}-402-claimed-only-zero-debit-v2-event`);
        }
      } finally {
        globalThis.fetch = originalFetch;
        chatEndpoint.pricing = originalChatPricing;
      }
      await migrator.unsafe(`REVOKE INSERT,UPDATE ON ${gateway}.user_budget_reservations
        FROM cinatoken_gateway_runtime;
        REVOKE UPDATE (budget_reserved_micros,updated_at) ON ${gateway}.users
        FROM cinatoken_gateway_runtime;`).simple();
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros+1
        WHERE id='v2-buyer'`), '42501');
      assert.equal(upstreamSends, 0);
      assert.equal(legacyLookupCalls, 0);

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

      const nonSharedId = `v2-bridge-${randomUUID()}`;
      const earlierShared = capture(nonSharedId);
      const earlierReference = await earlierShared.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(earlierReference);
      earlierShared.fetchBoundaryPermitted(earlierReference);
      earlierShared.upstreamHeadersObserved(earlierReference, 429);
      const beforeNonSharedSpent = await spent();
      await assert.rejects(economicAdapter.recordUsageAndOutbox(observedRepositories, {
        ...bridgeParams(nonSharedId),
        provider_key_id: 'provider-key:private',
        route_target_id: 'synthetic-nonshared',
      }, earlierShared.handoff(), null),
      /Potentially billable unknown shared-key attempt requires reserved buyer debit/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [nonSharedId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_events WHERE event_id=$1`, [nonSharedId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts WHERE request_log_id=$1`,
      [nonSharedId]))[0].n, 1);
      assert.equal(await spent(), beforeNonSharedSpent);
      assert.equal(legacyLookupCalls, 0);
      stage('non-shared-terminal-actual-with-earlier-unknown-rejected-before-buyer-write');

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

      const selectedAttemptName = 'shared-key-selected-attempt-identity-v357.sql';
      const selectedAttemptSql = await readFile(new URL(
        `../../../packages/core/migrations-proposals/postgres/${selectedAttemptName}`,
        import.meta.url), 'utf8');
      report.sourceSha256[selectedAttemptName] = sha(selectedAttemptSql);
      await assert.rejects(migrator.begin(tx => tx.unsafe(selectedAttemptSql).simple()),
        /activation or dependency differs/u);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_selected_attempt_activation = 'reviewed-v1'");
        await tx.unsafe(selectedAttemptSql).simple();
      });
      stage('selected-attempt-overlay-default-off-and-installed-after-v2-buyer');

      const exactId = `v2-selected-${randomUUID()}`;
      const exact = await claimObserved(exactId);
      await economicAdapter.recordUsageAndOutbox(observedRepositories,
        bridgeParams(exactId), exact.observed.handoff(), exact.selected);
      const [exactLog] = await migrator.unsafe(`SELECT route_trace,route_target_id
        FROM ${gateway}.api_key_request_logs WHERE id=$1`, [exactId]);
      assert.equal(JSON.parse(exactLog.route_trace).selected_shared_quote_attempt_id,
        exact.selected.attemptId);
      assert.equal(exactLog.route_target_id, exact.selected.routeTargetId);
      await expectCode(migrator.unsafe(`UPDATE ${gateway}.api_key_request_logs
        SET route_trace='{}' WHERE id=$1`, [exactId]),
      '23514', 'shared_key_selected_trace_immutable_v357');
      await expectCode(migrator.unsafe(`UPDATE ${gateway}.api_key_request_logs
        SET route_target_id='wrong-target' WHERE id=$1`, [exactId]),
      '23514', 'shared_key_selected_trace_immutable_v357');
      stage('real-record-usage-pins-exact-selected-attempt-and-final-route');

      const replayId = `v2-selected-${randomUUID()}`;
      const replayClaim = await claim(replayId);
      const replayOther = (await quoteProducer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,2,'v2-key','synthetic-target')`,
      [randomUUID(), replayId]))[0];
      assert.equal(replayOther.shared_key_id, replayClaim.shared_key_id);
      assert.equal(replayOther.route_target_id, replayClaim.route_target_id);
      const replayInput = charge(replayId, outcome(replayId, replayOther,
        { evidenceSha256: sha(bridgeUsage.raw_usage) }));
      replayInput.economicOutbox = { ...replayInput.economicOutbox,
        attempts: [outcome(replayId, replayClaim, {
          usageCertainty: 'unknown', inputTokens: null, outputTokens: null,
          cacheReadTokens: null, cacheWriteTokens: null,
          providerCostCertainty: 'unknown', providerCostMicros: null,
          evidenceKind: 'manual_review', evidenceSha256: null,
        }), ...replayInput.economicOutbox.attempts],
      };
      replayInput.beforeSpent = Number(await spent());
      replayInput.requestLog = { ...replayInput.requestLog,
        providerKeyId: 'sharedkey:v2-key',
        routeTargetId: 'synthetic-target',
        rawUsage: bridgeUsage.raw_usage,
        routeTrace: JSON.stringify({
          target: 'synthetic-target',
          selected_shared_quote_attempt_id: replayOther.attempt_id,
        }),
      };
      await insertRequestUsageAndChargeTxPg(buyerDb, replayInput);
      await insertRequestUsageAndChargeTxPg(buyerDb, replayInput);
      const beforeConflictingReplaySpent = await spent();
      await assert.rejects(insertRequestUsageAndChargeTxPg(buyerDb, {
        ...replayInput,
        requestLog: { ...replayInput.requestLog,
          routeTrace: JSON.stringify({
            target: 'synthetic-target',
            selected_shared_quote_attempt_id: replayClaim.attempt_id,
          }),
        },
      }), /Conflicting shared-key economic buyer log replay/u);
      assert.equal((await migrator.unsafe(`SELECT route_trace FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [replayId]))[0].route_trace,
      replayInput.requestLog.routeTrace);
      assert.equal(await spent(), beforeConflictingReplaySpent);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1`,
      [replayId]))[0].n, 2);
      stage('economic-replay-rejects-other-existing-same-key-same-route-attempt');

      const wrongUsageId = `v2-selected-${randomUUID()}`;
      const wrongUsageClaim = await claim(wrongUsageId);
      const wrongUsageInput = charge(wrongUsageId,
        outcome(wrongUsageId, wrongUsageClaim,
          { evidenceSha256: sha(bridgeUsage.raw_usage) }));
      wrongUsageInput.beforeSpent = Number(await spent());
      wrongUsageInput.requestLog = { ...wrongUsageInput.requestLog,
        providerKeyId: 'sharedkey:v2-key',
        routeTargetId: 'synthetic-target', rawUsage: bridgeUsage.raw_usage,
        inputTokens: 1000, totalTokens: 1005,
        routeTrace: JSON.stringify({
          target: 'synthetic-target',
          selected_shared_quote_attempt_id: wrongUsageClaim.attempt_id,
        }),
      };
      const beforeWrongUsageSpent = await spent();
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb, wrongUsageInput),
      '23514', 'shared_key_selected_attempt_usage_v357');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [wrongUsageId]))[0].n, 0);
      assert.equal(await spent(), beforeWrongUsageSpent);
      stage('selected-attempt-provider-token-count-must-match-buyer-log');

      const wrongDigestId = `v2-selected-${randomUUID()}`;
      const wrongDigestClaim = await claim(wrongDigestId);
      const wrongDigestInput = charge(wrongDigestId,
        outcome(wrongDigestId, wrongDigestClaim));
      wrongDigestInput.beforeSpent = Number(await spent());
      wrongDigestInput.requestLog = { ...wrongDigestInput.requestLog,
        providerKeyId: 'sharedkey:v2-key',
        routeTargetId: 'synthetic-target', rawUsage: bridgeUsage.raw_usage,
        routeTrace: JSON.stringify({
          target: 'synthetic-target',
          selected_shared_quote_attempt_id: wrongDigestClaim.attempt_id,
        }),
      };
      const beforeWrongDigestSpent = await spent();
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb, wrongDigestInput),
      '23514', 'shared_key_selected_attempt_usage_v357');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [wrongDigestId]))[0].n, 0);
      assert.equal(await spent(), beforeWrongDigestSpent);
      stage('selected-attempt-raw-provider-evidence-digest-must-match-buyer-log');

      const tamperedId = `v2-selected-${randomUUID()}`;
      const tampered = capture(tamperedId);
      const earlier = await tampered.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      const selected = await tampered.beforeFetch({
        providerKeyId: 'sharedkey:v2-key', targetId: 'synthetic-target',
      });
      assert.ok(earlier && selected);
      tampered.fetchBoundaryPermitted(selected);
      tampered.upstreamHeadersObserved(selected, 200);
      assert.equal(await tampered.observeProviderUsage(selected, bridgeUsage), true);
      await migrator.unsafe(`CREATE FUNCTION ${gateway}.fixture_tamper_selected_attempt_v357()
        RETURNS trigger LANGUAGE plpgsql AS $tamper$
        BEGIN
          NEW.route_trace:=pg_catalog.jsonb_set(NEW.route_trace::jsonb,
            '{selected_shared_quote_attempt_id}',
            pg_catalog.to_jsonb(pg_catalog.current_setting(
              'cinatoken.fixture_wrong_selected_attempt',true)))::text;
          RETURN NEW;
        END;
        $tamper$;
        CREATE TRIGGER zz_fixture_tamper_selected_attempt_v357
          BEFORE INSERT ON ${gateway}.api_key_request_logs FOR EACH ROW
          EXECUTE FUNCTION ${gateway}.fixture_tamper_selected_attempt_v357();`).simple();
      try {
        await buyer.unsafe(`SELECT pg_catalog.set_config(
          'cinatoken.fixture_wrong_selected_attempt',$1,false)`, [earlier.attemptId]);
        const beforeTamperedSpent = await spent();
        await expectCode(economicAdapter.recordUsageAndOutbox(observedRepositories,
          bridgeParams(tamperedId), tampered.handoff(), selected),
        '23514', 'shared_key_selected_attempt_usage_v357');
        assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
          ${gateway}.api_key_request_logs WHERE id=$1`, [tamperedId]))[0].n, 0);
        assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
          ${outbox}.shared_key_economic_events WHERE event_id=$1`, [tamperedId]))[0].n, 0);
        assert.equal(await spent(), beforeTamperedSpent);
      } finally {
        await buyer.unsafe('RESET cinatoken.fixture_wrong_selected_attempt');
        await migrator.unsafe(`DROP TRIGGER zz_fixture_tamper_selected_attempt_v357
          ON ${gateway}.api_key_request_logs;
          DROP FUNCTION ${gateway}.fixture_tamper_selected_attempt_v357();`).simple();
      }
      stage('same-key-same-route-earlier-attempt-cannot-impersonate-selected-usage');
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
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`economic-producer-v2-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

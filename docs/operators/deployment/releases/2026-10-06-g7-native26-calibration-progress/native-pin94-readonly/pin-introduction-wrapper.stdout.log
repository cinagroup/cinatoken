// Review-only v348 fixture successor: explicit runtime/buyer clients and exact aggregate proof.
// The historical v348 fixture, SQL proposals, test-only grants and denial assertions stay frozen.
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
import { handleChatCompletion } from '../../../packages/proxy/src/routes/v1/chat.ts';
import { createPostgresSharedKeyEconomicProducer } from '../../../packages/proxy/src/services/shared-key-quote-attempt.ts';
import { drainNodeBackgroundWork } from '../../../packages/proxy/src/runtime/schedule-background-work.ts';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const outbox = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposalPath = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const proposals = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation', 'reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation', 'reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation', 'reviewed-v1'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation', 'reviewed-v1'],
  ['buyer-critical-writer-privilege-split-v346.sql', 'buyer_settlement_privilege_split', 'reviewed-v1'],
];
const successorName = 'shared-key-economic-producer-buyer-login-v347.sql';
const denialName = 'shared-key-guardrail-post-reservation-denial-v348.sql';
const historicalFixtureSha256 = '603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13';
const digest = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-buyer-producer-v347-${label}` } });
}

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
    attemptIndex: claim.attempt_index,
    sharedKeyId: claim.shared_key_id, transitionId: claim.transition_id,
    quoteVersionId: claim.quote_version_id, usageCertainty: 'actual',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
    cacheWriteTokens: 0, providerCostCertainty: 'unknown',
    providerCostMicros: null, evidenceKind: 'provider_usage',
    evidenceSha256: 'a'.repeat(64), observedAtIso: new Date().toISOString(),
    ...overrides };
}

function payload(attempt) {
  return JSON.stringify([{ attempt_id: attempt.attemptId,
    attempt_index: attempt.attemptIndex, shared_key_id: attempt.sharedKeyId,
    transition_id: attempt.transitionId, quote_version_id: attempt.quoteVersionId,
    usage_certainty: attempt.usageCertainty, input_tokens: attempt.inputTokens,
    output_tokens: attempt.outputTokens, cache_read_tokens: attempt.cacheReadTokens,
    cache_write_tokens: attempt.cacheWriteTokens,
    provider_cost_certainty: attempt.providerCostCertainty,
    provider_cost_micros: attempt.providerCostMicros,
    evidence_kind: attempt.evidenceKind,
    evidence_sha256: attempt.evidenceSha256,
    observed_at: attempt.observedAtIso }]);
}

function charge(id, attempt, { mode, basis = 'actual',
  chargedCost = 0.01 } = {}) {
  const params = chargeParams(id, chargedCost);
  params.requestLog = { ...params.requestLog, userId: 'buyer-v347',
    apiKeyId: 'api-key-v347', workspaceId: 'workspace-v347',
    inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  params.userId = 'buyer-v347';
  params.beforeSpent = 1;
  params.audit = { ...params.audit, apiKeyId: 'api-key-v347',
    beforeSpent: 1, requestLogId: id };
  if (mode) params.userBudgetSettlement = { requestId: id, mode,
    reason: `buyer-login-v347-${mode}` };
  if (basis === 'none') {
    params.shouldChargeBudget = false;
    params.requestLog = { ...params.requestLog, status: 'error',
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      meteredCost: 0, standardCost: 0, chargedCost: 0,
      budgetChargedMicros: 0 };
  }
  params.economicOutbox = { eventVersion: 2, buyerChargeBasis: basis,
    buyerUsageCertainty: basis === 'actual' ? 'actual' : 'unknown',
    attempts: [attempt] };
  return params;
}

test('post-reservation Guardrail denial closes only a proven pre-send released buyer lease (runtime/buyer client successor)',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-guardrail-post-reservation-denial-v348-runtime-buyer-client-successor-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      lineage: { historicalFixture: 'scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs',
        historicalFixtureSha256, contract: 'explicit runtime read and buyer financial clients; exact aggregate reviewed-v1' },
      scope: 'owned loopback PostgreSQL 18.6; PG73 plus review-only C04 v348 denial proposal',
      limitations: [
        'No production role, migration, grant routine, secret, Worker, Queue, or Hyperdrive binding changed.',
        'The buyer LOGIN is a trusted financial capability and still has direct UPDATE rights on granted buyer columns.',
        'The v1 producer is disabled for the ordinary runtime; every old v1 caller needs a reviewed migration gate before cutover.',
        'In this buyer-split-marker-absent v346/v347 fixture, the legacy grant routine rerun restores ordinary runtime gateway financial writes; the separate v348 buyer-split marker blocks that routine after activation.',
        'The current buyer-split v348 marker and grant reconciler pin the v347 producer body, so neither can first activate after this v348 denial SQL until a compatibility proposal is reviewed; the reverse order is not tested here.',
        'Seller consumer, release/adjustment, management, payout, admission ownership, C03 recovery, D1/MySQL, and Linux CI are not covered.',
        'The private denial receipt trusts the buyer LOGIN release reason and the mark-before-fetch contract; no independent Guardrail-denial record is present.',
        'The Chat fixture adds buyer INSERT on reservations and SELECT on system_config/workspace_budgets only after proving the existing role lacks admission permission; this is not a reviewed production admission role.',
        'A failed release leaves a reserved orphan for independent manual review; this proposal does not infer buyer or provider cost.',
        'This successor uses the runtime LOGIN for route reads and the existing buyer LOGIN for financial writes; userBudgets retains only the old test-only buyer admission capability, not a reviewed production admission identity. POSTGRES_CHAT_BUDGET_OWNER_ENABLED remains unset.',
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
        'cinatoken_gateway_shared_quote_attempt_producer',
        quotePassword, 'quote');
      clients.push(migrator, runtime, buyer, quoteProducer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(names.length, 73);
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`,
            [name]);
        });
      }
      report.sourceSha256.formalMigrations = digest(corpus.join('\n'));
      report.sourceSha256.runtimeGrant = digest(await readFile(
        new URL('./grant-postgres-runtime.ts', import.meta.url)));
      report.sourceSha256.criticalWriter = digest(await readFile(new URL(
        '../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)));
      report.sourceSha256.fixture = digest(await readFile(new URL(import.meta.url)));
      report.sourceSha256.historicalFixture = digest(await readFile(new URL(
        './postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs', import.meta.url)));
      assert.equal(report.sourceSha256.historicalFixture, historicalFixtureSha256);
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      stage('formal-pg73-and-current-runtime-grant-installed');

      for (const [name, activation, value] of proposals) {
        const body = await readFile(new URL(name, proposalPath), 'utf8');
        report.sourceSha256[name] = digest(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${activation} = '${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v2-producer-v344-receipt-and-v346-buyer-split-installed');
      const successor = await readFile(new URL(successorName, proposalPath), 'utf8');
      report.sourceSha256[successorName] = digest(successor);
      const originalV2 = await readFile(new URL(
        'shared-key-economic-producer-v2.sql', proposalPath), 'utf8');
      const originalFunction = originalV2.replace(/\r\n/gu, '\n').match(
        /CREATE FUNCTION cinatoken_economic_outbox\.write_shared_key_economic_event_v2\([\s\S]*?\$producer\$;/u)?.[0];
      const successorFunction = successor.replace(/\r\n/gu, '\n').match(
        /CREATE OR REPLACE FUNCTION cinatoken_economic_outbox\.write_shared_key_economic_event_v2\([\s\S]*?\$producer\$;/u)?.[0];
      assert.ok(originalFunction && successorFunction);
      assert.equal(successorFunction, originalFunction
        .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        .replace("SESSION_USER <> 'cinatoken_gateway_runtime'",
          "SESSION_USER <> 'cinatoken_gateway_buyer_settlement'")
        .replace('Dedicated runtime LOGIN required for economic producer',
          'Dedicated buyer settlement LOGIN required for economic producer'));
      stage('v2-function-body-diff-is-exactly-login-gate-and-diagnostic');
      await assert.rejects(migrator.begin(tx => tx.unsafe(successor).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER FUNCTION ${outbox}.write_shared_key_economic_event_v2(
          text,text,text,bigint,jsonb,text) SECURITY INVOKER`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_buyer_login_activation = 'reviewed-v1'");
        await tx.unsafe(successor).simple();
      }), /activation or dependency differs/u);
      stage('successor-default-off-and-source-catalog-drift-fail-closed');
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_buyer_login_activation = 'reviewed-v1'");
        await tx.unsafe(successor).simple();
      });
      const denial = await readFile(new URL(denialName, proposalPath), 'utf8');
      report.sourceSha256[denialName] = digest(denial);
      report.sourceSha256.denialBuilder = digest(await readFile(new URL(
        './build-shared-key-guardrail-denial-v348.mjs', import.meta.url)));
      report.sourceSha256.chatRoute = digest(await readFile(new URL(
        '../../../packages/proxy/src/routes/v1/chat.ts', import.meta.url)));
      report.sourceSha256.budgetAdmission = digest(await readFile(new URL(
        '../../../packages/proxy/src/services/request-budget-admission.ts', import.meta.url)));
      await assert.rejects(migrator.begin(tx => tx.unsafe(denial).simple()),
        /activation or dependency differs/u);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_guardrail_denial_v348_activation = 'reviewed-v1'");
        await tx.unsafe(denial).simple();
      });
      stage('v348-default-off-release-proof-and-narrow-v2-validator-replacement');
      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${outbox}.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS runtime_v2_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${outbox}.write_shared_key_economic_event(text,text,text,jsonb,text)',
          'EXECUTE') AS runtime_v1_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${outbox}.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS buyer_v2_execute,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${outbox}.shared_key_buyer_budget_tx_receipts','INSERT')
          AS buyer_receipt_insert,
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${gateway}.user_earnings','UPDATE') AS buyer_seller_update`);
      assert.deepEqual(acl, { runtime_v2_execute: false,
        runtime_v1_execute: false, buyer_v2_execute: true,
        buyer_receipt_insert: false, runtime_spend_update: false,
        buyer_seller_update: false });
      stage('private-v2-execute-moves-to-buyer-login-with-v1-revoked', { acl });

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent) VALUES
          ('buyer-v347','buyer-v347@example.invalid',10,1),
          ('seller-v347','seller-v347@example.invalid',10,0);
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('seller-v347');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('workspace-v347','personal','buyer-v347',
            'Buyer Login Fixture','buyer-login-v347','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('api-key-v347','synthetic-v347-api-key',
            'buyer-v347','workspace-v347');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('shared-key-v347','seller-v347','openai',
            'synthetic-upstream-v347','synthetic-fingerprint-v347','active');
        INSERT INTO ${quotes}.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('quote-v347','shared-key-v347','seller-v347',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v1');
        INSERT INTO ${quotes}.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('transition-v347','shared-key-v347',NULL,'activate',
            'quote-v347','seller-v347');`).simple();
      const claim = async id => outcome(id, (await quoteProducer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt(
          $1,$2,1,'shared-key-v347','synthetic-target-v347')`,
      [randomUUID(), id]))[0]);
      const buyerDb = { driver: 'postgres', raw: buyer,
        drizzle: drizzle(buyer, { schema: pgCoreSchema }) };
      const buyerRepositories = createPostgresRepositories(buyerDb);
      const runtimeDb = { driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }) };
      const runtimeRepositories = createPostgresRepositories(runtimeDb);
      assert.notEqual(runtimeDb.raw, buyerDb.raw);
      const [runtimeIdentity] = await runtime.unsafe('SELECT current_user AS current_user, session_user AS session_user');
      const [buyerIdentity] = await buyer.unsafe('SELECT current_user AS current_user, session_user AS session_user');
      assert.deepEqual(runtimeIdentity, { current_user: 'cinatoken_gateway_runtime',
        session_user: 'cinatoken_gateway_runtime' });
      assert.deepEqual(buyerIdentity, { current_user: 'cinatoken_gateway_buyer_settlement',
        session_user: 'cinatoken_gateway_buyer_settlement' });
      stage('successor-runtime-buyer-clients-have-distinct-owned-login-identities',
        { runtimeIdentity, buyerIdentity });
      const reservationInput = id => ({ requestId: id,
        userId: 'buyer-v347', apiKeyId: 'api-key-v347',
        expectedBudgetEpoch: 0, reservedMicros: 20_000,
        nowIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 120_000).toISOString() });
      const noChargeAttempt = attempt => ({ ...attempt,
        usageCertainty: 'unknown', inputTokens: null,
        outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        providerCostCertainty: 'unknown', providerCostMicros: null,
        evidenceKind: 'manual_review', evidenceSha256: null });
      const snapshot = async id => (await migrator.unsafe(`SELECT
        (SELECT budget_spent::text FROM ${gateway}.users
          WHERE id='buyer-v347') AS spent,
        (SELECT count(*)::int FROM ${gateway}.api_key_request_logs
          WHERE id=$1) AS logs,
        (SELECT count(*)::int FROM ${outbox}.shared_key_economic_events
          WHERE event_id=$1) AS events,
        (SELECT count(*)::int FROM ${outbox}.shared_key_economic_event_attempts
          WHERE event_id=$1) AS attempts,
        (SELECT spent_delta_micros::bigint::text FROM
          ${outbox}.shared_key_buyer_budget_tx_receipts r
          JOIN ${outbox}.shared_key_economic_producer_tx_markers m
            ON m.log_xact_id=r.xact_id
          WHERE m.request_log_id=$1 AND r.user_id='buyer-v347') AS receipt_spent`,
      [id]))[0];
      stage('synthetic-buyer-seller-and-frozen-quote-installed');

      const admissionAclId = `buyer-admission-v348-${randomUUID()}`;
      await expectCode(buyerRepositories.userBudgets.reserve(
        reservationInput(admissionAclId)), '42501');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`,
      [admissionAclId]))[0].n, 0);
      stage('v346-v347-buyer-login-cannot-reserve-without-a-separate-admission-grant');
      // Local test-only permission models an admission writer. The v346/v347
      // production role plan does not currently provide this capability.
      await migrator.unsafe(`GRANT INSERT ON ${gateway}.user_budget_reservations
        TO cinatoken_gateway_buyer_settlement`);
      stage('test-only-buyer-reservation-insert-grant-installed');

      const releasedId = `guardrail-denied-v348-${randomUUID()}`;
      const releasedAttempt = noChargeAttempt(await claim(releasedId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(releasedId))).status, 'reserved');
      assert.equal(await buyerRepositories.userBudgets.release(releasedId,
        new Date().toISOString(), 'guardrail_budget_admission_rejected'), 1);
      assert.deepEqual((await migrator.unsafe(`SELECT r.state,
        r.settled_micros::text AS settled,r.dispatched_at,
        d.reserved_micros::text AS proof_hold,d.user_id,d.api_key_id
        FROM ${gateway}.user_budget_reservations r
        JOIN ${outbox}.shared_key_guardrail_pre_send_denials d
          ON d.request_id=r.request_id WHERE r.request_id=$1`, [releasedId]))[0],
      { state: 'released', settled: '0', dispatched_at: null,
        proof_hold: '20000', user_id: 'buyer-v347',
        api_key_id: 'api-key-v347' });
      const releasedZero = charge(releasedId, releasedAttempt,
        { basis: 'none', chargedCost: 0 });
      const beforeReleased = await snapshot(releasedId);
      await insertRequestUsageAndChargeTxPg(buyerDb, releasedZero);
      assert.deepEqual((await migrator.unsafe(`SELECT event_version,
        buyer_charge_basis,buyer_usage_certainty,buyer_debit_micros::text AS debit,
        event_certainty FROM ${outbox}.shared_key_economic_events
        WHERE event_id=$1`, [releasedId]))[0],
      { event_version: 2, buyer_charge_basis: 'none',
        buyer_usage_certainty: 'unknown', debit: '0',
        event_certainty: 'unresolved' });
      assert.deepEqual((await migrator.unsafe(`SELECT usage_certainty,
        provider_cost_certainty,input_tokens FROM
        ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1`,
      [releasedId]))[0], { usage_certainty: 'unknown',
        provider_cost_certainty: 'unknown', input_tokens: null });
      assert.equal((await snapshot(releasedId)).spent, beforeReleased.spent);
      await insertRequestUsageAndChargeTxPg(buyerDb, releasedZero);
      assert.equal((await snapshot(releasedId)).events, 1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.shared_key_earnings WHERE request_log_id=$1`,
      [releasedId]))[0].n, 0);
      stage('released-zero-with-private-pre-send-proof-commits-one-buyer-log-and-unresolved-v2-event');

      const falseBuyerId = `false-buyer-actual-v348-${randomUUID()}`;
      const falseBuyerAttempt = noChargeAttempt(await claim(falseBuyerId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(falseBuyerId))).status, 'reserved');
      assert.equal(await buyerRepositories.userBudgets.release(falseBuyerId,
        new Date().toISOString(), 'guardrail_budget_admission_rejected'), 1);
      const falseBuyerCharge = charge(falseBuyerId, falseBuyerAttempt,
        { basis: 'none', chargedCost: 0 });
      falseBuyerCharge.economicOutbox.buyerUsageCertainty = 'actual';
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        falseBuyerCharge), '23514', 'shared_key_economic_producer_buyer');
      assert.equal((await snapshot(falseBuyerId)).logs, 0);

      const falseAttemptId = `false-attempt-actual-v348-${randomUUID()}`;
      const falseAttempt = await claim(falseAttemptId);
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(falseAttemptId))).status, 'reserved');
      assert.equal(await buyerRepositories.userBudgets.release(falseAttemptId,
        new Date().toISOString(), 'guardrail_budget_admission_rejected'), 1);
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(falseAttemptId, falseAttempt,
          { basis: 'none', chargedCost: 0 })),
      '23514', 'shared_key_guardrail_denial_attempt_not_actual');
      assert.equal((await snapshot(falseAttemptId)).logs, 0);
      stage('pre-send-denial-rejects-actual-buyer-or-attempt-usage');

      await expectCode(migrator.unsafe(`INSERT INTO
        ${gateway}.guardrail_budget_reservations
        (id,request_id,assignment_id,guardrail_id,guardrail_version,
          scope_type,scope_id,period,period_start,period_end,
          limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($2,$1,'late-assignment','late-guardrail',1,
          'user','buyer-v347','daily',date_trunc('day',now()),
          date_trunc('day',now())+interval '1 day',
          100,100,'reserved',now()+interval '1 day',now(),now())`,
      [releasedId, `late-guardrail-${randomUUID()}`]),
      '23514', 'shared_key_guardrail_denial_guardrail_late');
      stage('late-guardrail-reservation-cannot-invalidate-committed-zero-buyer-proof');

      await expectCode(buyer.unsafe(`INSERT INTO
        ${outbox}.shared_key_guardrail_pre_send_denials
        (request_id,user_id,api_key_id,reserved_micros,release_xact_id,released_at)
        VALUES($1,'buyer-v347','api-key-v347',20000,pg_current_xact_id(),now())`,
      [releasedId]), '42501');
      await expectCode(buyer.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET terminal_reason='other' WHERE request_id=$1`, [releasedId]),
      '23514', 'shared_key_guardrail_denial_immutable');
      stage('buyer-cannot-forge-private-proof-or-rewrite-supported-terminal-reason');

      const otherReleaseId = `other-release-v348-${randomUUID()}`;
      const otherReleaseAttempt = noChargeAttempt(await claim(otherReleaseId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(otherReleaseId))).status, 'reserved');
      assert.equal(await buyerRepositories.userBudgets.release(otherReleaseId,
        new Date().toISOString(), 'other_pre_dispatch_cleanup'), 1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_guardrail_pre_send_denials WHERE request_id=$1`,
      [otherReleaseId]))[0].n, 0);
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(otherReleaseId, otherReleaseAttempt,
          { basis: 'none', chargedCost: 0 })),
      '23514', 'shared_key_economic_producer_buyer');
      assert.equal((await snapshot(otherReleaseId)).logs, 0);
      stage('ordinary-release-without-exact-denial-proof-cannot-create-zero-buyer-event');

      const postDispatchId = `post-dispatch-release-v348-${randomUUID()}`;
      const postDispatchAttempt = noChargeAttempt(await claim(postDispatchId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(postDispatchId))).status, 'reserved');
      await migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET state='dispatched',dispatched_at=now(),updated_at=now()
        WHERE request_id=$1`, [postDispatchId]);
      await buyer.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros-20000
          WHERE id='buyer-v347'`);
        await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='released',settled_micros=0,terminal_at=now(),
            terminal_reason='guardrail_budget_admission_rejected',updated_at=now()
          WHERE request_id=$1`, [postDispatchId]);
      });
      assert.deepEqual((await migrator.unsafe(`SELECT r.state,
        r.dispatched_at IS NOT NULL AS dispatched,
        (SELECT count(*)::int FROM ${outbox}.shared_key_guardrail_pre_send_denials d
          WHERE d.request_id=r.request_id) AS proofs
        FROM ${gateway}.user_budget_reservations r WHERE r.request_id=$1`,
      [postDispatchId]))[0], { state: 'released', dispatched: true,
        proofs: 0 });
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(postDispatchId, postDispatchAttempt,
          { basis: 'none', chargedCost: 0 })),
      '23514', 'shared_key_economic_producer_buyer');
      assert.equal((await snapshot(postDispatchId)).logs, 0);
      stage('released-row-after-possible-dispatch-never-becomes-no-egress-proof');

      const racingId = `racing-guardrail-v348-${randomUUID()}`;
      const racingAttempt = noChargeAttempt(await claim(racingId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(racingId))).status, 'reserved');
      let allowGuardrailCommit;
      const guardrailCommitGate = new Promise(resolve => { allowGuardrailCommit = resolve; });
      let reportGuardrailInserted;
      const guardrailInserted = new Promise(resolve => { reportGuardrailInserted = resolve; });
      const guardrailTx = migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.guardrail_budget_windows
          (workspace_id,scope_type,scope_id,period,period_start,period_end,
            unreserved_micros,settled_micros,reserved_micros,
            seeded_at,updated_at)
          VALUES('workspace-v347','user','buyer-v347','daily',date_trunc('day',now()),
            date_trunc('day',now())+interval '1 day',0,0,0,now(),now())
          ON CONFLICT DO NOTHING`);
        await tx.unsafe(`INSERT INTO ${gateway}.guardrail_budget_reservations
          (id,request_id,assignment_id,guardrail_id,guardrail_version,workspace_id,
            scope_type,scope_id,period,period_start,period_end,
            limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($2,$1,'racing-assignment','racing-guardrail',1,'workspace-v347',
            'user','buyer-v347','daily',date_trunc('day',now()),
            date_trunc('day',now())+interval '1 day',
            100,100,'reserved',now()+interval '1 day',now(),now())`,
        [racingId, `guardrail-race-${randomUUID()}`]);
        reportGuardrailInserted();
        await guardrailCommitGate;
      });
      let raceRelease;
      try {
        await Promise.race([guardrailInserted, guardrailTx.then(() => {
          throw new Error('Guardrail transaction ended before insert readiness');
        })]);
        let releaseCompleted = false;
        raceRelease = buyerRepositories.userBudgets.release(racingId,
          new Date().toISOString(), 'guardrail_budget_admission_rejected')
          .then(result => { releaseCompleted = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(releaseCompleted, false);
      } finally {
        allowGuardrailCommit();
      }
      await guardrailTx;
      assert.equal(await raceRelease, 1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_guardrail_pre_send_denials WHERE request_id=$1`,
      [racingId]))[0].n, 0);
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(racingId, racingAttempt,
          { basis: 'none', chargedCost: 0 })),
      '23514', 'shared_key_economic_producer_buyer');
      stage('uncommitted-earlier-guardrail-insert-serializes-release-and-prevents-zero-proof');

      const stillReservedId = `release-failed-v348-${randomUUID()}`;
      const stillReservedAttempt = noChargeAttempt(await claim(stillReservedId));
      assert.equal((await buyerRepositories.userBudgets.reserve(
        reservationInput(stillReservedId))).status, 'reserved');
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(stillReservedId, stillReservedAttempt,
          { basis: 'none', chargedCost: 0 })),
      '23514', 'shared_key_economic_producer_buyer');
      assert.deepEqual((await migrator.unsafe(`SELECT r.state,
        (SELECT count(*)::int FROM ${outbox}.shared_key_guardrail_pre_send_denials d
          WHERE d.request_id=r.request_id) AS proofs FROM
        ${gateway}.user_budget_reservations r WHERE r.request_id=$1`,
      [stillReservedId]))[0], { state: 'reserved', proofs: 0 });
      assert.equal((await snapshot(stillReservedId)).logs, 0);
      stage('release-failure-reserved-lease-remains-unresolved-without-buyer-log-or-v2-event');

      const chatRouteRow = {
        id: 'synthetic-target-v347', model_id: 'fixture/model',
        provider_id: 'fixture-provider', provider_model_name: 'fixture-model',
        priority: 1, status: 'active', route_group: 'default', weight: 1,
        price_override: null, custom_params: null,
        upstream_protocol: 'openai', upstream_operation: 'chat',
        adapter: 'passthrough', routing_metadata: null,
      };
      const chatProviderRow = {
        id: 'fixture-provider', name: 'fixture-provider',
        api_key: 'synthetic-own-key',
        endpoints: JSON.stringify({ openai: {
          base: 'https://example.invalid/v1' } }),
        shared_channel_type: 'openai', status: 'active', description: null,
      };
      const chatModel = {
        id: 'fixture/model', display_name: 'fixture/model', vendor: 'fixture',
        context_window: 128000, max_tokens: 8192, pricing_profile: null,
        tags: '[]', description: null, metadata: null,
        input_modalities: '["text"]', output_modalities: '["text"]',
        released_at: null, route_policy: '{"strategy":"weight_priority"}',
      };
      const chatEndpoint = {
        id: 'fixture-endpoint-v348', model_id: chatRouteRow.model_id,
        provider_id: chatProviderRow.id, provider_slug: 'openai', tag: 'test',
        endpoint_class: 'standard', region: null, context_length: 128000,
        max_prompt_tokens: null, max_completion_tokens: 8192,
        quantization: null, supported_parameters: '[]',
        pricing: JSON.stringify({ currency: 'USD', prompt: '0.000001',
          completion: '0.000001' }), supports_implicit_caching: false,
        supports_voice_cloning: false,
        supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
        image_capabilities: '{}', evidence_url: 'https://evidence.example/v348',
        verified_by: 'fixture', verified_at: new Date().toISOString(),
        expires_at: '2027-09-25T00:00:00.000Z', status: 'verified',
        route_target_id: chatRouteRow.id,
        subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
          chatRouteRow, chatProviderRow),
      };
      const chatSharedKey = {
        id: 'shared-key-v347', sellerUserId: 'seller-v347',
        channelType: 'openai', apiKey: 'synthetic-upstream-v347',
        keyFingerprint: 'synthetic-fingerprint', label: 'fixture',
        status: 'active', sellerPriority: 0, weight: 1,
        inputPrice: 1.25, outputPrice: 2.5, cacheReadPrice: 0.1,
        cacheWritePrice: 0.2, validatedAt: null, lastUsedAt: null,
        lastFailureAt: null, failureReason: null, servedInputTokens: 0,
        servedOutputTokens: 0, earnedTotal: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const effectiveBudgetGuardrail = {
        id: 'guardrail-v348', workspace_id: 'workspace-v347',
        owner_user_id: 'buyer-v347', name: 'Budget fixture', description: null,
        status: 'active', designated_version: 1, latest_version: 1,
        created_at: '2026-09-25T00:00:00.000Z',
        updated_at: '2026-09-25T00:00:00.000Z',
        version_id: 'guardrail-version-v348',
        version_config_json: '{"budget":{"limit":1,"period":"daily"}}',
        version_created_by_user_id: 'buyer-v347',
        version_created_at: '2026-09-25T00:00:00.000Z',
        assignment_id: 'assignment-v348', assignment_scope_type: 'user',
        assignment_scope_id: 'buyer-v347',
      };
      await migrator.unsafe(`GRANT SELECT ON ${gateway}.workspace_budgets,
        ${gateway}.system_config
        TO cinatoken_gateway_buyer_settlement`);
      const chatRepositories = {
        ...runtimeRepositories,
        // Preserve the original owned test-only admission methods without changing runtime client identity.
        userBudgets: buyerRepositories.userBudgets,
        guardrails: { ...runtimeRepositories.guardrails,
          getEffectiveForRequest: async () => [effectiveBudgetGuardrail] },
        guardrailBudgets: { ...runtimeRepositories.guardrailBudgets,
          expireBefore: async () => 0,
          reserveMany: async () => ({ status: 'blocked',
            assignmentId: 'assignment-v348' }) },
        modelRouting: { ...runtimeRepositories.modelRouting,
          getModelById: async id => id === chatModel.id ? chatModel : null,
          getModelRoutesByModelId: async id => id === chatModel.id
            ? [chatRouteRow] : [],
          resolveModelSurface: async () => null },
        providers: { ...runtimeRepositories.providers,
          getProvidersByIds: async ids => ids.includes(chatProviderRow.id)
            ? [chatProviderRow] : [] },
        modelEndpoints: { ...runtimeRepositories.modelEndpoints,
          listRuntimeBindingsByRouteTargetIds: async ids =>
            ids.includes(chatRouteRow.id) ? [chatEndpoint] : [] },
        routeDataPolicies: { ...runtimeRepositories.routeDataPolicies,
          getByRouteTargetIds: async () => [] },
        sharedKeys: { ...runtimeRepositories.sharedKeys,
          listActiveSharedKeysByChannel: async channel =>
            channel === 'openai' ? [chatSharedKey] : [] },
        byokKeys: { ...runtimeRepositories.byokKeys,
          listActiveForRequest: async () => [],
          shouldSuppressSharedCapacityForRequest: async () => false },
        requestLogs: { ...runtimeRepositories.requestLogs,
          getRecentRoutePerformanceSamples: async () => [],
          getRouteAvailabilityAggregates: async () => [] },
      };
      const runChat = async (id, repositories) => {
        const app = new Hono();
        app.post('/v1/chat/completions', c => {
          c.set('repositories', repositories);
          c.set('apiKey', {
            keyId: 'api-key-v347', apiKeyHash: 'a'.repeat(64),
            userId: 'buyer-v347', workspaceId: 'workspace-v347',
            userEmail: 'buyer-v347@example.invalid', budgetMax: 10,
            budgetSpent: 1, budgetEpoch: 0, budgetPeriod: 'none',
            budgetResetAt: null, metadata: null, chargedCostFactors: null,
            includeByokInLimit: false,
          });
          c.set('generationId', id);
          c.set('requestBodyLoggingMode', 'off');
          c.set('sharedKeyEconomicProducer',
            createPostgresSharedKeyEconomicProducer(buyerDb));
          return handleChatCompletion(c);
        });
        const result = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'fixture/model',
            messages: [{ role: 'user', content: 'deny before fetch' }],
            max_tokens: 16 }),
        }, {
          SHARED_KEY_QUOTE_ATTEMPTS_ENABLED: 'reviewed-v1',
          AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED: 'reviewed-v1',
          QUOTE_ATTEMPT_HYPERDRIVE: { connectionString:
            `postgresql://cinatoken_gateway_shared_quote_attempt_producer:${quotePassword}`
              + `@127.0.0.1:${cluster.port}/postgres?sslmode=disable` },
        });
        await drainNodeBackgroundWork();
        return result;
      };
      const originalFetch = globalThis.fetch;
      let upstreamSends = 0;
      try {
        globalThis.fetch = async () => {
          upstreamSends += 1;
          throw new Error('Guardrail denial must not fetch upstream');
        };
        const chatId = `chat-guardrail-v348-${randomUUID()}`;
        const chatResult = await runChat(chatId, chatRepositories);
        assert.equal(chatResult.status, 403, await chatResult.text());
        assert.equal(upstreamSends, 0);
        assert.deepEqual((await migrator.unsafe(`SELECT r.state,
          r.settled_micros::text AS settled,e.buyer_charge_basis,
          e.buyer_debit_micros::text AS debit,
          (SELECT count(*)::int FROM ${outbox}.shared_key_guardrail_pre_send_denials d
            WHERE d.request_id=r.request_id) AS proofs,
          (SELECT count(*)::int FROM ${quotes}.shared_key_dispatch_quote_attempts q
            WHERE q.request_log_id=r.request_id) AS claims
          FROM ${gateway}.user_budget_reservations r
          JOIN ${outbox}.shared_key_economic_events e
            ON e.request_log_id=r.request_id WHERE r.request_id=$1`,
        [chatId]))[0], { state: 'released', settled: '0',
          buyer_charge_basis: 'none', debit: '0', proofs: 1, claims: 1 });
        assert.equal((await snapshot(chatId)).logs, 1);
        stage('real-chat-guardrail-403-releases-ordinary-hold-and-commits-claim-log-v2-none-zero-send');

        const failedId = `chat-release-failed-v348-${randomUUID()}`;
        const failedRepositories = { ...chatRepositories,
          userBudgets: { ...chatRepositories.userBudgets,
            release: async () => { throw new Error('synthetic release failure'); } } };
        const failedResult = await runChat(failedId, failedRepositories);
        assert.equal(failedResult.status, 500);
        assert.equal(upstreamSends, 0);
        assert.deepEqual((await migrator.unsafe(`SELECT r.state,
          (SELECT count(*)::int FROM ${outbox}.shared_key_guardrail_pre_send_denials d
            WHERE d.request_id=r.request_id) AS proofs,
          (SELECT count(*)::int FROM ${quotes}.shared_key_dispatch_quote_attempts q
            WHERE q.request_log_id=r.request_id) AS claims,
          (SELECT count(*)::int FROM ${gateway}.api_key_request_logs l
            WHERE l.id=r.request_id) AS logs
          FROM ${gateway}.user_budget_reservations r
          WHERE r.request_id=$1`, [failedId]))[0],
        { state: 'reserved', proofs: 0, claims: 1, logs: 0 });
        stage('real-chat-release-failure-keeps-reserved-claim-for-manual-recovery-without-buyer-event');
      } finally {
        globalThis.fetch = originalFetch;
      }

      await expectCode(runtime.unsafe('SET ROLE cinatoken_gateway_buyer_settlement'),
        '42501');
      await expectCode(buyer.unsafe('SET ROLE cinatoken_gateway_runtime'), '42501');
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.users
        SET budget_spent=budget_spent+1 WHERE id='buyer-v347'`), '42501');
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.user_earnings
        SET balance_micros=balance_micros+1 WHERE user_id='seller-v347'`), '42501');
      await expectCode(buyer.unsafe(`UPDATE ${gateway}.user_earnings
        SET balance_micros=balance_micros+1 WHERE user_id='seller-v347'`), '42501');
      await expectCode(buyer.unsafe(`INSERT INTO ${outbox}.shared_key_buyer_budget_tx_receipts
        (xact_id,user_id,budget_epoch) VALUES(pg_current_xact_id(),'buyer-v347',0)`),
      '42501');
      await expectCode(runtime.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
        'missing','actual','actual',10000,'[]'::jsonb,'verify')`), '42501');
      await expectCode(runtime.unsafe(`SELECT ${outbox}.write_shared_key_economic_event(
        'missing','actual','actual','[]'::jsonb,'verify')`), '42501');
      stage('runtime-cannot-assume-buyer-or-call-either-producer-and-buyer-cannot-write-seller-or-receipt');

      const actualId = `buyer-producer-v347-${randomUUID()}`;
      const actualAttempt = await claim(actualId);
      const actual = charge(actualId, actualAttempt);
      await insertRequestUsageAndChargeTxPg(buyerDb, actual);
      const actualState = await snapshot(actualId);
      assert.deepEqual(actualState, { spent: '1.010000', logs: 1,
        events: 1, attempts: 1, receipt_spent: '10000' });
      assert.deepEqual((await migrator.unsafe(`SELECT event_version,
        buyer_charge_basis,buyer_debit_micros::text AS debit
        FROM ${outbox}.shared_key_economic_events WHERE event_id=$1`,
      [actualId]))[0], { event_version: 2,
        buyer_charge_basis: 'actual', debit: '10000' });
      stage('real-buyer-login-critical-writer-commits-debit-private-receipt-and-v2-event',
        { state: actualState });
      await insertRequestUsageAndChargeTxPg(buyerDb, actual);
      assert.deepEqual(await snapshot(actualId), actualState);
      assert.equal((await buyer.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
        $1,'actual','actual',10000,$2::jsonb,'verify') AS result`,
      [actualId, payload(actualAttempt)]))[0].result, 'verified');
      await expectCode(buyer.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
        $1,'actual','actual',10000,$2::jsonb,'create')`,
      [actualId, payload(actualAttempt)]), '23514',
      'shared_key_economic_producer_tx');
      stage('buyer-v2-replay-verifies-without-double-charge-or-post-commit-recreate');

      const reservedId = `buyer-producer-v347-${randomUUID()}`;
      const reservedAttempt = await claim(reservedId);
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='buyer-v347'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'buyer-v347','api-key-v347',0,10000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [reservedId]);
      });
      await insertRequestUsageAndChargeTxPg(buyerDb,
        charge(reservedId, reservedAttempt, { mode: 'reserved', basis: 'reserved' }));
      assert.deepEqual((await migrator.unsafe(`SELECT
        e.buyer_debit_micros::text AS debit,
        l.budget_charged_micros::text AS guardrail,
        r.state, r.settled_micros::text AS settled
        FROM ${outbox}.shared_key_economic_events e
        JOIN ${gateway}.api_key_request_logs l ON l.id=e.request_log_id
        JOIN ${gateway}.user_budget_reservations r ON r.request_id=e.request_log_id
        WHERE e.request_log_id=$1`, [reservedId]))[0],
      { debit: '20000', guardrail: '10000', state: 'expired', settled: '20000' });
      assert.equal((await snapshot(reservedId)).receipt_spent, '20000');
      stage('buyer-login-reserved-ceiling-uses-v344-same-transaction-receipt');

      const invalidId = `buyer-producer-v347-${randomUUID()}`;
      const invalid = await claim(invalidId);
      const beforeInvalid = (await snapshot(invalidId)).spent;
      await expectCode(insertRequestUsageAndChargeTxPg(buyerDb,
        charge(invalidId, { ...invalid, quoteVersionId: 'wrong-version' })),
      '23514', 'shared_key_economic_producer_attempt');
      assert.deepEqual(await snapshot(invalidId), { spent: beforeInvalid,
        logs: 0, events: 0, attempts: 0, receipt_spent: null });
      stage('invalid-quote-rolls-back-buyer-debit-log-receipt-and-event');

      const forgedId = `buyer-producer-v347-${randomUUID()}`;
      const forgedAttempt = await claim(forgedId);
      await expectCode(runtime.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
        (id,api_key_id,user_id,workspace_id,model_id,provider_id,status,
          charged_cost,standard_cost,budget_charged_micros)
        VALUES($1,'api-key-v347','buyer-v347','workspace-v347',
          'fixture/model','fixture-provider','success',0.01,0.01,10000)`,
      [forgedId]), '23514', 'shared_key_economic_event_required');
      await expectCode(runtime.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
        $1,'actual','actual',10000,$2::jsonb,'create')`,
      [forgedId, payload(forgedAttempt)]), '42501');
      assert.deepEqual(await snapshot(forgedId), { spent: '1.030000',
        logs: 0, events: 0, attempts: 0, receipt_spent: null });
      stage('runtime-forged-log-rolls-back-and-cannot-create-private-v2-event');

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const [rerun] = await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend_update,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${outbox}.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
          'EXECUTE') AS runtime_v2_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${outbox}.write_shared_key_economic_event(text,text,text,jsonb,text)',
          'EXECUTE') AS runtime_v1_execute`);
      assert.deepEqual(rerun, { runtime_spend_update: true,
        runtime_v2_execute: false, runtime_v1_execute: false });
      await expectCode(runtime.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
        $1,'actual','actual',10000,$2::jsonb,'create')`,
      [forgedId, payload(forgedAttempt)]), '42501');
      stage('current-grant-rerun-reopens-gateway-writes-but-not-outbox-producer-execute',
        { acl: rerun });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 4000) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = String(error?.stack ?? error).slice(0, 1500);
        failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`guardrail-post-reservation-denial-v348-runtime-buyer-client-successor-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

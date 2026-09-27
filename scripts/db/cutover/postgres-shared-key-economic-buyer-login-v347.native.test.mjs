// Review-only native proof: v2 event producer moves to a distinct buyer LOGIN.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { insertRequestUsageAndChargeTxPg } from '../../../packages/core/src/db/postgres/critical-writes.impl.ts';
import { chargeParams } from '../../../packages/core/src/test-support/postgres-financial-engine.mjs';
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
  params.economicOutbox = { eventVersion: 2, buyerChargeBasis: basis,
    buyerUsageCertainty: basis === 'reserved' ? 'unknown' : 'actual',
    attempts: [attempt] };
  return params;
}

test('dedicated buyer LOGIN runs the real v2 critical writer and ordinary runtime cannot impersonate it',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-economic-buyer-login-v347-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; PG73 plus review-only C04 proposals',
      limitations: [
        'No production role, migration, grant routine, secret, Worker, Queue, or Hyperdrive binding changed.',
        'The buyer LOGIN is a trusted financial capability and still has direct UPDATE rights on granted buyer columns.',
        'The v1 producer is disabled for the ordinary runtime; every old v1 caller needs a reviewed migration gate before cutover.',
        'The current grant routine rerun restores ordinary runtime gateway financial table writes, even though it does not restore private outbox producer EXECUTE.',
        'Seller consumer, release/adjustment, management, payout, admission ownership, C03 recovery, D1/MySQL, and Linux CI are not covered.',
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
      process.stdout.write(`economic-buyer-login-v347-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

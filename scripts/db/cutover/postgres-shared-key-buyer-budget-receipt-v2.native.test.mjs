// Review-only PG18.6 fixture. Fresh owned loopback cluster and synthetic facts.
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
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation'],
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

test('native PG18 v2 buyer account receipt binds each economic debit to budget changes',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-buyer-budget-receipt-v2-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only companion has no formal migration or production activation.',
        'Runtime still has broad gateway-table write privileges; the legacy earning path needs a separate role split.',
        'Existing reservations lack admission receipts and must drain or be explicitly reconciled before activation.',
        'Old-epoch v2 settlement is blocked: a historic capacity hold is not proof of an ordinary-user spend debit.',
        'Receipt maintenance is review-only; production retention policy, schedule, index/lock impact, and authorization are still required.',
        'Actual per-attempt usage and cost are synthetic; production observer integration remains open.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE ROLE producer_v2_acl_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const quoteProducer = client(cluster,
        'cinatoken_gateway_shared_quote_attempt_producer', quotePassword, 'quote');
      clients.push(migrator, runtime, quoteProducer);
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
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.public_model_daily_stats
          TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.guardrail_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.user_budget_reservations
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
      report.sourceSha256.nativeTest = sha(await readFile(new URL(import.meta.url)));
      for (let i = 0; i < proposals.length - 2; i++) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${proposals[i][1]} = 'reviewed-${i === 0 ? 'v2' : 'v1'}'`);
          await tx.unsafe(bodies[i]).simple();
        });
      }
      stage('quote-dispatch-v1-producer-consumer-and-v2-debit-installed');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-2)[1]} = 'reviewed-v1'`);
        await tx.unsafe(bodies.at(-2)).simple();
      });
      stage('v2-producer-installed-before-receipt');
      const activate = () => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-1)[1]} = 'reviewed-v1'`);
        await tx.unsafe(bodies.at(-1)).simple();
      });
      await assert.rejects(migrator.begin(tx => tx.unsafe(bodies.at(-1)).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER TABLE ${gateway}.users ENABLE ROW LEVEL SECURITY`);
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-1)[1]} = 'reviewed-v1'`);
        await tx.unsafe(bodies.at(-1)).simple();
      }), /activation or dependency differs/u);
      stage('default-off-and-account-row-security-drift-roll-back-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT EXECUTE ON FUNCTIONS TO producer_v2_acl_probe;`).simple();
      await assert.rejects(activate(), /activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT to_regclass(
        '${outbox}.shared_key_buyer_budget_tx_receipts')
        IS NULL AS absent`))[0].absent, true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE EXECUTE ON FUNCTIONS FROM producer_v2_acl_probe;`).simple();
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT SELECT ON TABLES TO producer_v2_acl_probe;`).simple();
      await assert.rejects(activate(), /activation or dependency differs/u);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE SELECT ON TABLES FROM producer_v2_acl_probe;`).simple();
      stage('third-role-default-function-and-table-grants-roll-back-install');
      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('v2-seller','seller-v2@example.invalid'),
          ('v2-buyer','buyer-v2@example.invalid');
        INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES ('v2-unreceipted-old','v2-buyer','v2-api-key',0,
            1000000,20000,'dispatched',now()+interval '1 day',now(),now());`).simple();
      await activate();
      const producer = `${outbox}.write_shared_key_economic_event_v2`;
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_economic_events`),
        '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_buyer_settlement_tx_markers`),
        '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_buyer_budget_tx_receipts`),
        '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.shared_key_buyer_reservation_admissions`),
        '42501');
      stage('private-receipt-and-admission-tables-deny-runtime-access');

      await migrator.unsafe(`INSERT INTO ${gateway}.workspaces
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
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_max=100 WHERE id='v2-buyer'`);
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
      const directLog = (tx, id) => tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
          input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
        VALUES ($1,'v2-buyer','v2-api-key','v2-workspace',0.010000,10000,
          10,5,0,0)`, [id]);
      const directProduce = (tx, id, attempt, basis = 'actual', debit = 10000) =>
        tx.unsafe(`SELECT ${outbox}.write_shared_key_economic_event_v2(
          $1,$2,$3,$4,$5::jsonb,'create') AS outcome`,
        [id, basis, basis === 'reserved' ? 'unknown' : 'actual',
          debit, payload([attempt])]);
      const directCreate = (id, attempt, { before, after,
        basis = 'actual', debit = 10000 } = {}) => runtime.begin(async tx => {
        if (before) await before(tx);
        await directLog(tx, id);
        await directProduce(tx, id, attempt, basis, debit);
        if (after) await after(tx);
      });
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
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [reservedId]);
      });
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
      stage('v2-current-epoch-reserved-ceiling-has-admission-and-settlement-receipts');

      const reservedActualId = `v2-${randomUUID()}`;
      const reservedActual = outcome(reservedActualId, await claim(reservedActualId));
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET
          budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`,
        [reservedActualId]);
      });
      await insertRequestUsageAndChargeTxPg(db, charge(reservedActualId,
        reservedActual, { basis: 'actual', mode: 'actual' }));
      assert.deepEqual(await eventRow(reservedActualId), {
        event_version: 2, buyer_charge_basis: 'actual',
        guardrail: '10000', debit: '10000',
      });
      stage('v2-current-epoch-actual-reservation-debits-and-releases-hold');

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

      const missingId = `v2-${randomUUID()}`;
      const missing = outcome(missingId, await claim(missingId));
      const beforeMissing = await spent();
      await expectCode(directCreate(missingId, missing), '23514',
        'shared_key_buyer_receipt_net_debit');
      assert.equal(await spent(), beforeMissing);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [missingId]))[0].n, 0);
      stage('runtime-log-and-v2-producer-without-account-debit-roll-back');

      const transientId = `v2-${randomUUID()}`;
      const transient = outcome(transientId, await claim(transientId));
      await expectCode(directCreate(transientId, transient, {
        before: tx => tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+0.01 WHERE id='v2-buyer'`),
        after: tx => tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent-0.01 WHERE id='v2-buyer'`),
      }), '23514', 'shared_key_buyer_receipt_later_change');
      assert.equal(await spent(), beforeMissing);
      stage('transient-increase-then-refund-in-one-transaction-is-not-a-debit');

      const earlyId = `v2-${randomUUID()}`;
      const early = outcome(earlyId, await claim(earlyId));
      await expectCode(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+0.01 WHERE id='v2-buyer'`);
        await directLog(tx, earlyId);
        await directProduce(tx, earlyId, early);
        await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent-0.01 WHERE id='v2-buyer'`);
      }), '23514', 'shared_key_buyer_receipt_later_change');
      assert.equal(await spent(), beforeMissing);
      stage('early-validation-followed-by-account-change-rolls-back');

      const earlyHoldId = `v2-${randomUUID()}`;
      const heldBefore = (await migrator.unsafe(`SELECT budget_reserved_micros::text AS n
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].n;
      await expectCode(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'reserved',now()+interval '1 day',now(),now())`, [earlyHoldId]);
        await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros-20000
          WHERE id='v2-buyer'`);
      }), '23514', 'shared_key_buyer_admission_later_change');
      assert.equal((await migrator.unsafe(`SELECT budget_reserved_micros::text AS n
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].n, heldBefore);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [earlyHoldId]))[0].n, 0);
      stage('early-admission-followed-by-hold-change-rolls-back');

      const earlyLimitId = `v2-${randomUUID()}`;
      await expectCode(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'reserved',now()+interval '1 day',now(),now())`, [earlyLimitId]);
        await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_max=0
          WHERE id='v2-buyer'`);
      }), '23514', 'shared_key_buyer_admission_later_change');
      assert.equal((await migrator.unsafe(`SELECT budget_max::text AS n
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].n, '100.000000');
      stage('early-admission-followed-by-capacity-change-rolls-back');

      const doubleIds = [`v2-${randomUUID()}`, `v2-${randomUUID()}`];
      const doubleAttempts = await Promise.all(doubleIds.map(async id =>
        outcome(id, await claim(id))));
      await expectCode(runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+0.01 WHERE id='v2-buyer'`);
        for (let i = 0; i < doubleIds.length; i++) {
          await directLog(tx, doubleIds[i]);
          await directProduce(tx, doubleIds[i], doubleAttempts[i]);
        }
      }), '23514', 'shared_key_buyer_receipt_net_debit');
      assert.equal(await spent(), beforeMissing);
      stage('two-v2-events-cannot-share-one-account-debit');

      const otherId = `v2-${randomUUID()}`;
      const other = outcome(otherId, await claim(otherId));
      await expectCode(directCreate(otherId, other, {
        before: tx => tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+0.01 WHERE id='v2-seller'`),
      }), '23514', 'shared_key_buyer_receipt_net_debit');
      stage('other-user-account-update-cannot-back-buyer-event');

      const epochId = `v2-${randomUUID()}`;
      const epoch = outcome(epochId, await claim(epochId));
      await expectCode(directCreate(epochId, epoch, {
        before: tx => tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+0.01,budget_epoch=budget_epoch+1
          WHERE id='v2-buyer'`),
      }), '23514', 'shared_key_buyer_receipt_epoch');
      stage('same-transaction-epoch-change-cannot-back-v2-event');

      const bypassId = `v2-${randomUUID()}`;
      const bypass = outcome(bypassId, await claim(bypassId));
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET
          budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [bypassId]);
      });
      await expectCode(directCreate(bypassId, bypass, {
        basis: 'reserved', debit: 20000,
        before: tx => tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='expired',settled_micros=20000,terminal_at=now()
          WHERE request_id=$1`, [bypassId]),
      }), '23514', 'shared_key_buyer_receipt_net_debit');
      assert.equal((await migrator.unsafe(`SELECT state FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [bypassId]))[0].state,
      'dispatched');
      stage('reservation-terminal-marker-without-account-debit-rolls-back');

      await expectCode(runtime.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET limit_micros=0 WHERE request_id=$1`, [bypassId]),
      '23514', 'shared_key_buyer_admission_immutable');
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET budget_epoch=budget_epoch+1 WHERE request_id=$1`, [bypassId]),
      '23514', 'shared_key_buyer_admission_immutable');
      await expectCode(migrator.unsafe(`DELETE FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [bypassId]),
      '23514', 'shared_key_buyer_admission_immutable');
      stage('verified-admission-capacity-epoch-and-row-remain-immutable');

      await expectCode(directCreate(bypassId, bypass, {
        basis: 'reserved', debit: 20000,
        before: async tx => {
          await tx.unsafe(`UPDATE ${gateway}.users SET
            budget_reserved_micros=budget_reserved_micros-20000,
            budget_spent=budget_spent+0.02 WHERE id='v2-buyer'`);
          await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
            SET state='expired',settled_micros=20000,terminal_at=now()
            WHERE request_id=$1`, [bypassId]);
        },
        after: async tx => {
          await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
            SET budget_epoch=budget_epoch+1 WHERE request_id=$1`, [bypassId]);
        },
      }), '23514', 'shared_key_buyer_admission_immutable');
      assert.equal((await migrator.unsafe(`SELECT state FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [bypassId]))[0].state,
      'dispatched');
      stage('early-event-validation-cannot-precede-reservation-epoch-change');

      const actualBypassId = `v2-${randomUUID()}`;
      const actualBypass = outcome(actualBypassId, await claim(actualBypassId));
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET
          budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`,
        [actualBypassId]);
      });
      await expectCode(directCreate(actualBypassId, actualBypass, {
        before: tx => tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='settled',settled_micros=10000,terminal_at=now()
          WHERE request_id=$1`, [actualBypassId]),
      }), '23514', 'shared_key_buyer_receipt_net_debit');
      stage('actual-reservation-terminal-marker-without-account-debit-rolls-back');

      const forgedAdmissionId = `v2-${randomUUID()}`;
      await runtime.begin(tx => tx.unsafe(`INSERT INTO
        ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'v2-buyer','v2-api-key',0,100000000,
          30000,'reserved',now()+interval '1 day',now(),now())`,
      [forgedAdmissionId]));
      assert.equal((await migrator.unsafe(`SELECT hold_verified FROM
        ${outbox}.shared_key_buyer_reservation_admissions
        WHERE request_id=$1`, [forgedAdmissionId]))[0].hold_verified, false);
      const forgedAdmission = outcome(forgedAdmissionId,
        await claim(forgedAdmissionId));
      await expectCode(directCreate(forgedAdmissionId, forgedAdmission, {
        basis: 'reserved', debit: 30000,
        before: tx => tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='expired',settled_micros=30000,terminal_at=now()
          WHERE request_id=$1`, [forgedAdmissionId]),
      }), '23514', 'shared_key_buyer_receipt_admission');
      stage('reservation-without-hold-stays-legacy-compatible-but-cannot-back-v2');

      await migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at,created_at,updated_at)
        VALUES ('v2-unlimited-legacy','v2-seller','v2-api-key',0,
          100000000,10000,'reserved',now()+interval '1 day',now(),now());
        INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
        VALUES ('v2-pre-settled-recovery','v2-buyer','v2-api-key',0,
          100000000,10000,10000,'settled',now()+interval '1 day',now(),now());`).simple();
      const legacyAdmissions = await migrator.unsafe(`SELECT request_id,hold_verified
        FROM ${outbox}.shared_key_buyer_reservation_admissions
        WHERE request_id IN ('v2-unlimited-legacy','v2-pre-settled-recovery')
        ORDER BY request_id`);
      assert.deepEqual(legacyAdmissions.map(({ request_id,hold_verified }) =>
        [request_id,hold_verified]), [
        ['v2-pre-settled-recovery',false],
        ['v2-unlimited-legacy',false],
      ]);
      stage('unlimited-and-pre-settled-legacy-reservations-still-commit');
      await migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET request_id='v2-unlimited-legacy-renamed'
        WHERE request_id='v2-unlimited-legacy';
        DELETE FROM ${gateway}.user_budget_reservations
        WHERE request_id='v2-unlimited-legacy-renamed'`);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_buyer_reservation_admissions
        WHERE request_id LIKE 'v2-unlimited-legacy%'`))[0].n, 0);
      stage('non-economic-reservation-rename-and-delete-remain-possible');

      const oldId = `v2-${randomUUID()}`;
      const old = outcome(oldId, await claim(oldId));
      const oldActualId = `v2-${randomUUID()}`;
      const oldActual = outcome(oldActualId, await claim(oldActualId));
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET
          budget_reserved_micros=budget_reserved_micros+50000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            30000,'dispatched',now()+interval '1 day',now(),now())`, [oldId]);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',0,100000000,
            20000,'dispatched',now()+interval '1 day',now(),now())`, [oldActualId]);
      });
      await migrator.unsafe(`UPDATE ${gateway}.users SET
        budget_epoch=budget_epoch+1,budget_spent=0,
        budget_reserved_micros=0 WHERE id='v2-buyer'`);
      await expectCode(insertRequestUsageAndChargeTxPg(db, charge(oldId, old,
        { basis: 'reserved', mode: 'reserved' })),
      '23514', 'shared_key_buyer_receipt_old_epoch');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [oldId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT state FROM
        ${gateway}.user_budget_reservations WHERE request_id=$1`, [oldId]))[0].state,
      'dispatched');
      assert.equal(await spent(), '0.000000');
      stage('old-epoch-reserved-v2-rolls-back-despite-historic-admission');
      await expectCode(insertRequestUsageAndChargeTxPg(db,
        charge(oldActualId, oldActual, { basis: 'actual', mode: 'actual' })),
      '23514', 'shared_key_buyer_receipt_old_epoch');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [oldActualId]))[0].n, 0);
      assert.equal(await spent(), '0.000000');
      stage('old-epoch-actual-v2-rolls-back-despite-historic-admission');

      const unreceipted = outcome('v2-unreceipted-old',
        await claim('v2-unreceipted-old'));
      await expectCode(directCreate('v2-unreceipted-old', unreceipted, {
        basis: 'reserved', debit: 20000,
        before: tx => tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='expired',settled_micros=20000,terminal_at=now()
          WHERE request_id='v2-unreceipted-old'`),
      }), '23514', 'shared_key_buyer_receipt_admission');
      stage('pre-activation-old-reservation-without-admission-is-blocked');

      const badId = `v2-${randomUUID()}`;
      const bad = outcome(badId, await claim(badId), { quoteVersionId: 'wrong-version' });
      await expectCode(insertRequestUsageAndChargeTxPg(db, charge(badId, bad)),
        '23514', 'shared_key_economic_producer_attempt');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [badId]))[0].n, 0);
      stage('invalid-outcome-rolls-back-buyer-log-budget-and-event');

      const exhaustedId = `v2-${randomUUID()}`;
      await runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=100,
          budget_reserved_micros=budget_reserved_micros+20000
          WHERE id='v2-buyer'`);
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,state,expires_at,created_at,updated_at)
          VALUES($1,'v2-buyer','v2-api-key',1,100000000,
            20000,'reserved',now()+interval '1 day',now(),now())`, [exhaustedId]);
      });
      assert.equal((await migrator.unsafe(`SELECT hold_verified FROM
        ${outbox}.shared_key_buyer_reservation_admissions
        WHERE request_id=$1`, [exhaustedId]))[0].hold_verified, false);
      stage('exhausted-budget-direct-reservation-cannot-gain-admission');

      const maintenance = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/shared-key-buyer-budget-receipt-maintenance.sql',
        import.meta.url), 'utf8');
      report.sourceSha256['shared-key-buyer-budget-receipt-maintenance.sql'] = sha(maintenance);
      await expectCode(migrator.begin(tx => tx.unsafe(maintenance).simple()),
        '23514', 'shared_key_buyer_receipt_maintenance_install');
      await migrator.unsafe(`GRANT SELECT(xact_id) ON
        ${outbox}.shared_key_buyer_budget_tx_receipts TO cinatoken_gateway_runtime`);
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.shared_key_buyer_receipt_maintenance_install='reviewed-v1'`);
        await tx.unsafe(maintenance).simple();
      }), '23514', 'shared_key_buyer_receipt_maintenance_install');
      await migrator.unsafe(`REVOKE SELECT(xact_id) ON
        ${outbox}.shared_key_buyer_budget_tx_receipts FROM cinatoken_gateway_runtime`);
      stage('receipt-maintenance-rejects-column-grant-drift');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.shared_key_buyer_receipt_maintenance_install='reviewed-v1'`);
        await tx.unsafe(maintenance).simple();
      });
      stage('receipt-maintenance-default-off-install-and-postflight');

      const backfillSql = `SELECT ${outbox}.backfill_buyer_budget_receipt_time($1) AS n`;
      const pruneSql = `SELECT ${outbox}.prune_buyer_budget_receipts(
        pg_catalog.clock_timestamp()-interval '90 days',$1) AS n`;
      const runMaintenance = (query, params) => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.shared_key_buyer_receipt_maintenance_run='reviewed-v1'`);
        return tx.unsafe(query, params);
      });
      await expectCode(runtime.unsafe(backfillSql, [1]), '42501');
      await expectCode(migrator.unsafe(backfillSql, [1]), '23514',
        'shared_key_buyer_receipt_maintenance_run');
      await expectCode(runMaintenance(backfillSql, [1001]), '23514',
        'shared_key_buyer_receipt_maintenance_run');
      stage('receipt-maintenance-runtime-denied-and-run-bounded');

      const countMissingTime = async () => (await migrator.unsafe(`SELECT
        count(*)::int AS n FROM ${outbox}.shared_key_buyer_budget_tx_receipts
        WHERE first_seen_at IS NULL`))[0].n;
      const beforeBackfill = await countMissingTime();
      assert.ok(beforeBackfill > 1);
      assert.equal((await runMaintenance(backfillSql, [1]))[0].n, 1);
      assert.equal(await countMissingTime(), beforeBackfill - 1);
      assert.equal((await runMaintenance(backfillSql, [1000]))[0].n,
        beforeBackfill - 1);
      assert.equal(await countMissingTime(), 0);
      stage('receipt-old-row-timestamps-backfill-in-bounded-pages');

      const maintenancePeer = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'maintenance-peer');
      clients.push(maintenancePeer);
      const [lockedReceipt] = await migrator.unsafe(`SELECT xact_id::text AS xid,
        user_id FROM ${outbox}.shared_key_buyer_budget_tx_receipts
        ORDER BY xact_id,user_id LIMIT 1`);
      await migrator.unsafe(`UPDATE ${outbox}.shared_key_buyer_budget_tx_receipts
        SET first_seen_at=NULL WHERE xact_id=$1::xid8 AND user_id=$2`,
      [lockedReceipt.xid, lockedReceipt.user_id]);
      let releaseMaintenanceLock;
      let signalMaintenanceLock;
      const maintenanceLockReady = new Promise(resolve => { signalMaintenanceLock = resolve; });
      const maintenanceLockWait = new Promise(resolve => { releaseMaintenanceLock = resolve; });
      const maintenanceLock = maintenancePeer.begin(async tx => {
        await tx.unsafe(`SELECT 1 FROM
          ${outbox}.shared_key_buyer_budget_tx_receipts
          WHERE xact_id=$1::xid8 AND user_id=$2 FOR UPDATE`,
        [lockedReceipt.xid, lockedReceipt.user_id]);
        signalMaintenanceLock();
        await maintenanceLockWait;
      });
      await maintenanceLockReady;
      try {
        assert.equal((await runMaintenance(backfillSql, [1000]))[0].n, 0);
        assert.equal(await countMissingTime(), 1);
      } finally {
        releaseMaintenanceLock();
        await maintenanceLock;
      }
      assert.equal((await runMaintenance(backfillSql, [1000]))[0].n, 1);
      assert.equal(await countMissingTime(), 0);
      stage('receipt-backfill-zero-can-mean-locked-row-and-requires-retry');

      let releaseBlocker;
      let signalReady;
      const blockerReady = new Promise(resolve => { signalReady = resolve; });
      const blockerWait = new Promise(resolve => { releaseBlocker = resolve; });
      const blocker = runtime.begin(async tx => {
        const xid = (await tx.unsafe(`SELECT pg_catalog.pg_current_xact_id()::text AS xid`))[0].xid;
        signalReady(xid);
        await blockerWait;
      });
      const blockerXid = await blockerReady;
      try {
        const agedXids = [];
        for (let i = 0; i < 2; i++) {
          const xid = await migrator.begin(async tx => {
            await tx.unsafe(`UPDATE ${gateway}.users SET
              budget_spent=budget_spent+0.000001 WHERE id='v2-buyer'`);
            return (await tx.unsafe(`SELECT pg_catalog.pg_current_xact_id()::text AS xid`))[0].xid;
          });
          assert.ok(BigInt(xid) > BigInt(blockerXid));
          assert.equal((await migrator.unsafe(`SELECT first_seen_at IS NOT NULL AS stamped
            FROM ${outbox}.shared_key_buyer_budget_tx_receipts
            WHERE xact_id=$1::xid8 AND user_id='v2-buyer'`, [xid]))[0].stamped, true);
          await migrator.unsafe(`UPDATE ${outbox}.shared_key_buyer_budget_tx_receipts
            SET first_seen_at=pg_catalog.clock_timestamp()-interval '100 days'
            WHERE xact_id=$1::xid8 AND user_id='v2-buyer'`, [xid]);
          agedXids.push(xid);
        }
        stage('new-receipts-receive-default-timestamp');
        assert.equal((await runMaintenance(pruneSql, [1000]))[0].n, 0);
        assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
          FROM ${outbox}.shared_key_buyer_budget_tx_receipts
          WHERE xact_id IN ($1::xid8,$2::xid8)`, agedXids))[0].n, 2);
        stage('open-older-xid-fences-otherwise-eligible-receipts');
      } finally {
        releaseBlocker();
        await blocker;
      }
      assert.equal((await runMaintenance(pruneSql, [1]))[0].n, 1);
      assert.equal((await runMaintenance(pruneSql, [1]))[0].n, 1);
      assert.equal((await runMaintenance(pruneSql, [1]))[0].n, 0);
      stage('completed-xid-receipts-prune-in-bounded-pages');

      // Integrate the already reviewed v2 debit/receipt with durable delivery
      // and the version-aware seller consumer, still on this disposable cluster.
      const deliveryPassword = randomBytes(24).toString('hex');
      const recoveryPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_shared_earning_delivery
          LOGIN PASSWORD '${deliveryPassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_recovery
          LOGIN PASSWORD '${recoveryPassword}';
        GRANT CONNECT ON DATABASE postgres TO
          cinatoken_gateway_shared_earning_delivery,
          cinatoken_gateway_shared_earning_recovery;`).simple();
      const delivery = client(cluster,
        'cinatoken_gateway_shared_earning_delivery', deliveryPassword, 'delivery');
      const consumer = client(cluster,
        'cinatoken_gateway_shared_earning_consumer', consumerPassword, 'consumer');
      clients.push(delivery, consumer);
      const deliverySql = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/shared-key-economic-delivery.sql',
        import.meta.url), 'utf8');
      const consumerV2Sql = await readFile(new URL(
        '../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer-v2.sql',
        import.meta.url), 'utf8');
      report.sourceSha256['shared-key-economic-delivery.sql'] = sha(deliverySql);
      report.sourceSha256['shared-key-snapshot-earning-consumer-v2.sql'] = sha(consumerV2Sql);
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.shared_key_economic_delivery_activation='reviewed-v1'`);
        await tx.unsafe(deliverySql).simple();
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_economic_delivery.shared_key_event_delivery_jobs
        WHERE event_id=$1 AND status='pending'`, [actualId]))[0].n, 1);
      stage('delivery-installer-backfills-existing-receipted-v2-event');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.shared_key_consumer_v2_activation='reviewed-v1'`);
        await tx.unsafe(consumerV2Sql).simple();
      });
      stage('version-aware-consumer-installs-after-durable-delivery');

      const deliveredId = `v2-${randomUUID()}`;
      const delivered = outcome(deliveredId, await claim(deliveredId));
      await insertRequestUsageAndChargeTxPg(db, charge(deliveredId, delivered));
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_economic_delivery.shared_key_event_delivery_jobs
        WHERE event_id=$1 AND status='pending'`, [deliveredId]))[0].n, 1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_events
        WHERE event_id=$1 AND event_version=2`, [deliveredId]))[0].n, 1);
      stage('critical-writer-v2-debit-receipt-event-and-job-commit-together');

      const rollbackId = `v2-${randomUUID()}`;
      const rollback = outcome(rollbackId, await claim(rollbackId),
        { quoteVersionId: 'wrong-version' });
      const spentBeforeRollback = await spent();
      await expectCode(insertRequestUsageAndChargeTxPg(db,
        charge(rollbackId, rollback)), '23514', 'shared_key_economic_producer_attempt');
      assert.equal(await spent(), spentBeforeRollback);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id=$1`, [rollbackId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${outbox}.shared_key_economic_events WHERE event_id=$1`, [rollbackId]))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_economic_delivery.shared_key_event_delivery_jobs
        WHERE event_id=$1`, [rollbackId]))[0].n, 0);
      stage('invalid-v2-outcome-rolls-back-buyer-log-debit-event-and-job');

      const [deliveryClaim] = await delivery.unsafe(`SELECT * FROM
        cinatoken_economic_delivery.claim_event($1,60)`, [deliveredId]);
      assert.equal(deliveryClaim.out_event_id, deliveredId);
      await expectCode(delivery.unsafe(`SELECT
        cinatoken_economic_delivery.ack_event($1,$2)`,
      [deliveredId, deliveryClaim.out_claim_token]), '23514');
      const [sellerBefore] = await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='v2-seller'`);
      const [decision] = await consumer.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event($1)`,
      [deliveredId]);
      assert.equal(decision.out_event_id, deliveredId);
      assert.equal(decision.out_decision, 'credited');
      const [sellerAfter] = await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='v2-seller'`);
      assert.ok(BigInt(sellerAfter.n) > BigInt(sellerBefore.n));
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_economic_consumer.shared_key_event_consumptions
        WHERE event_id=$1`, [deliveredId]))[0].n, 1);
      assert.equal((await delivery.unsafe(`SELECT
        cinatoken_economic_delivery.ack_event($1,$2) AS disposition`,
      [deliveredId, deliveryClaim.out_claim_token]))[0].disposition, 'completed');
      assert.equal((await migrator.unsafe(`SELECT status FROM
        cinatoken_economic_delivery.shared_key_event_delivery_jobs
        WHERE event_id=$1`, [deliveredId]))[0].status, 'completed');
      stage('consumer-marker-and-seller-credit-gate-delivery-ack');
      await consumer.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event($1)`,
      [deliveredId]);
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='v2-seller'`))[0].n,
      sellerAfter.n);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_economic_consumer.shared_key_attempt_consumptions
        WHERE event_id=$1 AND decision='credited'`,
      [deliveredId]))[0].n, 1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.portal_ledger_entries
        WHERE reference_type='shared_key_attempt_earning'
          AND reference_id=$1::text`, [delivered.attemptId]))[0].n, 1);
      stage('v2-delivery-consumer-replay-keeps-one-credit');

      const [pendingClaim] = await delivery.unsafe(`SELECT * FROM
        cinatoken_economic_delivery.claim_event($1,60)`, [reservedId]);
      assert.equal(pendingClaim.out_event_id, reservedId);
      const [pendingDecision] = await consumer.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event($1)`,
      [reservedId]);
      assert.equal(pendingDecision.out_decision, 'pending_manual');
      assert.equal((await migrator.unsafe(`SELECT decision FROM
        cinatoken_economic_consumer.shared_key_attempt_consumptions
        WHERE event_id=$1`, [reservedId]))[0].decision, 'pending_manual');
      assert.equal((await delivery.unsafe(`SELECT
        cinatoken_economic_delivery.ack_event($1,$2) AS disposition`,
      [reservedId, pendingClaim.out_claim_token]))[0].disposition, 'completed');
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='v2-seller'`))[0].n,
      sellerAfter.n);
      stage('reserved-v2-delivery-marks-pending-without-seller-credit');
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
      process.stdout.write(`buyer-budget-receipt-v2-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

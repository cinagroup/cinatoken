// Review-only PG18.6 fixture. Fresh owned loopback cluster and synthetic facts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const outbox = 'cinatoken_economic_outbox';
const consumerSchema = 'cinatoken_economic_consumer';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposalNames = [
  'shared-key-quote-versions.sql',
  'shared-key-dispatch-quote-attempts.sql',
  'shared-key-economic-outbox.sql',
  'shared-key-economic-outbox-producer.sql',
  'shared-key-snapshot-earning-consumer.sql',
  'shared-key-buyer-debit-v2.sql',
];
const activations = [
  "cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'",
  "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'",
  "cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'",
  "cinatoken.shared_key_economic_producer_activation = 'reviewed-v1'",
  "cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'",
  "cinatoken.shared_key_buyer_debit_v2_activation = 'reviewed-v1'",
];
const sha = value => createHash('sha256').update(value).digest('hex');
const info = error => ({ code: error?.code ?? null,
  constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 300) });
const client = (cluster, username, password, label) => postgres({
  host: '127.0.0.1', port: cluster.port, database: 'postgres',
  username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
  connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
  onnotice() {}, connection: { application_name: `cinatoken-buyer-debit-v2-${label}` },
});
async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES
    (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}
async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    assert.equal(error?.code, code, String(error));
    if (constraint) assert.equal(error?.constraint_name, constraint, String(error));
    return true;
  });
}
function event(id, count, { version = 2, basis = 'actual',
  charge = '10.000000', guardrailMicros = 10000000,
  debitMicros = 10000000, buyerCertainty = 'actual',
  eventCertainty = 'confirmed' } = {}) {
  return { event_id: id, request_log_id: id,
    event_type: 'shared_key_usage_settled', event_version: version,
    buyer_user_id: 'v2-buyer', buyer_api_key_id: 'v2-api-key',
    workspace_id: 'v2-workspace', buyer_charge_basis: basis,
    buyer_usage_certainty: buyerCertainty, buyer_charged_cost: charge,
    buyer_budget_charged_micros: guardrailMicros,
    buyer_input_tokens: 1000000, buyer_output_tokens: 2000000,
    buyer_cache_read_tokens: 0, buyer_cache_write_tokens: 0,
    attempt_count: count, event_certainty: eventCertainty,
    ...(version === 2 || debitMicros !== null
      ? { buyer_debit_micros: debitMicros } : {}),
  };
}
function outcome(id, claim, { unknown = false } = {}) {
  return { event_id: id, request_log_id: id,
    attempt_id: claim.attempt_id, attempt_index: claim.attempt_index,
    shared_key_id: claim.shared_key_id,
    transition_id: claim.transition_id,
    quote_version_id: claim.quote_version_id,
    usage_certainty: unknown ? 'unknown' : 'actual',
    input_tokens: unknown ? null : 1000000,
    output_tokens: unknown ? null : 2000000,
    cache_read_tokens: unknown ? null : 0,
    cache_write_tokens: unknown ? null : 0,
    provider_cost_certainty: unknown ? 'unknown' : 'actual',
    provider_cost_micros: unknown ? null : 2000000,
    evidence_kind: unknown ? 'timeout' : 'provider_usage',
    evidence_sha256: unknown ? null : 'c'.repeat(64),
    observed_at: new Date().toISOString() };
}
async function insertLog(tx, id, charge = '10.000000', guardrailMicros = 10000000) {
  await tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'v2-buyer','v2-api-key','v2-workspace',$2,$3,1000000,2000000,0,0)`,
  [id, charge, guardrailMicros]);
}
test('native PG18 v2 ordinary buyer debit is separate and v1 consumer stays gated',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-buyer-debit-v2-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'No v2 runtime producer or version-aware seller consumer is installed.',
        'The synthetic fixture performs a buyer budget update; it does not prove a real recordUsage caller or Workers/Hyperdrive transaction identity.',
        'A late actual reconciliation for enrolled reserved v2 requests is rejected until a reviewed adjustment event is designed.',
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
        CREATE ROLE buyer_debit_acl_probe NOLOGIN;
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
      const consumer = client(cluster,
        'cinatoken_gateway_shared_earning_consumer', consumerPassword, 'consumer');
      clients.push(migrator, runtime, quoteProducer, consumer);
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
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`,
            [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha(corpus.join('\n'));
      stage('formal-pg73-installed');
      const bodies = [];
      for (const name of proposalNames) {
        const body = await readFile(new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,
          import.meta.url), 'utf8');
        report.sourceSha256[name] = sha(body);
        bodies.push(body);
      }
      report.sourceSha256.nativeTest = sha(await readFile(new URL(import.meta.url)));
      for (let i = 0; i < proposalNames.length - 1; i++) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${activations[i]}`);
          await tx.unsafe(bodies[i]).simple();
        });
      }
      report.consumerBodyMd5 = (await migrator.unsafe(`SELECT pg_catalog.md5(
        pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),
          pg_catalog.chr(10))) AS body_md5 FROM pg_catalog.pg_proc p
        WHERE p.oid='${consumerSchema}.consume_shared_key_economic_event(text)'
          ::pg_catalog.regprocedure`))[0].body_md5;
      stage('quote-dispatch-v1-producer-and-consumer-installed');
      const activateV2 = async (sql = migrator) => sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${activations[5]}`);
        await tx.unsafe(bodies[5]).simple();
      });
      await assert.rejects(migrator.begin(tx => tx.unsafe(bodies[5]).simple()),
        /Buyer debit v2 activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.schema_migrations
          SET version='0042_forged_middle.sql'
          WHERE version='0042_gateway_keys_workspace.sql'`);
        await tx.unsafe(`SET LOCAL ${activations[5]}`);
        await tx.unsafe(bodies[5]).simple();
      }), /Buyer debit v2 activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        pg_catalog.pg_attribute WHERE attrelid=
        '${outbox}.shared_key_economic_events'::pg_catalog.regclass
        AND attname='buyer_debit_micros' AND NOT attisdropped`))[0].n, 0);
      stage('default-off-and-exact-pg73-ledger-drift-rollback');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER FUNCTION ${consumerSchema}.
          consume_shared_key_economic_event(text) SECURITY INVOKER`);
        await tx.unsafe(`SET LOCAL ${activations[5]}`);
        await tx.unsafe(bodies[5]).simple();
      }), /Buyer debit v2 activation or dependency differs/u);
      stage('v1-consumer-catalog-drift-rejected-before-v2-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT EXECUTE ON FUNCTIONS TO buyer_debit_acl_probe;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${consumerSchema}
        GRANT EXECUTE ON FUNCTIONS TO buyer_debit_acl_probe;`).simple();
      await assert.rejects(activateV2(),
        /Buyer debit v2 ACL exceeds reviewed contract/u);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        pg_catalog.pg_attribute WHERE attrelid=
        '${outbox}.shared_key_economic_events'::pg_catalog.regclass
        AND attname='buyer_debit_micros' AND NOT attisdropped`))[0].n, 0);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE EXECUTE ON FUNCTIONS FROM buyer_debit_acl_probe;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${consumerSchema}
        REVOKE EXECUTE ON FUNCTIONS FROM buyer_debit_acl_probe;`).simple();
      stage('third-role-default-function-grants-roll-back-entire-v2-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        GRANT SELECT ON TABLES TO buyer_debit_acl_probe;`).simple();
      await assert.rejects(activateV2(),
        /Buyer debit v2 ACL exceeds reviewed contract/u);
      assert.equal((await migrator.unsafe(`SELECT to_regclass(
        '${outbox}.shared_key_buyer_settlement_tx_markers') IS NULL AS absent`))[0]
        .absent, true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${outbox}
        REVOKE SELECT ON TABLES FROM buyer_debit_acl_probe;`).simple();
      stage('third-role-default-marker-table-grant-rolls-back-v2-install');
      await activateV2();
      stage('v2-schema-installed-without-new-runtime-privileges');
      await expectCode(runtime.unsafe(`SELECT buyer_debit_micros FROM
        ${outbox}.shared_key_economic_events`), '42501');
      await expectCode(consumer.unsafe(`SELECT buyer_debit_micros FROM
        ${outbox}.shared_key_economic_events`), '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${outbox}.
        shared_key_buyer_settlement_tx_markers`), '42501');
      await expectCode(runtime.unsafe(`SELECT ${outbox}.verify_buyer_debit_v2()`),
        '42501');
      stage('runtime-and-consumer-cannot-read-private-debit-or-run-guard');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('v2-seller','seller-v2@example.invalid'),
          ('v2-buyer','buyer-v2@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('v2-workspace','personal','v2-buyer','Default','default',
            true,'personal:v2-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('v2-api-key','synthetic-api-key','v2-buyer','v2-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('v2-key','v2-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator, `${quotes}.shared_key_quote_versions`, {
        version_id: 'v2-q1', shared_key_id: 'v2-key', seller_user_id: 'v2-seller',
        input_price_per_million: '1.250000', output_price_per_million: '2.500000',
        cache_read_price_per_million: '0.100000',
        cache_write_price_per_million: '0.200000',
        commission_rate: '0.100000', currency: 'USD',
        price_unit: 'per_million_tokens', billing_mode: 'shared_seller_key',
        entitlement_version: 'synthetic-entitlement-v1',
      });
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('v2-t1','v2-key',NULL,'activate','v2-q1','v2-seller')`);
      const claim = async id => (await quoteProducer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,1,
          'v2-key','synthetic-target')`, [randomUUID(), id]))[0];
      const consume = id => consumer.unsafe(`SELECT * FROM
        ${consumerSchema}.consume_shared_key_economic_event($1)`, [id]);
      const counts = async id => (await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_attempt_consumptions
          WHERE event_id=$1) AS details,
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_event_consumptions
          WHERE event_id=$1) AS markers,
        (SELECT count(*)::int FROM ${gateway}.portal_ledger_entries
          WHERE reference_type='shared_key_attempt_earning'
            AND reference_id IN (SELECT attempt_id::text FROM
              ${outbox}.shared_key_economic_event_attempts WHERE event_id=$1)) AS ledger`,
      [id]))[0];
      const settle = async (id, claimRow, eventRow, { reservationMicros,
        reservationState = 'expired', debitBudgetMicros = reservationMicros ?? 0,
        unknown = false } = {}) => migrator.begin(async tx => {
        if (reservationMicros !== undefined) {
          await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
            (request_id,user_id,api_key_id,budget_epoch,limit_micros,
              reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
            VALUES ($1,'v2-buyer','v2-api-key',0,100000000,$2,0,'reserved',
              now()+interval '1 hour',now(),now())`,
          [id, reservationMicros]);
          await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
            SET state=$2,settled_micros=$3,terminal_at=now(),updated_at=now()
            WHERE request_id=$1`, [id, reservationState, reservationMicros]);
        }
        await tx.unsafe(`UPDATE ${gateway}.users
          SET budget_spent=budget_spent+$1::numeric/1000000
          WHERE id='v2-buyer'`, [debitBudgetMicros]);
        await insertLog(tx, id, eventRow.buyer_charged_cost,
          eventRow.buyer_budget_charged_micros);
        await insertObject(tx, `${outbox}.shared_key_economic_events`, eventRow);
        await insertObject(tx, `${outbox}.shared_key_economic_event_attempts`,
          outcome(id, claimRow, { unknown }));
      });
      stage('synthetic-buyer-seller-and-pre-egress-quote-ready');

      const v1Claim = await claim('v1-compatible');
      await settle('v1-compatible', v1Claim,
        event('v1-compatible', 1, { version: 1, debitMicros: null }),
        { debitBudgetMicros: 10000000 });
      assert.equal((await migrator.unsafe(`SELECT buyer_debit_micros
        FROM ${outbox}.shared_key_economic_events
        WHERE event_id='v1-compatible'`))[0].buyer_debit_micros, null);
      const v1Result = (await consume('v1-compatible'))[0];
      assert.equal(v1Result.out_decision, 'credited');
      assert.deepEqual(await counts('v1-compatible'),
        { details: 1, markers: 1, ledger: 1 });
      stage('old-v1-event-and-consumer-remain-compatible');

      const reservedClaim = await claim('v2-reserved');
      await settle('v2-reserved', reservedClaim,
        event('v2-reserved', 1, { basis: 'reserved',
          buyerCertainty: 'unknown', eventCertainty: 'unresolved',
          debitMicros: 30000000 }),
        { reservationMicros: 30000000, unknown: true });
      const reservedFact = (await migrator.unsafe(`SELECT event_version,
        buyer_charge_basis, buyer_debit_micros::text AS debit,
        buyer_budget_charged_micros::text AS guardrail
        FROM ${outbox}.shared_key_economic_events
        WHERE event_id='v2-reserved'`))[0];
      assert.deepEqual(reservedFact, { event_version: 2,
        buyer_charge_basis: 'reserved', debit: '30000000', guardrail: '10000000' });
      await expectCode(consume('v2-reserved'), '23514',
        'shared_key_buyer_debit_v2_consumer_gate');
      assert.deepEqual(await counts('v2-reserved'),
        { details: 0, markers: 0, ledger: 0 });
      await expectCode(migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET settled_micros=10000000 WHERE request_id='v2-reserved'`),
      '23514', 'shared_key_buyer_debit_v2_adjustment_required');
      stage('reserved-ceiling-debit-differs-from-guardrail-and-old-consumer-blocked');

      const staleClaim = await claim('v2-stale-reservation');
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
          VALUES ('v2-stale-reservation','v2-buyer','v2-api-key',0,
            100000000,30000000,0,'reserved',
            now()+interval '1 hour',now(),now())`);
        await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='expired',settled_micros=30000000
          WHERE request_id='v2-stale-reservation'`);
      });
      await expectCode(settle('v2-stale-reservation', staleClaim,
        event('v2-stale-reservation', 1, { basis: 'reserved',
          buyerCertainty: 'unknown', eventCertainty: 'unresolved',
          debitMicros: 30000000 }), { unknown: true }),
      '23514', 'shared_key_buyer_debit_v2_same_tx');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.api_key_request_logs
        WHERE id='v2-stale-reservation'`))[0].n, 0);
      stage('precommitted-reservation-cannot-be-adopted-by-later-event');

      const terminalInsertClaim = await claim('v2-terminal-insert');
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
          VALUES ('v2-terminal-insert','v2-buyer','v2-api-key',0,
            100000000,30000000,30000000,'expired',
            now()+interval '1 hour',now(),now())`);
        await insertLog(tx, 'v2-terminal-insert');
        await insertObject(tx, `${outbox}.shared_key_economic_events`,
          event('v2-terminal-insert', 1, { basis: 'reserved',
            buyerCertainty: 'unknown', eventCertainty: 'unresolved',
            debitMicros: 30000000 }));
        await insertObject(tx, `${outbox}.shared_key_economic_event_attempts`,
          outcome('v2-terminal-insert', terminalInsertClaim, { unknown: true }));
      }), '23514', 'shared_key_buyer_debit_v2_same_tx');
      stage('terminal-reservation-insert-cannot-fabricate-settlement-marker');

      const mutatedClaim = await claim('v2-mutated-terminal');
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
          VALUES ('v2-mutated-terminal','v2-buyer','v2-api-key',0,
            100000000,30000000,0,'reserved',
            now()+interval '1 hour',now(),now())`);
        await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET state='expired',settled_micros=30000000
          WHERE request_id='v2-mutated-terminal'`);
      });
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.user_budget_reservations
          SET reserved_micros=40000000 WHERE request_id='v2-mutated-terminal'`);
        await insertLog(tx, 'v2-mutated-terminal', '30.000000', 10000000);
        await insertObject(tx, `${outbox}.shared_key_economic_events`,
          event('v2-mutated-terminal', 1, { basis: 'actual',
            charge: '30.000000', debitMicros: 30000000 }));
        await insertObject(tx, `${outbox}.shared_key_economic_event_attempts`,
          outcome('v2-mutated-terminal', mutatedClaim));
      }), '23514', 'shared_key_buyer_debit_v2_same_tx');
      assert.equal((await migrator.unsafe(`SELECT reserved_micros::text AS amount
        FROM ${gateway}.user_budget_reservations
        WHERE request_id='v2-mutated-terminal'`))[0].amount, '30000000');
      stage('terminal-reservation-mutation-cannot-refresh-prior-debit-marker');

      const actualClaim = await claim('v2-actual');
      await settle('v2-actual', actualClaim, event('v2-actual', 1),
        { debitBudgetMicros: 10000000 });
      await expectCode(consume('v2-actual'), '23514',
        'shared_key_buyer_debit_v2_consumer_gate');
      assert.deepEqual(await counts('v2-actual'),
        { details: 0, markers: 0, ledger: 0 });
      await expectCode(migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
        VALUES ('v2-actual','v2-buyer','v2-api-key',0,100000000,
          10000000,10000000,'settled',now()+interval '1 hour',now(),now())`),
      '23514', 'shared_key_buyer_debit_v2_adjustment_required');
      stage('v2-actual-also-blocked-from-old-credit-function');

      const wrongClaim = await claim('v2-wrong-debit');
      const spentBefore = (await migrator.unsafe(`SELECT budget_spent::text AS n
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].n;
      await expectCode(settle('v2-wrong-debit', wrongClaim,
        event('v2-wrong-debit', 1, { basis: 'reserved',
          buyerCertainty: 'unknown', eventCertainty: 'unresolved',
          debitMicros: 20000000 }),
        { reservationMicros: 30000000, unknown: true }),
      '23514', 'shared_key_buyer_debit_v2_reserved');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.api_key_request_logs WHERE id='v2-wrong-debit'`))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.user_budget_reservations
        WHERE request_id='v2-wrong-debit'`))[0].n, 0);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS n
        FROM ${gateway}.users WHERE id='v2-buyer'`))[0].n, spentBefore);
      stage('wrong-reserved-debit-rolls-back-log-reservation-and-buyer-budget');

      const wrongStateClaim = await claim('v2-wrong-state');
      await expectCode(settle('v2-wrong-state', wrongStateClaim,
        event('v2-wrong-state', 1, { basis: 'reserved',
          buyerCertainty: 'unknown', eventCertainty: 'unresolved',
          debitMicros: 30000000 }),
        { reservationMicros: 30000000, reservationState: 'settled', unknown: true }),
      '23514', 'shared_key_buyer_debit_v2_reserved');
      const actualMismatchClaim = await claim('v2-actual-mismatch');
      await expectCode(settle('v2-actual-mismatch', actualMismatchClaim,
        event('v2-actual-mismatch', 1, { debitMicros: 9000000 }),
        { debitBudgetMicros: 9000000 }),
      '23514', 'shared_key_buyer_debit_v2_actual');
      stage('reserved-state-and-actual-amount-mismatches-rejected');

      const noDebitClaim = await claim('v2-no-debit');
      await expectCode(settle('v2-no-debit', noDebitClaim,
        event('v2-no-debit', 1, { debitMicros: null }),
        { debitBudgetMicros: 10000000 }), '23514',
      'shared_key_economic_event_version_debit');
      const v1DebitClaim = await claim('v1-forged-debit');
      await expectCode(settle('v1-forged-debit', v1DebitClaim,
        event('v1-forged-debit', 1, { version: 1, debitMicros: 10000000 }),
        { debitBudgetMicros: 10000000 }), '23514',
      'shared_key_economic_event_version_debit');
      stage('versioned-debit-shape-rejects-null-v2-and-nonnull-v1');

      await expectCode(migrator.unsafe(`UPDATE ${outbox}.shared_key_economic_events
        SET buyer_debit_micros=1 WHERE event_id='v2-reserved'`),
      '23514', 'shared_key_economic_append_only');
      await expectCode(runtime.unsafe(`SELECT ${outbox}.write_shared_key_economic_event(
        'v2-reserved','reserved','unknown','[]'::jsonb,'verify')`),
      '23514', 'shared_key_economic_producer_input');
      stage('immutable-v2-fact-and-old-producer-still-rejects-reserved');
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = info(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = info(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key buyer debit v2 report: ' + reportPath);
    }
    if (failure) throw failure;
  });

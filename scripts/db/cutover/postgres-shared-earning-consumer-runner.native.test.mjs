// Review-only, owned loopback PostgreSQL 18.6 fixture for the local one-shot runner.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createPostgresSharedEarningConsumer, SHARED_EARNING_CONSUMER_ROLE,
} from '../../../packages/proxy/src/runtime/postgres-shared-earning-consumer.ts';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const outbox = 'cinatoken_economic_outbox';
const consumerSchema = 'cinatoken_economic_consumer';
const migrationPath = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposalPaths = {
  quote: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url),
  dispatch: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url),
  outbox: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url),
  consumer: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql', import.meta.url),
};
const sha = value => createHash('sha256').update(value).digest('hex');
const info = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) });
const wrap = raw => ({ driver: 'postgres', raw, drizzle: {} });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-earning-runner-v341-${label}` } });
}

async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES
    (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}

test('native PG18 one-shot shared earning runner uses only dedicated LOGIN and replays event ID',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-earning-runner-v341-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned PG18.6; PG73 + review-only quote/dispatch/outbox/consumer proposals + one-shot runner',
      stages: [], sourceSha256: {}, limitations: [
        'This is an event-ID-only local candidate. No Queue binding, durable scanner, retry lease, DLQ or production worker is active.',
        'Retire callback completion does not independently prove physical PostgreSQL socket closure.',
        'The test is synthetic and PostgreSQL-only; buyer outbox producer and real Workers/Hyperdrive remain separate gates.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const producerPassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${producerPassword}';
        CREATE ROLE ${SHARED_EARNING_CONSUMER_ROLE} LOGIN PASSWORD '${consumerPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, cinatoken_gateway_shared_quote_attempt_producer,
          ${SHARED_EARNING_CONSUMER_ROLE};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        ALTER ROLE ${SHARED_EARNING_CONSUMER_ROLE} IN DATABASE postgres SET transaction_timeout='30s';
        ALTER ROLE ${SHARED_EARNING_CONSUMER_ROLE} IN DATABASE postgres SET statement_timeout='15s';
        ALTER ROLE ${SHARED_EARNING_CONSUMER_ROLE} IN DATABASE postgres SET lock_timeout='5s';
        ALTER ROLE ${SHARED_EARNING_CONSUMER_ROLE} IN DATABASE postgres
          SET idle_in_transaction_session_timeout='10s';`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const producer = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', producerPassword, 'producer');
      const consumerA = client(cluster, SHARED_EARNING_CONSUMER_ROLE, consumerPassword, 'consumer-a');
      const consumerB = client(cluster, SHARED_EARNING_CONSUMER_ROLE, consumerPassword, 'consumer-b');
      clients.push(migrator, runtime, producer, consumerA, consumerB);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationPath)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrationPath), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      stage('formal-pg73-installed');
      const bodies = {};
      for (const [name, path] of Object.entries(proposalPaths)) bodies[name] = await readFile(path, 'utf8');
      report.sourceSha256 = { formalMigrationCorpus: sha(corpus.join('\n')),
        quoteProposal: sha(bodies.quote), dispatchProposal: sha(bodies.dispatch),
        outboxProposal: sha(bodies.outbox), consumerProposal: sha(bodies.consumer),
        runner: sha(await readFile(new URL('../../../packages/proxy/src/runtime/postgres-shared-earning-consumer.ts', import.meta.url))),
        nativeTest: sha(await readFile(new URL(import.meta.url))) };
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(bodies.quote).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_quote_attempt_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.dispatch).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.outbox).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      });
      stage('private-economic-contracts-installed');

      const run = (sql, forbidden, eventId) => createPostgresSharedEarningConsumer({ enabled: true,
        forbiddenClients: forbidden.map(wrap),
        async openInvocationClient() { return wrap(sql); },
        async retireConfirmedClient(value) { assert.equal(value.raw, sql); },
      }).runEventOnce(eventId);
      const denied = await run(runtime, [migrator, producer], 'absent');
      assert.equal(denied.status, 'authority_rejected');
      assert.equal(denied.queueAckSafe, false);
      const absent = await run(consumerA, [migrator, runtime, producer], 'absent');
      assert.equal(absent.status, 'outcome_unknown');
      assert.equal(absent.queueAckSafe, false);
      stage('runtime-login-rejected-and-absent-event-fails-closed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('runner-seller','seller-runner@example.invalid'),
          ('runner-buyer','buyer-runner@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('runner-workspace','personal','runner-buyer','Default','default',
            true,'personal:runner-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('runner-api-key','synthetic-api-key','runner-buyer','runner-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('runner-key','runner-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator, `${quotes}.shared_key_quote_versions`, {
        version_id: 'runner-quote', shared_key_id: 'runner-key', seller_user_id: 'runner-seller',
        input_price_per_million: '1.250000', output_price_per_million: '2.500000',
        cache_read_price_per_million: '0.100000', cache_write_price_per_million: '0.200000',
        commission_rate: '0.100000', currency: 'USD', price_unit: 'per_million_tokens',
        billing_mode: 'shared_seller_key', entitlement_version: 'synthetic-entitlement-v1',
      });
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('runner-transition','runner-key',NULL,'activate','runner-quote','runner-seller')`);
      const eventId = 'runner-event-1';
      const [claim] = await producer.unsafe(`SELECT * FROM ${quotes}.
        claim_shared_key_dispatch_quote_attempt($1,$2,1,'runner-key','synthetic-target')`,
      [randomUUID(), eventId]);
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
            input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
          VALUES ($1,'runner-buyer','runner-api-key','runner-workspace',
            10.000000,10000000,1000000,2000000,0,0)`, [eventId]);
        await insertObject(tx, `${outbox}.shared_key_economic_events`, {
          event_id: eventId, request_log_id: eventId, event_type: 'shared_key_usage_settled',
          event_version: 1, buyer_user_id: 'runner-buyer', buyer_api_key_id: 'runner-api-key',
          workspace_id: 'runner-workspace', buyer_charge_basis: 'actual',
          buyer_usage_certainty: 'actual', buyer_charged_cost: '10.000000',
          buyer_budget_charged_micros: 10000000, buyer_input_tokens: 1000000,
          buyer_output_tokens: 2000000, buyer_cache_read_tokens: 0,
          buyer_cache_write_tokens: 0, attempt_count: 1, event_certainty: 'confirmed',
        });
        await insertObject(tx, `${outbox}.shared_key_economic_event_attempts`, {
          event_id: eventId, request_log_id: eventId, attempt_id: claim.attempt_id,
          attempt_index: claim.attempt_index, shared_key_id: claim.shared_key_id,
          transition_id: claim.transition_id, quote_version_id: claim.quote_version_id,
          usage_certainty: 'actual', input_tokens: 1000000, output_tokens: 2000000,
          cache_read_tokens: 0, cache_write_tokens: 0, provider_cost_certainty: 'actual',
          provider_cost_micros: 2000000, evidence_kind: 'provider_usage',
          evidence_sha256: 'b'.repeat(64), observed_at: new Date().toISOString(),
        });
      });
      stage('immutable-synthetic-event-committed');

      const forbidden = [migrator, runtime, producer];
      const first = await run(consumerA, forbidden, eventId);
      assert.deepEqual(first, { status: 'processed', queueAckSafe: false,
        physicalClose: 'not_observed', result: { eventId, decision: 'credited',
          creditedAttempts: 1, pendingAttempts: 0, netMicros: '5625000' } });
      const replay = await run(consumerB, forbidden, eventId);
      assert.deepEqual(replay, first);
      const [balances] = await migrator.unsafe(`SELECT
        (SELECT balance_micros::text FROM ${gateway}.user_earnings
          WHERE user_id='runner-seller') AS balance,
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_event_consumptions
          WHERE event_id=$1) AS markers,
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_attempt_consumptions
          WHERE event_id=$1) AS details,
        (SELECT count(*)::int FROM ${gateway}.portal_ledger_entries
          WHERE reference_type='shared_key_attempt_earning'
            AND reference_id=$2) AS ledger`, [eventId, String(claim.attempt_id)]);
      assert.deepEqual(balances, { balance: '5625000', markers: 1, details: 1, ledger: 1 });
      stage('runner-commit-and-event-id-replay-credit-once');
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = info(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = info(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared earning consumer runner report: ' + reportPath);
    }
    if (failure) throw failure;
  });

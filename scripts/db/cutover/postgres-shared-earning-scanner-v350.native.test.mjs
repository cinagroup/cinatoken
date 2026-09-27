// Review-only native PG18 fixture for the Cron scanner, with synthetic facts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { runSharedEarningScannerClient } from
  '../../../packages/proxy/src/runtime/postgres-shared-earning-scanner.ts';

const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposalPaths = {
  quote: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url),
  dispatch: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url),
  outbox: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url),
  consumer: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql', import.meta.url),
  delivery: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-delivery.sql', import.meta.url),
};
const sha = text => createHash('sha256').update(text).digest('hex');
const info = error => ({ code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 300) });
const wrap = raw => ({ driver: 'postgres', raw, drizzle: {} });
function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `earning-scanner-v350-${label}` } });
}
async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES
    (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

test('native PG18 scanner consumes durable event IDs through dedicated LOGINs and restart',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = new URL('../../../docs/developers/architecture/implementation-evidence/C04-postgres-shared-earning-scanner-v350-results.json', import.meta.url);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, formal PG73 and review-only economic proposals; no deployed Worker/Hyperdrive',
      sourceSha256: {}, stages: [], limitations: [
        'The native fixture exercises direct PostgreSQL clients, not Cloudflare Workers or Hyperdrive.',
        'Synthetic events and local roles do not prove production credential custody, origin pool budget, or deployment.',
        'The v342 proposal and v340 consumer remain review-only; scanner activation is absent from shipped Wrangler config.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const passwords = Object.fromEntries(['migrator', 'runtime', 'producer', 'consumer', 'delivery', 'recovery']
        .map(name => [name, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.consumer}';
        CREATE ROLE cinatoken_gateway_shared_earning_delivery LOGIN PASSWORD '${passwords.delivery}';
        CREATE ROLE cinatoken_gateway_shared_earning_recovery LOGIN PASSWORD '${passwords.recovery}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer,cinatoken_gateway_shared_earning_delivery,
          cinatoken_gateway_shared_earning_recovery;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET transaction_timeout='30s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET statement_timeout='15s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET lock_timeout='5s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET idle_in_transaction_session_timeout='10s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET transaction_timeout='30s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET statement_timeout='15s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET lock_timeout='5s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET idle_in_transaction_session_timeout='10s';`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', passwords.migrator, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', passwords.runtime, 'runtime');
      const producer = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', passwords.producer, 'producer');
      const earning = client(cluster, 'cinatoken_gateway_shared_earning_consumer', passwords.consumer, 'consumer');
      const delivery = client(cluster, 'cinatoken_gateway_shared_earning_delivery', passwords.delivery, 'delivery');
      clients.push(migrator, runtime, producer, earning, delivery);
      await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe('INSERT INTO cinatoken_gateway.schema_migrations(version) VALUES ($1)', [name]);
        });
      }
      stage('formal-pg73-installed');
      const bodies = {};
      for (const [name, path] of Object.entries(proposalPaths)) bodies[name] = await readFile(path, 'utf8');
      report.sourceSha256 = {
        formalMigrationCorpus: sha(corpus.join('\n')),
        ...Object.fromEntries(Object.entries(bodies).map(([name, body]) => [`${name}Proposal`, sha(body)])),
        scannerRuntime: sha(await readFile(new URL('../../../packages/proxy/src/runtime/postgres-shared-earning-scanner.ts', import.meta.url))),
        nativeTest: sha(await readFile(new URL(import.meta.url))),
      };
      const activate = (name, body) => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.${name} = 'reviewed-v1'`);
        await tx.unsafe(body).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(bodies.quote).simple();
      });
      await activate('shared_quote_attempt_activation', bodies.dispatch);
      await activate('shared_key_economic_outbox_activation', bodies.outbox);
      await activate('shared_key_snapshot_consumer_activation', bodies.consumer);
      await activate('shared_key_economic_delivery_activation', bodies.delivery);
      stage('review-only-event-delivery-and-consumer-installed');

      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email) VALUES
          ('scanner-seller','scanner-seller@example.invalid'),
          ('scanner-buyer','scanner-buyer@example.invalid');
        INSERT INTO cinatoken_gateway.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('scanner-workspace','personal','scanner-buyer','Default','default',
            true,'personal:scanner-buyer');
        INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id)
          VALUES ('scanner-api-key','synthetic-api-key','scanner-buyer','scanner-workspace');
        INSERT INTO cinatoken_gateway.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('scanner-key','scanner-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator, 'cinatoken_economic_quotes.shared_key_quote_versions', {
        version_id: 'scanner-q1', shared_key_id: 'scanner-key', seller_user_id: 'scanner-seller',
        input_price_per_million: '1.250000', output_price_per_million: '2.500000',
        cache_read_price_per_million: '0.100000', cache_write_price_per_million: '0.200000',
        commission_rate: '0.100000', currency: 'USD', price_unit: 'per_million_tokens',
        billing_mode: 'shared_seller_key', entitlement_version: 'synthetic-entitlement-v1',
      });
      await migrator.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('scanner-t1','scanner-key',NULL,'activate','scanner-q1','scanner-seller')`);
      const settle = async eventId => {
        const [quote] = await producer.unsafe(`SELECT * FROM
          cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
          $1,$2,1,'scanner-key','synthetic-target')`, [randomUUID(), eventId]);
        await migrator.begin(async tx => {
          await tx.unsafe(`INSERT INTO cinatoken_gateway.api_key_request_logs
            (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
              input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
            VALUES ($1,'scanner-buyer','scanner-api-key','scanner-workspace',
              10.000000,10000000,1000000,2000000,0,0)`, [eventId]);
          await insertObject(tx, 'cinatoken_economic_outbox.shared_key_economic_events', {
            event_id: eventId, request_log_id: eventId, event_type: 'shared_key_usage_settled',
            event_version: 1, buyer_user_id: 'scanner-buyer', buyer_api_key_id: 'scanner-api-key',
            workspace_id: 'scanner-workspace', buyer_charge_basis: 'actual',
            buyer_usage_certainty: 'actual', buyer_charged_cost: '10.000000',
            buyer_budget_charged_micros: 10000000, buyer_input_tokens: 1000000,
            buyer_output_tokens: 2000000, buyer_cache_read_tokens: 0,
            buyer_cache_write_tokens: 0, attempt_count: 1, event_certainty: 'confirmed',
          });
          await insertObject(tx, 'cinatoken_economic_outbox.shared_key_economic_event_attempts', {
            event_id: eventId, request_log_id: eventId, attempt_id: quote.attempt_id,
            attempt_index: quote.attempt_index, shared_key_id: quote.shared_key_id,
            transition_id: quote.transition_id, quote_version_id: quote.quote_version_id,
            usage_certainty: 'actual', input_tokens: 1000000, output_tokens: 2000000,
            cache_read_tokens: 0, cache_write_tokens: 0,
            provider_cost_certainty: 'actual', provider_cost_micros: 2000000,
            evidence_kind: 'provider_usage', evidence_sha256: 'c'.repeat(64),
            observed_at: new Date().toISOString(),
          });
        });
      };
      const job = async id => (await migrator.unsafe(`SELECT status,attempt_count
        FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs WHERE event_id=$1`, [id]))[0];
      const balance = async () => BigInt((await migrator.unsafe(`SELECT balance_micros::text AS amount
        FROM cinatoken_gateway.user_earnings WHERE user_id='scanner-seller'`))[0]?.amount ?? 0);
      const makeRun = (deliveryRaw = delivery, earningRaw = earning) => () =>
        runSharedEarningScannerClient({ deliveryClient: wrap(deliveryRaw),
          async openEarningClient() { return wrap(earningRaw); },
          async retireConfirmedEarningClient() {},
        }, { maxItems: 1, admissionBudgetMs: 25_000, leaseSeconds: 300 });

      await settle('scanner-permission');
      await assert.rejects(makeRun(runtime)(), /Dedicated PostgreSQL shared earning delivery LOGIN/);
      assert.deepEqual(await job('scanner-permission'), { status: 'pending', attempt_count: 0 });
      await assert.rejects(makeRun(delivery, runtime)(), /consumer outcome unconfirmed/);
      assert.deepEqual(await job('scanner-permission'), { status: 'leased', attempt_count: 1 });
      assert.equal(await balance(), 0n);
      stage('wrong-delivery-and-consumer-logins-denied');
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute'
        WHERE event_id='scanner-permission'`);
      assert.deepEqual(await makeRun()(), { claimed: 1, completed: 1,
        housekeeping: 0, stopReason: 'item_limit' });
      assert.equal((await job('scanner-permission')).status, 'completed');
      assert.equal(await balance(), 5625000n);
      stage('expired-lease-restart-credits-once');

      await settle('scanner-ack-loss');
      let deliveryTransactions = 0;
      const ackLoss = { begin: async run => {
        const value = await delivery.begin(run);
        if (++deliveryTransactions === 2) throw new Error('synthetic ACK response lost');
        return value;
      } };
      await assert.rejects(makeRun(ackLoss)(), /synthetic ACK response lost/);
      assert.equal((await job('scanner-ack-loss')).status, 'completed');
      assert.equal(await balance(), 11250000n);
      assert.deepEqual(await makeRun()(), { claimed: 0, completed: 0,
        housekeeping: 0, stopReason: 'no_claim' });
      assert.equal(await balance(), 11250000n);
      stage('lost-ack-response-restart-does-not-double-credit');

      await settle('scanner-consumer-loss');
      const consumerLoss = { begin: async run => {
        const value = await earning.begin(run);
        throw new Error('synthetic consumer response lost');
      } };
      await assert.rejects(makeRun(delivery, consumerLoss)(), /consumer outcome unconfirmed/);
      assert.equal((await job('scanner-consumer-loss')).status, 'leased');
      assert.equal(await balance(), 16875000n);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute'
        WHERE event_id='scanner-consumer-loss'`);
      assert.deepEqual(await makeRun()(), { claimed: 0, completed: 0,
        housekeeping: 1, stopReason: 'no_claim' });
      assert.equal((await job('scanner-consumer-loss')).status, 'completed');
      assert.equal(await balance(), 16875000n);
      stage('lost-consumer-response-marker-reconciled-without-recredit');

      await settle('scanner-housekeeping-first');
      await settle('scanner-after-housekeeping');
      assert.deepEqual(await job('scanner-housekeeping-first'),
        { status: 'pending', attempt_count: 0 });
      await earning.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)`,
      ['scanner-housekeeping-first']);
      assert.equal(await balance(), 22500000n);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()-interval '2 minutes'
        WHERE event_id='scanner-housekeeping-first'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()-interval '1 minute'
        WHERE event_id='scanner-after-housekeeping'`);
      assert.deepEqual(await makeRun()(), { claimed: 1, completed: 1,
        housekeeping: 1, stopReason: 'item_limit' });
      assert.equal((await job('scanner-housekeeping-first')).status, 'completed');
      assert.equal((await job('scanner-after-housekeeping')).status, 'completed');
      assert.equal(await balance(), 28125000n);
      assert.deepEqual(await makeRun()(), { claimed: 0, completed: 0,
        housekeeping: 0, stopReason: 'no_claim' });
      assert.equal(await balance(), 28125000n);
      stage('earliest-housekeeping-does-not-delay-later-pending-event');
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = info(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = info(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log('Native earning scanner report: ' + reportPath.pathname);
    }
    if (failure) throw failure;
  });

// Review-only owned PostgreSQL 18.6 fixture for bounded delivery backlog observation.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { observeDedicatedSharedEarningBacklog } from '../../../packages/proxy/src/runtime/postgres-shared-earning-backlog-observer.ts';

const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposalPaths = {
  quote: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url),
  dispatch: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url),
  outbox: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url),
  consumer: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql', import.meta.url),
  delivery: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-delivery.sql', import.meta.url),
  backlog: new URL('../../../packages/core/migrations-proposals/postgres/shared-key-delivery-backlog-observation.sql', import.meta.url),
};
const observerPath = new URL('../../../packages/proxy/src/runtime/postgres-shared-earning-backlog-observer.ts', import.meta.url);
const sha = text => createHash('sha256').update(text).digest('hex');
const info = error => ({ code: error?.code ?? null,
  constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 300) });
function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `earning-backlog-v353-${label}` } });
}
async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES
    (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}
async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    assert.equal(error?.code, code, String(error));
    if (constraint) assert.equal(error?.constraint_name, constraint, String(error));
    return true;
  });
}

test('PG18 backlog summary is capped, replayable and executable only by delivery LOGIN',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = new URL('../../../docs/developers/architecture/implementation-evidence/C04-shared-earning-backlog-observation-v353-results.json', import.meta.url);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, formal PG73 and review-only economic proposals; no Worker/Hyperdrive/remote SQL',
      sourceSha256: {}, stages: [], limitations: [
        'Counts are capped lower bounds when saturated; they are not full backlog totals.',
        'Oldest pending due age measures next_attempt_at lateness, not original event residence age.',
        'The dedicated Worker observation path is only locally composed; no Hyperdrive, alert or production database was used.',
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
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres SET transaction_timeout = '30s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres SET statement_timeout = '15s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres SET lock_timeout = '5s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres SET idle_in_transaction_session_timeout = '10s';
        CREATE ROLE cinatoken_gateway_shared_earning_recovery LOGIN PASSWORD '${passwords.recovery}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer,cinatoken_gateway_shared_earning_delivery,
          cinatoken_gateway_shared_earning_recovery;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', passwords.migrator, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', passwords.runtime, 'runtime');
      const producer = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', passwords.producer, 'producer');
      const earning = client(cluster, 'cinatoken_gateway_shared_earning_consumer', passwords.consumer, 'consumer');
      const delivery = client(cluster, 'cinatoken_gateway_shared_earning_delivery', passwords.delivery, 'delivery');
      const recovery = client(cluster, 'cinatoken_gateway_shared_earning_recovery', passwords.recovery, 'recovery');
      clients.push(migrator, runtime, producer, earning, delivery, recovery);
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
        backlogObserver: sha(await readFile(observerPath, 'utf8')),
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
      stage('review-only-economic-delivery-installed');
      report.indexDefinitions = await migrator.unsafe(`SELECT c.relname,
        pg_catalog.pg_get_indexdef(c.oid) AS definition
        FROM pg_catalog.pg_class c WHERE c.relnamespace=
          'cinatoken_economic_delivery'::pg_catalog.regnamespace
          AND c.relname IN ('shared_key_delivery_pending_due',
            'shared_key_delivery_expired_lease','shared_key_delivery_dead_letter')
        ORDER BY c.relname`);

      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(bodies.backlog).simple();
      }), '23514', 'shared_key_delivery_backlog_preflight');
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        'cinatoken_economic_delivery.observe_backlog(integer)') AS fn`))[0].fn, null);
      stage('default-off-installation-rejected');
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`DROP INDEX cinatoken_economic_delivery.shared_key_delivery_pending_due;
          CREATE INDEX shared_key_delivery_pending_due ON
            cinatoken_economic_delivery.shared_key_event_delivery_jobs(event_id,next_attempt_at)
            WHERE status='pending'`).simple();
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_delivery_backlog_observation_activation
          = 'reviewed-v1'`);
        await tx.unsafe(bodies.backlog).simple();
      }), '23514', 'shared_key_delivery_backlog_preflight');
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        'cinatoken_economic_delivery.observe_backlog(integer)') AS fn`))[0].fn, null);
      stage('same-name-wrong-index-definition-rejected');
      await activate('shared_key_delivery_backlog_observation_activation', bodies.backlog);
      const catalog = (await migrator.unsafe(`SELECT p.prosecdef,p.proconfig,
        pg_catalog.has_function_privilege('cinatoken_gateway_shared_earning_delivery',
          p.oid,'EXECUTE') AS delivery_execute,
        pg_catalog.has_table_privilege('cinatoken_gateway_shared_earning_delivery',
          'cinatoken_economic_delivery.shared_key_event_delivery_jobs','SELECT') AS delivery_select
        FROM pg_catalog.pg_proc p WHERE p.oid=
          'cinatoken_economic_delivery.observe_backlog(integer)'::pg_catalog.regprocedure`))[0];
      assert.equal(catalog.prosecdef, true);
      assert.equal(catalog.delivery_execute, true);
      assert.equal(catalog.delivery_select, false);
      assert.ok(catalog.proconfig.includes('enable_seqscan=off'));
      stage('narrow-definer-function-installed');

      const observe = (sql, cap = 1000) => sql.unsafe(`SELECT * FROM
        cinatoken_economic_delivery.observe_backlog($1::integer)`, [cap]);
      const [empty] = await delivery.begin(async tx => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        return observe(tx);
      });
      assert.deepEqual({ pending: empty.out_pending_count, due: empty.out_due_count,
        leased: empty.out_leased_count, dead: empty.out_dead_letter_count,
        pendingSaturated: empty.out_pending_saturated, age: empty.out_oldest_pending_due_age_seconds },
      { pending: 0, due: 0, leased: 0, dead: 0, pendingSaturated: false, age: null });
      stage('empty-read-only-observation');

      for (const denied of [runtime, earning, recovery])
        await expectCode(observe(denied), '42501');
      await expectCode(delivery.unsafe(`SELECT * FROM
        cinatoken_economic_delivery.shared_key_event_delivery_jobs`), '42501');
      await expectCode(delivery.unsafe('SET ROLE cinatoken_gateway_migrator'), '42501');
      for (const cap of [null, 0, 1001])
        await expectCode(observe(delivery, cap), '23514', 'shared_key_delivery_backlog_protocol');
      await expectCode(delivery.begin(async tx => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await observe(tx, 1);
      }), '23514', 'shared_key_delivery_backlog_protocol');
      stage('unauthorized-roles-and-cap-bounds-denied');

      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email) VALUES
          ('backlog-seller','backlog-seller@example.invalid'),
          ('backlog-buyer','backlog-buyer@example.invalid');
        INSERT INTO cinatoken_gateway.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('backlog-workspace','personal','backlog-buyer','Default','default',
            true,'personal:backlog-buyer');
        INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id)
          VALUES ('backlog-api-key','synthetic-api-key','backlog-buyer','backlog-workspace');
        INSERT INTO cinatoken_gateway.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('backlog-key','backlog-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator, 'cinatoken_economic_quotes.shared_key_quote_versions', {
        version_id: 'backlog-q1', shared_key_id: 'backlog-key', seller_user_id: 'backlog-seller',
        input_price_per_million: '1.250000', output_price_per_million: '2.500000',
        cache_read_price_per_million: '0.100000', cache_write_price_per_million: '0.200000',
        commission_rate: '0.100000', currency: 'USD', price_unit: 'per_million_tokens',
        billing_mode: 'shared_seller_key', entitlement_version: 'synthetic-entitlement-v1',
      });
      await migrator.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('backlog-t1','backlog-key',NULL,'activate','backlog-q1','backlog-seller')`);
      const settle = async eventId => {
        const [quote] = await producer.unsafe(`SELECT * FROM
          cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
          $1,$2,1,'backlog-key','synthetic-target')`, [randomUUID(), eventId]);
        await migrator.begin(async tx => {
          await tx.unsafe(`INSERT INTO cinatoken_gateway.api_key_request_logs
            (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
              input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
            VALUES ($1,'backlog-buyer','backlog-api-key','backlog-workspace',
              10.000000,10000000,1000000,2000000,0,0)`, [eventId]);
          await insertObject(tx, 'cinatoken_economic_outbox.shared_key_economic_events', {
            event_id: eventId, request_log_id: eventId, event_type: 'shared_key_usage_settled',
            event_version: 1, buyer_user_id: 'backlog-buyer', buyer_api_key_id: 'backlog-api-key',
            workspace_id: 'backlog-workspace', buyer_charge_basis: 'actual',
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
            cache_read_tokens: 0, cache_write_tokens: 0, provider_cost_certainty: 'actual',
            provider_cost_micros: 2000000, evidence_kind: 'provider_usage',
            evidence_sha256: 'c'.repeat(64), observed_at: new Date().toISOString(),
          });
        });
      };
      for (const id of ['pending-old', 'pending-due', 'pending-future',
        'lease-expired', 'lease-future', 'dead-letter', 'completed'])
        await settle(`backlog-${id}`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()-interval '2 minutes'
        WHERE event_id='backlog-pending-old'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()-interval '30 seconds'
        WHERE event_id='backlog-pending-due'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()+interval '2 minutes'
        WHERE event_id='backlog-pending-future'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET status='leased',attempt_count=1,claim_token=pg_catalog.gen_random_uuid(),
          claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute'
        WHERE event_id='backlog-lease-expired'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET status='leased',attempt_count=1,claim_token=pg_catalog.gen_random_uuid(),
          claimed_at=clock_timestamp()-interval '30 seconds',
          lease_until=clock_timestamp()+interval '2 minutes'
        WHERE event_id='backlog-lease-future'`);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET status='dead_letter',attempt_count=8,dead_at=clock_timestamp()
        WHERE event_id='backlog-dead-letter'`);
      await earning.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)`,
      ['backlog-completed']);
      await migrator.unsafe(`UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
        SET status='completed',completed_at=clock_timestamp()
        WHERE event_id='backlog-completed'`);
      stage('mixed-durable-jobs-seeded');

      const [bounded] = await observe(delivery, 2);
      assert.deepEqual({ pending: bounded.out_pending_count,
        pendingSaturated: bounded.out_pending_saturated,
        due: bounded.out_due_count, dueSaturated: bounded.out_due_saturated,
        leased: bounded.out_leased_count, leasedSaturated: bounded.out_leased_saturated,
        dead: bounded.out_dead_letter_count, deadSaturated: bounded.out_dead_letter_saturated },
      { pending: 2, pendingSaturated: true, due: 2, dueSaturated: true,
        leased: 2, leasedSaturated: false, dead: 1, deadSaturated: false });
      assert.ok(BigInt(bounded.out_oldest_pending_due_age_seconds) >= 120n);
      const [minimumCap] = await observe(delivery, 1);
      assert.deepEqual({ pending: minimumCap.out_pending_count,
        pendingSaturated: minimumCap.out_pending_saturated,
        due: minimumCap.out_due_count, dueSaturated: minimumCap.out_due_saturated,
        leased: minimumCap.out_leased_count, leasedSaturated: minimumCap.out_leased_saturated,
        dead: minimumCap.out_dead_letter_count, deadSaturated: minimumCap.out_dead_letter_saturated },
      { pending: 1, pendingSaturated: true, due: 1, dueSaturated: true,
        leased: 1, leasedSaturated: true, dead: 1, deadSaturated: false });
      const [exact] = await observe(delivery, 1000);
      assert.deepEqual({ pending: exact.out_pending_count, due: exact.out_due_count,
        leased: exact.out_leased_count, dead: exact.out_dead_letter_count,
        pendingSaturated: exact.out_pending_saturated, dueSaturated: exact.out_due_saturated },
      { pending: 3, due: 3, leased: 2, dead: 1,
        pendingSaturated: false, dueSaturated: false });
      stage('capped-saturation-and-exact-below-cap');

      const observedByWorker = await observeDedicatedSharedEarningBacklog({
        driver: 'postgres', raw: delivery,
      });
      assert.deepEqual({ cap: observedByWorker.cap, pending: observedByWorker.pending,
        due: observedByWorker.due, leased: observedByWorker.leased,
        deadLetter: observedByWorker.deadLetter,
        pendingSaturated: observedByWorker.pendingSaturated,
        dueSaturated: observedByWorker.dueSaturated },
      { cap: 1000, pending: 3, due: 3, leased: 2, deadLetter: 1,
        pendingSaturated: false, dueSaturated: false });
      assert.ok(BigInt(observedByWorker.oldestPendingDueAgeSeconds) >= 120n);
      await assert.rejects(observeDedicatedSharedEarningBacklog({
        driver: 'postgres', raw: runtime,
      }), /Dedicated PostgreSQL shared earning delivery LOGIN/);
      stage('worker-backlog-observer-composes-with-real-function-and-direct-login');

      const before = await migrator.unsafe(`SELECT event_id,status,attempt_count,
        next_attempt_at,lease_until,claim_token,completed_at,dead_at
        FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs ORDER BY event_id`);
      const [replayed] = await delivery.begin(async tx => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        return observe(tx, 2);
      });
      assert.deepEqual([replayed.out_pending_count, replayed.out_due_count,
        replayed.out_leased_count, replayed.out_dead_letter_count],
      [bounded.out_pending_count, bounded.out_due_count,
        bounded.out_leased_count, bounded.out_dead_letter_count]);
      const after = await migrator.unsafe(`SELECT event_id,status,attempt_count,
        next_attempt_at,lease_until,claim_token,completed_at,dead_at
        FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs ORDER BY event_id`);
      assert.deepEqual(after, before);
      stage('read-only-replay-preserves-jobs');
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = info(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = info(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log('Native earning backlog report: ' + reportPath.pathname);
    }
    if (failure) throw failure;
  });

// Review-only PG18.6 fixture. Fresh owned loopback cluster, synthetic facts only.
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
const economic = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = ['shared-key-quote-versions.sql',
  'shared-key-dispatch-quote-attempts.sql', 'shared-key-economic-outbox.sql',
  'shared-key-economic-outbox-producer.sql'];
const sha = value => createHash('sha256').update(value).digest('hex');
const evidenceSha = 'a'.repeat(64);

function sqlClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-economic-producer-v340-${label}` } });
}

function outcome(id, claim, overrides = {}) {
  return { attemptId: claim.attempt_id, requestLogId: id,
    attemptIndex: claim.attempt_index, sharedKeyId: claim.shared_key_id,
    transitionId: claim.transition_id, quoteVersionId: claim.quote_version_id,
    usageCertainty: 'actual', inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    providerCostCertainty: 'actual', providerCostMicros: 2000,
    evidenceKind: 'provider_usage', evidenceSha256: evidenceSha,
    observedAtIso: new Date().toISOString(), ...overrides };
}

function input(id, attempts, overrides = {}) {
  const params = chargeParams(id, 0.01);
  params.requestLog = { ...params.requestLog, userId: 'economic-buyer',
    apiKeyId: 'economic-api-key', workspaceId: 'economic-workspace',
    inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  params.userId = 'economic-buyer';
  params.beforeSpent = 0;
  params.audit = { ...params.audit, apiKeyId: 'economic-api-key', beforeSpent: 0 };
  return { ...params, economicOutbox: { buyerChargeBasis: 'actual',
    buyerUsageCertainty: 'actual', attempts }, ...overrides };
}

function dbPayload(attempts) {
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

async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    const databaseError = error?.cause ?? error;
    assert.equal(databaseError?.code, code, String(databaseError?.message ?? error));
    if (constraint) assert.equal(databaseError?.constraint_name, constraint, String(databaseError));
    return true;
  });
}

async function expectCause(work, pattern) {
  await assert.rejects(work, error => {
    assert.match(String(error?.cause?.message ?? error?.message ?? error), pattern);
    return true;
  });
}

test('native PG18 same-transaction shared-key economic producer and critical writer',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-economic-producer-v340-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'The opt-in core writer is not connected to recordUsage or a production economic producer.',
        'The caller must supply observed per-attempt usage/cost certainty; quote admission alone is not billable evidence.',
        'This fixture uses a direct local runtime LOGIN and does not prove Hyperdrive, Workers or any consumer/payout.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE economic_third NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = sqlClient(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const competingMigrator = sqlClient(cluster,
        'cinatoken_gateway_migrator', migratorPassword, 'competing-migrator');
      const runtime = sqlClient(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const quoteProducer = sqlClient(cluster,
        'cinatoken_gateway_shared_quote_attempt_producer', quotePassword, 'quote');
      clients.push(migrator, competingMigrator, runtime, quoteProducer);
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
      // The formal schema does not install an application runtime grant policy;
      // this fixture grants only the base tables touched by the critical writer.
      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${gateway} TO cinatoken_gateway_runtime;
        GRANT SELECT, UPDATE ON ${gateway}.api_keys,${gateway}.users,
          ${gateway}.guardrail_budget_windows TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT ON ${gateway}.api_key_request_logs
          TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.public_model_daily_stats
          TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.guardrail_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT SELECT, UPDATE ON ${gateway}.user_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT INSERT ON ${gateway}.user_audit_logs,
          ${gateway}.provider_attempt_availability
          TO cinatoken_gateway_runtime;`).simple();
      const bodies = await Promise.all(proposals.map(async name => {
        const body = await readFile(new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,
          import.meta.url), 'utf8');
        report.sourceSha256[name] = sha(body); return body;
      }));
      report.sourceSha256.nativeTest = sha(await readFile(new URL(import.meta.url)));
      const settings = [
        "cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'",
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'",
        "cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'",
        "cinatoken.shared_key_economic_producer_activation = 'reviewed-v1'",
      ];
      for (let i = 0; i < 3; i++) await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${settings[i]}`);
        await tx.unsafe(bodies[i]).simple();
      });
      await assert.rejects(migrator.begin(tx => tx.unsafe(bodies[3]).simple()),
        /activation or dependency differs/u);
      stage('producer-default-off');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.schema_migrations
          SET version='0042_forged_middle_version.sql'
          WHERE version='0042_gateway_keys_workspace.sql'`);
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /activation or dependency differs/u);
      stage('exact-pg73-ledger-rejects-middle-version-drift');

      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${economic}
        GRANT SELECT ON TABLES TO economic_third;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${economic}
        GRANT EXECUTE ON FUNCTIONS TO economic_third;`).simple();
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /ACL or binding exceeds reviewed contract/u);
      assert.equal((await migrator.unsafe(`SELECT
        to_regclass('${economic}.shared_key_economic_producer_tx_markers') IS NULL AS absent`))[0].absent,
      true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${economic}
        REVOKE SELECT ON TABLES FROM economic_third;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${economic}
        REVOKE EXECUTE ON FUNCTIONS FROM economic_third;`).simple();
      stage('third-role-default-grant-drift-rolls-back');
      const expectAbsentAfterActivationFailure = async () => {
        const [{ absent, noProducer }] = await migrator.unsafe(`SELECT
          to_regclass('${economic}.shared_key_economic_producer_tx_markers') IS NULL AS absent,
          to_regprocedure('${economic}.write_shared_key_economic_event(text,text,text,jsonb,text)')
            IS NULL AS "noProducer"`);
        assert.equal(absent, true);
        assert.equal(noProducer, true);
      };
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER TABLE ${gateway}.shared_key_earnings
          DISABLE TRIGGER shared_key_earnings_reject_economic_event`);
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /trigger catalog differs/u);
      await expectAbsentAfterActivationFailure();
      stage('disabled-legacy-double-pay-guard-rolls-back-activation');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`DROP TRIGGER shared_key_economic_events_guard_insert
          ON ${economic}.shared_key_economic_events;
          CREATE TRIGGER shared_key_economic_events_guard_insert
            BEFORE INSERT ON ${economic}.shared_key_economic_events
            FOR EACH ROW EXECUTE FUNCTION ${economic}.reject_economic_fact_mutation();`).simple();
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /trigger catalog differs/u);
      await expectAbsentAfterActivationFailure();
      stage('rebound-event-insert-guard-rolls-back-activation');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION
          ${quotes}.reject_dispatch_quote_attempt_mutation()
          RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
          SET search_path TO pg_catalog, pg_temp AS $no_op$
          BEGIN RETURN NULL; END;
          $no_op$;`);
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /function catalog differs/u);
      await expectAbsentAfterActivationFailure();
      stage('no-op-claim-immutability-guard-rolls-back-activation');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER TABLE ${economic}.shared_key_economic_event_attempts
          DISABLE TRIGGER shared_key_economic_attempts_no_change`);
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
      }), /trigger catalog differs/u);
      await expectAbsentAfterActivationFailure();
      stage('disabled-outcome-immutability-guard-rolls-back-activation');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${settings[3]}`);
        await tx.unsafe(bodies[3]).simple();
        await competingMigrator.unsafe(`SET lock_timeout='500ms'`);
        await expectCode(competingMigrator.unsafe(`ALTER FUNCTION
          ${economic}.guard_legacy_earning_insert() SECURITY INVOKER`), '55P03');
      });
      stage('same-transaction-producer-installed');
      stage('function-attestation-lock-blocks-concurrent-replacement');

      const producer = `${economic}.write_shared_key_economic_event`;
      await expectCode(runtime.unsafe(`SELECT * FROM ${economic}.shared_key_economic_events`), '42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${economic}.shared_key_economic_producer_tx_markers`), '42501');
      await expectCode(runtime.unsafe(`INSERT INTO ${economic}.shared_key_economic_events
        (event_id,request_log_id) VALUES ('x','x')`), '42501');
      stage('runtime-has-execute-only-private-privilege');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('economic-seller','producer-seller@example.invalid'),
          ('economic-buyer','producer-buyer@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('economic-workspace','personal','economic-buyer','Default','default',
            true,'personal:economic-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('economic-api-key','synthetic-key','economic-buyer','economic-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('economic-key','economic-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('economic-seller');
        INSERT INTO ${quotes}.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('economic-q1','economic-key','economic-seller',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v1');
        INSERT INTO ${quotes}.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('economic-t1','economic-key',NULL,'activate','economic-q1',
            'economic-seller');`).simple();
      const claim = async id => (await quoteProducer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,1,'economic-key','synthetic-target')`,
      [randomUUID(), id]))[0];
      const rows = async (table, id) => (await migrator.unsafe(`SELECT count(*)::int AS n FROM ${table}
        WHERE ${table.endsWith('events') ? 'request_log_id' : table.endsWith('attempts')
          ? 'request_log_id' : 'id'}=$1`, [id]))[0].n;
      const client = { driver: 'postgres', raw: runtime,
        drizzle: drizzle(runtime, { schema: pgCoreSchema }) };
      const id = `economic-${randomUUID()}`;
      const first = outcome(id, await claim(id));
      const params = input(id, [first]);
      await assert.rejects(insertRequestUsageAndChargeTxPg(client, input(id, [first], {
        userBudgetSettlement: { requestId: id, mode: 'reserved', reason: 'fixture-ceiling' },
        economicOutbox: { buyerChargeBasis: 'reserved',
          buyerUsageCertainty: 'unknown', attempts: [first] },
      })), /Reserved ordinary-user settlement needs an explicit economic buyer debit/u);
      await assert.rejects(insertRequestUsageAndChargeTxPg(client, input(id, [first], {
        economicOutbox: { buyerChargeBasis: 'none',
          buyerUsageCertainty: 'actual', attempts: [first] },
      })), /Invalid shared-key economic event basis|buyer basis differs/u);
      assert.equal(await rows(`${gateway}.api_key_request_logs`, id), 0);
      stage('reserved-ceiling-and-charged-none-rejected-before-mutation');
      await insertRequestUsageAndChargeTxPg(client, params);
      assert.equal(await rows(`${gateway}.api_key_request_logs`, id), 1);
      assert.equal(await rows(`${economic}.shared_key_economic_events`, id), 1);
      assert.equal(await rows(`${economic}.shared_key_economic_event_attempts`, id), 1);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent FROM ${gateway}.users
        WHERE id='economic-buyer'`))[0].spent, '0.010000');
      stage('critical-writer-buyer-log-budget-event-outcome-one-commit');

      await insertRequestUsageAndChargeTxPg(client, params);
      assert.equal(await rows(`${economic}.shared_key_economic_events`, id), 1);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent FROM ${gateway}.users
        WHERE id='economic-buyer'`))[0].spent, '0.010000');
      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'create')`,
        [id, dbPayload([first])]), '23514', 'shared_key_economic_producer_tx');
      assert.equal((await runtime.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'verify') AS result`,
        [id, dbPayload([first])]))[0].result, 'verified');
      stage('post-commit-replay-verifies-without-double-charge-or-backfill');

      const reservedActualId = `economic-${randomUUID()}`;
      const reservedActualAttempt = outcome(reservedActualId,
        await claim(reservedActualId));
      await migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'economic-buyer','economic-api-key',0,1000000,
          20000,'dispatched',now()+interval '1 day',now(),now())`,
      [reservedActualId]);
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=20000 WHERE id='economic-buyer'`);
      const reservedActualParams = input(reservedActualId, [reservedActualAttempt], {
        beforeSpent: 0.01,
        userBudgetSettlement: { requestId: reservedActualId,
          mode: 'actual', reason: 'fixture-actual' },
      });
      await insertRequestUsageAndChargeTxPg(client, reservedActualParams);
      await insertRequestUsageAndChargeTxPg(client, reservedActualParams);
      assert.deepEqual((await migrator.unsafe(`SELECT state,settled_micros::text AS settled
        FROM ${gateway}.user_budget_reservations WHERE request_id=$1`,
      [reservedActualId]))[0], { state: 'settled', settled: '10000' });
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent,
        budget_reserved_micros::text AS reserved FROM ${gateway}.users
        WHERE id='economic-buyer'`))[0].reserved, '0');
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent FROM ${gateway}.users
        WHERE id='economic-buyer'`))[0].spent, '0.020000');
      assert.equal(await rows(`${economic}.shared_key_economic_events`, reservedActualId), 1);
      stage('actual-ordinary-reservation-settles-once-with-economic-event');

      const changed = outcome(id, { ...first, attempt_id: first.attemptId,
        attempt_index: first.attemptIndex, shared_key_id: first.sharedKeyId,
        transition_id: first.transitionId, quote_version_id: first.quoteVersionId },
      { providerCostMicros: 2001 });
      await expectCause(insertRequestUsageAndChargeTxPg(client, input(id, [changed])),
        /Conflicting economic outcome replay/u);
      stage('conflicting-replay-rejected');

      const rollbackId = `economic-${randomUUID()}`;
      const rollbackClaim = await claim(rollbackId);
      const rollback = outcome(rollbackId, rollbackClaim,
        { quoteVersionId: 'wrong-version' });
      await expectCause(insertRequestUsageAndChargeTxPg(client,
        input(rollbackId, [rollback])), /quote identity or uniqueness differs/u);
      assert.equal(await rows(`${gateway}.api_key_request_logs`, rollbackId), 0);
      assert.equal(await rows(`${economic}.shared_key_economic_events`, rollbackId), 0);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS spent FROM ${gateway}.users
        WHERE id='economic-buyer'`))[0].spent, '0.020000');
      stage('producer-error-rolls-back-buyer-log-and-budget');

      const missingId = `economic-${randomUUID()}`;
      await claim(missingId);
      const legacy = input(missingId, []);
      delete legacy.economicOutbox;
      await expectCode(insertRequestUsageAndChargeTxPg(client, legacy),
        '23514', 'shared_key_economic_event_required');
      assert.equal(await rows(`${gateway}.api_key_request_logs`, missingId), 0);
      stage('missing-event-deferred-guard-rolls-back-legacy-writer');

      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'other')`,
        [id, dbPayload([first])]), '23514', 'shared_key_economic_producer_input');
      const extra = JSON.parse(dbPayload([first]));
      extra[0].credential = 'forbidden';
      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'verify')`,
        [id, JSON.stringify(extra)]), '23514', 'shared_key_economic_producer_outcome_shape');
      extra[0].credential = 'x'.repeat(4 * 1024 * 1024);
      await expectCode(runtime.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'verify')`,
        [id, JSON.stringify(extra)]), '23514', 'shared_key_economic_producer_input');
      await expectCode(runtime.begin(async tx => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'verify')`,
          [id, dbPayload([first])]);
      }), '23514', 'shared_key_economic_producer_isolation');
      stage('wrong-mode-extra-json-and-stale-isolation-rejected');

      const expiredId = `economic-${randomUUID()}`;
      const expiredAttempt = outcome(expiredId, await claim(expiredId));
      await migrator.unsafe(`INSERT INTO ${gateway}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,settled_micros,state,expires_at,terminal_at,
          terminal_reason,created_at,updated_at)
        VALUES($1,'economic-buyer','economic-api-key',0,1000000,
          10000,10000,'expired',now()+interval '1 day',now(),
          'reserved_ceiling',now(),now())`, [expiredId]);
      const directLog = tx => tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
          input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
        VALUES($1,'economic-buyer','economic-api-key','economic-workspace',
          0.010000,10000,10,5,0,0)`, [expiredId]);
      await expectCode(runtime.begin(async tx => {
        await directLog(tx);
        await tx.unsafe(`SELECT ${producer}($1,'reserved','unknown',$2::jsonb,'create')`,
          [expiredId, dbPayload([expiredAttempt])]);
      }), '23514', 'shared_key_economic_producer_input');
      await expectCode(runtime.begin(async tx => {
        await directLog(tx);
        await tx.unsafe(`SELECT ${producer}($1,'none','actual',$2::jsonb,'create')`,
          [expiredId, dbPayload([expiredAttempt])]);
      }), '23514', 'shared_key_economic_producer_buyer');
      await expectCode(runtime.begin(async tx => {
        await directLog(tx);
        await tx.unsafe(`SELECT ${producer}($1,'actual','actual',$2::jsonb,'create')`,
          [expiredId, dbPayload([expiredAttempt])]);
      }), '23514', 'shared_key_economic_producer_buyer');
      assert.equal(await rows(`${gateway}.api_key_request_logs`, expiredId), 0);
      assert.equal(await rows(`${economic}.shared_key_economic_events`, expiredId), 0);
      stage('direct-execute-rejects-reserved-and-expired-as-actual');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const sourceError = error?.actual ?? error;
      report.failure = { code: sourceError?.code ?? null,
        constraint: sourceError?.constraint_name ?? null,
        position: sourceError?.position ?? null,
        queryNearPosition: sourceError?.query && sourceError?.position
          ? sourceError.query.slice(Math.max(0, Number(sourceError.position) - 150),
            Number(sourceError.position) + 150)
          : null,
        message: String(error?.stack ?? error).slice(0, 3000) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`economic-producer-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });

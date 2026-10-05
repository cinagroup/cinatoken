// Review-only PG18.6 fixture. It owns a fresh loopback cluster and uses only
// synthetic buyer, seller, quote and amount facts. No ambient database URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const economic = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const quoteProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url);
const dispatchProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url);
const outboxProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const info = error => ({ code: error?.code ?? null, constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 300) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-economic-v339-${label}` } });
}

function quote(id, inputPrice) {
  return { version_id: id, shared_key_id: 'economic-key', seller_user_id: 'economic-seller',
    input_price_per_million: inputPrice, output_price_per_million: '2.500000',
    cache_read_price_per_million: '0.100000', cache_write_price_per_million: '0.200000',
    commission_rate: '0.100000', currency: 'USD',
    price_unit: 'per_million_tokens', billing_mode: 'shared_seller_key',
    entitlement_version: 'synthetic-entitlement-v1' };
}

async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}

async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    assert.equal(error?.code, code, String(error));
    if (constraint) assert.equal(error?.constraint_name, constraint, String(error));
    return true;
  });
}

async function activate(sql, body, key) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL cinatoken.${key} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

async function insertLog(sql, id, { charge = '0.010000', chargeMicros = 10000,
  input = 10, output = 5 } = {}) {
  await sql.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'economic-buyer','economic-api-key','economic-workspace',$2,$3,$4,$5,0,0)`,
  [id, charge, chargeMicros, input, output]);
}

function event(id, attempts, { charge = '0.010000', chargeMicros = 10000,
  input = 10, output = 5, certainty = 'confirmed' } = {}) {
  return { event_id: id, request_log_id: id, event_type: 'shared_key_usage_settled',
    event_version: 1, buyer_user_id: 'economic-buyer',
    buyer_api_key_id: 'economic-api-key', workspace_id: 'economic-workspace',
    buyer_charge_basis: 'actual', buyer_usage_certainty: 'actual',
    buyer_charged_cost: charge, buyer_budget_charged_micros: chargeMicros,
    buyer_input_tokens: input, buyer_output_tokens: output,
    buyer_cache_read_tokens: 0, buyer_cache_write_tokens: 0,
    attempt_count: attempts, event_certainty: certainty };
}

function outcome(id, claim, overrides = {}) {
  return { event_id: id, request_log_id: id, attempt_id: claim.attempt_id,
    attempt_index: claim.attempt_index, shared_key_id: claim.shared_key_id,
    transition_id: claim.transition_id, quote_version_id: claim.quote_version_id,
    usage_certainty: 'actual', input_tokens: 5, output_tokens: 2,
    cache_read_tokens: 0, cache_write_tokens: 0,
    provider_cost_certainty: 'actual', provider_cost_micros: 2000,
    evidence_kind: 'provider_usage', evidence_sha256: 'a'.repeat(64),
    observed_at: new Date().toISOString(), ...overrides };
}

test('native PG18 shared-key economic event is complete, atomic and blocks legacy double pay',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-economic-outbox-v339-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned PG18.6; 73 formal migrations; quote + dispatch + economic proposals only',
      stages: [], sourceSha256: {}, limitations: [
        'The production critical writer does not yet pass typed buyer certainty, quote refs or per-attempt usage/cost into this outbox.',
        'The current synchronous settleSharedKeyEarning call remains outside buyer settlement; this proposal prevents its payout for enrolled events but implements no new consumer.',
        'The synthetic fixture writes a buyer budget value with the log in one transaction; it does not exercise the actual critical-write API or D1/MySQL.',
        'The proposal rejects non-READ-COMMITTED inserts for every request log, economic event and legacy earning; real deployment must audit all writers for this isolation contract.',
        'An attempt committed before an upstream send can remain without a buyer log after a crash; unknown reconciliation and consumer/retry protocols remain open.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const producerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${producerPassword}';
        CREATE ROLE cinatoken_economic_acl_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster,'cinatoken_gateway_migrator',migratorPassword,'migrator');
      const producer = client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',producerPassword,'producer');
      const runtime = client(cluster,'cinatoken_gateway_runtime',runtimePassword,'runtime');
      clients.push(migrator, producer, runtime);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`,[name]);
        });
      }
      stage('formal-pg73-installed');
      const quoteBody = await readFile(quoteProposal,'utf8');
      const dispatchBody = await readFile(dispatchProposal,'utf8');
      const outboxBody = await readFile(outboxProposal,'utf8');
      report.sourceSha256 = { quoteProposal: sha(quoteBody), dispatchProposal: sha(dispatchBody),
        economicProposal: sha(outboxBody), nativeTest: sha(await readFile(new URL(import.meta.url))),
        formalMigrationCorpus: sha(corpus.join('\n')) };
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(quoteBody).simple();
      });
      await activate(migrator,dispatchBody,'shared_quote_attempt_activation');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(outboxBody).simple();
      }), /Shared-key economic outbox activation or dependency differs/);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.schema_migrations
          SET version='0042_forged_middle_version.sql'
          WHERE version='0042_gateway_keys_workspace.sql'`);
        const [ledger] = await tx.unsafe(`SELECT count(*)::int AS n,
          bool_or(version='0073_recovery_api_key_workspace_lock.sql') AS has_last
          FROM ${gateway}.schema_migrations`);
        assert.deepEqual(ledger,{n:73,has_last:true});
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'");
        await tx.unsafe(outboxBody).simple();
      }), /Shared-key economic outbox activation or dependency differs/);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version)
          VALUES ('0074_unreviewed_extra.sql')`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'");
        await tx.unsafe(outboxBody).simple();
      }), /Shared-key economic outbox activation or dependency differs/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.schema_migrations`))[0].n,73);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS
          TO cinatoken_economic_acl_probe;
        ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES
          TO cinatoken_economic_acl_probe;
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS
          TO cinatoken_economic_acl_probe;`).simple();
      await assert.rejects(activate(migrator,outboxBody,
        'shared_key_economic_outbox_activation'),
      /Economic outbox ACL exceeds reviewed owner-only contract/);
      assert.equal((await migrator.unsafe(`SELECT
        pg_catalog.to_regnamespace('${economic}') IS NULL AS absent`))[0].absent,true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES REVOKE USAGE ON SCHEMAS
          FROM cinatoken_economic_acl_probe;
        ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES
          FROM cinatoken_economic_acl_probe;
        ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS
          FROM cinatoken_economic_acl_probe;`).simple();
      stage('hostile-migrator-default-grants-rejected-atomically');
      await activate(migrator,outboxBody,'shared_key_economic_outbox_activation');
      stage('exact-pg73-ledger-and-default-off-activation');

      await expectCode(runtime.unsafe(`SELECT * FROM ${economic}.shared_key_economic_events`),'42501');
      await expectCode(runtime.unsafe(`SELECT * FROM ${economic}.shared_key_economic_event_attempts`),'42501');
      stage('ordinary-runtime-denied-private-economic-source');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('economic-seller','seller-economic@example.invalid'),
          ('economic-buyer','buyer-economic@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('economic-workspace','personal','economic-buyer','Default','default',
            true,'personal:economic-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('economic-api-key','synthetic-api-key','economic-buyer','economic-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('economic-key','economic-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('economic-seller');`).simple();
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,quote('economic-q1','1.250000'));
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('economic-t1','economic-key',NULL,'activate','economic-q1','economic-seller')`);
      const claim = async (id,index) => (await producer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,$3,'economic-key','synthetic-target')`,
      [randomUUID(),id,index]))[0];
      stage('immutable-quote-and-dedicated-pre-egress-claim-installed');

      let snapshotReady;
      let releaseSnapshot;
      const didSnapshot = new Promise(resolve => { snapshotReady = resolve; });
      const snapshotHold = new Promise(resolve => { releaseSnapshot = resolve; });
      const staleBuyer = migrator.begin(async tx => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        // Establish the transaction snapshot before the separate producer
        // commits its quote attempt, then try to insert the buyer log.
        assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM
          ${quotes}.shared_key_dispatch_quote_attempts
          WHERE request_log_id='stale-snapshot'`))[0].n,0);
        snapshotReady();
        await snapshotHold;
        await insertLog(tx,'stale-snapshot');
      });
      await Promise.race([didSnapshot, staleBuyer.then(() => {
        throw new Error('Stale buyer transaction ended before its snapshot signal');
      })]);
      const staleAttempt = await claim('stale-snapshot',1);
      assert.ok(staleAttempt.attempt_id);
      releaseSnapshot();
      await expectCode(staleBuyer,'23514','shared_key_economic_isolation');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id='stale-snapshot'`))[0].n,0);
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await insertObject(tx,`${economic}.shared_key_economic_events`,
          event('stale-event-no-log',1));
      }),'23514','shared_key_economic_isolation');
      await insertLog(migrator,'stale-legacy');
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,
            gross_amount,platform_fee,net_amount)
          VALUES ('stale-legacy-payout','stale-legacy','economic-key','economic-seller',
            0.010000,0.001000,0.009000)`);
      }),'23514','shared_key_economic_isolation');
      stage('stale-repeatable-read-snapshot-cannot-bypass-economic-coverage');

      await claim('missing-event',1);
      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=budget_spent+0.01
          WHERE id='economic-buyer'`);
        await insertLog(tx,'missing-event');
      }),'23514','shared_key_economic_event_required');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id='missing-event'`))[0].n,0);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS n FROM
        ${gateway}.users WHERE id='economic-buyer'`))[0].n,'0.000000');
      stage('missing-event-rolls-back-buyer-log-and-budget');

      const missingOutcome = await claim('missing-outcome',1);
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'missing-outcome');
        await insertObject(tx,`${economic}.shared_key_economic_events`,event('missing-outcome',1));
      }),'23514','shared_key_economic_attempt_coverage');
      assert.ok(missingOutcome.attempt_id);
      stage('missing-attempt-outcome-rolls-back-buyer-log-and-event');

      const mismatch = await claim('buyer-mismatch',1);
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'buyer-mismatch');
        await insertObject(tx,`${economic}.shared_key_economic_events`,
          event('buyer-mismatch',1,{ chargeMicros: 9000 }));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('buyer-mismatch',mismatch));
      }),'23514','shared_key_economic_buyer_mismatch');
      stage('typed-buyer-amount-must-match-persisted-log');

      const unresolved = await claim('unknown-attempt',1);
      const unknownOutcome = outcome('unknown-attempt',unresolved,{
        usage_certainty:'unknown',input_tokens:null,output_tokens:null,
        cache_read_tokens:null,cache_write_tokens:null,
        provider_cost_certainty:'unknown',provider_cost_micros:null,
        evidence_kind:'timeout',evidence_sha256:null });
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'unknown-attempt',{input:0,output:0});
        await insertObject(tx,`${economic}.shared_key_economic_events`,{
          ...event('unknown-attempt',1,{input:0,output:0}),
          buyer_charge_basis:'reserved',buyer_usage_certainty:'unknown' });
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,unknownOutcome);
      }),'23514','shared_key_economic_certainty');
      await migrator.begin(async tx => {
        await insertLog(tx,'unknown-attempt',{input:0,output:0});
        await insertObject(tx,`${economic}.shared_key_economic_events`,{
          ...event('unknown-attempt',1,{input:0,output:0,certainty:'unresolved'}),
          buyer_charge_basis:'reserved',buyer_usage_certainty:'unknown' });
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,unknownOutcome);
      });
      assert.equal((await migrator.unsafe(`SELECT event_certainty FROM
        ${economic}.shared_key_economic_events WHERE event_id='unknown-attempt'`))[0]
        .event_certainty,'unresolved');
      stage('unknown-provider-attempt-cannot-be-declared-confirmed');

      const first = await claim('multi-attempt',1);
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,quote('economic-q2','3.750000'));
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('economic-t2','economic-key','economic-t1','activate',
          'economic-q2','economic-seller')`);
      const second = await claim('multi-attempt',2);
      assert.equal(first.quote_version_id,'economic-q1');
      assert.equal(second.quote_version_id,'economic-q2');
      await migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=budget_spent+0.01
          WHERE id='economic-buyer'`);
        await insertLog(tx,'multi-attempt');
        await insertObject(tx,`${economic}.shared_key_economic_events`,event('multi-attempt',2));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('multi-attempt',first,{ provider_cost_micros: 4000 }));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('multi-attempt',second,{ provider_cost_micros: 2000 }));
      });
      const facts = await migrator.unsafe(`SELECT attempt_index,quote_version_id,
        provider_cost_micros::text AS cost FROM
        ${economic}.shared_key_economic_event_attempts
        WHERE event_id='multi-attempt' ORDER BY attempt_index`);
      assert.deepEqual(facts.map(row => ({index:row.attempt_index,quote:row.quote_version_id,cost:row.cost})),
        [{index:1,quote:'economic-q1',cost:'4000'},
          {index:2,quote:'economic-q2',cost:'2000'}]);
      assert.equal((await migrator.unsafe(`SELECT budget_spent::text AS n FROM
        ${gateway}.users WHERE id='economic-buyer'`))[0].n,'0.010000');
      stage('two-billable-attempts-preserve-distinct-quote-versions-and-costs');

      await expectCode(insertObject(migrator,`${economic}.shared_key_economic_events`,
        event('multi-attempt',2)),'23505');
      await expectCode(migrator.unsafe(`UPDATE ${economic}.shared_key_economic_events
        SET event_certainty='unresolved' WHERE event_id='multi-attempt'`),
      '23514','shared_key_economic_append_only');
      await expectCode(migrator.unsafe(`DELETE FROM
        ${economic}.shared_key_economic_event_attempts WHERE event_id='multi-attempt'`),
      '23514','shared_key_economic_append_only');
      stage('duplicate-event-and-economic-fact-mutation-rejected');

      await expectCode(migrator.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,
          gross_amount,platform_fee,net_amount)
        VALUES ('duplicate-payout','multi-attempt','economic-key','economic-seller',
          0.010000,0.001000,0.009000)`),
      '23514','shared_key_economic_legacy_double_pay');
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n FROM
        ${gateway}.user_earnings WHERE user_id='economic-seller'`))[0].n,'0');
      stage('old-synchronous-earning-cannot-double-pay-enrolled-event');

      await insertLog(migrator,'legacy-paid');
      await migrator.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,
          gross_amount,platform_fee,net_amount)
        VALUES ('legacy-payout','legacy-paid','economic-key','economic-seller',
          0.010000,0.001000,0.009000)`);
      const paidBefore = (await migrator.unsafe(`SELECT balance_micros::text AS n FROM
        ${gateway}.user_earnings WHERE user_id='economic-seller'`))[0].n;
      await expectCode(insertObject(migrator,`${economic}.shared_key_economic_events`,
        event('legacy-paid',1)),'23514','shared_key_economic_legacy_paid');
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n FROM
        ${gateway}.user_earnings WHERE user_id='economic-seller'`))[0].n,paidBefore);
      stage('previously-paid-legacy-log-cannot-be-adopted-as-new-event');

      const swap1 = await claim('index-swap',1);
      const swap2 = await claim('index-swap',2);
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'index-swap');
        await insertObject(tx,`${economic}.shared_key_economic_events`,event('index-swap',2));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('index-swap',swap1,{ attempt_index: 2 }));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('index-swap',swap2,{ attempt_index: 1 }));
      }),'23503','shared_key_economic_attempt_quote');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id='index-swap'`))[0].n,0);
      stage('attempt-index-swap-rejected-by-exact-composite-quote-reference');

      const raceFirst = await claim('race-close',1);
      let entered;
      let release;
      const didEnter = new Promise(resolve => { entered = resolve; });
      const hold = new Promise(resolve => { release = resolve; });
      const buyerCommit = migrator.begin(async tx => {
        await insertLog(tx,'race-close');
        await insertObject(tx,`${economic}.shared_key_economic_events`,event('race-close',1));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('race-close',raceFirst));
        entered();
        await hold;
      });
      await didEnter;
      const lateClaim = claim('race-close',2);
      const observed = await Promise.race([
        lateClaim.then(() => 'claimed', () => 'rejected'),delay(120).then(() => 'blocked')]);
      assert.equal(observed,'blocked');
      release();
      await buyerCommit;
      await expectCode(lateClaim,'23514','shared_quote_attempt_after_log');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts WHERE request_log_id='race-close'`))[0].n,1);
      stage('concurrent-late-claim-waits-for-buyer-commit-then-rejects');

      report.status='PASS';
    } catch (error) {
      failure=error; report.status='FAIL'; report.error=info(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({timeout:1})));
      try { await cluster.cleanup(); report.cleanup='PASS'; }
      catch (error) { report.cleanup='FAIL'; report.cleanupError=info(error); failure ??= error; }
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log('Native shared-key economic outbox report: '+reportPath);
    }
    if(failure) throw failure;
  });

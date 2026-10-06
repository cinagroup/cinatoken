// Review-only owned PG18.6 proof. Every identity and economic row is synthetic.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const outbox = 'cinatoken_economic_outbox';
const review = 'cinatoken_economic_orphan_review';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['quoteProposal', new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url), 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['attemptProposal', new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url), 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['outboxProposal', new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', import.meta.url), 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['reviewProposal', new URL('../../../packages/core/migrations-proposals/postgres/shared-key-orphan-review-v348.sql', import.meta.url), 'shared_key_orphan_review_activation', 'reviewed-v1'],
];
const sha = value => createHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null,
  constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 350) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-orphan-v348-${label}` } });
}

async function install(sql, body, key, value) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL cinatoken.${key} = '${value}'`);
    await tx.unsafe(body).simple();
  });
}

async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error?.code, code, String(error)); return true;
  });
}

function makeDeferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('native PG18 orphan review enqueues every committed claim without charging',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-shared-key-orphan-review-v348-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion,
      scope: 'owned PG18.6; PG73 + review-only quote/attempt/outbox/orphan proposals; synthetic identities',
      stages: [], sourceSha256: {}, limitations: [
        'No production role or binding, Workers/Hyperdrive, provider request, true send proof or financial correction is exercised.',
        'The review job is a durable investigation pointer; absence of a log or event never means no egress or zero cost.',
        'The fixture advances next_attempt_at with direct migrator SQL to exercise eight retries without wall-clock sleeps.',
        'A due-list page can be empty or stale during concurrent locks; every scheduler pass must restart from its first page.',
        'No production-scale backlog or lock-contention benchmark is measured.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const passwords = Object.fromEntries(['migrator','runtime','producer','worker','recovery']
        .map(name => [name, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.producer}';
        CREATE ROLE cinatoken_gateway_shared_orphan_worker LOGIN NOINHERIT PASSWORD '${passwords.worker}';
        CREATE ROLE cinatoken_gateway_shared_orphan_recovery LOGIN NOINHERIT PASSWORD '${passwords.recovery}';
        CREATE ROLE cinatoken_orphan_role_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_orphan_worker,
          cinatoken_gateway_shared_orphan_recovery;`).simple();
      const migrator = client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const installer = client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'installer');
      const producer = client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',passwords.producer,'producer');
      const producer2 = client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',passwords.producer,'producer2');
      const worker = client(cluster,'cinatoken_gateway_shared_orphan_worker',passwords.worker,'worker');
      const worker2 = client(cluster,'cinatoken_gateway_shared_orphan_worker',passwords.worker,'worker2');
      const recovery = client(cluster,'cinatoken_gateway_shared_orphan_recovery',passwords.recovery,'recovery');
      const runtime = client(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      clients.push(migrator,installer,producer,producer2,worker,worker2,recovery,runtime);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
      assert.equal(names.length,73);
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`,[name]);
        });
      }
      stage('formal-pg73-installed',{migrations:names.length});
      const bodies = {};
      for (const [name,url,key,value] of proposals) {
        bodies[name] = await readFile(url,'utf8');
        report.sourceSha256[name]=sha(bodies[name]);
        if (name!=='reviewProposal') await install(migrator,bodies[name],key,value);
      }
      report.sourceSha256.formalMigrationCorpus=sha(corpus.join('\n'));
      report.sourceSha256.nativeTest=sha(await readFile(new URL(import.meta.url)));
      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('review-seller','review-seller@example.invalid'),
          ('review-buyer','review-buyer@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('review-workspace','personal','review-buyer','Default','default',
            true,'personal:review-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('review-api-key','synthetic-api-key','review-buyer','review-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('review-key','review-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');
        INSERT INTO ${quotes}.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('review-version','review-key','review-seller',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-entitlement');
        INSERT INTO ${quotes}.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('review-transition','review-key',NULL,'activate',
            'review-version','review-seller');`).simple();
      stage('review-only-source-proposals-and-synthetic-quote-installed');

      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(bodies.reviewProposal).simple();
      }), /Orphan review activation, source guard or role contract differs/);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regnamespace(
        '${review}') IS NULL AS absent`))[0].absent,true);
      stage('review-proposal-default-off-install-rolls-back-atomically');

      await cluster.admin.unsafe(`GRANT cinatoken_orphan_role_probe
        TO cinatoken_gateway_shared_orphan_worker`);
      await assert.rejects(install(migrator,bodies.reviewProposal,
        'shared_key_orphan_review_activation','reviewed-v1'),
      /Orphan review activation, source guard or role contract differs/);
      await cluster.admin.unsafe(`REVOKE cinatoken_orphan_role_probe
        FROM cinatoken_gateway_shared_orphan_worker`);
      await cluster.admin.unsafe(`ALTER ROLE cinatoken_gateway_shared_orphan_recovery INHERIT`);
      await assert.rejects(install(migrator,bodies.reviewProposal,
        'shared_key_orphan_review_activation','reviewed-v1'),
      /Orphan review activation, source guard or role contract differs/);
      await cluster.admin.unsafe(`ALTER ROLE cinatoken_gateway_shared_orphan_recovery NOINHERIT`);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regnamespace(
        '${review}') IS NULL AS absent`))[0].absent,true);
      stage('worker-membership-and-recovery-inherit-role-probes-fail-closed');

      const claimSql = `SELECT * FROM ${quotes}.claim_shared_key_dispatch_quote_attempt(
        $1::uuid,$2::text,$3::integer,'review-key','review-target')`;
      const claim = async (sql,id,index,attemptId=randomUUID()) =>
        (await sql.unsafe(claimSql,[attemptId,id,index]))[0];
      const heldInserted=makeDeferred(),releaseHeld=makeDeferred();
      const heldId=randomUUID();
      const heldClaim=producer2.begin(async tx => {
        await tx.unsafe(claimSql,[heldId,'review-install-crossing',1]);
        heldInserted.resolve(); await releaseHeld.promise;
      });
      await heldInserted.promise;
      let installSettled=false;
      const installReview=install(installer,bodies.reviewProposal,
        'shared_key_orphan_review_activation','reviewed-v1')
        .finally(()=>{installSettled=true;});
      await delay(100);
      assert.equal(installSettled,false,'installer must wait for uncommitted source INSERT');
      releaseHeld.resolve();
      await heldClaim; await installReview;
      const [backfilled]=await migrator.unsafe(`SELECT claim_count,status FROM ${review}.jobs
        WHERE request_log_id='review-install-crossing'`);
      assert.deepEqual(backfilled,{claim_count:1,status:'pending'});
      stage('long-preinstall-claim-commits-before-locked-backfill-and-is-enqueued');

      const first=await claim(producer,'review-ack-unknown',1);
      // Simulate losing the SQL COMMIT acknowledgement after its durable effect.
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${review}.jobs
        WHERE request_log_id='review-ack-unknown'`))[0].n,1);
      const replay=await claim(producer,'review-ack-unknown',1,first.attempt_id);
      assert.equal(replay.attempt_id,first.attempt_id);
      assert.equal((await migrator.unsafe(`SELECT claim_count FROM ${review}.jobs
        WHERE request_log_id='review-ack-unknown'`))[0].claim_count,1);
      await claim(producer,'review-ack-unknown',2);
      assert.equal((await migrator.unsafe(`SELECT claim_count FROM ${review}.jobs
        WHERE request_log_id='review-ack-unknown'`))[0].claim_count,2);
      stage('ack-unknown-and-duplicate-claim-replay-preserve-one-job-and-exact-attempt-count');

      const lateInserted=makeDeferred(),releaseLate=makeDeferred();
      const late=producer2.begin(async tx => {
        await tx.unsafe(claimSql,[randomUUID(),'review-late-commit',1]);
        lateInserted.resolve(); await releaseLate.promise;
      });
      await lateInserted.promise;
      const cutoff=(await migrator.unsafe(`SELECT pg_catalog.clock_timestamp() AS t`))[0].t;
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${review}.jobs
        WHERE request_log_id='review-late-commit'`))[0].n,0);
      releaseLate.resolve(); await late;
      const [lateJob]=await migrator.unsafe(`SELECT j.claim_count,a.claimed_at<=$1 AS old_claim_time
        FROM ${review}.jobs j JOIN ${quotes}.shared_key_dispatch_quote_attempts a
          ON a.request_log_id=j.request_log_id
        WHERE j.request_log_id='review-late-commit'`,[cutoff]);
      assert.deepEqual(lateJob,{claim_count:1,old_claim_time:true});
      stage('late-commit-claim-enqueues-atomically-despite-precommit-claimed-at');

      const due=()=>worker.unsafe(`SELECT * FROM ${review}.list_due(
        NULL::timestamptz,NULL::text,100,0)`);
      const due1=await due(),due2=await due();
      assert.deepEqual(due1.map(x=>x.request_log_id),due2.map(x=>x.request_log_id));
      assert.ok(due1.some(x=>x.request_log_id==='review-late-commit'));
      const leaseToken=randomUUID();
      const leaseQuery=`SELECT * FROM ${review}.claim_job($1::text,$2::uuid,30,0)`;
      const [lease]=await worker.unsafe(leaseQuery,['review-ack-unknown',leaseToken]);
      const [leaseReplay]=await worker.unsafe(leaseQuery,['review-ack-unknown',leaseToken]);
      assert.deepEqual(leaseReplay,lease);
      assert.equal((await worker.unsafe(`SELECT ${review}.fail_job(
        'review-ack-unknown',$1::uuid,'insufficient_evidence',5) AS outcome`,[leaseToken]))[0]
        .outcome,'retry_scheduled');
      assert.equal((await worker.unsafe(`SELECT ${review}.fail_job(
        'review-ack-unknown',$1::uuid,'insufficient_evidence',5) AS outcome`,[leaseToken]))[0]
        .outcome,'already_recorded');
      assert.equal((await migrator.unsafe(`SELECT status,lease_attempt_count FROM ${review}.jobs
        WHERE request_log_id='review-ack-unknown'`))[0].lease_attempt_count,1);
      stage('repeated-due-scan-lease-and-failure-acks-are-idempotent');

      await claim(producer,'review-skipped',1);
      const rowLocked=makeDeferred(),releaseRow=makeDeferred();
      const lockTx=migrator.begin(async tx => {
        await tx.unsafe(`SELECT 1 FROM ${review}.jobs
          WHERE request_log_id='review-skipped' FOR UPDATE`);
        rowLocked.resolve(); await releaseRow.promise;
      });
      await rowLocked.promise;
      assert.equal((await worker2.unsafe(leaseQuery,['review-skipped',randomUUID()])).length,0);
      assert.ok((await due()).some(x=>x.request_log_id==='review-skipped'));
      releaseRow.resolve(); await lockTx;
      assert.equal((await worker2.unsafe(leaseQuery,['review-skipped',randomUUID()])).length,1);
      stage('skip-locked-zero-page-is-retryable-even-when-due-census-is-nonzero');

      await claim(producer,'review-dead',1);
      for (let attempt=1;attempt<=8;attempt++) {
        const token=randomUUID();
        const [leased]=await worker.unsafe(leaseQuery,['review-dead',token]);
        assert.equal(leased.lease_attempt_count,attempt);
        const [failed]=await worker.unsafe(`SELECT ${review}.fail_job(
          'review-dead',$1::uuid,'manual_evidence_missing',5) AS outcome`,[token]);
        assert.equal(failed.outcome,attempt===8?'dead_letter':'retry_scheduled');
        if (attempt<8) await migrator.unsafe(`UPDATE ${review}.jobs
          SET next_attempt_at=pg_catalog.clock_timestamp()-interval '1 second',
            revision=revision+1,last_action='fixture_advance_due',
            last_operation_token=NULL,last_reason_code=NULL
          WHERE request_log_id='review-dead'`);
      }
      const [dead]=await migrator.unsafe(`SELECT status,lease_attempt_count FROM ${review}.jobs
        WHERE request_log_id='review-dead'`);
      assert.deepEqual(dead,{status:'dead_letter',lease_attempt_count:8});
      const recoveryToken=randomUUID();
      const recoverySql=`SELECT ${review}.requeue_dead_letter(
        'review-dead',$1::uuid,'operator_recheck') AS outcome`;
      assert.equal((await recovery.unsafe(recoverySql,[recoveryToken]))[0].outcome,'requeued');
      assert.equal((await recovery.unsafe(recoverySql,[recoveryToken]))[0].outcome,'already_requeued');
      assert.deepEqual((await migrator.unsafe(`SELECT status,lease_attempt_count,recovery_count
        FROM ${review}.jobs WHERE request_log_id='review-dead'`))[0],
      {status:'pending',lease_attempt_count:0,recovery_count:1});
      stage('eight-attempt-dead-letter-and-operator-token-requeue-have-immutable-audit');

      const eventClaim=await claim(producer,'review-event-late',1);
      const eventLeaseToken=randomUUID();
      const leaseHeld=makeDeferred(),releaseLease=makeDeferred();
      const workerTx=worker2.begin(async tx => {
        assert.equal((await tx.unsafe(leaseQuery,
          ['review-event-late',eventLeaseToken])).length,1);
        leaseHeld.resolve(); await releaseLease.promise;
      });
      await leaseHeld.promise;
      const eventTx=installer.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
            input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
          VALUES ('review-event-late','review-buyer','review-api-key',
            'review-workspace',0,0,0,0,0,0)`);
        await insertObject(tx,`${outbox}.shared_key_economic_events`,{
          event_id:'review-event-late',request_log_id:'review-event-late',
          event_type:'shared_key_usage_settled',event_version:1,
          buyer_user_id:'review-buyer',buyer_api_key_id:'review-api-key',
          workspace_id:'review-workspace',buyer_charge_basis:'none',
          buyer_usage_certainty:'unknown',buyer_charged_cost:0,
          buyer_budget_charged_micros:0,buyer_input_tokens:0,buyer_output_tokens:0,
          buyer_cache_read_tokens:0,buyer_cache_write_tokens:0,
          attempt_count:1,event_certainty:'unresolved'
        });
        await insertObject(tx,`${outbox}.shared_key_economic_event_attempts`,{
          event_id:'review-event-late',request_log_id:'review-event-late',
          attempt_id:eventClaim.attempt_id,attempt_index:1,
          shared_key_id:eventClaim.shared_key_id,
          transition_id:eventClaim.transition_id,
          quote_version_id:eventClaim.quote_version_id,
          usage_certainty:'unknown',input_tokens:null,output_tokens:null,
          cache_read_tokens:null,cache_write_tokens:null,
          provider_cost_certainty:'unknown',provider_cost_micros:null,
          evidence_kind:'manual_review',evidence_sha256:null,
          observed_at:new Date().toISOString()
        });
      });
      let eventSettled=false;
      const watchedEvent=eventTx.finally(()=>{eventSettled=true;});
      await delay(100);
      assert.equal(eventSettled,false,'event must wait for review request advisory lock');
      releaseLease.resolve(); await workerTx; await watchedEvent;
      assert.equal((await migrator.unsafe(`SELECT status FROM ${review}.jobs
        WHERE request_log_id='review-event-late'`))[0].status,'resolved_event');
      assert.equal((await worker.unsafe(`SELECT ${review}.fail_job(
        'review-event-late',$1::uuid,'late_failure',5) AS outcome`,[eventLeaseToken]))[0]
        .outcome,'stale');
      stage('late-economic-event-serializes-with-lease-and-revokes-stale-worker-token');

      await expectCode(runtime.unsafe(`SELECT * FROM ${review}.jobs`),'42501');
      await expectCode(producer.unsafe(`SELECT * FROM ${review}.jobs`),'42501');
      await expectCode(worker.unsafe(`UPDATE ${review}.jobs SET status='resolved_event'
        WHERE request_log_id='review-dead'`),'42501');
      await expectCode(worker.unsafe(`SET ROLE cinatoken_gateway_migrator`),'42501');
      await expectCode(worker.unsafe(`SELECT ${review}.requeue_dead_letter(
        'review-dead',$1::uuid,'forged')`,[randomUUID()]),'42501');
      const noCharge=await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${gateway}.api_key_request_logs
          WHERE id IN ('review-ack-unknown','review-dead','review-late-commit')) AS logs,
        (SELECT count(*)::int FROM ${outbox}.shared_key_economic_events
          WHERE request_log_id IN ('review-ack-unknown','review-dead','review-late-commit')) AS events,
        (SELECT count(*)::int FROM ${gateway}.shared_key_earnings
          WHERE request_log_id IN ('review-ack-unknown','review-dead','review-late-commit')) AS earnings`);
      assert.deepEqual(noCharge[0],{logs:0,events:0,earnings:0});
      const audit=await migrator.unsafe(`SELECT request_log_id,count(*)::int AS n,
        max(revision)::int AS max_revision FROM ${review}.job_audit
        WHERE request_log_id IN ('review-dead','review-event-late')
        GROUP BY request_log_id ORDER BY request_log_id`);
      assert.equal(audit.length,2);
      assert.ok(audit.every(x=>x.n===x.max_revision+1));
      stage('direct-role-boundary-and-unresolved-no-charge-with-monotonic-audit');

      report.status='PASS';
    } catch (error) {
      failure=error; report.status='FAIL'; report.error=errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try { await cluster.cleanup(); report.cleanup='PASS'; }
      catch (error) { report.cleanup='FAIL'; report.cleanupError=errorInfo(error); failure??=error; }
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log('Native shared-key orphan review report: '+reportPath);
    }
    if (failure) throw failure;
  });

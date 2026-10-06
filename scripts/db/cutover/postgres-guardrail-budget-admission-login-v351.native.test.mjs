// Owned PG18.6 proof of a multi-intent Guardrail admission API with no raw grants.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const gateway = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const prerequisites = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation', 'reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation', 'reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation', 'reviewed-v1'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation', 'reviewed-v1'],
];
const digest = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `guardrail-admission-v351-${label}` } });
}

async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause?.code, code, String(error));
    if (constraint) assert.equal(cause?.constraint_name, constraint, String(error));
    return true;
  });
}

test('Guardrail admission LOGIN can reserve only checked multi-intent windows',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-guardrail-budget-admission-v351-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; PG73 plus v348/v349 buyer split, v350 ordinary and v351 Guardrail admission proposals',
      limitations: [
        'No production migration, credential, Worker binding, remote SQL, or deployment changed.',
        'The existing Guardrail repository still uses raw table DML and cannot run under this LOGIN without a reviewed adapter.',
        'The buyer settlement LOGIN retains trusted direct Guardrail window/reservation writes; this proposal limits only the admission LOGIN.',
        'The DB verifies current authoritative budget intents but the caller still chooses request/user/key and route basis; independent request identity binding remains open.',
        'The v348 private pre-send denial receipt remains buyer-only; admission cannot issue its special ordinary-budget release reason.',
        'Dispatched extension, forfeiture, expired lease recovery, settlement, and configuration race closure are not provided by these three functions.',
        'D1/MySQL and Linux CI are not exercised.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const names = ['migrator','runtime','buyer_settlement','budget_admission',
        'shared_quote_attempt_producer','shared_earning_consumer'];
      const passwords = Object.fromEntries(names.map(name => [name,
        randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${passwords.buyer_settlement}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT PASSWORD '${passwords.budget_admission}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.shared_quote_attempt_producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.shared_earning_consumer}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${names.map(name =>
          `cinatoken_gateway_${name}`).join(',')};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime = client(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const buyer = client(cluster,'cinatoken_gateway_buyer_settlement',
        passwords.buyer_settlement,'buyer');
      const admission = client(cluster,'cinatoken_gateway_budget_admission',
        passwords.budget_admission,'admission');
      const peer = client(cluster,'cinatoken_gateway_budget_admission',
        passwords.budget_admission,'peer');
      clients.push(migrator,runtime,buyer,admission,peer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrationNames = await listPg73Migrations();
      assert.equal(migrationNames.length,73);
      const corpus = [];
      for (const name of migrationNames) {
        const body = await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version)
            VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations = digest(corpus.join('\n'));
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      // Keep the original grant calls and exact rejection checks on the PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({ DATABASE_URL:migratorUrl });
      for (const [name,setting,value] of prerequisites) {
        const body = await readFile(new URL(name,proposals),'utf8');
        report.sourceSha256[name] = digest(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      await activatePostgresBuyerSplitV348({ DATABASE_URL:migratorUrl });
      await grantPostgresBuyerSplitV348({ DATABASE_URL:migratorUrl });
      await activatePostgresBuyerGuardrailSplitV349({ DATABASE_URL:migratorUrl });
      await grantPostgresBuyerGuardrailSplitV349({ DATABASE_URL:migratorUrl });
      for (const name of [
        'buyer-critical-writer-privilege-split-v346.sql',
        'shared-key-economic-producer-buyer-login-v347.sql',
        'buyer-split-grant-marker-v348.sql',
        'buyer-split-runtime-grant-v348.sql',
        'shared-key-guardrail-post-reservation-denial-v348.sql',
        'buyer-split-guardrail-grant-marker-v349.sql',
        'buyer-split-guardrail-runtime-grant-v349.sql',
      ]) report.sourceSha256[name]=digest(await readFile(new URL(name,proposals),'utf8'));
      report.sourceSha256.runtimeGrant=digest(await readFile(
        new URL('./grant-postgres-runtime.ts',import.meta.url),'utf8'));
      stage('pg73-economic-prerequisites-and-buyer-guardrail-split-installed');

      const ordinary = await readFile(new URL('budget-admission-login-v350.sql',proposals),'utf8');
      report.sourceSha256.ordinaryAdmission = digest(ordinary);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.budget_admission_login_activation='reviewed-v1'");
        await tx.unsafe(ordinary).simple();
      });
      const proposal = await readFile(new URL('guardrail-budget-admission-login-v351.sql',proposals),'utf8');
      report.sourceSha256.guardrailAdmission = digest(proposal);
      report.sourceSha256.fixture = digest(await readFile(new URL(import.meta.url)));
      await assert.rejects(migrator.begin(tx => tx.unsafe(proposal).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`GRANT UPDATE (reserved_micros)
          ON ${gateway}.guardrail_budget_windows TO cinatoken_gateway_budget_admission`);
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_admission_v351_activation='reviewed-v1'");
        await tx.unsafe(proposal).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_admission_v351_activation='reviewed-v1'");
        await tx.unsafe(proposal).simple();
      });
      stage('default-off-and-raw-ACL-drift-refused-before-atomic-install');

      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.guardrail_budget_windows','UPDATE') AS window_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.guardrail_budget_reservations','INSERT') AS reservation_insert,
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE') AS reserve_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${gateway}.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE') AS runtime_execute,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${gateway}.guardrail_budget_windows','UPDATE') AS runtime_window_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${gateway}.guardrail_budget_reservations','INSERT') AS runtime_reservation_insert`);
      assert.deepEqual(acl,{ window_update:false,reservation_insert:false,
        reserve_execute:true,runtime_execute:false,
        runtime_window_update:false,runtime_reservation_insert:false });
      await expectCode(admission.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=0`),'42501');
      await expectCode(admission.unsafe(`INSERT INTO ${gateway}.guardrail_budget_windows
        (workspace_id,scope_type,scope_id,period,period_start,period_end,seeded_at,updated_at)
        VALUES('forged','api_key','forged','daily',now(),now()+interval '1 day',now(),now())`),'42501');
      await expectCode(runtime.unsafe(`SELECT ${gateway}.mark_guardrail_budgets_dispatched_v351(
        'forged',now(),now()+interval '1 minute')`),'42501');
      await expectCode(runtime.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=0`),'42501');
      await expectCode(buyer.unsafe(`SELECT ${gateway}.release_guardrail_budgets_v351(
        'forged',now(),'forged')`),'42501');
      stage('admission-has-function-only-capability-and-other-logins-cannot-invoke', { acl });

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent)
          VALUES('v351-user','v351-user@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v351-workspace','personal','v351-user','V351','v351','active');
        INSERT INTO ${gateway}.api_keys
          (id,key,user_id,workspace_id,limit_micros,limit_reset)
          VALUES('v351-key','synthetic-v351-key','v351-user','v351-workspace',
            2000000,'daily');
        INSERT INTO ${gateway}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v351-budget','v351-workspace','daily',2000000);
        INSERT INTO ${gateway}.guardrails
          (id,workspace_id,owner_user_id,name,status)
          VALUES('v351-guardrail','v351-workspace','v351-user','Budget','active');
        INSERT INTO ${gateway}.guardrail_versions
          (id,guardrail_id,version,config_json)
          VALUES('v351-version','v351-guardrail',1,
            '{"budget":{"limit":2,"period":"daily"}}');
        INSERT INTO ${gateway}.guardrail_assignments
          (id,workspace_id,guardrail_id,scope_type,scope_id)
          VALUES('v351-assignment','v351-workspace','v351-guardrail','user','v351-user');`).simple();
      const now = () => new Date();
      const intents = at => {
        const start = new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
        const end = new Date(start.getTime()+86_400_000);
        const common = {workspaceId:'v351-workspace',guardrailVersion:1,
          period:'daily',periodStart:start.toISOString(),periodEnd:end.toISOString(),
          limitMicros:2_000_000};
        return [
          {...common,assignmentId:'v351-assignment',guardrailId:'v351-guardrail',
            scopeType:'user',scopeId:'v351-user'},
          {...common,assignmentId:'workspace-budget:v351-budget',
            guardrailId:'workspace-budget:v351-budget',scopeType:'workspace',scopeId:'v351-workspace'},
          {...common,assignmentId:'gateway-key-limit:v351-key',
            guardrailId:'gateway-key-limit:v351-key',scopeType:'api_key',scopeId:'v351-key'},
        ];
      };
      const reserve = (sql,id,micros,items=intents(now()),basis='charged') => {
        const instant=now();
        return sql.unsafe(`SELECT ${gateway}.reserve_guardrail_budgets_v351(
          $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,
          [id,'v351-user','v351-key',sql.json(items),micros,basis,
            instant.toISOString(),new Date(instant.getTime()+120_000).toISOString()])
          .then(rows=>rows[0].result);
      };
      const mark = (sql,id,expiryIso) => { const instant=now(); return sql.unsafe(
        `SELECT ${gateway}.mark_guardrail_budgets_dispatched_v351($1,$2,$3) AS ok`,
        [id,instant.toISOString(),expiryIso??new Date(instant.getTime()+900_000).toISOString()])
        .then(rows=>rows[0].ok); };
      const release = (sql,id,reason='pre_send_cancel') => sql.unsafe(
        `SELECT ${gateway}.release_guardrail_budgets_v351($1,$2,$3) AS count`,
        [id,now().toISOString(),reason]).then(rows=>rows[0].count);
      const id=`v351-multi-${randomUUID()}`;
      const [payloadProbe]=await admission.unsafe(`SELECT pg_catalog.jsonb_typeof($1::jsonb) AS kind,
        pg_catalog.jsonb_array_length($1::jsonb) AS length`,[admission.json(intents(now()))]);
      assert.deepEqual(payloadProbe,{kind:'array',length:3});
      assert.deepEqual(await reserve(admission,id,1_000_000),
        {status:'reserved',reservationCount:3});
      assert.deepEqual(await reserve(admission,id,1_000_000),
        {status:'idempotent',reservationCount:3});
      const [held] = await migrator.unsafe(`SELECT count(*)::integer AS rows,
        sum(reserved_micros)::bigint AS total FROM ${gateway}.guardrail_budget_windows
        WHERE workspace_id='v351-workspace'`);
      assert.equal(held.rows,3);
      assert.equal(Number(held.total),3_000_000);
      stage('three-authoritative-intents-reserve-atomically-and-replay-idempotently');

      assert.deepEqual(await reserve(admission,`v351-omit-${randomUUID()}`,
        1_000_000,intents(now()).slice(1)),{status:'conflict'});
      assert.deepEqual(await reserve(admission,`v351-fake-${randomUUID()}`,
        1_000_000,intents(now()).map((item,index)=>index===1
          ? {...item,limitMicros:9_000_000}:item)),{status:'stale'});
      assert.deepEqual(await reserve(admission,`v351-period-${randomUUID()}`,
        1_000_000,intents(now()).map((item,index)=>index===1
          ? {...item,periodStart:'2020-01-01T00:00:00.000Z'}:item)),{status:'stale'});
      assert.deepEqual(await reserve(admission,`v351-over-${randomUUID()}`,
        1_500_000),{status:'blocked',assignmentId:'gateway-key-limit:v351-key'});
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n FROM
        ${gateway}.guardrail_budget_reservations WHERE request_id LIKE 'v351-%'`))[0].n,3);
      stage('missing-intent-forged-limit-and-period-refused; blocked-call-leaves-no-new-hold');

      await migrator.unsafe(`INSERT INTO ${gateway}.guardrails
          (id,workspace_id,owner_user_id,name,status,is_workspace_default)
          VALUES('v351-default','v351-workspace','v351-user','Default Budget','active',true);
        INSERT INTO ${gateway}.guardrail_versions
          (id,guardrail_id,version,config_json)
          VALUES('v351-default-version','v351-default',1,
            '{"budget":{"limit":2,"period":"daily"}}');`).simple();
      const defaultBase=intents(now())[0];
      const defaults=['user','api_key'].map(scopeType=>({
        ...defaultBase,assignmentId:`workspace-default:v351-default:${scopeType==='user'?'user':'api-key'}`,
        guardrailId:'v351-default',scopeType,
        scopeId:scopeType==='user'?'v351-user':'v351-key',
      }));
      assert.deepEqual(await reserve(admission,`v351-overlap-${randomUUID()}`,
        100_000,[...intents(now()),...defaults]),{status:'conflict'});
      await migrator.unsafe(`DELETE FROM ${gateway}.guardrails WHERE id='v351-default'`);
      stage('two-valid-assignments-sharing-a-window-fail-closed-as-current-repository-does');

      assert.equal(await release(admission,id),3);
      assert.equal(await release(admission,id),0);
      assert.equal(Number((await migrator.unsafe(`SELECT sum(reserved_micros)::bigint AS total
        FROM ${gateway}.guardrail_budget_windows WHERE workspace_id='v351-workspace'`))[0].total),0);
      const markedId=`v351-mark-${randomUUID()}`;
      assert.deepEqual(await reserve(admission,markedId,1_000_000),
        {status:'reserved',reservationCount:3});
      const markedExpiry=new Date(Date.now()+600_000).toISOString();
      assert.equal(await mark(admission,markedId,markedExpiry),true);
      assert.equal(await mark(admission,markedId,markedExpiry),true);
      assert.equal(await mark(admission,markedId,
        new Date(new Date(markedExpiry).getTime()+60_000).toISOString()),false);
      const markedRows=await migrator.unsafe(`SELECT state,expires_at
        FROM ${gateway}.guardrail_budget_reservations WHERE request_id=$1`,[markedId]);
      assert.equal(markedRows.length,3);
      assert.ok(markedRows.every(row=>row.state==='dispatched'
        && row.expires_at.toISOString()===markedExpiry));
      assert.equal(await release(admission,markedId),0);
      stage('release-only-before-dispatch-and-idempotent-mark-preserve-holds');
      stage('dispatched-replay-refuses-longer-unrecorded-lease');

      await expectCode(release(admission,markedId,'guardrail_budget_admission_rejected'),
        '23514','guardrail_admission_call_v351');
      await expectCode(admission.unsafe(`SELECT ${gateway}.release_user_budget_v350(
        'none',now(),'guardrail_budget_admission_rejected')`),
        '23514','budget_admission_call_v350');
      const trigger = (await migrator.unsafe(`SELECT pg_catalog.pg_get_functiondef(
        'cinatoken_economic_outbox.capture_guardrail_pre_send_denial()'::pg_catalog.regprocedure)
        AS body`))[0].body;
      assert.match(trigger,/SESSION_USER\s*<>\s*'cinatoken_gateway_buyer_settlement'/u);
      stage('special-pre-send-denial-reason-remains-buyer-only');

      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros+1
        WHERE workspace_id='v351-workspace' AND scope_type='api_key'`);
      await expectCode(reserve(admission,`v351-drift-${randomUUID()}`,100_000),
        '23514','guardrail_admission_counter_v351');
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros-1
        WHERE workspace_id='v351-workspace' AND scope_type='api_key'`);
      stage('unmatched-window-counter-drift-fails-closed');

      const raceId1=`v351-race-1-${randomUUID()}`;
      const raceId2=`v351-race-2-${randomUUID()}`;
      const race = await Promise.all([reserve(admission,raceId1,600_000),
        reserve(peer,raceId2,600_000)]);
      assert.deepEqual(race.map(row=>row.status).sort(),['blocked','reserved']);
      stage('concurrent-admissions-do-not-overbook-same-windows', { results:race });

      const expiringId=`v351-lock-expiry-${randomUUID()}`;
      const leaseNow=now();
      const leaseExpiry=new Date(leaseNow.getTime()+4_000);
      const [shortLease]=await admission.unsafe(`SELECT
        ${gateway}.reserve_guardrail_budgets_v351(
          $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,[
          expiringId,'v351-user','v351-key',admission.json(intents(leaseNow)),
          100_000,'charged',leaseNow.toISOString(),leaseExpiry.toISOString(),
        ]);
      assert.deepEqual(shortLease.result,{status:'reserved',reservationCount:3});
      const [{pid:markPid}]=await admission.unsafe('SELECT pg_catalog.pg_backend_pid() AS pid');
      let unlockRequest;
      const holdRequest=new Promise(resolve=>{ unlockRequest=resolve; });
      let announceLock;
      const requestLocked=new Promise(resolve=>{ announceLock=resolve; });
      const locker=peer.begin(async tx=>{
        const [{pid}]=await tx.unsafe(`SELECT pg_catalog.pg_backend_pid() AS pid,
          pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext($1))`,[expiringId]);
        announceLock(pid);
        await holdRequest;
      });
      let pendingMark;
      try {
        const blockerPid=await Promise.race([requestLocked,
          locker.then(()=>{throw new Error('request lock ended before mark');})]);
        pendingMark=mark(admission,expiringId);
        pendingMark.catch(()=>{});
        let observedWait=false;
        const waitDeadline=Date.now()+2_000;
        while (Date.now()<waitDeadline) {
          const [{blockers}]=await migrator.unsafe(`SELECT
            pg_catalog.pg_blocking_pids($1::integer) AS blockers`,[markPid]);
          if (blockers.includes(blockerPid)) { observedWait=true; break; }
          await sleep(20);
        }
        assert.equal(observedWait,true,'mark must wait on the request advisory lock');
        const [{before_expiry:beforeExpiry}]=await migrator.unsafe(`SELECT
          pg_catalog.clock_timestamp()<$1::timestamptz AS before_expiry`,[
          leaseExpiry.toISOString()]);
        assert.equal(beforeExpiry,true,'mark must be waiting before lease expiry');
        let observedExpiry=false;
        const expiryDeadline=Date.now()+10_000;
        while (Date.now()<expiryDeadline) {
          const [{expired}]=await migrator.unsafe(`SELECT
            pg_catalog.clock_timestamp()>=$1::timestamptz AS expired`,[
            leaseExpiry.toISOString()]);
          if (expired) { observedExpiry=true; break; }
          await sleep(25);
        }
        assert.equal(observedExpiry,true,'database lease must expire during lock wait');
      } finally {
        unlockRequest();
        await locker;
      }
      assert.equal(await pendingMark,false);
      const expiringRows=await migrator.unsafe(`SELECT state,dispatched_at
        FROM ${gateway}.guardrail_budget_reservations WHERE request_id=$1`,[
        expiringId]);
      assert.equal(expiringRows.length,3);
      assert.ok(expiringRows.every(row=>row.state==='reserved'
        && row.dispatched_at===null));
      stage('advisory-lock-wait-past-lease-expiry-refuses-dispatch-without-state-change');

      const [definition] = await migrator.unsafe(`SELECT pg_catalog.pg_get_functiondef(
        '${gateway}.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)'::pg_catalog.regprocedure)
        AS body`);
      assert.match(definition.body,/server_now\s+timestamptz\s*:=\s*pg_catalog\.clock_timestamp\(\)/u);
      assert.match(definition.body,/date_trunc\('day',\s*server_now AT TIME ZONE 'UTC'\)/u);
      assert.match(definition.body,/k\.expires_at\s*>\s*server_now/u);
      await migrator.unsafe(`UPDATE ${gateway}.api_keys SET
        expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE id='v351-key'`);
      const lagNow=new Date(Date.now()-90_000);
      const expiryFuture=new Date(Date.now()+20_000);
      const [expiredKeyResult]=await admission.unsafe(`SELECT ${gateway}.reserve_guardrail_budgets_v351(
        $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,[
          `v351-expired-key-${randomUUID()}`,'v351-user','v351-key',
          admission.json(intents(now())),100_000,'charged',
          lagNow.toISOString(),expiryFuture.toISOString(),
        ]);
      assert.deepEqual(expiredKeyResult.result,{status:'conflict'});
      stage('database-clock-governs-period-and-key-expiry-despite-lagged-client-time');

      report.status='PASS';
    } catch (error) {
      failure=error; report.status='FAIL';
      const cause=error?.cause ?? error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        detail:cause?.detail??null,
        message:String(error?.stack??error).slice(0,4000)};
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try { await cluster.cleanup(); report.cleanup='PASS'; }
      catch (error) {report.cleanup='FAIL'; report.cleanupError=String(error).slice(0,1500);
        failure??=error;}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`guardrail-budget-admission-v351-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });

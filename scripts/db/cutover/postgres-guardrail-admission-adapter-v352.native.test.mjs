// Owned PG18.6 proof of a request-scoped, default-off v351 application adapter.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { openPostgresGuardrailBudgetAdmissionOwner,
  PostgresGuardrailBudgetAdmissionUnsupportedTransitionError,
} from '../../../packages/proxy/src/services/postgres-guardrail-budget-admission.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const gateway='cinatoken_gateway';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposals=new URL('../../../packages/core/migrations-proposals/postgres/',import.meta.url);
const prerequisites=[
  ['shared-key-quote-versions.sql','shared_key_quote_versions_activation','reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql','shared_quote_attempt_activation','reviewed-v1'],
  ['shared-key-economic-outbox.sql','shared_key_economic_outbox_activation','reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql','shared_key_economic_producer_activation','reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql','shared_key_snapshot_consumer_activation','reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql','shared_key_buyer_debit_v2_activation','reviewed-v1'],
  ['shared-key-economic-producer-v2.sql','shared_key_economic_producer_v2_activation','reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql','shared_key_buyer_budget_receipt_activation','reviewed-v1'],
];
const hash=value=>createHash('sha256').update(value).digest('hex');

function client(cluster,username,password,label){
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,
    onnotice(){},connection:{application_name:`guardrail-adapter-v352-${label}`}});
}

test('request-level Guardrail adapter reaches only v351 functions under direct admission LOGIN',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const reportPath=join(dirname(cluster.owned),
      `report-guardrail-admission-adapter-v352-${randomUUID()}.json`);
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],
      scope:'owned loopback PostgreSQL 18.6; PG73 plus v348/v349/v350/v351 review-only proposals and request-scoped app adapter',
      limitations:[
        'No route, coordinator, Worker, Hyperdrive binding, production credential, formal migration, remote SQL, or deployment changed.',
        'The owner request/user/key identity and held micro amount are caller supplied; no independent authenticated request or signed quote binding exists.',
        'The existing coordinator catches expiry failures, so this narrow adapter must not be substituted as a full GuardrailBudgetsRepository.',
        'Dispatched fallback extension, forfeiture, lease expiry recovery and buyer settlement remain unsupported; the admission LOGIN has no authority for them.',
        'Buyer settlement still has trusted direct Guardrail write grants; D1/MySQL parity, Linux CI and real UTC period-boundary execution are not tested.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];let owner;let failure;
    try{
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const roleNames=['migrator','runtime','buyer_settlement','budget_admission',
        'shared_quote_attempt_producer','shared_earning_consumer'];
      const passwords=Object.fromEntries(roleNames.map(name=>[name,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${passwords.buyer_settlement}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT PASSWORD '${passwords.budget_admission}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.shared_quote_attempt_producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.shared_earning_consumer}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${roleNames.map(name=>
          `cinatoken_gateway_${name}`).join(',')};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=client(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const admission=client(cluster,'cinatoken_gateway_budget_admission',
        passwords.budget_admission,'admission');
      clients.push(migrator,runtime,admission);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrationNames=await listPg73Migrations();
      assert.equal(migrationNames.length,73);
      const corpus=[];
      for(const name of migrationNames){
        const body=await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations=hash(corpus.join('\n'));
      const migratorUrl=`postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      const runtimeUrl=`postgres://cinatoken_gateway_runtime:${passwords.runtime}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      const admissionUrl=`postgres://cinatoken_gateway_budget_admission:${passwords.budget_admission}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      for(const [name,setting,value] of prerequisites){
        const body=await readFile(new URL(name,proposals),'utf8');
        report.sourceSha256[name]=hash(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      await activatePostgresBuyerSplitV348({DATABASE_URL:migratorUrl});
      await grantPostgresBuyerSplitV348({DATABASE_URL:migratorUrl});
      await activatePostgresBuyerGuardrailSplitV349({DATABASE_URL:migratorUrl});
      await grantPostgresBuyerGuardrailSplitV349({DATABASE_URL:migratorUrl});
      const ordinary=await readFile(new URL('budget-admission-login-v350.sql',proposals),'utf8');
      const guardrail=await readFile(new URL('guardrail-budget-admission-login-v351.sql',proposals),'utf8');
      report.sourceSha256.ordinaryAdmission=hash(ordinary);
      report.sourceSha256.guardrailAdmission=hash(guardrail);
      report.sourceSha256.adapter=hash(await readFile(new URL(
        '../../../packages/proxy/src/services/postgres-guardrail-budget-admission.ts',
        import.meta.url)));
      report.sourceSha256.fixture=hash(await readFile(new URL(import.meta.url)));
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.budget_admission_login_activation='reviewed-v1'");
        await tx.unsafe(ordinary).simple();
      });
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_admission_v351_activation='reviewed-v1'");
        await tx.unsafe(guardrail).simple();
      });
      stage('pg73-and-reviewed-function-only-prerequisites-installed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent)
          VALUES('v352-user','v352-user@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v352-workspace','personal','v352-user','V352','v352','active');
        INSERT INTO ${gateway}.api_keys
          (id,key,user_id,workspace_id,limit_micros,limit_reset)
          VALUES('v352-key','synthetic-v352-key','v352-user','v352-workspace',
            2000000,'daily');
        INSERT INTO ${gateway}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v352-budget','v352-workspace','daily',2000000);`).simple();
      const at=new Date();
      const start=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
      const end=new Date(start.getTime()+86_400_000);
      const common={workspaceId:'v352-workspace',guardrailVersion:1,
        period:'daily',periodStart:start.toISOString(),periodEnd:end.toISOString(),
        limitMicros:2_000_000};
      const intents=[
        {...common,assignmentId:'workspace-budget:v352-budget',
          guardrailId:'workspace-budget:v352-budget',scopeType:'workspace',scopeId:'v352-workspace'},
        {...common,assignmentId:'gateway-key-limit:v352-key',
          guardrailId:'gateway-key-limit:v352-key',scopeType:'api_key',scopeId:'v352-key'},
      ];
      const requestId=`v352-adapter-${randomUUID()}`;
      owner=await openPostgresGuardrailBudgetAdmissionOwner({
        runtimeClient:{driver:'postgres',raw:runtime},
        runtimeConnectionString:runtimeUrl,admissionConnectionString:admissionUrl,
        requestId,userId:'v352-user',apiKeyId:'v352-key',
      });
      const now=()=>new Date();
      const reserve=(id,micros)=>{
        const instant=now();return owner.guardrailAdmission.reserveMany({
          requestId:id,intents,reservedMicros:micros,nowIso:instant.toISOString(),
          expiresAtIso:new Date(instant.getTime()+120_000).toISOString(),
        });
      };
      assert.deepEqual(await reserve(requestId,800_000),
        {status:'reserved',reservationCount:2});
      assert.deepEqual(await reserve(requestId,800_000),
        {status:'idempotent',reservationCount:2});
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n FROM
        ${gateway}.guardrail_budget_reservations WHERE request_id=$1`,[requestId]))[0].n,2);
      stage('request-owner-reserves-real-multi-intent-ledger-through-v351-function');

      assert.throws(()=>reserve(`other-${randomUUID()}`,1),
        /request identity differs/u);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n FROM
        ${gateway}.guardrail_budget_reservations WHERE request_id LIKE 'other-%'`))[0].n,0);
      stage('request-scoped-owner-refuses-cross-request-use-before-any-SQL');

      assert.equal(await owner.guardrailAdmission.releaseMany(requestId,
        now().toISOString(),'pre_send_cancel'),2);
      assert.equal(Number((await migrator.unsafe(`SELECT sum(reserved_micros)::bigint AS amount
        FROM ${gateway}.guardrail_budget_windows WHERE workspace_id='v352-workspace'`))[0].amount),0);
      stage('pre-send-release-returns-acknowledged-count-and-clears-both-holds');
      await owner.close();owner=null;

      const secondId=`v352-mark-${randomUUID()}`;
      owner=await openPostgresGuardrailBudgetAdmissionOwner({
        runtimeClient:{driver:'postgres',raw:runtime},
        runtimeConnectionString:runtimeUrl,admissionConnectionString:admissionUrl,
        requestId:secondId,userId:'v352-user',apiKeyId:'v352-key',
      });
      assert.deepEqual(await reserve(secondId,800_000),
        {status:'reserved',reservationCount:2});
      const dispatchAt=now();
      assert.equal(await owner.guardrailAdmission.markDispatched(secondId,
        dispatchAt.toISOString(),new Date(dispatchAt.getTime()+900_000).toISOString()),true);
      assert.equal(await owner.guardrailAdmission.releaseMany(secondId,
        now().toISOString(),'not_allowed_after_dispatch'),0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n FROM
        ${gateway}.guardrail_budget_reservations
        WHERE request_id=$1 AND state='dispatched'`,[secondId]))[0].n,2);
      stage('dispatch-mark-crosses-boundary-and-later-release-keeps-ceiling');

      for(const [name,call] of [
        ['extendDispatched',()=>owner.unsupported.extendDispatched({
          requestId:secondId,intents,reservedMicros:100_000,
          nowIso:now().toISOString(),expiresAtIso:new Date(Date.now()+120_000).toISOString(),
        })],
        ['forfeitMany',()=>owner.unsupported.forfeitMany(secondId,now().toISOString(),'unknown')],
        ['expireBefore',()=>owner.unsupported.expireBefore(now().toISOString(),1)],
      ]) await assert.rejects(call(),PostgresGuardrailBudgetAdmissionUnsupportedTransitionError,name);
      assert.throws(()=>owner.guardrailAdmission.releaseMany(secondId,
        now().toISOString(),'guardrail_budget_admission_rejected'),/requires buyer settlement LOGIN/u);
      stage('unsupported-extend-forfeit-expiry-and-buyer-only-denial-fail-closed');

      await owner.close();
      assert.throws(()=>owner.guardrailAdmission.reserveMany({
        requestId:secondId,intents,reservedMicros:1,nowIso:now().toISOString(),
        expiresAtIso:new Date(Date.now()+120_000).toISOString(),
      }),/owner is closed/u);
      owner=null;
      const [actualAdmissionLogin]=await admission.unsafe(`SELECT
        CURRENT_USER AS current_role, SESSION_USER AS session_role`);
      assert.deepEqual(actualAdmissionLogin,{
        current_role:'cinatoken_gateway_budget_admission',
        session_role:'cinatoken_gateway_budget_admission',
      });
      const acl=await migrator.unsafe(`SELECT roles.role_name, targets.table_name,
          pg_catalog.has_table_privilege(roles.role_name,targets.table_name,
            'INSERT,UPDATE,DELETE') AS table_write,
          pg_catalog.has_any_column_privilege(roles.role_name,targets.table_name,
            'INSERT,UPDATE') AS column_write
        FROM (VALUES ('cinatoken_gateway_budget_admission'),
          ('cinatoken_gateway_runtime')) AS roles(role_name)
        CROSS JOIN (VALUES ('${gateway}.guardrail_budget_windows'),
          ('${gateway}.guardrail_budget_reservations')) AS targets(table_name)
        ORDER BY roles.role_name,targets.table_name`);
      assert.equal(acl.length,4);
      assert.equal(acl.every(row=>row.table_write===false && row.column_write===false),true);
      for(const sql of [admission,runtime]){
        await assert.rejects(sql.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
          SET reserved_micros=reserved_micros WHERE false`),error=>error.code==='42501');
      }
      stage('request-owner-cleanup-and-actual-LOGIN-raw-Guardrail-DML-rejected',{
        actualAdmissionLogin,acl});
      report.status='PASS';
    }catch(error){
      failure=error;report.status='FAIL';const cause=error?.cause??error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,4000)};
    }finally{
      if(owner){try{await owner.close();}catch(error){failure??=error;}}
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try{await cluster.cleanup();report.cleanup='PASS';}
      catch(error){report.cleanup='FAIL';report.cleanupError=String(error).slice(0,1500);failure??=error;}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`guardrail-admission-adapter-v352-report=${reportPath}\n`);
    }
    if(failure)throw failure;
    assert.equal(report.cleanup,'PASS');
  });

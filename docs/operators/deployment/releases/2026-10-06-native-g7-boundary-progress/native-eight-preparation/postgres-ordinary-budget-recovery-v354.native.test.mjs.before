// Owned PG18.6 proof of the default-off ordinary budget recovery LOGIN.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { openPostgresOrdinaryBudgetRecoveryOwner } from '../../../packages/proxy/src/services/postgres-ordinary-budget-recovery.ts';

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
    onnotice(){},connection:{application_name:`ordinary-recovery-v354-${label}`}});
}
async function expectCode(work,code,constraint){
  await assert.rejects(work,error=>{
    const cause=error?.cause??error;
    assert.equal(cause?.code,code,String(error));
    if(constraint) assert.equal(cause?.constraint_name,constraint);
    return true;
  });
}

test('independent ordinary budget recovery LOGIN preserves dispatched ceilings',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const reportPath=join(dirname(cluster.owned),
      `report-ordinary-budget-recovery-v354-${randomUUID()}.json`);
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],
      scope:'owned loopback PostgreSQL 18.6; PG73 plus v348/v350 and review-only v354',
      limitations:[
        'No production role, credential, route, Worker, scheduler, formal migration, remote SQL, or deployment changed.',
        'The recovery LOGIN can forfeit any dispatched request or scan expired leases; caller authentication and credential isolation are not established.',
        'The existing coordinator still uses the separate v351 admission owner and does not compose this recovery port.',
        'A recovered quoted shared-key request may need a separate economic adjustment protocol before a later typed v2 event can be written.',
        'Buyer settlement still has trusted direct financial writes; Guardrail recovery, D1/MySQL and Linux CI are outside this fixture.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];let owner;let failure;
    try{
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const roleNames=['migrator','runtime','buyer_settlement','budget_admission',
        'budget_recovery','shared_quote_attempt_producer','shared_earning_consumer'];
      const passwords=Object.fromEntries(roleNames.map(name=>[name,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${passwords.buyer_settlement}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT PASSWORD '${passwords.budget_admission}';
        CREATE ROLE cinatoken_gateway_budget_recovery LOGIN NOINHERIT PASSWORD '${passwords.budget_recovery}';
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
      const recovery=client(cluster,'cinatoken_gateway_budget_recovery',
        passwords.budget_recovery,'recovery');
      const buyer=client(cluster,'cinatoken_gateway_buyer_settlement',
        passwords.buyer_settlement,'buyer');
      clients.push(migrator,runtime,admission,recovery,buyer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
      assert.equal(names.length,73);
      const corpus=[];
      for(const name of names){
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
      const recoveryUrl=`postgres://cinatoken_gateway_budget_recovery:${passwords.budget_recovery}`
        +`@127.0.0.1:${cluster.port}/postgres`;
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
      const admissionSql=await readFile(new URL('budget-admission-login-v350.sql',proposals),'utf8');
      const recoverySql=await readFile(new URL('ordinary-budget-recovery-login-v354.sql',proposals),'utf8');
      report.sourceSha256.admission=hash(admissionSql);
      report.sourceSha256.recovery=hash(recoverySql);
      report.sourceSha256.owner=hash(await readFile(new URL(
        '../../../packages/proxy/src/services/postgres-ordinary-budget-recovery.ts',import.meta.url)));
      report.sourceSha256.fixture=hash(await readFile(new URL(import.meta.url)));
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.budget_admission_login_activation='reviewed-v1'");
        await tx.unsafe(admissionSql).simple();
      });
      await assert.rejects(migrator.begin(tx=>tx.unsafe(recoverySql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT UPDATE (budget_spent) ON ${gateway}.users
          TO cinatoken_gateway_budget_recovery`);
        await tx.unsafe("SET LOCAL cinatoken.ordinary_budget_recovery_v354_activation='reviewed-v1'");
        await tx.unsafe(recoverySql).simple();
      }),/activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        '${gateway}.forfeit_user_budget_dispatched_v354(text,timestamptz,text)')
        IS NULL AS absent`))[0].absent,true);
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.ordinary_budget_recovery_v354_activation='reviewed-v1'");
        await tx.unsafe(recoverySql).simple();
      });
      stage('pg73-v348-v350-installed-and-v354-default-off-drift-rollback');

      const acl=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_recovery',
          '${gateway}.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
          'EXECUTE') AS recovery_forfeit,
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
          '${gateway}.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
          'EXECUTE') AS admission_forfeit,
        pg_catalog.has_function_privilege('cinatoken_gateway_budget_recovery',
          '${gateway}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
          'EXECUTE') AS recovery_reserve,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${gateway}.expire_user_budget_leases_v354(timestamptz,integer)',
          'EXECUTE') AS runtime_expire,
        pg_catalog.has_table_privilege('cinatoken_gateway_budget_recovery',
          '${gateway}.user_budget_reservations','UPDATE') AS recovery_row_update,
        pg_catalog.has_any_column_privilege('cinatoken_gateway_budget_recovery',
          '${gateway}.user_budget_reservations','UPDATE') AS recovery_column_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_budget_recovery',
          '${gateway}.users','budget_spent','UPDATE') AS recovery_spend_update,
        pg_catalog.has_column_privilege('cinatoken_gateway_runtime',
          '${gateway}.users','budget_spent','UPDATE') AS runtime_spend_update`);
      assert.deepEqual(acl[0],{recovery_forfeit:true,admission_forfeit:false,
        recovery_reserve:false,
        runtime_expire:false,recovery_row_update:false,recovery_column_update:false,
        recovery_spend_update:false,runtime_spend_update:false});
      await expectCode(recovery.unsafe(`UPDATE ${gateway}.users SET budget_spent=1`),'42501');
      await expectCode(recovery.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET settled_micros=1`),'42501');
      await expectCode(runtime.unsafe(`SELECT ${gateway}.expire_user_budget_leases_v354(now(),1)`),'42501');
      await expectCode(admission.unsafe(`SELECT ${gateway}.forfeit_user_budget_dispatched_v354(
        'none',now(),'unknown')`),'42501');
      await expectCode(recovery.unsafe(`SELECT ${gateway}.reserve_user_budget_v350(
        'none','none','none',0,1,now(),now()+interval '1 minute')`),'42501');
      await expectCode(recovery.unsafe(`SELECT ${gateway}.expire_user_budget_leases_v354(
        now(),101)`),'23514','ordinary_recovery_call_v354');
      await expectCode(buyer.unsafe(`SELECT ${gateway}.forfeit_user_budget_dispatched_v354(
        'none',now(),'unknown')`),'42501');
      await expectCode(recovery.unsafe('SET ROLE cinatoken_gateway_buyer_settlement'),'42501');
      stage('actual-recovery-LOGIN-has-functions-only-and-runtime-remains-without-budget-DML',{acl:acl[0]});

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent)
          VALUES('v354-forfeit','forfeit@example.invalid',1,0),
            ('v354-scan','scan@example.invalid',1,0),
            ('v354-old','old@example.invalid',1,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v354-workspace','personal','v354-forfeit','V354','v354','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES('v354-key-forfeit','synthetic-v354-forfeit','v354-forfeit','v354-workspace'),
            ('v354-key-scan','synthetic-v354-scan','v354-scan','v354-workspace'),
            ('v354-key-old','synthetic-v354-old','v354-old','v354-workspace');`).simple();
      const reserve=async(id,user,key,micros)=>{
        const at=new Date();
        return (await admission.unsafe(`SELECT ${gateway}.reserve_user_budget_v350(
          $1,$2,$3,0,$4::bigint,$5::timestamptz,$6::timestamptz) AS value`,
          [id,user,key,micros,at.toISOString(),
            new Date(at.getTime()+120_000).toISOString()]))[0].value;
      };
      const mark=async id=>{
        const at=new Date();
        return (await admission.unsafe(`SELECT ${gateway}.mark_user_budget_dispatched_v350(
          $1,$2::timestamptz,$3::timestamptz) AS value`,
          [id,at.toISOString(),new Date(at.getTime()+900_000).toISOString()]))[0].value;
      };
      const account=async id=>{
        const value=(await migrator.unsafe(`SELECT budget_spent::text AS spent,
          budget_reserved_micros,budget_epoch AS epoch
          FROM ${gateway}.users WHERE id=$1`,[id]))[0];
        return {spent:value.spent,reserved:Number(value.budget_reserved_micros),
          epoch:Number(value.epoch)};
      };
      const row=async id=>{
        const value=(await migrator.unsafe(`SELECT state,settled_micros,
          terminal_reason AS reason FROM ${gateway}.user_budget_reservations
          WHERE request_id=$1`,[id]))[0];
        return {state:value.state,settled:Number(value.settled_micros),reason:value.reason};
      };
      owner=await openPostgresOrdinaryBudgetRecoveryOwner({
        runtimeClient:{driver:'postgres',raw:runtime},
        runtimeConnectionString:runtimeUrl,recoveryConnectionString:recoveryUrl,
      });
      const forfeitId=`v354-forfeit-${randomUUID()}`;
      assert.equal((await reserve(forfeitId,'v354-forfeit','v354-key-forfeit',700_000)).status,'reserved');
      assert.equal(await mark(forfeitId),true);
      assert.equal(await owner.recovery.forfeitDispatched(forfeitId,new Date().toISOString(),
        'usage_unknown'),1);
      assert.deepEqual(await row(forfeitId),{state:'expired',settled:700_000,reason:'usage_unknown'});
      assert.deepEqual(await account('v354-forfeit'),{spent:'0.700000',reserved:0,epoch:0});
      assert.deepEqual(await reserve(`v354-blocked-${randomUUID()}`,
        'v354-forfeit','v354-key-forfeit',400_000),
        {status:'blocked',remainingMicros:300_000});
      stage('dispatched-unknown-forfeit-charges-full-ceiling-before-capacity-can-return');

      // Model a lost client acknowledgement after a committed result. An
      // explicit replay must be idempotent and must not charge the ceiling twice.
      try{
        assert.equal(await owner.recovery.forfeitDispatched(forfeitId,
          new Date().toISOString(),'usage_unknown'),1);
        throw new Error('simulated COMMIT acknowledgement loss');
      }catch(error){assert.match(String(error),/simulated COMMIT acknowledgement loss/u);}
      assert.equal(await owner.recovery.forfeitDispatched(forfeitId,
        new Date().toISOString(),'usage_unknown'),1);
      assert.deepEqual(await account('v354-forfeit'),{spent:'0.700000',reserved:0,epoch:0});
      const preId=`v354-pre-${randomUUID()}`;
      assert.equal((await reserve(preId,'v354-forfeit','v354-key-forfeit',100_000)).status,'reserved');
      assert.equal(await owner.recovery.forfeitDispatched(preId,
        new Date().toISOString(),'not_dispatched'),0);
      assert.equal((await row(preId)).state,'reserved');
      assert.equal((await admission.unsafe(`SELECT ${gateway}.release_user_budget_v350(
        $1,now(),'pre_send_cancel') AS value`,[preId]))[0].value,1);
      stage('acknowledged-replay-is-idempotent-and-pre-dispatch-forfeit-is-rejected');

      const scanIds=['v354-scan-a','v354-scan-b','v354-scan-c']
        .map(prefix=>`${prefix}-${randomUUID()}`);
      for(const id of scanIds) assert.equal((await reserve(id,'v354-scan',
        'v354-key-scan',200_000)).status,'reserved');
      assert.equal(await mark(scanIds[1]),true);
      for(const id of scanIds) await migrator.unsafe(`UPDATE
        ${gateway}.user_budget_reservations
        SET created_at=now()-interval '20 minutes',
          expires_at=now()-interval '1 minute'
        WHERE request_id=$1`,[id]);
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),2),2);
      assert.deepEqual(await row(scanIds[0]),{state:'released',settled:0,
        reason:'lease_expired_before_dispatch'});
      assert.deepEqual(await row(scanIds[1]),{state:'expired',settled:200_000,
        reason:'lease_expired_after_dispatch'});
      assert.equal((await row(scanIds[2])).state,'reserved');
      assert.deepEqual(await account('v354-scan'),{spent:'0.200000',reserved:200_000,epoch:0});
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),2),1);
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),2),0);
      assert.deepEqual(await account('v354-scan'),{spent:'0.200000',reserved:0,epoch:0});
      stage('bounded-two-row-expiry-scan-releases-unsent-and-charges-sent-full-ceiling');

      const driftId=`v354-drift-${randomUUID()}`;
      assert.equal((await reserve(driftId,'v354-scan','v354-key-scan',100_000)).status,'reserved');
      await migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations
        SET created_at=now()-interval '20 minutes',
          expires_at=now()-interval '1 minute' WHERE request_id=$1`,[driftId]);
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros+1 WHERE id='v354-scan'`);
      await expectCode(owner.recovery.expireBefore(new Date().toISOString(),1),
        '23514','ordinary_recovery_counter_v354');
      assert.equal((await row(driftId)).state,'reserved');
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET budget_reserved_micros=budget_reserved_micros-1 WHERE id='v354-scan'`);
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),1),1);
      stage('counter-drift-aborts-expiry-atomically-without-restoring-capacity');

      const oldId=`v354-old-${randomUUID()}`;
      assert.equal((await reserve(oldId,'v354-old','v354-key-old',100_000)).status,'reserved');
      assert.equal(await mark(oldId),true);
      await migrator.unsafe(`UPDATE ${gateway}.users SET
        budget_epoch=1,budget_reserved_micros=0,budget_spent=0
        WHERE id='v354-old'`);
      await migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations SET
        created_at=now()-interval '20 minutes',
        expires_at=now()-interval '1 minute' WHERE request_id=$1`,[oldId]);
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),1),1);
      assert.deepEqual(await row(oldId),{state:'expired',settled:100_000,
        reason:'lease_expired_after_dispatch'});
      assert.deepEqual(await account('v354-old'),{spent:'0.000000',reserved:0,epoch:1});
      stage('old-epoch-expiry-records-ceiling-without-debiting-current-epoch');

      const busyDispatchedId=`v354-busy-dispatched-${randomUUID()}`;
      const busyReservedId=`v354-busy-reserved-${randomUUID()}`;
      assert.equal((await reserve(busyDispatchedId,'v354-scan',
        'v354-key-scan',100_000)).status,'reserved');
      assert.equal(await mark(busyDispatchedId),true);
      assert.equal((await reserve(busyReservedId,'v354-scan',
        'v354-key-scan',100_000)).status,'reserved');
      await migrator.unsafe(`UPDATE ${gateway}.user_budget_reservations SET
        created_at=now()-interval '20 minutes',
        expires_at=now()-interval '1 minute' WHERE request_id=$1`,[busyReservedId]);
      let lockReady;
      let unlock;
      const locked=new Promise(resolve=>{lockReady=resolve;});
      const released=new Promise(resolve=>{unlock=resolve;});
      const accountLock=migrator.begin(async tx=>{
        await tx.unsafe(`SELECT id FROM ${gateway}.users
          WHERE id='v354-scan' FOR UPDATE`);
        lockReady();
        await released;
      });
      await locked;
      try{
        await expectCode(owner.recovery.forfeitDispatched(busyDispatchedId,
          new Date().toISOString(),'usage_unknown'),'55P03');
        assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),1),0);
      }finally{unlock();await accountLock;}
      assert.equal((await row(busyDispatchedId)).state,'dispatched');
      assert.equal((await row(busyReservedId)).state,'reserved');
      assert.equal(await owner.recovery.forfeitDispatched(busyDispatchedId,
        new Date().toISOString(),'usage_unknown'),1);
      assert.equal(await owner.recovery.expireBefore(new Date().toISOString(),1),1);
      assert.deepEqual(await account('v354-scan'),{spent:'0.300000',reserved:0,epoch:0});
      stage('busy-account-skip-locks-preserve-counter-and-avoid-lock-order-deadlock');
      await owner.close();owner=null;
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
      process.stdout.write(`ordinary-budget-recovery-v354-report=${reportPath}\n`);
    }
    if(failure)throw failure;
    assert.equal(report.cleanup,'PASS');
  });

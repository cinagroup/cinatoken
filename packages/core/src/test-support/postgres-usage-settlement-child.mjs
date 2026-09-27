import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../storage/drizzle/schema.pg.ts';
import { createDispatchIntentRepositoryPostgres } from '../storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../storage/recovery/usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from '../storage/recovery/usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from '../storage/recovery/usage-settlement-postgres.ts';
import { sample } from '../storage/recovery/usage-settlement-test-support.mjs';

const [dataDir,mode]=process.argv.slice(2),g='cinatoken_gateway';
assert.ok(dataDir&&['persist','commit-lost-ack','confirm'].includes(mode));
assert.ok(process.env.GATEWAY_PGLITE_MODULE);assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE,/^[a-z]+:\/\//i);
const {PGlite}=await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
const pg=await PGlite.create({dataDir,parsers:{20:v=>v,1700:v=>v,1184:v=>v}});
const options={parsers:{},serializers:{}};let transactions=0,loseConfirmation=false;
function adapt(db){return {options,unsafe(query,params=[]){
  let pending;const run=rowMode=>pending??=(async()=>{
    if(loseConfirmation&&query.startsWith('SELECT')&&query.includes('request_usage_commit_receipts'))throw new Error('fixture confirmation unavailable');
    return (await db.query(query,params,{rowMode,parsers:options.parsers})).rows;
  })();
  return {then:(yes,no)=>run('object').then(yes,no),values:()=>run('array')};
}};}
const raw={...adapt(pg),async begin(run){transactions++;return pg.transaction(tx=>run(adapt(tx)));}};
const client={driver:'postgres',raw,drizzle:drizzle(raw,{schema:pgCoreSchema})};
const facts=createUsageSettlementFactsRepositoryPostgres(client),jobs=createUsageRecoveryJobsPostgres(client),intents=createDispatchIntentRepositoryPostgres(client);
const scope={kind:'tenant',userId:'recovery-user',workspaceId:'recovery-workspace'};
try{
  if(mode==='persist'){
    await pg.exec(`CREATE SCHEMA ${g}`);const dir=new URL('../../migrations-postgres/',import.meta.url);
    for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')&&x<='0068_function_schema_resolution.sql').sort())await pg.transaction(tx=>tx.exec(readFileSync(new URL(file,dir),'utf8')));
    for(const file of ['request-dispatch-intents.sql','request-usage-settlement-facts.sql','request-usage-recovery-jobs.sql','request-usage-commit-receipts.sql']){
      await pg.transaction(tx=>tx.exec(readFileSync(new URL('../../migrations-proposals/postgres/'+file,import.meta.url),'utf8')));
    }
    await pg.transaction(tx=>tx.exec(readFileSync(new URL('../../migrations-postgres/0073_recovery_api_key_workspace_lock.sql',import.meta.url),'utf8')));
    await pg.exec(`INSERT INTO ${g}.users(id,email,budget_max,budget_reserved_micros) VALUES('recovery-user','restart@example.invalid',10,500000);
      INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status) VALUES('recovery-workspace','personal','recovery-user','Fixture','fixture','active');
      INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id) VALUES('recovery-key','','recovery-user','recovery-workspace');`);
    const value=sample(0.25),expiry=Number((await pg.query('SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+600000)::text AS n')).rows[0].n);
    await intents.prepare(value.intent,expiry);assert.equal(await intents.claim(value.intent,0,value.dispatchClaimId),'granted');
    await pg.query(`INSERT INTO ${g}.user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
      VALUES($1,'recovery-user','recovery-key',0,10000000,500000,'dispatched',$2,$3,$3)`,[value.intent.requestId,'2026-09-07T00:10:00.000Z',value.recordedAtIso]);
    const ref=await facts.persist(value);assert.equal(await jobs.inspect(ref),null);
  }else{
    // Original request, monetary params and lease proof are NOT passed between processes.
    const entries=await facts.listForRecovery(scope.userId,scope.workspaceId,50);assert.equal(entries.length,1);
    const ref=entries[0].reference,value=await facts.load(ref);
    assert.equal(value.params.chargedCost,0.25);assert.equal(value.params.requestLog.pricingAudit,'{"fixture":"original-price","cost":0.25}');
    if(mode==='commit-lost-ack'){
      assert.deepEqual(await jobs.scanUnregistered(scope,50),[ref]);await jobs.ensure(ref);
      const claim=await jobs.claim({ref,revision:0},30);assert.equal(claim.status,'claimed');
      const uncertainRaw={...raw,async begin(run){await raw.begin(run);loseConfirmation=true;throw new Error('fixture COMMIT ACK lost');}};
      const uncertain={driver:'postgres',raw:uncertainRaw,drizzle:drizzle(uncertainRaw,{schema:pgCoreSchema})};
      await assert.rejects(createUsageSettlementRepositoryPostgres(uncertain).commit(ref,claim.lease.proof),/confirmation unavailable/);
    }else{
      assert.equal(transactions,0);
      // This unrelated well-formed proof grants no ownership: committed confirmation is read-only.
      assert.equal(await createUsageSettlementRepositoryPostgres(client).commit(ref,{token:randomUUID(),revision:1}),'committed');
      assert.equal(transactions,0);assert.equal((await jobs.inspect(ref)).state,'committed');
      assert.deepEqual(await jobs.scanDue(scope,50),[]);assert.deepEqual(await jobs.scanUnregistered(scope,50),[]);
      assert.equal(await intents.claim(value.intent,1,ref.dispatchClaimId),'not_granted');
    }
    const result=(await pg.query(`SELECT (SELECT count(*)::int FROM ${g}.request_usage_commit_receipts) AS receipts,
      (SELECT count(*)::int FROM ${g}.api_key_request_logs) AS logs,
      (SELECT count(*)::int FROM ${g}.user_audit_logs) AS audits,
      (SELECT budget_spent::text FROM ${g}.users WHERE id='recovery-user') AS spent,
      (SELECT budget_reserved_micros::text FROM ${g}.users WHERE id='recovery-user') AS reserved`)).rows[0];
    assert.deepEqual(result,{receipts:1,logs:1,audits:1,spent:'0.250000',reserved:'0'});
    assert.equal(Date.parse((await pg.query(`SELECT created_at FROM ${g}.api_key_request_logs`)).rows[0].created_at),Date.parse(value.recordedAtIso));
    assert.equal((await pg.query(`SELECT stat_date FROM ${g}.public_model_daily_stats`)).rows[0].stat_date,value.recordedAtIso.slice(0,10));
  }
}finally{await pg.close();}
// Clean process close/reopen, not abrupt crash/WAL or native COMMIT protocol evidence.
process.stdout.write(JSON.stringify({mode}));

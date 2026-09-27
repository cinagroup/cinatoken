import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDispatchIntentRepositoryPostgres } from '../storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../storage/recovery/usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from '../storage/recovery/usage-recovery-jobs-postgres.ts';
import { SettlementRecoveryClaimUncertainError } from '../storage/recovery/settlement-recovery-types.ts';
import { sample } from '../storage/recovery/usage-settlement-test-support.mjs';

const [dataDir,mode]=process.argv.slice(2);
assert.ok(dataDir && ['persist','claim-lost-ack','recover'].includes(mode));
assert.ok(process.env.GATEWAY_PGLITE_MODULE);
assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE,/^[a-z]+:\/\//i);
const {PGlite}=await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
const pg=await PGlite.create({dataDir});
const adapt=db=>({unsafe:async(query,params=[])=>(await db.query(query,params)).rows});
const client={driver:'postgres',raw:{...adapt(pg),begin:run=>pg.transaction(tx=>run(adapt(tx)))}};
const facts=createUsageSettlementFactsRepositoryPostgres(client),jobs=createUsageRecoveryJobsPostgres(client),intents=createDispatchIntentRepositoryPostgres(client);
const scope={kind:'tenant',userId:'recovery-user',workspaceId:'recovery-workspace'};
try {
  if(mode==='persist'){
    await pg.exec('CREATE SCHEMA cinatoken_gateway');
    const dir=new URL('../../migrations-postgres/',import.meta.url);
    for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')&&x<='0068_function_schema_resolution.sql').sort())await pg.transaction(tx=>tx.exec(readFileSync(new URL(file,dir),'utf8')));
    for(const file of ['request-dispatch-intents.sql','request-usage-settlement-facts.sql','request-usage-recovery-jobs.sql']){
      await pg.transaction(tx=>tx.exec(readFileSync(new URL('../../migrations-proposals/postgres/'+file,import.meta.url),'utf8')));
    }
    await pg.exec(`INSERT INTO cinatoken_gateway.users(id,email) VALUES ('recovery-user','restart@example.invalid');
      INSERT INTO cinatoken_gateway.workspaces(id,scope_type,personal_owner_user_id,name,slug,status) VALUES ('recovery-workspace','personal','recovery-user','Fixture','fixture','active');
      INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id) VALUES ('recovery-key','','recovery-user','recovery-workspace');`);
    const value=sample(0.25);
    const expiry=Number((await pg.query('SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+600000)::text AS n')).rows[0].n);
    await intents.prepare(value.intent,expiry);assert.equal(await intents.claim(value.intent,0,value.dispatchClaimId),'granted');
    const ref=await facts.persist(value);assert.equal(await jobs.inspect(ref),null);
  } else if(mode==='claim-lost-ack') {
    const refs=await jobs.scanUnregistered(scope,50);assert.equal(refs.length,1);
    const row=await jobs.ensure(refs[0]);assert.equal(row.state,'pending');assert.equal(row.revision,0);
    const unknown=createUsageRecoveryJobsPostgres({...client,raw:{...client.raw,async begin(run){
      await client.raw.begin(run);throw new Error('synthetic committed ACK loss');
    }}});
    await assert.rejects(unknown.claim({ref:refs[0],revision:0},1),SettlementRecoveryClaimUncertainError);
    const observed=await jobs.inspect(refs[0]);assert.equal(observed.state,'leased');assert.equal(observed.proof,undefined);assert.equal(observed.lease_token,undefined);
  } else {
    // Only the tenant scope and owned disk path survive. No original body, token or revision
    // is passed from the earlier processes. The DB supplies the due candidate after expiry.
    const entries=await facts.listForRecovery(scope.userId,scope.workspaceId,50);assert.equal(entries.length,1);
    const ref=entries[0].reference,old=await jobs.inspect(ref);assert.equal(old.attempts,1);assert.equal(old.revision,1);
    const delay=(await pg.query('SELECT GREATEST(0,($1::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint)/1000.0)+0.05 AS n',[old.expiresAtMs])).rows[0].n;
    assert.ok(Number(delay)<=1.2);await pg.query('SELECT pg_sleep($1)',[delay]);
    const due=await jobs.scanDue(scope,50);assert.deepEqual(due,[{ref,revision:1}]);
    const claim=await jobs.claim(due[0],30);assert.equal(claim.status,'claimed');assert.equal(claim.lease.revision,2);assert.equal(claim.lease.attempts,2);
    const value=await facts.load(ref);assert.equal(value.params.chargedCost,0.25);
    assert.equal(value.params.requestLog.pricingAudit,'{"fixture":"original-price","cost":0.25}');
    assert.equal(await intents.claim(value.intent,1,ref.dispatchClaimId),'not_granted');
    assert.equal(await jobs.fail(claim.lease,'snapshot_invalid'),'blocked');
    assert.deepEqual(await jobs.scanDue(scope,50),[]);assert.deepEqual(await jobs.scanUnregistered(scope,50),[]);
    const stats=(await pg.query(`SELECT (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs) AS logs,
      (SELECT budget_spent::text FROM cinatoken_gateway.users WHERE id='recovery-user') AS spent`)).rows[0];
    assert.deepEqual(stats,{logs:0,spent:'0.000000'});
  }
}finally{await pg.close();}
// Clean process close/reopen, NOT power-loss, WAL crash or financial completion acceptance.
process.stdout.write(JSON.stringify({mode}));

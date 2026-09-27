import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../drizzle/schema.pg.ts';
import { createFinancialEngine, reserveParams, now as recordedAt, expires } from '../../test-support/postgres-financial-engine.mjs';
import { createPostgresGuardrailBudgetsRepository } from '../../db/postgres/guardrail-budgets.impl.ts';
import { insertRequestUsageAndChargeTxPg as critical } from '../../db/postgres/critical-writes.impl.ts';
import { roundGatewayMoney } from '../../lib/money-precision.ts';
import { guardrailBudgetUnits } from '../../db/guardrail-budget-types.ts';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from './usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from './usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from './usage-settlement-postgres.ts';
import { sample } from './usage-settlement-test-support.mjs';
import { SettlementConflictError } from './settlement-recovery-types.ts';

const g='cinatoken_gateway',receipt=`${g}.request_usage_commit_receipts`,job=`${g}.request_usage_recovery_jobs`;
const all={kind:'all'}, proposal=name=>readFileSync(new URL('../../../migrations-proposals/postgres/'+name,import.meta.url),'utf8');
test('PostgreSQL original usage transaction + immutable receipt + final recovery fence', {timeout:180_000},async t=>{
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE);
  const f=await createFinancialEngine({migrationHead:'0068_function_schema_resolution.sql'});t.after(()=>f.pg.close());
  for(const file of ['request-dispatch-intents.sql','request-usage-settlement-facts.sql','request-usage-recovery-jobs.sql','request-usage-commit-receipts.sql'])await f.pg.transaction(tx=>tx.exec(proposal(file)));
  // The proposal-backed fixture predates formal recovery migrations, but the
  // critical writer now needs the independently migrated API-key lock helper.
  await f.pg.transaction(tx=>tx.exec(readFileSync(new URL('../../../migrations-postgres/0073_recovery_api_key_workspace_lock.sql',import.meta.url),'utf8')));
  const intents=createDispatchIntentRepositoryPostgres(f.client),facts=createUsageSettlementFactsRepositoryPostgres(f.client);
  const jobs=createUsageRecoveryJobsPostgres(f.client),repo=createUsageSettlementRepositoryPostgres(f.client),guards=createPostgresGuardrailBudgetsRepository(f.client);
  const now=async()=>Number((await f.pg.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS n')).rows[0].n);
  const rows=async(sql,params=[])=>(await f.pg.query(sql,params)).rows;
  const counts=async()=>Object.fromEntries(await Promise.all(['request_usage_commit_receipts','api_key_request_logs','provider_attempt_availability','user_audit_logs'].map(async name=>[name,(await rows(`SELECT count(*)::int AS n FROM ${g}.${name}`))[0].n])));
  async function fixture({cost=0.25,guarded=true,legacy=false,edit,register=true,leaseSeconds=30}={}){
    const value=sample(cost);Object.assign(value.intent,{userId:'user',apiKeyId:'key',workspaceId:'workspace'});
    Object.assign(value.params.requestLog,{userId:'user',apiKeyId:'key',workspaceId:'workspace',budgetAccountedAt:recordedAt});
    value.recordedAtIso=recordedAt;value.params.requestLog.providerAttempts[0].observedAtIso=recordedAt;
    value.params.userId='user';value.params.beforeSpent=1;value.params.audit.apiKeyId='key';value.params.audit.beforeSpent=1;
    if(guarded)value.params.guardrailBudgetSettlement={requestId:value.intent.requestId,mode:'actual',reason:'fixture_actual'};
    edit?.(value);
    const id=value.intent.requestId;
    await intents.prepare(value.intent,(await now())+60000);assert.equal(await intents.claim(value.intent,0,value.dispatchClaimId),'granted');
    if(value.params.userBudgetSettlement){
      await f.pg.query(`INSERT INTO ${g}.user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'user','key',0,10000000,2000000,'dispatched',$2,$3,$3)`,[id,expires,recordedAt]);
      await f.pg.exec(`UPDATE ${g}.users SET budget_reserved_micros=2000000 WHERE id='user'`);
    }
    if(guarded){
      const byok=value.params.requestLog.isByok===true;
      const params={...reserveParams(byok?['api_key']:['user','api_key','workspace'],id),reservedMicros:500000,...(byok?{settlementBasis:'gateway_key_route'}:{})};
      assert.equal((await guards.reserveMany(params)).status,'reserved');await guards.markDispatched(id,recordedAt,expires);
    }
    if(legacy){await critical(f.client,value.params);await f.pg.query(`UPDATE ${g}.api_key_request_logs SET created_at=$1 WHERE id=$2`,[recordedAt,id]);}
    const ref=await facts.persist(value);
    if(!register)return {value,ref};
    await jobs.ensure(ref);const result=await jobs.claim({ref,revision:0},leaseSeconds);assert.equal(result.status,'claimed');
    return {value,ref,lease:result.lease};
  }
  function wrapped(hooks={}){
    const adapt=raw=>({...raw,unsafe(query,params=[]){
      const run=async(mode)=>{await hooks.beforeQuery?.(query,params,raw);const operation=raw.unsafe(query,params);
        const result=mode==='array'?await operation.values():await operation;await hooks.afterQuery?.(query,params,result,raw);return result;};
      return {then:(yes,no)=>run('object').then(yes,no),values:()=>run('array')};
    }});
    const raw={...adapt(f.client.raw),async begin(run){
      await hooks.beforeBegin?.();const result=await f.client.raw.begin(async tx=>{const result=await run(adapt(tx));await hooks.beforeCommit?.(tx);return result;});
      await hooks.afterCommit?.();return result;
    }};
    const client={driver:'postgres',raw,drizzle:drizzle(raw,{schema:pgCoreSchema})};
    return {client,repo:createUsageSettlementRepositoryPostgres(client)};
  }
  async function check(name,run){await t.test(name,async()=>{await f.reset('public,pg_temp,pg_catalog');await run();});}
  for(const cost of [0,0.25])await check(`original buyer/ordinary/Guardrail/log/stats/audit transaction commits one receipt: ${cost}`,async()=>{
    const {ref,value,lease}=await fixture({cost});const beforeTransactions=f.transactions.length;
    assert.equal(await repo.commit(ref,lease.proof),'committed');assert.equal(f.transactions.length,beforeTransactions+1);
    assert.equal((await jobs.inspect(ref)).state,'committed');assert.deepEqual(await jobs.scanDue(all,50),[]);assert.deepEqual(await jobs.scanUnregistered(all,50),[]);
    assert.deepEqual(await facts.load(ref),value);
    const summary=await counts();assert.equal(summary.request_usage_commit_receipts,1);assert.equal(summary.api_key_request_logs,1);assert.equal(summary.provider_attempt_availability,1);assert.equal(summary.user_audit_logs,cost?1:0);
    const account=(await rows(`SELECT budget_spent::text,budget_reserved_micros::text FROM ${g}.users WHERE id='user'`))[0];assert.equal(Number(account.budget_spent),1+cost);assert.equal(account.budget_reserved_micros,'0');
    assert.ok((await rows(`SELECT reserved_micros::text,settled_micros::text FROM ${g}.guardrail_budget_windows`)).every(x=>x.reserved_micros==='0'&&Number(x.settled_micros)===cost*1000000));
    const log=(await rows(`SELECT created_at::text,budget_charged_micros::text FROM ${g}.api_key_request_logs`))[0];assert.equal(Date.parse(log.created_at),Date.parse(recordedAt));assert.equal(Number(log.budget_charged_micros),cost*1000000);
    assert.equal((await rows(`SELECT stat_date FROM ${g}.public_model_daily_stats`))[0].stat_date,recordedAt.slice(0,10));
    const after=await f.snapshot(g);assert.equal(await repo.commit(ref,lease.proof),'committed');assert.deepEqual(await f.snapshot(g),after);
    const terminal=await jobs.inspect(ref);assert.equal((await jobs.ensure(ref)).state,'committed');
    assert.deepEqual(await jobs.claim({ref,revision:terminal.revision},30),{status:'not_claimed'});
    assert.equal(await jobs.fail(lease,'execution_error'),'not_owned');assert.deepEqual(await jobs.inspect(ref),terminal);
    await assert.rejects(f.pg.query(`UPDATE ${job} SET state='leased',last_transition='claimed',revision=revision+1,
      attempts=attempts+1,lease_token=$2,lease_seconds=30 WHERE request_id=$1`,[ref.requestId,randomUUID()]));
    assert.deepEqual(await f.snapshot(g),after);
  });
  await check('BYOK zero buyer charge preserves original key-limit standard usage without creating an ordinary debit',async()=>{
    const {ref,lease}=await fixture({cost:0,edit:value=>{Object.assign(value.params.requestLog,{isByok:true,standardCost:0.5,requestOrigin:'https://fixture.invalid',dataRegion:'global',chargedCostUsd:0});}});
    assert.equal(await repo.commit(ref,lease.proof),'committed');
    assert.equal((await rows(`SELECT settled_micros::text FROM ${g}.guardrail_budget_windows`))[0].settled_micros,'500000');
    assert.equal(Number((await rows(`SELECT budget_spent FROM ${g}.users WHERE id='user'`))[0].budget_spent),1);
  });
  await check('known original unreserved charge reuses the existing counter path',async()=>{
    const {ref,lease}=await fixture({guarded:false,edit:value=>{delete value.params.userBudgetSettlement;}});
    assert.equal(await repo.commit(ref,lease.proof),'committed');assert.equal(Number((await rows(`SELECT budget_spent FROM ${g}.users WHERE id='user'`))[0].budget_spent),1.25);
  });
  await check('simultaneous duplicate calls converge to one committed economic result (serialized PGlite)',async()=>{
    const {ref,lease}=await fixture();
    assert.deepEqual(await Promise.all(Array.from({length:8},()=>repo.commit(ref,lease.proof))),Array(8).fill('committed'));
    assert.equal((await counts()).request_usage_commit_receipts,1);assert.equal((await counts()).api_key_request_logs,1);
    assert.equal(Number((await rows(`SELECT budget_spent FROM ${g}.users WHERE id='user'`))[0].budget_spent),1.25);
    assert.equal((await jobs.inspect(ref)).revision,lease.revision+1);
  });
  await check('append-only recovery log read keeps reservation locking, rollback, replay and conflict fences',async()=>{
    const {ref,lease}=await fixture(),before=await f.snapshot(g),start=f.queries.length;
    const failing=wrapped({afterQuery(query){
      if(/^insert\s+into\s+"cinatoken_gateway"\."api_key_request_logs"/i.test(query))throw new Error('fixture post-log failure');
    }});
    await assert.rejects(failing.repo.commit(ref,lease.proof),error=>error?.cause?.message==='fixture post-log failure');
    const statements=f.queries.slice(start).map(({query})=>query);
    const logReads=statements.filter(query=>/^select\b/i.test(query)&&query.includes('"api_key_request_logs"'));
    assert.equal(logReads.length,1);
    assert.doesNotMatch(logReads[0],/\bfor\s+update\b/i);
    assert.ok(statements.some(query=>/^select\b/i.test(query)&&query.includes('"user_budget_reservations"')&&/\bfor\s+update\b/i.test(query)));
    assert.deepEqual(await f.snapshot(g),before);
    assert.deepEqual((await counts()).request_usage_commit_receipts,0);
    assert.equal(await repo.commit(ref,lease.proof),'committed');
    assert.equal((await counts()).request_usage_commit_receipts,1);
    assert.equal((await counts()).api_key_request_logs,1);
    assert.equal(Number((await rows(`SELECT budget_spent FROM ${g}.users WHERE id='user'`))[0].budget_spent),1.25);
    const committed=await f.snapshot(g);
    assert.equal(await repo.commit(ref,lease.proof),'committed');
    assert.deepEqual(await f.snapshot(g),committed);
    await f.pg.query(`UPDATE ${g}.api_key_request_logs SET charged_cost=9 WHERE id=$1`,[ref.requestId]);
    const tampered=await f.snapshot(g);
    await assert.rejects(repo.commit(ref,lease.proof),SettlementConflictError);
    assert.deepEqual(await f.snapshot(g),tampered);
  });
  await check('all nine reference fields must match before either writing or confirming a prior receipt',async()=>{
    const {ref,lease}=await fixture();
    for(const committed of [false,true]){
      if(committed)await repo.commit(ref,lease.proof);
      const before=await f.snapshot(g),transactions=f.transactions.length;
      for(const patch of [{requestId:'other'},{attemptIndex:2},{userId:'other'},{apiKeyId:'other-key'},{workspaceId:'other-workspace'},
        {operation:'images.edits'},{contextSha256:'b'.repeat(64)},{dispatchClaimId:randomUUID()},{payloadSha256:'b'.repeat(64)}]){
        await assert.rejects(repo.commit({...ref,...patch},lease.proof),SettlementConflictError);
      }
      assert.equal(f.transactions.length,transactions);assert.deepEqual(await f.snapshot(g),before);
    }
  });
  await check('invalid references/proofs reject without database I/O, and valid caller inputs are owned before awaiting',async()=>{
    const {ref,lease}=await fixture();let calls=0;
    const rejecting=createUsageSettlementRepositoryPostgres({driver:'postgres',raw:{unsafe(){calls++;throw new Error('unexpected I/O');}}});
    for(const proof of [null,{}, {token:lease.proof.token+'\n',revision:1},{token:lease.proof.token,revision:0},
      {token:lease.proof.token,revision:Number.MAX_SAFE_INTEGER},{token:lease.proof.token,revision:1.5}])await assert.rejects(rejecting.commit(ref,proof),TypeError);
    await assert.rejects(rejecting.commit({...ref,requestId:ref.requestId+'\n'},lease.proof),TypeError);assert.equal(calls,0);
    const mutable={...ref},proof={...lease.proof},pending=repo.commit(mutable,proof);mutable.userId='other';proof.token=randomUUID();
    assert.equal(await pending,'committed');
  });
  for(const [operation,target] of [['insert','request_usage_commit_receipts'],['update','users'],['update','user_budget_reservations'],['insert','api_key_request_logs'],
    ['insert','provider_attempt_availability'],['insert','public_model_daily_stats'],['insert','user_audit_logs'],['update','guardrail_budget_reservations'],['update','guardrail_budget_windows'],['update','request_usage_recovery_jobs']]){
    await check(`failure after actual ${operation} ${target} rolls back money, receipt, logs and completion`,async()=>{
      const {ref,lease}=await fixture(),before=await f.snapshot(g),jobBefore=await jobs.inspect(ref);let hit=false;
      const failing=wrapped({afterQuery(query){const q=query.toLowerCase();if(q.startsWith(operation)&&q.includes(target)){hit=true;throw new Error('fixture boundary failure');}}});
      await assert.rejects(failing.repo.commit(ref,lease.proof));assert.equal(hit,true);assert.deepEqual(await f.snapshot(g),before);
      assert.deepEqual(await jobs.inspect(ref),jobBefore);assert.equal((await counts()).request_usage_commit_receipts,0);
    });
  }
  await check('pre-COMMIT failure rolls back everything; new lease can commit the original fact later',async()=>{
    const {ref,value,lease}=await fixture({leaseSeconds:1}),before=await f.snapshot(g);
    await assert.rejects(wrapped({beforeCommit(){throw new Error('commit failed');}}).repo.commit(ref,lease.proof));assert.deepEqual(await f.snapshot(g),before);
    await f.pg.query('SELECT pg_sleep(1.1)');const next=await jobs.claim({ref,revision:lease.revision},30);assert.equal(next.status,'claimed');
    assert.equal(await repo.commit(ref,next.lease.proof),'committed');assert.deepEqual(await facts.load(ref),value);
  });
  await check('lost COMMIT ACK reconciles one complete result without another financial transaction',async()=>{
    const {ref,lease}=await fixture();let commits=0;
    assert.equal(await wrapped({afterCommit(){commits++;throw new Error('ACK lost');}}).repo.commit(ref,lease.proof),'committed');
    assert.equal(commits,1);assert.equal((await counts()).request_usage_commit_receipts,1);assert.equal((await jobs.inspect(ref)).state,'committed');
  });
  await check('COMMIT ACK plus confirmation loss returns uncertain; later read-only confirmation never recharges',async()=>{
    const {ref,lease}=await fixture();let committed=false,commits=0;
    await assert.rejects(wrapped({afterCommit(){committed=true;commits++;throw new Error('ACK lost');},beforeQuery(q){if(committed&&q.startsWith('SELECT')&&q.includes('request_usage_commit_receipts'))throw new Error('read unavailable');}}).repo.commit(ref,lease.proof),/read unavailable/);
    const after=await f.snapshot(g),tx=f.transactions.length;assert.equal(commits,1);assert.equal(await repo.commit(ref,lease.proof),'committed');assert.equal(f.transactions.length,tx);assert.deepEqual(await f.snapshot(g),after);
  });
  await check('expiry before transaction and superseded token/revision prevent economic writes',async()=>{
    const {ref,lease}=await fixture({leaseSeconds:1}),before=await f.snapshot(g);await f.pg.query('SELECT pg_sleep(1.1)');
    await assert.rejects(repo.commit(ref,lease.proof));assert.deepEqual(await f.snapshot(g),before);
    const next=await jobs.claim({ref,revision:1},30);assert.equal(next.status,'claimed');
    for(const proof of [lease.proof,{token:lease.proof.token,revision:2},{token:next.lease.proof.token,revision:1}])await assert.rejects(repo.commit(ref,proof));
    assert.deepEqual(await f.snapshot(g),before);assert.equal(await repo.commit(ref,next.lease.proof),'committed');
  });
  await check('lease expiry during monetary writes rolls the already-applied writes back',async()=>{
    const {ref,lease}=await fixture({leaseSeconds:1}),before=await f.snapshot(g);let hit=false;
    await assert.rejects(wrapped({async afterQuery(q,p,r,raw){if(!hit&&q.toLowerCase().startsWith('update')&&q.includes('"users"')){hit=true;await raw.unsafe('SELECT pg_sleep(1.1)');}}}).repo.commit(ref,lease.proof));
    assert.equal(hit,true);assert.deepEqual(await f.snapshot(g),before);assert.equal((await counts()).request_usage_commit_receipts,0);
  });
  await check('expiry after final job UPDATE but before COMMIT is rejected by actual deferred SQL validation',async()=>{
    const {ref,lease}=await fixture({leaseSeconds:1}),before=await f.snapshot(g);let completedInside=false;
    await assert.rejects(wrapped({async beforeCommit(tx){const row=await tx.unsafe(`SELECT state FROM ${job} WHERE request_id=$1`,[ref.requestId]);completedInside=row[0].state==='committed';await tx.unsafe('SELECT pg_sleep(1.1)');}}).repo.commit(ref,lease.proof),/expired|deferred|Failed query/);
    assert.equal(completedInside,true);assert.deepEqual(await f.snapshot(g),before);assert.equal((await jobs.inspect(ref)).state,'leased');assert.equal((await counts()).request_usage_commit_receipts,0);
  });
  await check('ACK delivery after expiry cannot revoke a transaction already committed while valid',async()=>{
    const {ref,lease}=await fixture({leaseSeconds:1});assert.equal(await wrapped({afterCommit(){return f.pg.query('SELECT pg_sleep(1.1)');}}).repo.commit(ref,lease.proof),'committed');
    assert.equal((await counts()).request_usage_commit_receipts,1);assert.equal((await jobs.inspect(ref)).state,'committed');
  });
  await check('legacy same-id same-cost log is never adopted, and the new receipt cannot charge it again',async()=>{
    const {ref,lease}=await fixture({legacy:true}),before=await f.snapshot(g);await assert.rejects(repo.commit(ref,lease.proof));
    assert.deepEqual(await f.snapshot(g),before);assert.equal((await counts()).request_usage_commit_receipts,0);assert.equal((await jobs.inspect(ref)).state,'leased');
  });
  for(const register of [false,true])await check(`unfenced legacy writer cannot bypass a fact-owned request, registered=${register}`,async()=>{
    const {ref,value}=await fixture({register}),before=await f.snapshot(g);await assert.rejects(critical(f.client,value.params));
    assert.deepEqual(await f.snapshot(g),before);assert.equal((await counts()).request_usage_commit_receipts,0);assert.ok(await facts.load(ref));
  });
  await check('direct critical-writer recovery input is owned and must hash to the exact immutable payload',async()=>{
    const {ref,value,lease}=await fixture();const wrong=structuredClone(value.params);wrong.chargedCost=0.5;wrong.requestLog.chargedCost=0.5;
    const before=f.queries.length;await assert.rejects(critical(f.client,wrong,{ref,proof:lease.proof,recordedAtIso:value.recordedAtIso}),SettlementConflictError);assert.equal(f.queries.length,before);
    const mutable=structuredClone(value.params),input={ref:{...ref},proof:{...lease.proof},recordedAtIso:value.recordedAtIso};
    const pending=critical(f.client,mutable,input);mutable.chargedCost=9;input.ref.userId='other';input.proof.token=randomUUID();await pending;
    assert.equal(await repo.commit(ref,lease.proof),'committed');
  });
  await check('old budget epoch recovery never debits or resets the new epoch',async()=>{
    const {ref,lease}=await fixture();await f.pg.exec(`UPDATE ${g}.users SET budget_epoch=1,budget_spent=4,budget_reserved_micros=0 WHERE id='user'`);
    assert.equal(await repo.commit(ref,lease.proof),'committed');
    const row=(await rows(`SELECT budget_spent::text,budget_epoch::text,budget_reserved_micros::text FROM ${g}.users WHERE id='user'`))[0];assert.equal(Number(row.budget_spent),4);assert.equal(row.budget_epoch,'1');assert.equal(row.budget_reserved_micros,'0');
  });
  await check('current API-key workspace mismatch rejects instead of silently reassigning a historical settlement',async()=>{
    const {ref,lease}=await fixture();await f.pg.exec(`UPDATE ${g}.api_keys SET workspace_id='other-workspace' WHERE id='key'`);const before=await f.snapshot(g);
    await assert.rejects(repo.commit(ref,lease.proof));assert.deepEqual(await f.snapshot(g),before);assert.equal((await counts()).request_usage_commit_receipts,0);
  });
  for(const text of ['\u0000','\ud800','\udfff'])await check('unsupported raw PostgreSQL text is retained in the fact but never silently normalized or charged: '+JSON.stringify(text),async()=>{
    const {ref,value,lease}=await fixture({edit:value=>value.params.requestLog.errorMessage=text}),before=await f.snapshot(g),transactions=f.transactions.length;
    await assert.rejects(repo.commit(ref,lease.proof),/losslessly/);assert.equal(f.transactions.length,transactions);assert.deepEqual(await f.snapshot(g),before);assert.deepEqual(await facts.load(ref),value);
  });
  await check('Unicode and double-escaped JSON audit strings remain compatible with actual log writes',async()=>{
    const {ref,value,lease}=await fixture({edit:value=>{value.params.requestLog.errorMessage='图片🚀';value.params.requestLog.rawUsage=JSON.stringify({extra:'\u0000'});}});
    assert.equal(await repo.commit(ref,lease.proof),'committed');const log=(await rows(`SELECT error_message,raw_usage FROM ${g}.api_key_request_logs`))[0];
    assert.equal(log.error_message,value.params.requestLog.errorMessage);assert.equal(log.raw_usage,value.params.requestLog.rawUsage);
  });
  await check('existing six-decimal money rounding is retained for a binary half-boundary',async()=>{
    const cost=1.0000025,{ref,lease}=await fixture({cost,guarded:false});assert.equal(await repo.commit(ref,lease.proof),'committed');
    assert.equal(Number((await rows(`SELECT charged_cost FROM ${g}.api_key_request_logs`))[0].charged_cost),roundGatewayMoney(cost));
  });
  await check('SQL receipt compatibility matches actual JS monetary rounding and clamped units across bounded binary edge samples',async()=>{
    const values=[0,0.0000005,1.0000025,0.9999995,Number.MAX_SAFE_INTEGER/1e6];
    for(let i=0;i<2000;i++){const value=(i+0.5)/1e6;values.push(value,value*(1-Number.EPSILON),value*(1+Number.EPSILON));}
    for(let power=0;power<=52;power++)for(const offset of [-1,-0.5,0,0.5,1]){const value=(2**power+offset)/1e6;if(value>=0&&value<=Number.MAX_SAFE_INTEGER/1e6)values.push(value);}
    let seed=123456789;for(let i=0;i<2000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push((seed/2**32)*(Number.MAX_SAFE_INTEGER/1e6));}
    const samples=[...new Set(values)];
    const mismatch=await rows(`SELECT v.input FROM unnest($1::text[],$2::text[],$3::text[]) AS v(input,money,units)
      WHERE cinatoken_gateway.usage_money_v1(v.input)::numeric(18,6)<>v.money::numeric(18,6)
        OR cinatoken_gateway.usage_budget_units_v1(v.input)<>v.units::bigint LIMIT 5`,
      [samples.map(String),samples.map(x=>String(roundGatewayMoney(x))),samples.map(x=>String(guardrailBudgetUnits(roundGatewayMoney(x))))]);
    assert.deepEqual(mismatch,[]);assert.ok(samples.length>7000);
  });
  await check('receipt alone and forged completion cannot commit without the matching full financial transaction',async()=>{
    const {ref,value,lease}=await fixture(),before=await f.snapshot(g);
    await assert.rejects(f.pg.query(`UPDATE ${job} SET state='committed',last_transition='committed',revision=revision+1,lease_token=NULL,lease_seconds=NULL,last_error=NULL WHERE request_id=$1`,[ref.requestId]));
    await assert.rejects(f.pg.query(`INSERT INTO ${receipt}(request_id,payload_sha256,user_id,workspace_id,recorded_at,lease_token,lease_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,[ref.requestId,ref.payloadSha256,ref.userId,ref.workspaceId,value.recordedAtIso,lease.proof.token,lease.revision]));
    assert.deepEqual(await f.snapshot(g),before);assert.equal((await counts()).request_usage_commit_receipts,0);
  });
  await check('immutable receipt rejects UPDATE/DELETE, and changed committed log is a conflict rather than permission to recharge',async()=>{
    const {ref,lease}=await fixture();await repo.commit(ref,lease.proof);
    await assert.rejects(f.pg.query(`UPDATE ${receipt} SET payload_sha256=$1 WHERE request_id=$2`,['b'.repeat(64),ref.requestId]),/immutable/);
    await assert.rejects(f.pg.query(`DELETE FROM ${receipt} WHERE request_id=$1`,[ref.requestId]),/immutable/);
    await f.pg.query(`UPDATE ${g}.api_key_request_logs SET charged_cost=9 WHERE id=$1`,[ref.requestId]);const before=await f.snapshot(g);
    await assert.rejects(repo.commit(ref,lease.proof),SettlementConflictError);assert.deepEqual(await f.snapshot(g),before);
  });
  await check('missing receipt schema rejects before financial BEGIN without falling back to the legacy writer',async()=>{
    const {ref,lease}=await fixture(),before=await f.snapshot(g),transactions=f.transactions.length;
    await f.pg.exec(`ALTER TABLE ${receipt} RENAME TO fixture_hidden_receipts`);
    try{await assert.rejects(repo.commit(ref,lease.proof),/does not exist/);assert.equal(f.transactions.length,transactions);assert.deepEqual(await f.snapshot(g),before);}
    finally{await f.pg.exec(`ALTER TABLE ${g}.fixture_hidden_receipts RENAME TO request_usage_commit_receipts`);}
  });
  for(const searchPath of ['public,pg_temp,pg_catalog','pg_temp,public,pg_catalog','pg_catalog,cinatoken_gateway,pg_temp'])await check('financial recovery is schema-qualified: '+searchPath,async()=>{
    await f.pg.exec('SET search_path TO '+searchPath);const shadow={public:await f.snapshot('public'),temp:await f.snapshot('pg_temp')};
    const {ref,lease}=await fixture();await repo.commit(ref,lease.proof);assert.deepEqual(await f.snapshot('public'),shadow.public);assert.deepEqual(await f.snapshot('pg_temp'),shadow.temp);
  });
});

test('three clean processes persist the fact, lose financial ACK and readback, then confirm without charging again', {timeout:120_000},()=>{
  const parent=realpathSync(tmpdir()),owned=mkdtempSync(join(parent,'cinatoken-pg-settlement-'));
  const child=fileURLToPath(new URL('../../test-support/postgres-usage-settlement-child.mjs',import.meta.url));
  let terminal=true;
  try{
    for(const mode of ['persist','commit-lost-ack','confirm']){
      const result=spawnSync(process.execPath,['--import','tsx',child,join(owned,'db'),mode],{
        encoding:'utf8',timeout:35_000,env:{...process.env,GATEWAY_PG_FINANCIAL_BASELINE:''},
      });
      terminal=result.error===undefined&&result.status!==null;
      assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).mode,mode);
    }
  }finally{
    if(terminal){
      const target=realpathSync(owned);assert.equal(dirname(target),parent);assert.equal(resolve(target),resolve(owned));
      assert.ok(basename(target).startsWith('cinatoken-pg-settlement-'));rmSync(target,{recursive:true});
    }
  }
});

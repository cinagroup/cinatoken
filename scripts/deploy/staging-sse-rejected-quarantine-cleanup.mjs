import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {canonicalSseOperatorRow} from './staging-sse-operator-fixture.mjs';
import {sseSnapshotFaultRow} from '../../packages/proxy/scripts/staging/images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from '../../packages/proxy/scripts/staging/images-sse-cancel-observer.ts';
import {exactStagingRowGuard} from './staging-sql-row-guard.mjs';

const copy=v=>structuredClone(v),sha=v=>createHash('sha256').update(v).digest('hex');
const financial=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];
const order=['model_endpoint_routes','model_endpoints','model_routes','models','providers','api_keys','workspaces','users','system_config'];
const schemaSql='SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513';
const schemaJsonSql="SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) AS schema_json FROM ("+schemaSql+')';
const guard=(condition,params)=>({sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE json('quarantine_changed') END AS cleanup_guard`,params});
const identity=({table,row})=>{
  assert.ok(order.includes(table));const names=table==='model_endpoint_routes'?['endpoint_id','route_target_id']:table==='system_config'?['key']:['id'];
  assert.ok(names.every(n=>typeof row[n]==='string'&&row[n].length>0&&row[n].length<256));
  return {where:names.map(n=>n+' IS ?').join(' AND '),params:names.map(n=>row[n])};
};

/** Quarantined metadata only, not reconciliation of a dispatched/charged job.
 * Retains the original ONE sent request and missing rejection body/native proof.
 * Never applies the unsent cleanup predicate and never changes accounting rows.
 * Trusted caller verifies immutable input hashes and implements fresh checkClosed.
 */
export function createRejectedSseQuarantineCleanup({reference,run,plan,baselineCounts,clock,checkClosed,batch,persist,onWait}){
  const ref=copy(reference),original=copy(run),input=copy(plan),baseline=copy(baselineCounts);
  let running,rows,tables,countsQuery,expected;
  const report={result:'NOT_RUN',deleteAttempted:false,fixtureRemoved:false,primarySends:1,recoveryAttempts:0,nativeProof:false,experimentPassed:false,c02GatePassed:false};
  async function save(event){
    const ac=new AbortController(),deadline=clock.after(clock.sample(),5000);let timer;
    try{await Promise.race([Promise.resolve().then(()=>persist(copy(event),{signal:ac.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('quarantine_journal_timeout'));},5000);})]);
      assert.ok(clock.remaining(deadline)>0);
    }finally{clearTimeout(timer);ac.abort();}
  }
  async function validate(){
    assert.equal(original.result,'ATTENTION_REQUIRED');assert.equal(original.run.primarySends,1);assert.equal(original.run.seedAcknowledged,true);
    assert.equal(original.run.finalIsolationVerified,true);const f=original.run.finalization;
    assert.equal(f.accessClosed,true);assert.equal(f.tailAbsent,true);assert.equal(f.keyRevoked,true);assert.equal(f.recoveryAttempts,0);
    assert.deepEqual(f.errors.slice().sort(),['native-proof','primary-finish']);assert.equal(f.fixtureRemoved,false);
    const journal=original.run.coordinator.journal;assert.equal(journal.requests.length,1);const e=journal.requests[0];
    assert.equal(e.responseStatus,409);assert.equal(e.id,null);assert.equal(e.mode,'after-hold');assert.equal(e.timing.finished,undefined);
    assert.equal(journal.runId,input.runId);assert.equal(journal.keyHash,input.keyHash);assert.equal(journal.expiresAt,input.expiresAt);
    const p=input.plans.find(p=>p.mode==='after-hold');assert.equal(e.probeId,p.snapshot.probeId);assert.equal(e.upstreamProbeId,p.upstream.probeId);
    assert.equal(ref.result,'PASS');assert.equal(ref.runId,input.runId);assert.equal(ref.armedProbesVerified,true);
    assert.equal(ref.seedRows.length,28);assert.equal(ref.probes.length,3);
    const fixture=await imageSseFixture(input.runId,input.keyHash,input.expiresAt);
    assert.equal(fixture.seed.length,28);const seen=new Set();
    for(let i=0;i<fixture.seed.length;i++){
      const seed=fixture.seed[i],m=/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \([?,]+\)$/.exec(seed.sql);assert.ok(m);
      const item=ref.seedRows[i];assert.equal(item.table,m[1]);const names=m[2].split(',');
      for(let j=0;j<names.length;j++)if(names[j]!=='verified_at')assert.deepEqual(item.row[names[j]],seed.params[j]);
      const id=identity(item),token=item.table+JSON.stringify(id.params);assert.ok(!seen.has(token));seen.add(token);
    }
    const key=ref.seedRows.find(x=>x.table==='api_keys').row,user=ref.seedRows.find(x=>x.table==='users').row;
    assert.equal(key.status,'revoked');assert.equal(user.budget_spent_micros,0);assert.equal(user.budget_reserved_micros,0);
    const times=ref.seedRows.filter(x=>x.table==='model_endpoints').map(x=>x.row.verified_at);assert.equal(new Set(times).size,1);assert.equal(new Date(times[0]).toISOString(),times[0]);
    const probes=[sseSnapshotFaultRow(p.snapshot),canonicalSseOperatorRow(p.upstream),sseCancelObservationRow(p.snapshot)].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    assert.deepEqual(ref.probes,probes);rows=[...ref.seedRows,...probes.map(row=>({table:'system_config',row}))];
    tables=Object.keys(baseline);assert.equal(tables.length,56);for(const t of tables)assert.match(t,/^[a-z][a-z0-9_]*$/);
    for(const t of financial)assert.equal(baseline[t],0);
    expected={...baseline};for(const {table} of rows){assert.ok(Object.hasOwn(expected,table));expected[table]++;}
    assert.deepEqual(ref.counts,expected);countsQuery={sql:'SELECT '+tables.map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(','),params:[]};
  }
  async function closed(){
    const proof=await checkClosed();
    for(const k of ['stagingIdentity','versionAndModule','ingressClosed','accessClosed','tailAbsent','tokenAbsent','productionUnchanged','billingAllowed'])assert.equal(proof[k],true,k);
    const at=clock.sample();await save({step:'quarantine-closure',proof,observedAt:at});return at;
  }
  async function snapshot({initial=false}={}){
    const result=await batch([{sql:schemaSql,params:[]},{sql:schemaJsonSql,params:[]},countsQuery,...rows.map(item=>{
      const id=identity(item);return {sql:`SELECT * FROM ${item.table} WHERE ${id.where} LIMIT 2`,params:id.params};})],{write:false});
    assert.equal(result.length,rows.length+3);assert.equal(result[0].length,ref.schema.objects);assert.equal(sha(JSON.stringify(result[0])),ref.schema.sha256);
    assert.equal(result[1].length,1);assert.deepEqual(JSON.parse(result[1][0].schema_json),result[0]);assert.deepEqual(result[2],[expected]);
    for(let i=0;i<rows.length;i++){
      if(initial&&rows[i].table==='system_config'){
        // Historical probe evidence recorded canonical key/value/description,
        // not DB-maintained metadata. Capture the full row NOW, before the new
        // safety wait, then require every field unchanged on the final read.
        assert.equal(result[i+3].length,1);const actual=result[i+3][0];
        for(const [name,value] of Object.entries(rows[i].row))assert.deepEqual(actual[name],value);
        exactStagingRowGuard('system_config',actual);rows[i].row=copy(actual);
      }else assert.deepEqual(result[i+3],[rows[i].row]);
    }
    return {schemaJson:result[1][0].schema_json,counts:result[2][0],rows:result.slice(3)};
  }
  async function execute(){
    report.result='RUNNING';
    try{
      report.stage='validate';await validate();report.stage='initial-closure';await closed();report.stage='initial-snapshot';const before=await snapshot({initial:true});
      const started=clock.sample(),deadline=clock.after(started,350000);
      report.waitStarted=started;await save({step:'quarantine-wait',started,deadline,before,primarySends:1,rejectionBodyCaptured:false,nativeProof:false});
      report.stage='safety-wait';await clock.waitUntil(deadline,{onWait});report.waitFinished=clock.sample();
      report.stage='final-closure';const closedAt=await closed();report.stage='final-snapshot';const fresh=await snapshot();report.stage='delete-plan';
      const statements=[guard('('+schemaJsonSql.replace(' AS schema_json','')+') IS ?',[fresh.schemaJson]),
        ...tables.map(t=>guard(`(SELECT COUNT(*) FROM ${t})=?`,[expected[t]])),...rows.map(r=>exactStagingRowGuard(r.table,r.row))];
      for(const table of order)for(const item of rows.filter(r=>r.table===table)){
        const id=identity(item);statements.push({sql:`DELETE FROM ${table} WHERE ${id.where}`,params:id.params});
      }
      // Same-transaction postconditions catch unexpected cascades/triggers too.
      statements.push(...tables.map(t=>guard(`(SELECT COUNT(*) FROM ${t})=?`,[baseline[t]])));
      assert.ok(statements.length<=256&&Buffer.byteLength(JSON.stringify(statements))<=1048576);
      await save({step:'quarantine-delete',result:'PENDING',fresh,statementSha256:sha(JSON.stringify(statements)),primarySends:1});
      assert.ok(clock.remaining(clock.after(closedAt,60000))>0);
      report.stage='delete';report.deleteAttempted=true;await batch(statements,{write:true});
      report.deleteAcknowledged=true;const after=await batch([countsQuery],{write:false});assert.deepEqual(after,[ [baseline] ]);
      report.fixtureRemoved=true;report.removedRows=31;report.countsAfter=after[0][0];report.result='CLEANED_QUARANTINE';
      await save({step:'quarantine-delete',result:'ACK',removedRows:31,countsAfter:after[0][0]});
    }catch{report.result='ATTENTION_REQUIRED';}
    report.finished=clock.sample();try{await save({step:'quarantine-complete',...report});}catch{report.result='ATTENTION_REQUIRED';report.finalJournalFailed=true;}
    return copy(report);
  }
  return Object.freeze({run(){return running??=execute();},report:()=>copy(report)});
}

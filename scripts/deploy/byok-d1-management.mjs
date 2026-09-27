import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SSE_STAGING_SCOPE as scope} from './staging-sse-reconciliation.mjs';
import {captureByokD1CleanupBaseline,BYOK_CLEANUP_TABLES,BYOK_D1_MAINTENANCE_KEY} from '../../packages/proxy/scripts/staging/byok-d1-cleanup.ts';
import {BYOK_D1_CONTROL_KEY,parseByokD1Control} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';
import {BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED,byokD1FenceTransition} from '../../packages/proxy/scripts/staging/byok-d1-write-fence.ts';
import {parseByokMaintenancePermit} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-contract.ts';

const hash=v=>createHash('sha256').update(v).digest('hex'),copy=v=>structuredClone(v);
const hex=/^[a-f0-9]{64}$/,uint=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000000;
const root=`https://api.cloudflare.com/client/v4/accounts/${scope.account}/d1/database/${scope.database}`;
const schemaSelect='SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513';
const schemaJson=`(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${schemaSelect}))`;
const examined=new Set(['admin_api_keys','d1_migrations','model_endpoint_backfill_database_identity','system_config',
  'users','workspaces','management_api_keys','byok_keys','user_audit_logs']);

/** Host-only, fixed staging D1 REST adapter; no generic query/URL/DDL/delete API.
 * The caller must provide the full frozen deployment/isolation/budget preflight
 * guard. A journal ACK alone is not that guard. Installation of the 17-statement
 * fence remains on the native binding path: this adapter requires it installed.
 * All REST writes are SINGLE conditional statements, not assumed transactions.
 * No automatic retry, resume, reset, admission reopening or fixture cleanup.
 */
export function createByokD1Management(options) {
  let journal,apiToken,expectedSchemaSha256,assertWriteReady,fetchImpl,timeoutMs;
  try {
    assert.ok(options&&Object.keys(options).every(k=>['journal','apiToken','expectedSchemaSha256','assertWriteReady','fetchImpl','timeoutMs'].includes(k)));
    ({journal,apiToken,expectedSchemaSha256,assertWriteReady,fetchImpl=fetch,timeoutMs=60000}=options);
    assert.match(journal.identity.runId,/^c02-byok-[a-f0-9]{12}$/);assert.equal(typeof journal.attempt,'function');
    assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.match(expectedSchemaSha256,hex);
    assert.equal(typeof assertWriteReady,'function');assert.equal(typeof fetchImpl,'function');
    assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
  }catch {throw Error('byok_management_options');}
  const runId=journal.identity.runId;
  let busy=false,baseline,schema,initial,verified=[],stoppedRaw,maintenancePermit;
  const report={httpAttempts:0,httpAcknowledged:0,rowsRead:0,rowsWritten:0,mutationsAttempted:0,
    operations:[],automaticRetries:0,nativeAcceptanceProved:false};
  const ack=step=>assert.equal(journal.snapshot().attempts[step],'ACK');
  function admissible() {const s=journal.snapshot();assert.ok(!s.poisoned&&!s.closed&&!s.attempts.stop&&!s.attempts['seal-fence']);}
  async function operation(step,work,{containment=false}={}) {
    if(busy)throw Error('byok_management_busy');busy=true;
    try {
      return await journal.attempt(step,async()=>{
        const ac=new AbortController(),deadline=performance.now()+timeoutMs;let timer,reader;
        // Timers can be delayed by synchronous work/microtask pressure. Check
        // monotonic elapsed time at every admission/acceptance checkpoint too.
        const alive=()=>{if(performance.now()>=deadline)ac.abort();ac.signal.throwIfAborted();};
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('deadline'));},timeoutMs);});
        // A late response is cancelled; abort is NOT proof of remote SQL cancellation.
        const cancel=body=>{try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}};
        async function request(queries) {
          alive();assert.ok(report.httpAttempts<80);
          let body;
          if(queries){
            assert.ok(queries.length>=1&&queries.length<=9);
            for(const q of queries){assert.ok(Buffer.byteLength(q.sql)<=100000&&q.params.length<=100);
              assert.ok(q.params.every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)));}
            body=JSON.stringify(queries.length===1?queries[0]:{batch:queries});assert.ok(Buffer.byteLength(body)<=1048576);
          }
          const mutation=!!queries?.some(q=>!/^(SELECT|PRAGMA)\b/.test(q.sql));
          assert.ok(!mutation||queries.length===1);report.httpAttempts++;if(mutation)report.mutationsAttempted++;
          const event={step,method:queries?'POST':'GET',statements:queries?.length??0,mutation,result:'PENDING'};
          report.operations.push(event);
          let response;
          try {
            const pending=Promise.resolve().then(()=>fetchImpl(root+(queries?'/query':''),{
              method:event.method,headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},
              body,redirect:'error',cache:'no-store',signal:ac.signal}));
            pending.then(r=>{if(ac.signal.aborted)cancel(r.body);},()=>{});
            response=await Promise.race([pending,timeout]);alive();event.status=response.status;
            assert.equal(response.status,200);assert.equal(response.redirected,false);
            assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:\s*;|$)/i);
            const length=response.headers.get('Content-Length');
            if(length!==null)assert.ok(/^\d{1,8}$/.test(length)&&Number(length)<=2097152);
            assert.ok(response.body);reader=response.body.getReader();let bytes=0,eof=false;const chunks=[];
            for(let i=0;i<4096;i++){
              const part=await Promise.race([reader.read(),timeout]);alive();
              if(part.done){eof=true;break;}assert.ok(part.value instanceof Uint8Array);
              bytes+=part.value.byteLength;assert.ok(bytes<=2097152);chunks.push(part.value);
            }
            assert.ok(eof);if(length!==null)assert.equal(bytes,Number(length));
            const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
            assert.equal(data.success,true);assert.deepEqual(data.errors,[]);
            const value=data.result;
            if(queries){
              assert.ok(Array.isArray(value)&&value.length===queries.length);
              let reads=0,writes=0;
              for(const r of value){assert.equal(r.success,true);assert.ok(Array.isArray(r.results));
                assert.ok(uint(r.meta?.rows_read)&&uint(r.meta?.rows_written));reads+=r.meta.rows_read;writes+=r.meta.rows_written;}
              assert.ok(uint(report.rowsRead+reads)&&uint(report.rowsWritten+writes));
              report.rowsRead+=reads;report.rowsWritten+=writes;
              if(!mutation)assert.equal(writes,0);
            }else {assert.equal(value.uuid,scope.database);assert.equal(value.name,'cinatoken-staging');}
            alive();event.result='ACK';report.httpAcknowledged++;return value;
          }catch {event.result='FAILED_OR_UNCERTAIN';throw Error('management_unconfirmed');}
          finally {if(reader){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{};try{reader.releaseLock();}catch{};reader=undefined;}
            else if(response)cancel(response.body);}
        }
        try {
          if(!containment){ack('preflight');ack('closure-before');}
          const value=await work({request,signal:ac.signal});alive();return value;
        }finally {clearTimeout(timer);ac.abort();}
      },value=>({evidenceSha256:hash(JSON.stringify(value)),rowsRead:report.rowsRead,rowsWritten:report.rowsWritten}));
    }catch {throw Error('byok_management_unconfirmed');}finally {busy=false;}
  }
  function readShim(request) {
    const queries=new WeakMap();
    function prepare(sql,params=[]) {
      assert.ok(!/[;]|--|\/\*/.test(sql));
      const pragma=/^PRAGMA table_info\(([a-z][a-z0-9_]*)\)$/.exec(sql);
      assert.ok(/^SELECT\b/.test(sql)||pragma&&examined.has(pragma[1]));
      const s=Object.freeze({bind:(...p)=>prepare(sql,p),all:async()=>(await request([{sql,params}]))[0]});
      queries.set(s,{sql,params});return s;
    }
    return {prepare,batch:items=>request(items.map(s=>{assert.ok(queries.has(s));return queries.get(s);}))};
  }
  async function readValue(request,key,max) {
    const r=(await request([{sql:'SELECT value FROM system_config WHERE key = ? AND length(CAST(value AS BLOB)) <= ?',params:[key,max]}]))[0];
    assert.equal(r.results.length,1);assert.deepEqual(Object.keys(r.results[0]),['value']);
    assert.equal(typeof r.results[0].value,'string');return r.results[0].value;
  }
  async function writeValue(request,q,key,max) {
    const r=(await request([{...q,sql:q.sql+' RETURNING value'}]))[0];
    // REST meta.changes is not the SQL changes() contract. RETURNING identifies
    // the matched row; a separate read must confirm its exact stored value.
    assert.equal(r.results.length,1);assert.deepEqual(Object.keys(r.results[0]),['value']);
    const raw=r.results[0].value;assert.equal(typeof raw,'string');assert.ok(Buffer.byteLength(raw)<=max);
    assert.equal(await readValue(request,key,max),raw);return raw;
  }
  function writeGuard() {assert.equal(assertWriteReady(),true);}
  return Object.freeze({
    async captureBaseline(){
      const result=await operation('baseline',async({request})=>{
        admissible();await request();
        const db=readShim(request);
        const b=await captureByokD1CleanupBaseline(db,expectedSchemaSha256,'write-fence-v1');
        const rows=(await db.prepare(schemaSelect).all()).results,s=JSON.stringify(rows);
        assert.equal(hash(s),expectedSchemaSha256);schema=s;return b;
      });baseline=copy(result);return copy(result);
    },
    async arm(tokenHash){
      const result=await operation('arm',async({request})=>{
        admissible();ack('baseline');assert.ok(baseline&&schema);assert.match(tokenHash,hex);writeGuard();
        const value={version:1,runId,tokenHash,issuedAt:0,expiresAt:900,state:'ready',cursor:0,pendingCase:null,receipts:[]};
        const raw=await writeValue(request,{sql:`INSERT INTO system_config(key,value) SELECT ?,
          json_set(?,'$.issuedAt',unixepoch('now'),'$.expiresAt',unixepoch('now')+900)
          WHERE ${schemaJson} IS ? AND ${Object.entries(baseline.counts).map(([t,n])=>`(SELECT COUNT(*) FROM ${t}) = ${n}`).join(' AND ')}
          AND EXISTS(SELECT 1 FROM system_config WHERE key = ? AND value = ?)
          AND NOT EXISTS(SELECT 1 FROM system_config WHERE key IN (?,?))`,
          params:[BYOK_D1_CONTROL_KEY,JSON.stringify(value),schema,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED,BYOK_D1_CONTROL_KEY,BYOK_D1_MAINTENANCE_KEY]},BYOK_D1_CONTROL_KEY,32768);
        const c=parseByokD1Control(raw);assert.equal(c.runId,runId);assert.equal(c.tokenHash,tokenHash);
        assert.equal(c.state,'ready');assert.equal(c.cursor,0);return c;
      });initial=copy(result);return copy(result);
    },
    async openFence(){return operation('open-fence',async({request})=>{
      admissible();ack('arm');assert.ok(initial&&schema);writeGuard();
      const q=byokD1FenceTransition(runId,true);q.sql+=` AND ${schemaJson} IS ?`;q.params.push(schema);
      const value=await writeValue(request,q,BYOK_D1_FENCE_KEY,128);
      assert.equal(value,JSON.stringify({version:1,state:'open',runId}));return {state:'open',runId};
    });},
    async verifyCase(index,receipt){return operation('verify-case-'+index,async({request})=>{
      admissible();assert.ok(Number.isInteger(index)&&index>=0&&index<10&&index===verified.length);ack('case-'+index);
      assert.ok(initial);const c=parseByokD1Control(await readValue(request,BYOK_D1_CONTROL_KEY,32768));
      assert.equal(c.runId,runId);assert.equal(c.tokenHash,initial.tokenHash);assert.equal(c.issuedAt,initial.issuedAt);assert.equal(c.expiresAt,initial.expiresAt);
      assert.equal(c.state,index===9?'done':'ready');assert.equal(c.cursor,index+1);
      assert.deepEqual(c.receipts,[...verified,receipt]);verified=copy(c.receipts);return c;
    });},
    async sealFence(){return operation('seal-fence',async({request})=>{
      // Even after a lost STOP ACK: independently inspect its durable outcome.
      // This can only close an open fence for THIS stopped run, never open/reset.
      await request();const raw=await readValue(request,BYOK_D1_CONTROL_KEY,32768),c=parseByokD1Control(raw);
      assert.equal(c.runId,runId);assert.equal(c.state,'stopped');
      assert.equal(await writeValue(request,byokD1FenceTransition(runId,false),BYOK_D1_FENCE_KEY,128),BYOK_D1_FENCE_CLOSED);
      stoppedRaw=raw;return {state:'closed',runId,pendingCase:c.pendingCase,completedCases:c.cursor};
    },{containment:true});},
    async armMaintenance({tokenHash,closure}){return operation('arm-maintenance',async({request})=>{
      for(const k of ['stop','seal-fence','close-gateway','close-access','open-controller-access','open-controller','closure-fresh'])ack(k);
      assert.ok(baseline&&stoppedRaw&&verified.length===10);assert.match(tokenHash,hex);
      for(let i=0;i<10;i++)ack('verify-case-'+i);
      const c=parseByokD1Control(stoppedRaw);assert.equal(c.pendingCase,null);assert.equal(c.cursor,10);assert.deepEqual(c.receipts,verified);
      const observed=closure.assertFreshMaintenanceIngress();assert.equal(observed.result,'MAINTENANCE_READY');
      assert.equal(observed.knownIngressClosed,false);assert.equal(observed.knownProducerIngressClosed,true);assert.equal(observed.maintenanceOnlyConfigured,true);
      assert.equal(observed.maintenance.runId,runId);
      assert.equal(observed.databaseQuiescenceProved,false);assert.match(observed.evidenceSha256,hex);
      const observedAt=Math.floor(Date.parse(observed.finished.wallAt)/1000);assert.ok(Number.isSafeInteger(observedAt)&&observedAt>0);
      const p=parseByokMaintenancePermit(JSON.stringify({version:1,runId,tokenHash,issuedAt:observedAt,expiresAt:observedAt+60,state:'ready',baseline,
        closure:{observedAt,evidenceSha256:observed.evidenceSha256},receipt:null}));writeGuard();
      const raw=await writeValue(request,{sql:`INSERT INTO system_config(key,value) SELECT ?,
        json_set(?,'$.issuedAt',unixepoch('now'),'$.expiresAt',unixepoch('now')+60)
        WHERE unixepoch('now') BETWEEN ? AND ? AND ${schemaJson} IS ?
        AND EXISTS(SELECT 1 FROM system_config WHERE key = ? AND value = ?)
        AND EXISTS(SELECT 1 FROM system_config WHERE key = ? AND value = ?)
        AND NOT EXISTS(SELECT 1 FROM system_config WHERE key = ?)`,
        params:[BYOK_D1_MAINTENANCE_KEY,JSON.stringify(p),observedAt,observedAt+5,schema,
          BYOK_D1_CONTROL_KEY,stoppedRaw,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED,BYOK_D1_MAINTENANCE_KEY]},BYOK_D1_MAINTENANCE_KEY,16384);
      const result=parseByokMaintenancePermit(raw);assert.equal(result.runId,runId);assert.equal(result.state,'ready');
      assert.equal(result.tokenHash,tokenHash);assert.deepEqual(result.baseline,baseline);assert.deepEqual(result.closure,p.closure);
      maintenancePermit=copy(result);return result;
    });},
    async verifyFinal(){return operation('final-verify',async({request})=>{
      // A public cleanup receipt is not a database postcondition. Only this
      // same adapter has the exact pre-fixture baseline and issued permit.
      for(const k of ['cleanup','close-gateway','close-access','close-controller','close-controller-access','revoke-token','closure-after'])ack(k);
      assert.ok(baseline&&schema&&maintenancePermit&&verified.length===10);
      await request();
      const raw=await readValue(request,BYOK_D1_MAINTENANCE_KEY,16384),p=parseByokMaintenancePermit(raw);
      assert.equal(p.state,'finished');assert.deepEqual({...p,state:'ready',receipt:null},maintenancePermit);
      assert.equal(p.receipt.removedRows,664);assert.equal(p.receipt.statementCount,143);
      const expectedCounts={...baseline.counts,system_config:baseline.counts.system_config+1};
      const countsSql='SELECT '+BYOK_CLEANUP_TABLES.map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',');
      async function bookends(){
        const rows=(await request([{sql:schemaSelect,params:[]}]))[0].results;
        assert.equal(JSON.stringify(rows),schema);
        assert.deepEqual((await request([{sql:countsSql,params:[]}]))[0].results,[expectedCounts]);
        assert.equal(await readValue(request,BYOK_D1_FENCE_KEY,128),BYOK_D1_FENCE_CLOSED);
        assert.equal(await readValue(request,BYOK_D1_MAINTENANCE_KEY,16384),raw);
      }
      await bookends();
      const preserved=['admin_api_keys','d1_migrations','model_endpoint_backfill_database_identity','system_config'];
      const descriptions=await request(preserved.map(t=>({sql:`PRAGMA table_info(${t})`,params:[]})));
      const queries=preserved.map((t,i)=>{
        const columns=descriptions[i].results;assert.ok(columns.length>0&&columns.length<=100&&columns.some(c=>c.pk>0));
        const names=columns.map(c=>{assert.match(c.name,/^[a-z][a-z0-9_]*$/);return c.name;});assert.equal(new Set(names).size,names.length);
        const size=names.map(n=>`COALESCE(length(CAST(${n} AS BLOB)),0)`).join('+');
        return {sql:`SELECT ${names.join(',')} FROM ${t} WHERE (${size}) <= ${t==='system_config'?65536:8192} ORDER BY ${names.join(',')} LIMIT ?`,
          params:[expectedCounts[t]+1],names};
      });
      const results=await request(queries.map(({names,...q})=>q));let total=0;
      for(let i=0;i<preserved.length;i++){
        const table=preserved[i],rows=results[i].results;assert.equal(rows.length,expectedCounts[table]);
        for(const r of rows){assert.deepEqual(Object.keys(r).sort(),queries[i].names.slice().sort());
          assert.ok(Object.values(r).every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)));}
        if(table==='system_config'){
          const permits=rows.filter(r=>r.key===BYOK_D1_MAINTENANCE_KEY);assert.equal(permits.length,1);assert.equal(permits[0].value,raw);
          assert.ok(rows.every(r=>r.key!==BYOK_D1_CONTROL_KEY));
        }
        const canonical=JSON.stringify(rows.filter(r=>table!=='system_config'||r.key!==BYOK_D1_MAINTENANCE_KEY)
          .map(r=>Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]]))));
        total+=Buffer.byteLength(canonical);assert.ok(total<=1048576);
        assert.equal(hash(canonical),baseline.preservedRowSha256[table]);
      }
      // Bracket row reads; still observations, not an atomic snapshot or proof
      // that every external producer has stopped. No DELETE or permit reset.
      await bookends();
      return {runId,baselineRestoredExceptRetainedPermit:true,retainedClosedFence:true,retainedFinishedPermit:true,
        tablesChecked:56,preservedTablesChecked:4,removedRows:664,statementCount:143,
        schemaSha256:expectedSchemaSha256,permitSha256:hash(raw),databaseQuiescenceProved:false};
    });},
    report:()=>copy(report),
  });
}

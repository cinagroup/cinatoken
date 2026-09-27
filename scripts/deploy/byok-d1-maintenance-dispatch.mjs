import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const endpoint='https://cinatoken-staging-recovery-control.cinagroup.workers.dev/_control/byok-d1/cleanup';
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).sort().join(',')===names.slice().sort().join(',');
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Host-only single invocation, not provisioning, closure proof or a complete
 * operator. The trusted caller must validate the frozen plan/budget/baseline,
 * install and seal the DB fence, arm the permit and establish Access first.
 * The fixed workspace journal consumes cleanup BEFORE any network I/O. Even a
 * pre-claim failure cannot be replayed through this component or that journal.
 * Tokens are only sent to the fixed staging controller and never persisted.
 */
export function createByokD1MaintenanceDispatch({journal,runId,token,accessClientId,accessClientSecret,
  expectedRemovedRows,timeoutMs=30000,signal,fetchImpl=fetch,assertReady}) {
  assert.equal(typeof journal?.attempt,'function');assert.equal(typeof fetchImpl,'function');
  assert.equal(typeof assertReady,'function');
  assert.match(runId,/^c02-byok-[a-f0-9]{12}$/);
  assert.ok(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'Invalid maintenance credential');
  for(const v of [accessClientId,accessClientSecret])assert.ok(typeof v==='string'&&v.length>0&&v.length<=512&&/^[\x21-\x7e]+$/.test(v));
  assert.ok(Number.isSafeInteger(expectedRemovedRows)&&expectedRemovedRows>=1&&expectedRemovedRows<=1200);
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000);
  let started=false;
  return Object.freeze({async run(){
    assert.equal(started,false,'Maintenance dispatch cannot be replayed');started=true;
    return journal.attempt('cleanup',async()=>{
      const ac=new AbortController(),deadline=performance.now()+timeoutMs;let timer,onAbort,reader,response,stopped=false;
      const interrupted=new Promise((_,reject)=>{
        onAbort=()=>{stopped=true;ac.abort();cancel(reader);reject(Error('maintenance_interrupted'));};
        signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
        timer=setTimeout(onAbort,timeoutMs);
      });
      const active=()=>{ac.signal.throwIfAborted();assert.ok(performance.now()<deadline);};
      const work=Promise.resolve().then(async()=>{
        active();assert.equal(assertReady(),true);active(); // after PENDING fsync, immediately before HTTP
        response=await fetchImpl(endpoint,{method:'POST',redirect:'error',cache:'no-store',signal:ac.signal,
          headers:{Authorization:'Bearer '+token,'CF-Access-Client-Id':accessClientId,'CF-Access-Client-Secret':accessClientSecret,
            'X-CinaToken-BYOK-Command':'cleanup-once-v1','Content-Length':'0'}});
        if(stopped){cancel(response.body);throw Error('maintenance_interrupted');}active();
        assert.equal(response.status,200);assert.equal(response.redirected,false);
        assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
        assert.equal(response.headers.get('Cache-Control'),'no-store');
        const length=response.headers.get('Content-Length');if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=1024);
        assert.ok(response.body);reader=response.body.getReader();let bytes=0;const chunks=[];
        for(;;){active();const next=await reader.read();active();if(next.done)break;
          bytes+=next.value.byteLength;assert.ok(bytes<=1024);chunks.push(Buffer.from(next.value));}
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
        assert.ok(keys(value,['status','retry_safe','receipt']));assert.equal(value.status,'cleaned');assert.equal(value.retry_safe,false);
        const r=value.receipt;assert.ok(keys(r,['runId','removedRows','statementCount']));
        assert.equal(r.runId,runId);assert.equal(r.removedRows,expectedRemovedRows);assert.equal(r.statementCount,143);
        active();return {runId,removedRows:r.removedRows,statementCount:r.statementCount};
      });
      try{return await Promise.race([work,interrupted]);}
      finally{stopped=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
        if(reader){try{void reader.cancel().catch(()=>{}).finally(()=>{try{reader.releaseLock();}catch{}});}catch{}}
        else cancel(response?.body);}
    },receipt=>({publicHttp:1,evidenceSha256:sha(receipt)}));
  }});
}

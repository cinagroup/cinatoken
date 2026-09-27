import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex'),copy=v=>structuredClone(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const workers=[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'];
const paths=new Set(['/d1/database/'+g.database,'/access/service_tokens','/workers/scripts/'+g.worker+'/tails',
  ...[g,c].map(t=>'/access/apps/'+t.app),
  ...workers.flatMap(w=>[...['settings','deployments','subdomain','schedules'].map(s=>`/workers/scripts/${w}/${s}`),'/workers/domains?service='+w]),
  ...['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(w=>`/workers/scripts/${w}/settings`)]);
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};

/** Fixed GET-only observation transport. No SQL, content upload/download,
 * arbitrary URLs, billing API, mutations, retries, token ownership or resume.
 * Uses a separate bounded fsync log under the real exclusive reservation;
 * it cannot consume the operation journal's containment capacity. API response
 * bodies and credentials never enter that log. io is solely for fault tests.
 */
export function createByokD1ReadTransport({journal,apiToken,fetchImpl=fetch,timeoutMs=20000,io=fs}){
  let fd,directory;
  try{
    assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
    assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=20000);
    assert.equal(journal.snapshot().closed,false);assert.match(journal.identity.runId,/^c02-byok-[a-f0-9]{12}$/);
    directory=resolve(journal.directory);assert.equal(basename(directory),'byok-d1-execution-reservation');
    assert.equal(fs.realpathSync(directory),directory);assert.ok(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink());
    fd=io.openSync(resolve(directory,'observations.jsonl'),'wx',0o600);
  }catch{throw Error('byok_read_transport_options_or_reservation');}
  const controllers=new Set(),inFlight=new Set();let sequence=0,bytesWritten=0,previous='0'.repeat(64),closed=false,poisoned=false;
  const report={logicalAttempts:0,httpReservations:0,httpAttempts:0,httpAcknowledged:0,receivedBytes:0,
    active:0,peakActive:0,journalFailed:false,cloudMutationAttempted:false,remoteReadsDrained:false,automaticRetries:0};
  function save(detail){
    assert.equal(closed,false);assert.ok(sequence<1024);
    const event={sequence:sequence+1,previous,...detail},sha256=hash(JSON.stringify(event)),data=Buffer.from(JSON.stringify({...event,sha256})+'\n');
    assert.ok(data.length<=4096&&bytesWritten+data.length<=1048576);
    try{
      for(let offset=0;offset<data.length;){const n=io.writeSync(fd,data,offset,data.length-offset);assert.ok(Number.isInteger(n)&&n>0&&n<=data.length-offset);offset+=n;}
      io.fsyncSync(fd);sequence++;previous=sha256;bytesWritten+=data.length;
    }catch{report.journalFailed=true;throw Error('read_log_failed');}
  }
  try{save({event:'RESERVED',identity:{...journal.identity},account:g.account,readOnly:true});}
  catch{try{io.closeSync(fd);}catch{}throw Error('byok_read_log_reservation_failed');}
  const stop=()=>{poisoned=true;for(const controller of controllers)controller.abort();};
  async function api(path,method='GET',body,options={}){
    try{
      assert.ok(!closed&&!poisoned&&report.active<4);assert.equal(method,'GET');assert.equal(body,undefined);assert.ok(paths.has(path));
      assert.ok(options&&Object.keys(options).every(k=>k==='signal'));assert.ok(options.signal===undefined||options.signal instanceof AbortSignal);
      options.signal?.throwIfAborted();
    }catch{throw Error('byok_read_rejected');}
    report.active++;report.peakActive=Math.max(report.peakActive,report.active);report.logicalAttempts++;
    const ac=new AbortController();controllers.add(ac);const started=performance.now();let overallTimer,onAbort;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{ac.abort();reject(Error('read_interrupted'));};
      options.signal?.addEventListener('abort',onAbort,{once:true});
      overallTimer=setTimeout(onAbort,60000);
    });
    // Transport-wide poison aborts other in-flight reads too, not just this one.
    let onOwnAbort;const ownAbort=new Promise((_,reject)=>{onOwnAbort=()=>reject(Error('read_aborted'));ac.signal.addEventListener('abort',onOwnAbort,{once:true});});
    interrupted.catch(()=>{});ownAbort.catch(()=>{});
    function live(){assert.ok(!closed&&!poisoned&&performance.now()-started<60000);ac.signal.throwIfAborted();}
    async function request(target){
      live();assert.ok(report.httpReservations<320);const attempt=++report.httpReservations;
      let response,reader,status,received=0,reads=0,timer,completed=false,stage='pending-persist',failure,pendingPersistMs=0,ackPersistMs=0;
      const begin=performance.now();
      const event={attempt,path:target,method:'GET'};
      save({event:'PENDING',...event,startedMonoMs:Math.floor(begin)}); // Durable before network admission.
      pendingPersistMs=Math.max(0,Math.floor(performance.now()-begin));stage='admission';
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('read_timeout'));},timeoutMs);});
      const check=()=>{
        if(performance.now()-begin>=timeoutMs)failure='deadline';
        else if(ac.signal.aborted||poisoned)failure='cancelled_or_poisoned';
        live();assert.ok(performance.now()-begin<timeoutMs);
      };
      const work=Promise.resolve().then(async()=>{
        check();stage='fetch';report.httpAttempts++;
        response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+g.account+target,
          {method:'GET',headers:{Authorization:'Bearer '+apiToken,Accept:'application/json'},redirect:'error',cache:'no-store',signal:ac.signal});
        if(ac.signal.aborted){cancel(response.body);throw Error('read_aborted');}check();status=response.status;stage='headers';
        assert.equal(status,200);assert.equal(response.redirected,false);
        assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
        const length=response.headers.get('Content-Length');if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
        assert.ok(response.body);reader=response.body.getReader();const chunks=[];stage='body';
        for(;;){check();assert.ok(++reads<=4096);const r=await reader.read();check();if(r.done)break;
          assert.ok(r.value instanceof Uint8Array);received+=r.value.byteLength;report.receivedBytes+=r.value.byteLength;
          assert.ok(received<=2097152);chunks.push(Buffer.from(r.value));}
        if(length!==null)assert.equal(received,Number(length));
        stage='parse';const data=Buffer.concat(chunks,received),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
        // Cloudflare's Workers domains endpoint emits errors:null on success.
        // Treat only absence/null/[] as no errors; truthy success or malformed
        // error fields must never make an observation admissible.
        assert.equal(v.success,true);assert.ok(v.errors===undefined||v.errors===null||Array.isArray(v.errors)&&v.errors.length===0);assert.ok(Object.hasOwn(v,'result'));
        check();return {value:v,sha256:hash(data)};
      });
      try{
        const result=await Promise.race([work,timeout,interrupted,ownAbort]);check();
        stage='ack-persist';const persistAt=performance.now();
        save({event:'ACK',...event,status,receivedBytes:received,responseSha256:result.sha256,
          elapsedMs:Math.max(0,Math.floor(persistAt-begin)),pendingPersistMs});
        ackPersistMs=Math.max(0,Math.floor(performance.now()-persistAt));report.httpAcknowledged++;
        // ACK records a complete validated HTTP response, not permission to
        // admit stale evidence after a stalled synchronous disk flush.
        check();completed=true;return result.value;
      }finally{
        clearTimeout(timer);cancel(reader);if(reader)try{reader.releaseLock();}catch{}else cancel(response?.body);
        if(!completed){stop();try{save({event:'FAILED_OR_UNCERTAIN',...event,...(status===undefined?{}:{status}),receivedBytes:received,
          failure:failure??stage,elapsedMs:Math.max(0,Math.floor(performance.now()-begin)),pendingPersistMs,ackPersistMs});}catch{report.journalFailed=true;}}
      }
    }
    async function execute(){
      if(path!=='/access/service_tokens')return (await request(path)).result;
      const values=[],ids=new Set();let total,pages;
      for(let page=1;page<=(pages??1);page++){
        const data=await request(path+'?per_page=1000&page='+page),i=data.result_info,rows=data.result;
        assert.ok(i&&Array.isArray(rows)&&rows.length<=1000);
        assert.equal(i.page,page);assert.equal(i.per_page,1000);assert.equal(i.count,rows.length);
        assert.ok(Number.isSafeInteger(i.total_count)&&i.total_count>=0&&i.total_count<=20000);
        assert.ok(Number.isSafeInteger(i.total_pages)&&i.total_pages>=0&&Math.max(1,i.total_pages)===Math.max(1,Math.ceil(i.total_count/1000)));
        total??=i.total_count;pages??=Math.max(1,i.total_pages);assert.equal(i.total_count,total);assert.equal(Math.max(1,i.total_pages),pages);
        assert.equal(rows.length,Math.min(1000,total-(page-1)*1000));
        for(const token of rows){assert.match(token.id,uuid);assert.ok(!ids.has(token.id));ids.add(token.id);
          // Maintenance observation must bind the exact run-owned token name,
          // while secrets and other token details still never leave this reader.
          if(token.name!==undefined)assert.ok(typeof token.name==='string'&&token.name.length>0&&token.name.length<=1024);
          values.push({id:token.id,...(token.name===undefined?{}:{name:token.name})});}
      }
      assert.equal(values.length,total);return values;
    }
    // All awaits inside execute are bounded requests. Wait for their finally
    // blocks (including failure journal writes) before releasing this slot.
    try{return await execute();}
    catch{stop();throw Error('byok_read_unconfirmed');}
    finally{clearTimeout(overallTimer);options.signal?.removeEventListener('abort',onAbort);ac.signal.removeEventListener('abort',onOwnAbort);
      controllers.delete(ac);ac.abort();report.active--;}
  }
  return Object.freeze({api:(...args)=>{const p=api(...args);inFlight.add(p);p.then(()=>inFlight.delete(p),()=>inFlight.delete(p));return p;},
    settle:async()=>{await Promise.allSettled([...inFlight]);},
    report:()=>copy({...report,closed,poisoned,journalRecords:sequence,journalBytes:bytesWritten,journalSha256:previous}),
    close(){assert.equal(report.active,0);if(!closed){closed=true;io.closeSync(fd);}}});
}

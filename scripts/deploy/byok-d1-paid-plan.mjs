import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const account='7ea8e46d8210bad342fa7595f7935fea';
const paths=['/workers/account-settings','/subscriptions'];
const sha=v=>createHash('sha256').update(v).digest('hex'),copy=v=>structuredClone(v);
const obj=v=>{assert.ok(v!==null&&typeof v==='object'&&!Array.isArray(v));return v;};
const string=(v,max=128)=>{assert.ok(typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v));return v;};
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};
function instant(v){
  string(v,64);assert.match(v,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
  const n=Date.parse(v);assert.ok(Number.isFinite(n));assert.equal(new Date(n).toISOString().slice(0,19),v.slice(0,19));
  const fraction=(v.match(/\.(\d+)Z$/)?.[1]??'').padEnd(9,'0');
  return BigInt(n)*1000000n+BigInt(fraction.slice(3));
}

/** Pure projection, not provenance verification or permission to execute. Only
 * an exact Workers Paid account subscription in a current Paid period qualifies.
 * Unrelated products and their prices/identities never enter the projection. */
export function projectByokD1PaidPlan({settings,subscriptions,atMs}){
  obj(settings);assert.ok(Number.isSafeInteger(atMs)&&atMs>=0);
  const at=BigInt(atMs)*1000000n,defaultUsageModel=string(settings.default_usage_model,64);
  assert.ok(Array.isArray(subscriptions)&&subscriptions.length<=1000);
  const workers=[];const seen=new Set();
  for(const value of subscriptions){
    obj(value);if(value.rate_plan==null)continue;obj(value.rate_plan);if(value.rate_plan.id!=='workers_paid')continue;
    const id=string(value.id);assert.match(id,/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
    assert.ok(!seen.has(id));seen.add(id);assert.ok(workers.length<16);
    const plan=obj(value.rate_plan),scope=string(plan.scope,32),state=string(value.state,32);
    assert.ok(['Trial','Provisioned','Paid','AwaitingPayment','Cancelled','Failed','Expired'].includes(state));
    const startMs=instant(value.current_period_start),endMs=instant(value.current_period_end);assert.ok(endMs>startMs);
    const currency=string(value.currency,3);assert.match(currency,/^[A-Z]{3}$/);
    assert.ok(Number.isFinite(value.price)&&value.price>=0&&value.price<=1e9);
    workers.push({subscriptionId:id,productId:'workers_paid',publicName:plan.public_name==null?null:string(plan.public_name),scope,state,
      periodStart:value.current_period_start,periodEnd:value.current_period_end,currency,price:value.price,
      current:scope==='account'&&state==='Paid'&&startMs<=at&&at<endMs});
  }
  workers.sort((x,y)=>x.subscriptionId.localeCompare(y.subscriptionId));const current=workers.filter(s=>s.current);
  assert.equal(current.length,1); // Neither a missing plan nor ambiguous overlap is an admission fact.
  return {account,defaultUsageModel,workersSubscriptions:workers,selected:current[0]};
}

/** Four fixed management GETs; independent of the mutation/closure transport.
 * No billing writes, subscription creation, invoices, SQL, deployment or retries.
 * A successful observation is time-bound evidence for a future preflight, not
 * actualPaidPlanVerified for an arbitrary later operation or a complete permit.
 * io is an explicit fault-test seam; production defaults to the real filesystem. */
export function createByokD1PaidPlan({workspace,apiToken,fetchImpl=fetch,timeoutMs=60000,signal,io=fs}){
  try{
    assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
    assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);assert.ok(signal===undefined||signal instanceof AbortSignal);
    for(const key of ['openSync','writeSync','fsyncSync','closeSync'])assert.equal(typeof io[key],'function');
  }catch{throw Error('byok_paid_plan_options_invalid');}
  const root=resolve(workspace),directory=resolve(root,'.wrangler/staging/byok-d1-paid-plan-reservation');
  let promise,fd,closed=false,sequence=0,previous='0'.repeat(64);
  const report={result:'NOT_RUN',account,paidPlanObserved:false,fullPreflightPassed:false,budgetVerified:false,
    subscriptionCreated:false,cloudWrites:0,automaticRetries:0,operations:[],observations:[],snapshotIsAtomic:false};
  function save(v){
    assert.ok(!closed&&sequence<16);const row={sequence:sequence+1,previous,...v},digest=sha(JSON.stringify(row)),bytes=Buffer.from(JSON.stringify({...row,sha256:digest})+'\n');
    assert.ok(bytes.length<=4096&&!bytes.toString().includes(apiToken));
    for(let at=0;at<bytes.length;){const n=io.writeSync(fd,bytes,at,bytes.length-at);assert.ok(Number.isInteger(n)&&n>0&&n<=bytes.length-at);at+=n;}io.fsyncSync(fd);sequence++;previous=digest;
  }
  function persistResult(){
    const text=JSON.stringify(report,null,2);assert.ok(!text.includes(apiToken));let resultFd;
    try{resultFd=io.openSync(resolve(directory,'result.json'),'wx',0o600);const bytes=Buffer.from(text);
      for(let at=0;at<bytes.length;){const n=io.writeSync(resultFd,bytes,at,bytes.length-at);assert.ok(Number.isInteger(n)&&n>0&&n<=bytes.length-at);at+=n;}io.fsyncSync(resultFd);
    }finally{if(resultFd!==undefined)io.closeSync(resultFd);}
  }
  async function execute(){
    const began=performance.now(),wallBegan=Date.now(),ac=new AbortController();let timer,onAbort,phase='reservation';
    const interrupted=new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Error('plan_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);});interrupted.catch(()=>{});
    function live(){
      const elapsed=performance.now()-began,wallElapsed=Date.now()-wallBegan;
      assert.ok(!closed&&elapsed<timeoutMs&&wallElapsed>=0&&Math.abs(wallElapsed-elapsed)<=1000);ac.signal.throwIfAborted();
    }
    async function get(path){
      live();assert.ok(paths.includes(path)&&report.operations.length<4);const op={attempt:report.operations.length+1,path,method:'GET',result:'PENDING',receivedBytes:0};
      report.operations.push(op);save(op);live();const requestBegan=performance.now();let reader,response,requestTimer,settled=false;
      const check=()=>{live();assert.ok(performance.now()-requestBegan<20000);};
      const deadline=new Promise((_,reject)=>{requestTimer=setTimeout(()=>{ac.abort();reject(Error('plan_read_deadline'));},20000);});
      const work=Promise.resolve().then(async()=>{
        check();response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+account+path,
          {method:'GET',headers:{Authorization:'Bearer '+apiToken,Accept:'application/json'},redirect:'error',cache:'no-store',signal:ac.signal});
        if(settled||ac.signal.aborted){cancel(response.body);throw Error('plan_read_late');}check();op.status=response.status;
        assert.equal(response.status,200);assert.equal(response.redirected,false);assert.ok(response.body);
        assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
        const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');
        assert.ok(encoding===null||['gzip','br','deflate','identity'].includes(encoding));
        if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
        reader=response.body.getReader();const chunks=[];for(let n=0;;n++){
          check();assert.ok(n<4096);const v=await reader.read();check();if(v.done)break;assert.ok(v.value instanceof Uint8Array);
          op.receivedBytes+=v.value.byteLength;assert.ok(op.receivedBytes<=2097152);chunks.push(Buffer.from(v.value));
        }
        if(length!==null&&(!encoding||encoding==='identity'))assert.equal(op.receivedBytes,Number(length));
        const bytes=Buffer.concat(chunks,op.receivedBytes);op.responseSha256=sha(bytes);
        const value=obj(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));assert.equal(value.success,true);
        assert.ok(value.errors==null||Array.isArray(value.errors)&&value.errors.length===0);assert.ok(Object.hasOwn(value,'result'));
        // Official SDK uses SubscriptionsSinglePage, not arbitrary guessed pages.
        // Contradictory pagination metadata must nevertheless fail closed.
        if(path==='/subscriptions'){
          assert.ok(Array.isArray(value.result)&&value.result.length<=1000);
          if(value.result_info!=null){const info=obj(value.result_info);
            for(const key of ['count','total_count'])if(info[key]!==undefined)assert.equal(info[key],value.result.length);
            if(info.page!==undefined)assert.equal(info.page,1);
            if(info.total_pages!==undefined)assert.ok(info.total_pages===1||value.result.length===0&&info.total_pages===0);
            if(info.per_page!==undefined)assert.ok(Number.isSafeInteger(info.per_page)&&info.per_page>=value.result.length&&info.per_page<=1000);
            assert.ok(info.cursors==null||obj(info.cursors).after==null);
          }
        }
        check();return value.result;
      });
      try{const value=await Promise.race([work,deadline,interrupted]);check();op.result='ACK';return value;}
      catch{op.result='FAILED_OR_UNCERTAIN';ac.abort();throw Error('plan_read_unconfirmed');}
      finally{settled=true;clearTimeout(requestTimer);cancel(reader??response?.body);op.elapsedMs=Math.floor(performance.now()-requestBegan);save({...op});}
    }
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const path of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(path))fs.mkdirSync(path);assert.equal(fs.realpathSync(path),path);assert.ok(fs.lstatSync(path).isDirectory()&&!fs.lstatSync(path).isSymbolicLink());}
      fs.mkdirSync(directory);fd=io.openSync(resolve(directory,'journal.jsonl'),'wx',0o600);report.result='RUNNING';report.startedAt=new Date(wallBegan).toISOString();
      save({event:'RESERVED',account,requestLimit:4,timeoutMs});live();
      for(let round=0;round<2;round++){
        phase='settings-'+round;const settings=await get(paths[0]);live();phase='subscriptions-'+round;const subscriptions=await get(paths[1]);live();
        phase='qualify-'+round;const atMs=Date.now(),projection=projectByokD1PaidPlan({settings,subscriptions,atMs});
        live();report.observations.push({observedAt:new Date(atMs).toISOString(),...projection});
      }
      phase='compare';const [{observedAt:firstAt,...first},{observedAt:lastAt,...last}]=report.observations;assert.deepEqual(last,first);live();
      // The exact eligible period must span the whole observation, not just the
      // final request. A boundary crossed during collection requires fresh work.
      assert.ok(instant(last.selected.periodStart)<=BigInt(wallBegan)*1000000n&&BigInt(Date.now())*1000000n<instant(last.selected.periodEnd));
      report.paidPlanObserved=true;report.planStable=true;report.result='PAID_PLAN_OBSERVED';
      report.evidenceSha256=sha(JSON.stringify({account,startedAt:report.startedAt,firstAt,lastAt,projection:last,operations:report.operations}));
    }catch{report.result='FAILED_RETAINED';report.paidPlanObserved=false;report.failedPhase=phase;delete report.evidenceSha256;}
    finally{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-began);
      if(fd!==undefined){
        try{save({event:'FINISHED',result:report.result,paidPlanObserved:report.paidPlanObserved});}
        catch{report.result='FAILED_RETAINED';report.paidPlanObserved=false;delete report.evidenceSha256;}
        closed=true;
        try{io.closeSync(fd);persistResult();}catch{report.result='FAILED_RETAINED';report.paidPlanObserved=false;delete report.evidenceSha256;throw Error('byok_paid_plan_result_not_durable');}
      }
    }
    return copy(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>copy(report)});
}

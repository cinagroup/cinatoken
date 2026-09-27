import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const copy=v=>structuredClone(v),sha=v=>createHash('sha256').update(v).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tailId=/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const targets=[g,c],workers=[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'];
const production=['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'];
const dbPath='/d1/database/'+g.database,tailPath='/workers/scripts/'+g.worker+'/tails';
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};

/** Account/Worker/D1 targets are fixed, never supplied URLs. Import does no I/O.
 * The SAME original session/clock must be used by setup, window and finalizer.
 * Public inference/RPC transport remains outside this management transport.
 * batch(write:true) is only for canonical seed/revoke and the existing guarded
 * reconciler; it is not a SQL authorization service for untrusted callers.
 */
export function createSseCapacityPeerTransport({session,apiToken,fetchImpl=fetch,persist}) {
  assert.equal(typeof apiToken,'string');assert.ok(apiToken.length>0&&apiToken.length<=4096);
  assert.equal(typeof persist,'function');assert.equal(session.plan.scope.account,g.account);
  assert.equal(session.plan.scope.database,g.database);assert.equal(session.plan.scope.gateway,g.worker);assert.equal(session.plan.scope.controller,c.worker);
  const {clock}=session,writes=new Set(),acked=new Set();let cleaning=false,dbVerified=false,ownedToken,ownedTail,journalFailed=false;
  const report={operations:[],rowsRead:0,rowsWritten:0,cloudMutationAttempted:false,productionWrites:0,modelCalls:0,kmsCalls:0};
  async function bounded(work,ms,signal) {
    const deadline=clock.after(clock.sample(),ms),ac=new AbortController();let timer,onAbort;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{ac.abort();reject(Error('transport_aborted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      timer=setTimeout(()=>{ac.abort();reject(Error('transport_timeout'));},clock.remaining(deadline));
    });
    try {
      const value=await Promise.race([Promise.resolve().then(()=>{ac.signal.throwIfAborted();return work(ac.signal);}),interrupted]);
      ac.signal.throwIfAborted();assert.ok(clock.remaining(deadline)>0);return value;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();}
  }
  async function save(event,containment=false) {
    try{await bounded(signal=>persist(copy(event),{signal}),5000);}
    catch{journalFailed=true;if(!containment)throw Error('transport_journal');}
  }
  function allowed(path,method,body) {
    if(method==='GET')return path===dbPath||path===tailPath||path==='/access/service_tokens'||path==='/billable-usage'
      ||targets.some(t=>path==='/access/apps/'+t.app)
      ||workers.some(w=>['settings','deployments','subdomain','schedules'].some(s=>path===`/workers/scripts/${w}/${s}`)||path==='/workers/domains?service='+w)
      ||production.some(w=>path===`/workers/scripts/${w}/settings`);
    if(path===tailPath&&method==='POST'){assert.equal(cleaning,false);assert.deepEqual(body,{filters:[{header:{key:'x-c02-sse-host-expiry'}}]});return true;}
    if(ownedTail&&path===tailPath+'/'+ownedTail&&method==='DELETE'){assert.equal(cleaning,true);assert.equal(body,undefined);return true;}
    if(path==='/access/service_tokens'&&method==='POST'){
      assert.equal(cleaning,false);assert.deepEqual(body,{name:session.plan.tokenName,duration:'1h'});return true;
    }
    if(ownedToken&&path==='/access/service_tokens/'+ownedToken){
      assert.equal(cleaning,true);if(method==='DELETE'){assert.equal(body,undefined);return true;}
      if(method==='PUT'){assert.deepEqual(body,{name:session.plan.tokenName,enabled:false});return true;}
    }
    for(const t of targets){
      if(path===`/workers/scripts/${t.worker}/subdomain`&&method==='POST'){
        assert.deepEqual(body,{enabled:!cleaning,previews_enabled:false});return true;
      }
      if(path===`/access/apps/${t.app}/policies/${t.policy}`&&method==='PUT'){
        assert.equal(body.decision,cleaning?'deny':'non_identity');assert.equal(body.precedence,1);
        assert.equal(body.name,t===g?'CinaToken staging closed':'CinaToken recovery staging closed');
        assert.deepEqual(body.include,cleaning?[{everyone:{}}]:[{service_token:{token_id:ownedToken}}]);
        if(!cleaning)assert.match(ownedToken,uuid);
        assert.deepEqual(body.exclude??[],[]);assert.deepEqual(body.require??[],[]);return true;
      }
      if(path==='/access/apps/'+t.app&&method==='PUT'){
        assert.equal(body.id,t.app);assert.equal(body.domain,t.domain);assert.equal(body.aud,t.audience);assert.equal(body.type,'self_hosted');
        assert.deepEqual(body.destinations,[{type:'public',uri:t.domain}]);assert.equal(body.service_auth_401_redirect,!cleaning);return true;
      }
    }
    return false;
  }
  async function bytes(response,max,signal) {
    assert.ok(response.body);const reader=response.body.getReader(),parts=[];let size=0;
    const onAbort=()=>cancel(reader);signal.addEventListener('abort',onAbort,{once:true});
    try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;
      size+=next.value.byteLength;assert.ok(size<=max);parts.push(Buffer.from(next.value));}
      return Buffer.concat(parts,size);
    }finally{signal.removeEventListener('abort',onAbort);cancel(reader);}
  }
  async function request(path,method,body,{signal,sqlWrite=false,sql=false,content=false,repeatSafe=false,tokenPage}={}) {
    const encoded=body===undefined?undefined:JSON.stringify(body);assert.ok(!encoded||Buffer.byteLength(encoded)<=1048576);
    const mutation=method!=='GET'&&(!sql||sqlWrite);
    let writeKey;
    if(mutation){if(!cleaning)session.assertWriteReady();
      writeKey=(cleaning?'cleanup ':'setup ')+method+' '+path+(sql?' '+sha(encoded):'');
      assert.ok(!writes.has(writeKey)||(repeatSafe&&acked.has(writeKey)),'Uncertain writes are never replayed');writes.add(writeKey);acked.delete(writeKey);
    }
    assert.ok(report.operations.length<(cleaning?360:240),'Management capacity reserved for cleanup');
    const op={attempt:report.operations.length+1,path,method,started:clock.sample(),result:'PENDING',mutation};report.operations.push(op);
    // No raw body, auth value, token response, tail URL or exception is logged.
    await save({step:'peer-management',...op},cleaning);
    let response;
    try {
      const value=await bounded(async inner=>{
        if(mutation)report.cloudMutationAttempted=true;
        response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${g.account}${path}`,{
          method,headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},body:encoded,redirect:'error',cache:'no-store',signal:inner});
        if(inner.aborted){cancel(response.body);inner.throwIfAborted();}
        op.status=response.status;report.lastCloudDate=response.headers.get('Date');
        const data=await bytes(response,content?12582912:2097152,inner);assert.equal(response.ok,true);
        if(content)return {data,type:response.headers.get('Content-Type')};
        const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));assert.equal(result.success,true);
        if(sql){assert.ok(Array.isArray(result.result));assert.equal(result.result.length,body.batch.length);
          assert.ok(result.result.every(v=>v.success===true&&['rows_read','rows_written'].every(k=>Number.isSafeInteger(v.meta?.[k])&&v.meta[k]>=0)));}
        if(tokenPage){
          assert.ok(Array.isArray(result.result));const info=result.result_info;
          assert.ok(info&&['count','page','per_page','total_count','total_pages'].every(k=>Number.isSafeInteger(info[k])&&info[k]>=0));
          assert.equal(info.page,tokenPage);assert.equal(info.per_page,1000);assert.equal(info.count,result.result.length);
          assert.ok(info.count<=1000&&info.total_count<=20000&&info.total_pages<=20);
          assert.equal(Math.max(1,info.total_pages),Math.max(1,Math.ceil(info.total_count/1000)));
          return {values:result.result,info};
        }
        return result.result;
      },content?60000:20000,signal);
      // Capture confirmed ownership before the post-response journal can fail.
      if(path===tailPath&&method==='POST'){assert.match(value.id,tailId);ownedTail=value.id;}
      if(path==='/access/service_tokens'&&method==='POST'){assert.match(value.id,uuid);assert.equal(value.name,session.plan.tokenName);ownedToken=value.id;}
      if(path===dbPath&&method==='GET'){assert.equal(value.uuid,g.database);assert.equal(value.name,'cinatoken-staging');dbVerified=true;}
      op.result='ACK';if(writeKey)acked.add(writeKey);return value;
    }catch{op.result='FAILED_OR_UNCERTAIN';throw Error('peer_management_failed');}
    finally{cancel(response?.body);op.finished=clock.sample();await save({step:'peer-management',...op},cleaning);}
  }
  async function listTokens(signal) {
    const values=[],ids=new Set();let initial;
    // Fixed, bounded pages; never infer absence or uniqueness from page one.
    // Each page is a separate original management reservation and timed read.
    for(let page=1;page<=20;page++){
      const result=await request('/access/service_tokens?page='+page+'&per_page=1000','GET',undefined,{signal,tokenPage:page});
      initial??=result.info;
      assert.equal(result.info.total_count,initial.total_count);assert.equal(result.info.total_pages,initial.total_pages);
      const pages=Math.max(1,initial.total_pages);
      assert.equal(result.values.length,page<pages?1000:initial.total_count-(page-1)*1000);
      for(const token of result.values){assert.match(token.id,uuid);assert.ok(!ids.has(token.id));ids.add(token.id);values.push(token);}
      if(page===pages)break;
    }
    assert.equal(values.length,initial.total_count);
    const matches=values.filter(t=>t.name===session.plan.tokenName);assert.ok(matches.length<=1);
    if(matches.length&&writes.has('setup POST /access/service_tokens'))ownedToken=matches[0].id;
    return values;
  }
  async function api(path,method='GET',body,options={}) {
    // Snapshot before asynchronous persistence; URL normalization cannot turn a
    // validated relative path into a different account, Worker or database.
    const data=copy(body);assert.equal(typeof path,'string');assert.ok(allowed(path,method,data),'Out-of-scope management request');
    if(path==='/access/service_tokens'&&method==='GET')return listTokens(options.signal);
    assert.notEqual(path,dbPath+'/query');return request(path,method,data,{signal:options.signal});
  }
  async function batch(statements,{write=false,signal}={}) {
    assert.equal(dbVerified,true);assert.equal(typeof write,'boolean');const rows=copy(statements);
    assert.ok(rows.length>0&&rows.length<=256&&rows.every(s=>typeof s.sql==='string'&&Buffer.byteLength(s.sql)<=100000&&Array.isArray(s.params)&&s.params.length<=100));
    if(!write)assert.ok(rows.every(s=>s.sql.startsWith('SELECT ')&&!/;|--|\/\*/.test(s.sql)),'Read-only queries are single SELECT statements');
    if(!cleaning){assert.ok(report.rowsRead<1000000);assert.ok(report.rowsWritten<10000);}
    const revoke=cleaning&&rows.length===1&&rows[0].sql==="UPDATE api_keys SET status='revoked' WHERE id=? AND user_id=? AND workspace_id=? AND key_hash=?"
      &&JSON.stringify(rows[0].params)===JSON.stringify([session.plan.runId+'-key',session.plan.runId+'-user',session.plan.runId+'-workspace',session.plan.keyHash]);
    if(journalFailed&&write&&!revoke)throw Error('transport_journal_forbids_sql_write');
    const values=await request(dbPath+'/query','POST',{batch:rows},{signal,sql:true,sqlWrite:write,repeatSafe:revoke});assert.equal(values.length,rows.length);
    for(const v of values){assert.equal(v.success,true);
      for(const k of ['rows_read','rows_written'])assert.ok(Number.isSafeInteger(v.meta?.[k])&&v.meta[k]>=0);
      report.rowsRead+=v.meta.rows_read;report.rowsWritten+=v.meta.rows_written;if(!write)assert.equal(v.meta.rows_written,0);
    }
    await save({step:'peer-d1-counts',rowsRead:report.rowsRead,rowsWritten:report.rowsWritten},cleaning&&(!write||revoke));return values.map(v=>v.results);
  }
  return Object.freeze({api,batch,
    beginCleanup(){cleaning=true;},
    content:(options={})=>request('/workers/scripts/'+g.worker+'/content/v2','GET',undefined,{signal:options.signal,content:true}),
    ownership:()=>({runId:session.plan.runId,tokenName:session.plan.tokenName,...(ownedToken?{tokenId:ownedToken}:{}),
      tail:{creation:writes.has('setup POST '+tailPath)?'attempted':'not-attempted',...(ownedTail?{id:ownedTail}:{})}}),
    report:()=>copy({...report,cleaning,journalFailed,dbVerified}),
  });
}

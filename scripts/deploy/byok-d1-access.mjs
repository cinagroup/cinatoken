import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const credential=v=>typeof v==='string'&&v.length>0&&v.length<=512&&/^[\x21-\x7e]+$/.test(v);
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};
const appPath=t=>'/access/apps/'+t.app,ingressPath=t=>'/workers/scripts/'+t.worker+'/subdomain';
const policy=(t,id)=>({name:t===g?'CinaToken staging closed':'CinaToken recovery staging closed',
  decision:id?'non_identity':'deny',precedence:1,include:id?[{service_token:{token_id:id}}]:[{everyone:{}}],exclude:[],require:[]});
function appIdentity(a,t) {
  assert.equal(a.id,t.app);assert.equal(a.type,'self_hosted');assert.equal(a.domain,t.domain);assert.equal(a.aud,t.audience);
  assert.deepEqual(a.destinations,[{type:'public',uri:t.domain}]);assert.notEqual(a.service_auth_401_redirect,true);
  assert.equal(a.policies.length,1);assert.equal(a.policies[0].id,t.policy);
}
function appState(a,t,id) {
  appIdentity(a,t);const p=a.policies[0],expected=policy(t,id);
  for(const k of Object.keys(expected))assert.deepEqual(p[k]??(['exclude','require'].includes(k)?[]:undefined),expected[k]);
}
function subdomain(s,enabled) {assert.equal(s.enabled,enabled);assert.equal(s.previews_enabled,false);}

/** Host-only fixed staging Access/ingress adapter, NOT a deployment operator.
 * Every public operation uses the exclusive fsync journal before HTTP. No API
 * accepts a URL, resource ID, SQL, application update, production target or retry.
 * assertReady(step) is the trusted operator's synchronous, fail-closed check of
 * frozen deployments, plan entitlement, remaining permit time and USD2 reserves;
 * this module cannot manufacture those proofs. It is rechecked before EACH
 * activating write. Controller activation is only for private maintenance.
 *
 * New service-token secret is returned once, only in memory. No resume API.
 * Unknown activation writes can still land remotely after a timeout: containment
 * is best effort and NEVER asserts quiescence or resolves the poisoned journal.
 * Full operator must retain unknown state and independently reobserve it.
 */
export function createByokD1Access(options) {
  let journal,apiToken,assertReady,fetchImpl,timeoutMs;
  try {
    assert.ok(options&&Object.getPrototypeOf(options)===Object.prototype);
    assert.ok(Object.keys(options).every(k=>['journal','apiToken','assertReady','fetchImpl','timeoutMs'].includes(k)));
    ({journal,apiToken,assertReady,fetchImpl=fetch,timeoutMs=60000}=options);
    assert.equal(typeof journal?.attempt,'function');assert.equal(typeof journal?.snapshot,'function');
    assert.match(journal.identity.runId,/^c02-byok-[a-f0-9]{12}$/);
    assert.ok(credential(apiToken));assert.equal(typeof assertReady,'function');assert.equal(typeof fetchImpl,'function');
    assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
  } catch {throw Error('Invalid BYOK Access options');}
  const tokenName=journal.identity.runId+'-access';
  let ownedId=null,creationAttempted=false,creationConfirmed=false,busy=false,ended=false;
  const report={apiAttempts:0,acknowledgedResponses:0,readAttempts:0,writeAttempts:0,mayReplay:false,
    cloudQuiescenceProved:false,cleanupAuthorized:false};
  const state=()=>journal.snapshot().attempts;
  function ready(step) {
    const s=state();assert.equal(ended,false);assert.equal(journal.snapshot().poisoned,false);
    for(const k of ['preflight','closure-before'])assert.equal(s[k],'ACK');
    assert.equal(s['revoke-token'],undefined);
    if(step!=='create-token'){assert.equal(s['create-token'],'ACK');assert.ok(ownedId);}
    if(step.startsWith('open-controller')) {
      for(const k of ['stop','seal-fence','close-gateway','close-access',
        ...Array.from({length:10},(_,i)=>'verify-case-'+i)])assert.equal(s[k],'ACK');
      // Prepare transport while the fence is closed and BEFORE the fresh
      // producer observation and one-time D1 permit. This is not cleanup authority.
      for(const k of ['closure-fresh','arm-maintenance','cleanup','close-controller','close-controller-access'])assert.equal(s[k],undefined);
      if(step==='open-controller')assert.equal(s['open-controller-access'],'ACK');
    }else {
      for(const k of ['stop','seal-fence','close-gateway','close-access','close-controller','close-controller-access'])assert.equal(s[k],undefined);
      if(step==='open-gateway')assert.equal(s['open-access'],'ACK');
    }
    // A Promise is not a synchronous proof. The guard must fail closed.
    assert.equal(assertReady(step),true);
  }
  async function operation(step,activating,work,signal) {
    assert.ok(signal===undefined||signal instanceof AbortSignal,'Invalid abort signal');
    assert.equal(busy,false,'Access operation in progress');busy=true;
    try {
      return await journal.attempt(step,async()=>{
        const ac=new AbortController(),deadline=performance.now()+timeoutMs;
        let timer,onAbort,finished=false,reader,response;
        const summary={reads:0,writes:0,acks:0};
        const interrupted=new Promise((_,reject)=>{
          onAbort=()=>{finished=true;ac.abort();cancel(reader);reject(Error('access_interrupted'));};
          signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
          timer=setTimeout(onAbort,timeoutMs);
        });
        const live=()=>{ac.signal.throwIfAborted();assert.ok(performance.now()<deadline);};
        async function api(path,method='GET',body) {
          live();assert.ok(summary.reads+summary.writes<48);
          const write=method!=='GET';if(write&&activating)ready(step);live();
          const encoded=body===undefined?undefined:JSON.stringify(body);assert.ok(encoded===undefined||Buffer.byteLength(encoded)<=8192);
          report.apiAttempts++;report[write?'writeAttempts':'readAttempts']++;summary[write?'writes':'reads']++;
          response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+g.account+path,{
            method,redirect:'error',cache:'no-store',signal:ac.signal,
            headers:{Authorization:'Bearer '+apiToken,Accept:'application/json',...(encoded===undefined?{}:{'Content-Type':'application/json'})},body:encoded});
          if(finished){cancel(response.body);throw Error('access_interrupted');}live();
          assert.equal(response.status,200);assert.equal(response.redirected,false);
          assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
          const length=response.headers.get('Content-Length');
          if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
          assert.ok(response.body);reader=response.body.getReader();let bytes=0,reads=0;const chunks=[];
          try {
            for(;;){live();assert.ok(++reads<=4096);const next=await reader.read();live();if(next.done)break;
              bytes+=next.value.byteLength;assert.ok(bytes<=2097152);chunks.push(Buffer.from(next.value));}
            if(length!==null)assert.equal(bytes,Number(length));
            const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
            assert.equal(v.success,true);assert.ok(v.errors===undefined||(Array.isArray(v.errors)&&v.errors.length===0));
            assert.ok(Object.hasOwn(v,'result'));live();summary.acks++;report.acknowledgedResponses++;return v;
          } finally {cancel(reader);try{reader.releaseLock();}catch{}reader=undefined;response=undefined;}
        }
        const result=async(path,method,body)=>(await api(path,method,body)).result;
        async function tokens() {
          const all=[],ids=new Set();let total,pages;
          for(let page=1;page<=(pages??1);page++) {
            const v=await api('/access/service_tokens?per_page=1000&page='+page),i=v.result_info,rows=v.result;
            assert.ok(Array.isArray(rows)&&rows.length<=1000&&i);
            assert.equal(i.page,page);assert.equal(i.per_page,1000);assert.equal(i.count,rows.length);
            assert.ok(Number.isSafeInteger(i.total_count)&&i.total_count>=0&&i.total_count<=20000);
            assert.ok(Number.isSafeInteger(i.total_pages)&&i.total_pages>=0
              &&Math.max(1,i.total_pages)===Math.max(1,Math.ceil(i.total_count/1000)));
            total??=i.total_count;pages??=Math.max(1,i.total_pages);assert.equal(i.total_count,total);assert.equal(Math.max(1,i.total_pages),pages);
            assert.equal(rows.length,Math.min(1000,total-(page-1)*1000));
            for(const r of rows){assert.match(r.id,uuid);assert.ok(typeof r.name==='string'&&r.name.length<=1024);assert.ok(!ids.has(r.id));ids.add(r.id);
              all.push({id:r.id,name:r.name});}
          }
          assert.equal(all.length,total);return all;
        }
        const workPromise=Promise.resolve().then(async()=>{
          live();if(activating)ready(step);
          const value=await work({result,tokens,live});live();return {value,summary};
        });
        try{return await Promise.race([workPromise,interrupted]);}
        finally {finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();cancel(reader);if(!reader)cancel(response?.body);}
      },r=>({logicalApiReads:r.summary.reads,evidenceSha256:hash({step,summary:r.summary,
        // Never hash or serialize service-token secrets into the journal.
        result:step==='create-token'?{created:true,tokenId:ownedId}:r.value})}));
    } catch {throw Error('byok_access_operation_unconfirmed');}
    finally {busy=false;}
  }
  const checkIngress=async(result,t,enabled)=>subdomain(await result(ingressPath(t)),enabled);
  async function changeAccess(t,opening,{signal}={}) {
    const step=opening?(t===g?'open-access':'open-controller-access'):(t===g?'close-access':'close-controller-access');
    const r=await operation(step,opening,async({result})=>{
      if(opening){await checkIngress(result,t,false);if(t===c)await checkIngress(result,g,false);}
      const before=await result(appPath(t));appIdentity(before,t);
      if(opening)appState(before,t,null);
      const desired=policy(t,opening?ownedId:null);
      // On containment an unexpected policy body may be replaced, but only the
      // already fixed single policy on the exact staging application.
      const alreadyClosed=!opening&&(()=>{try{appState(before,t,null);return true;}catch{return false;}})();
      if(!alreadyClosed)await result(appPath(t)+'/policies/'+t.policy,'PUT',desired);
      const after=await result(appPath(t));appState(after,t,opening?ownedId:null);
      if(opening)await checkIngress(result,t,false);
      return {appId:t.app,accessSha256:hash(after),closed:!opening};
    },signal);return r.value;
  }
  async function changeIngress(t,opening,{signal}={}) {
    const step=(opening?'open-':'close-')+(t===g?'gateway':'controller');
    const r=await operation(step,opening,async({result})=>{
      if(opening){appState(await result(appPath(t)),t,ownedId);if(t===c)await checkIngress(result,g,false);}
      const before=await result(ingressPath(t));
      if(opening)subdomain(before,false);
      if(opening||before.enabled!==false||before.previews_enabled!==false)
        await result(ingressPath(t),'POST',{enabled:opening,previews_enabled:false});
      await checkIngress(result,t,opening);
      if(opening)appState(await result(appPath(t)),t,ownedId);
      return {worker:t.worker,enabled:opening,previewsEnabled:false};
    },signal);return r.value;
  }
  const methods={
    async createToken({signal}={}) {
      const r=await operation('create-token',true,async({result,tokens})=>{
        const existing=await tokens();
        assert.ok(existing.length<20000&&existing.every(t=>t.name!==tokenName));
        // Set before fetch: a failed/malformed/late ACK cannot permit recreation.
        creationAttempted=true;
        const v=await result('/access/service_tokens','POST',{name:tokenName,duration:'1h'});
        assert.equal(v.name,tokenName);assert.match(v.id,uuid);ownedId=v.id;
        assert.ok(credential(v.client_id)&&credential(v.client_secret));
        const matches=(await tokens()).filter(t=>t.name===tokenName);
        assert.equal(matches.length,1);assert.equal(matches[0].id,ownedId);creationConfirmed=true;
        return {tokenId:ownedId,accessClientId:v.client_id,accessClientSecret:v.client_secret};
      },signal);return r.value;
    },
    openGatewayAccess:opts=>changeAccess(g,true,opts),openGateway:opts=>changeIngress(g,true,opts),
    openControllerAccess:opts=>changeAccess(c,true,opts),openController:opts=>changeIngress(c,true,opts),
    closeGateway:opts=>changeIngress(g,false,opts),closeController:opts=>changeIngress(c,false,opts),
    closeGatewayAccess:opts=>changeAccess(g,false,opts),closeControllerAccess:opts=>changeAccess(c,false,opts),
    async revokeToken({signal}={}) {
      ended=true;
      const r=await operation('revoke-token',false,async({result,tokens})=>{
        if(!creationAttempted){
          assert.equal(ownedId,null);
          assert.ok(state()['create-token']===undefined||state()['create-token']==='NOT_INVOKED',
            'Token ownership is not recoverable by a new adapter');
          return {revoked:false,creationAttempted:false};
        }
        const before=await tokens(),matches=before.filter(t=>t.name===tokenName);
        assert.ok(matches.length<=1);
        if(matches.length===0){
          // If creation ACK was lost, absence NOW cannot exclude a late create.
          assert.ok(creationConfirmed);assert.ok(before.every(t=>t.id!==ownedId));
          return {revoked:true,alreadyAbsent:true};
        }
        if(ownedId)assert.equal(matches[0].id,ownedId);else ownedId=matches[0].id;
        const deleted=await result('/access/service_tokens/'+ownedId,'DELETE');assert.equal(deleted.id,ownedId);
        assert.ok((await tokens()).every(t=>t.name!==tokenName&&t.id!==ownedId));
        return {revoked:true,alreadyAbsent:false};
      },signal);return r.value;
    },
    async contain() {
      assert.equal(busy,false,'Wait for the in-flight operation to settle');ended=true;
      const failures=[];
      for(const [step,method] of [['close-gateway','closeGateway'],['close-controller','closeController'],
        ['close-access','closeGatewayAccess'],['close-controller-access','closeControllerAccess'],['revoke-token','revokeToken']]) {
        if(state()[step]){if(state()[step]!=='ACK')failures.push(step);continue;}
        try{await methods[method]();}catch{failures.push(step);}
      }
      return {attemptsSettled:true,failedSteps:failures,journalPoisoned:journal.snapshot().poisoned,
        knownIngressClosureReverified:false,cloudQuiescenceProved:false,cleanupAuthorized:false,mayReplay:false};
    },
    snapshot:()=>({...report,busy,ended,creationAttempted,creationConfirmed,ownedTokenId:ownedId}),
  };
  return Object.freeze(methods);
}

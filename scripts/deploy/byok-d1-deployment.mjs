import assert from 'node:assert/strict';
import {parseByokWorkerContent} from './byok-worker-content.mjs';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
import {parseByokD1InstallGrant} from '../../packages/proxy/scripts/staging/byok-d1-install-contract.ts';

const sha=v=>createHash('sha256').update(v).digest('hex'),digest=v=>sha(JSON.stringify(v));
const hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const roles=['receiver','controller','gateway'];
const names={receiver:'cinatoken-staging-usage-recovery',controller:c.worker,gateway:g.worker};
const exact=(v,keys)=>assert.ok(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(','));
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};
const plain=(name,text)=>({name,type:'plain_text',text});
// Explicit Standard CPU configuration, not a strict metered-cost upper bound:
// the platform tolerates occasional overruns, and waiting on D1 is not CPU time.
// Keep this fixed in the candidate identity; never inherit an old higher limit.
export const BYOK_D1_WORKER_LIMITS=Object.freeze({cpu_ms:30000});
function prepare(input) {
  try {
    exact(input,['runId','priorManifestSha256','grant','bundles','priorWorkers']);
    assert.match(input.runId,/^c02-byok-[a-f0-9]{12}$/);assert.match(input.priorManifestSha256,hex);
    const grant=parseByokD1InstallGrant(JSON.stringify(input.grant));assert.equal(grant.runId,input.runId);
    exact(input.bundles,roles);exact(input.priorWorkers,roles);
    const workers=roles.map(role=>{
      const bundle=input.bundles[role],prior=input.priorWorkers[role];
      exact(bundle,['code','sha256']);assert.equal(typeof bundle.code,'string');
      assert.ok(Buffer.byteLength(bundle.code)>0&&Buffer.byteLength(bundle.code)<=1048576);assert.match(bundle.sha256,hex);assert.equal(sha(bundle.code),bundle.sha256);
      exact(prior,['settingsSha256','versionId']);assert.match(prior.settingsSha256,hex);assert.match(prior.versionId,uuid);
      const bindings=role==='receiver'?[plain('BYOK_MAINTENANCE_ENVIRONMENT','staging'),plain('BYOK_MAINTENANCE_ENABLED','true'),
        {name:'RECOVERY_DB',type:'d1',id:g.database}]
        :role==='controller'?[plain('BYOK_MAINTENANCE_CONTROL_ENVIRONMENT','staging'),plain('BYOK_MAINTENANCE_CONTROL_ENABLED','true'),
          plain('BYOK_MAINTENANCE_ACCESS_AUD',c.audience),{name:'USAGE_RECOVERY',type:'service',service:names.receiver,entrypoint:'UsageRecovery'}]
        :[plain('BYOK_GATEWAY_ENVIRONMENT','staging'),plain('BYOK_GATEWAY_ENABLED','true'),plain('BYOK_GATEWAY_ACCESS_AUD',g.audience),
          plain('BYOK_GATEWAY_INSTALL_GRANT',JSON.stringify(grant)),{name:'BYOK_DB',type:'d1',id:g.database}];
      const module='byok-d1-'+role+'.mjs';
      return {role,name:names[role],module,code:bundle.code,codeSha256:bundle.sha256,prior:{...prior},
        metadata:{main_module:module,bindings,compatibility_date:'2026-09-16',compatibility_flags:['nodejs_compat'],
          limits:{...BYOK_D1_WORKER_LIMITS},
          keep_bindings:[],keep_assets:false,logpush:false,tail_consumers:[],
          observability:{enabled:true,head_sampling_rate:1,logs:{invocation_logs:false}},
          annotations:{'workers/message':input.runId+' '+role}}};
    });
    const descriptor={version:1,runId:input.runId,priorManifestSha256:input.priorManifestSha256,
      workers:workers.map(({code,...rest})=>rest)};
    return {workers,descriptor,sha256:digest(descriptor),grant};
  }catch{throw Error('byok_deployment_candidate_invalid');}
}

/** Deterministic, offline fingerprint for the exclusive journal reservation.
 * Bundles must be byte-frozen from verified local builds; this pins their bytes,
 * not their correctness. The prior manifest binds the operator/source evidence.
 */
export function byokD1DeploymentFingerprint(candidate){return prepare(candidate).sha256;}

function normalizedBindings(rows){
  assert.ok(Array.isArray(rows)&&rows.length<=8);const seen=new Set();
  return rows.map(r=>{
    assert.ok(!seen.has(r.name));seen.add(r.name);
    if(r.type==='plain_text'){exact(r,['type','name','text']);return {...r};}
    if(r.type==='d1'){
      assert.ok(Object.keys(r).every(k=>['name','type','id','database_id'].includes(k)));
      if(r.id!==undefined&&r.database_id!==undefined)assert.equal(r.id,r.database_id);
      return {name:r.name,type:r.type,id:r.id??r.database_id};
    }
    assert.equal(r.type,'service');assert.ok(Object.keys(r).every(k=>['name','type','service','entrypoint','environment'].includes(k)));
    assert.ok(r.environment===undefined||r.environment===null||r.environment==='production');
    return {name:r.name,type:r.type,service:r.service,entrypoint:r.entrypoint};
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
function desiredSettings(value,w){
  assert.deepEqual(normalizedBindings(value.bindings),normalizedBindings(w.metadata.bindings));
  assert.equal(value.compatibility_date,w.metadata.compatibility_date);assert.deepEqual(value.compatibility_flags,w.metadata.compatibility_flags);
  assert.deepEqual(value.tail_consumers??[],[]);assert.deepEqual(value.streaming_tail_consumers??[],[]);assert.notEqual(value.logpush,true);
  assert.deepEqual(value.observability,w.metadata.observability);
  // A missing/default/null/string-valued limit is not evidence that the
  // uploaded setting took effect. Other server-default limit fields may exist.
  assert.ok(value.limits&&typeof value.limits==='object'&&!Array.isArray(value.limits));
  assert.equal(value.limits.cpu_ms,w.metadata.limits.cpu_ms);
  for(const key of ['assets','containers','migrations'])assert.ok(value[key]===undefined||value[key]===null);
}
function closedAccess(a,t){
  assert.equal(a.id,t.app);assert.equal(a.aud,t.audience);assert.equal(a.type,'self_hosted');assert.equal(a.domain,t.domain);
  assert.deepEqual(a.destinations,[{type:'public',uri:t.domain}]);assert.notEqual(a.service_auth_401_redirect,true);
  assert.equal(a.policies.length,1);const p=a.policies[0];assert.equal(p.id,t.policy);assert.equal(p.precedence,1);assert.equal(p.decision,'deny');
  assert.deepEqual(p.include,[{everyone:{}}]);assert.deepEqual(p.exclude??[],[]);assert.deepEqual(p.require??[],[]);
}

/** Fixed existing-resource deployment only. No CLI, resource creation fallback,
 * custom URLs, retries, rollbacks, entry enabling or D1 queries. PUT is an
 * immediately deployed upload, so an unknown outcome stops the entire chain.
 * Existing-resource reads are not a cloud CAS against an external administrator.
 * The full operator must own exclusivity and inspect all other invocation paths.
 * assertReady synchronously proves frozen sources, actual plan, USD2 reserves,
 * complete prior-code preflight and grant lifetime. ACK names alone are not proof.
 */
export function createByokD1Deployment(options){
  let journal,candidate,apiToken,assertReady,fetchImpl,timeoutMs,plan;
  try{
    assert.ok(options&&Object.keys(options).every(k=>['journal','candidate','apiToken','assertReady','fetchImpl','timeoutMs'].includes(k)));
    ({journal,candidate,apiToken,assertReady,fetchImpl=fetch,timeoutMs=60000}=options);plan=prepare(candidate);
    assert.equal(typeof journal?.attempt,'function');assert.equal(typeof journal?.snapshot,'function');
    assert.deepEqual(journal.identity,{runId:plan.descriptor.runId,candidateSha256:plan.sha256,priorManifestSha256:plan.descriptor.priorManifestSha256});
    assert.ok(typeof apiToken==='string'&&/^[\x21-\x7e]{1,512}$/.test(apiToken));assert.equal(typeof assertReady,'function');assert.equal(typeof fetchImpl,'function');
    assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
  }catch{throw Error('byok_deployment_options_invalid');}
  let busy=false,failed=false,cursor=0;const receipts=[];
  const report={httpAttempts:0,readAttempts:0,uploadAttempts:0,acknowledgedResponses:0,mayReplay:false};
  function ready(role){
    assert.equal(failed,false);const s=journal.snapshot();assert.equal(s.poisoned,false);
    for(const step of ['preflight','closure-before'])assert.equal(s.attempts[step],'ACK');
    for(const step of ['create-token','open-access','open-gateway','install-fence','arm','stop','seal-fence',
      'close-gateway','close-controller','close-access','close-controller-access','revoke-token'])assert.equal(s.attempts[step],undefined);
    for(const prev of roles.slice(0,roles.indexOf(role)))assert.equal(s.attempts['deploy-'+prev],'ACK');
    const now=Math.floor(Date.now()/1000);assert.ok(now>=plan.grant.issuedAt&&now<plan.grant.expiresAt);
    assert.equal(assertReady(role),true);
  }
  async function deploy(w,signal){
    const ac=new AbortController(),deadline=performance.now()+timeoutMs;let timer,onAbort,reader,response,done=false;
    const facts={reads:0,acks:0},base='/workers/scripts/'+w.name;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{done=true;ac.abort();cancel(reader);reject(Error('deployment_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);
    });
    const live=()=>{ac.signal.throwIfAborted();assert.ok(performance.now()<deadline);};
    async function request(path,{upload,content=false}={}){
      live();assert.ok(facts.reads<40);if(upload)ready(w.role);live();
      report.httpAttempts++;report[upload?'uploadAttempts':'readAttempts']++;if(!upload)facts.reads++;
      response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+g.account+path,
        {method:upload?'PUT':'GET',headers:{Authorization:'Bearer '+apiToken},redirect:'error',cache:'no-store',signal:ac.signal,body:upload});
      if(done){cancel(response.body);throw Error('deployment_interrupted');}live();assert.equal(response.status,200);assert.equal(response.redirected,false);
      const type=response.headers.get('Content-Type')??'';assert.ok(type.length<=256);
      if(!content)assert.match(type,/^application\/json(?:;\s*charset=utf-8)?$/i);
      else assert.match(type,/^(multipart\/form-data;|application\/javascript|text\/javascript)/i);
      const length=response.headers.get('Content-Length');if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
      assert.ok(response.body);reader=response.body.getReader();let bytes=0,reads=0;const chunks=[];
      try{
        for(;;){live();assert.ok(++reads<=4096);const next=await reader.read();live();if(next.done)break;
          bytes+=next.value.byteLength;assert.ok(bytes<=2097152);chunks.push(Buffer.from(next.value));}
        if(length!==null)assert.equal(Number(length),bytes);const data=Buffer.concat(chunks,bytes);live();
        if(content){report.acknowledgedResponses++;facts.acks++;return {data,type,entrypoint:response.headers.get('cf-entrypoint')??undefined};}
        const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));assert.equal(v.success,true);
        // Successful Workers domains responses use null for an empty errors field.
        assert.ok(v.errors===undefined||v.errors===null||(Array.isArray(v.errors)&&v.errors.length===0));assert.ok(Object.hasOwn(v,'result'));
        report.acknowledgedResponses++;facts.acks++;return v.result;
      }finally{cancel(reader);try{reader.releaseLock();}catch{}reader=undefined;response=undefined;}
    }
    async function ingress(){
      const s=await request(base+'/subdomain');assert.equal(s.enabled,false);assert.equal(s.previews_enabled,false);
      assert.deepEqual(await request('/workers/domains?service='+w.name),[]);assert.deepEqual((await request(base+'/schedules')).schedules,[]);
    }
    const versions=async()=>{
      const v=(await request(base+'/deployments')).deployments?.[0]?.versions;
      assert.ok(Array.isArray(v)&&v.length===1);assert.match(v[0].version_id,uuid);assert.equal(v[0].percentage,100);return v;
    };
    async function confirmedDependencies(){
      for(const r of receipts){
        assert.equal(digest(await request('/workers/scripts/'+r.worker+'/settings')),r.settingsSha256);
        assert.deepEqual((await request('/workers/scripts/'+r.worker+'/deployments')).deployments[0].versions,[{version_id:r.versionId,percentage:100}]);
      }
    }
    const work=Promise.resolve().then(async()=>{
      live();ready(w.role);const db=await request('/d1/database/'+g.database);assert.equal(db.uuid,g.database);assert.equal(db.name,'cinatoken-staging');
      const oldSettings=await request(base+'/settings');assert.equal(digest(oldSettings),w.prior.settingsSha256);
      for(const key of ['assets','containers','migrations'])assert.ok(oldSettings[key]===undefined||oldSettings[key]===null);
      assert.ok(Array.isArray(oldSettings.bindings)&&oldSettings.bindings.every(b=>['plain_text','secret_text','service','d1'].includes(b.type)));
      assert.deepEqual(oldSettings.tail_consumers??[],[]);assert.deepEqual(oldSettings.streaming_tail_consumers??[],[]);assert.notEqual(oldSettings.logpush,true);
      assert.deepEqual(await versions(),[{version_id:w.prior.versionId,percentage:100}]);await ingress();
      for(const t of [g,c])closedAccess(await request('/access/apps/'+t.app),t);await confirmedDependencies();
      const form=new FormData();form.set('metadata',JSON.stringify(w.metadata));
      form.set(w.module,new Blob([w.code],{type:'application/javascript+module'}),w.module);
      await request(base+'?excludeScript=true&bindings_inherit=strict',{upload:form});
      const after=await versions();assert.notEqual(after[0].version_id,w.prior.versionId);
      const settings=await request(base+'/settings');desiredSettings(settings,w);
      const content=await request(base,{content:true});
      const decoded=parseByokWorkerContent({...content,entrypoint:content.entrypoint??w.module});
      assert.equal(decoded.entrypoint,w.module);assert.equal(decoded.modules.length,1);
      assert.equal(decoded.modules[0].name,w.module);assert.equal(decoded.modules[0].sha256,w.codeSha256);
      live();await ingress();for(const t of [g,c])closedAccess(await request('/access/apps/'+t.app),t);
      await confirmedDependencies();assert.deepEqual(await versions(),after);
      const settingsAgain=await request(base+'/settings');assert.equal(digest(settingsAgain),digest(settings));
      return {role:w.role,worker:w.name,versionId:after[0].version_id,settingsSha256:digest(settings),codeSha256:w.codeSha256,
        workersDevClosed:true,previewClosed:true,knownDomainsAndCronsEmpty:true,accessClosed:true,readAttempts:facts.reads};
    });
    try{return await Promise.race([work,interrupted]);}
    finally{done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();cancel(reader);if(!reader)cancel(response?.body);}
  }
  return Object.freeze({
    async deployNext({signal}={}){
      assert.ok(signal===undefined||signal instanceof AbortSignal);assert.ok(!busy&&!failed&&cursor<roles.length);busy=true;
      const w=plan.workers[cursor];
      try{
        const r=await journal.attempt('deploy-'+w.role,()=>deploy(w,signal),r=>({logicalApiReads:r.readAttempts,evidenceSha256:digest(r)}));
        receipts.push(r);cursor++;return structuredClone(r);
      }catch{failed=true;throw Error('byok_deployment_unconfirmed');}
      finally{busy=false;}
    },
    snapshot:()=>({...report,cursor,busy,failed,receipts:structuredClone(receipts),candidateSha256:plan.sha256,cloudQuiescenceProved:false}),
  });
}

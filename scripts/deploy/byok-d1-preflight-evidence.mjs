import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
import {createByokD1PaidPlan} from './byok-d1-paid-plan.mjs';
import {createByokD1PriorCode} from './byok-d1-prior-code.mjs';
import {byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';
import {createByokD1IngressClosure} from './byok-d1-ingress-closure.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex'),digest=v=>sha(JSON.stringify(v)),copy=v=>structuredClone(v);
const exact=(v,keys)=>assert.ok(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(','));
const roles={receiver:'cinatoken-staging-usage-recovery',controller:c.worker,gateway:g.worker};
const base='https://api.cloudflare.com/client/v4/accounts/'+g.account;
const allowed=new Set(['/workers/account-settings','/subscriptions',...Object.values(roles).flatMap(w=>['','/settings','/deployments'].map(s=>'/workers/scripts/'+w+s))].map(p=>base+p));
const missing=['ALL_INVOCATION_PATHS_UNPROVEN','EXCLUSIVE_OWNERSHIP_UNPROVEN','CUMULATIVE_BUDGET_UNPROVEN','NATIVE_MAINTENANCE_TIMING_UNPROVEN'];
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};
const builtins=new Set(builtinModules.flatMap(n=>[n,n.startsWith('node:')?n:'node:'+n]));
const canonical=p=>{assert.ok(typeof p==='string'&&p.length>0&&p.length<=1024&&!/[\\:\x00-\x1f]/.test(p)&&!p.startsWith('/'));
  assert.ok(p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!/[. ]$/.test(s)));return p;};
function physical(root,p){
  assert.equal(fs.realpathSync(root),root);assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
  const rel=relative(root,p);assert.ok(!rel.startsWith('..')&&!rel.startsWith(sep));let current=root;
  for(const part of rel.split(sep)){current=resolve(current,part);assert.equal(fs.lstatSync(current).isSymbolicLink(),false);}
  assert.equal(fs.realpathSync(p),p);
}
function bytes(root,p,max=8388608){
  canonical(p);const full=resolve(root,p);physical(root,full);const fd=fs.openSync(full,'r');
  try{
    const before=fs.fstatSync(fd,{bigint:true});assert.ok(before.isFile()&&before.size<=BigInt(max));
    const chunks=[],chunk=Buffer.allocUnsafe(65536);let size=0;
    for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;assert.ok(size<=max);chunks.push(Buffer.from(chunk.subarray(0,n)));}
    const after=fs.fstatSync(fd,{bigint:true});
    assert.deepEqual([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs],[before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs]);
    physical(root,full);const current=fs.statSync(full,{bigint:true});assert.equal(current.ino,before.ino);assert.equal(current.dev,before.dev);
    assert.equal(BigInt(size),before.size);return Buffer.concat(chunks,size);
  }finally{fs.closeSync(fd);}
}

/** Read-only candidate-scoped collection, BEFORE the once-only execution journal.
 * Connects live source guard, actual producer bundle/input closure, prior-code
 * archive and paid-plan observations. It deliberately cannot issue the seven
 * attestations required by createByokD1Operator: four proof domains remain open.
 * sourceFreeze is a trusted live host capability from beginByokD1SourceFreeze,
 * NOT an untrusted plugin/RPC interface. Production calls use this bundled entry
 * and the real filesystem; injected fetch/io are explicit local fault-test seams.
 */
export function createByokD1PreflightEvidence(options){
  let workspace,sourceRoot,candidate,expected,sourceSnapshot,producerMetafile,sourceFreeze,apiToken,fetchImpl,signal,timeoutMs,io;
  let identity,producer;
  function checkSources(){
    assert.equal(sourceFreeze.assertCurrent(),true);
    const binding=sourceFreeze.bindCandidate(candidate);
    assert.deepEqual(binding,{runId:identity.runId,candidateSha256:identity.candidateSha256,
      priorManifestSha256:identity.priorManifestSha256,sourceEvidenceSha256:sourceSnapshot.evidenceSha256});
    const {evidenceSha256,...snapshot}=sourceSnapshot;assert.equal(digest(snapshot),evidenceSha256);
    return binding;
  }
  function producerProof(){
    const paths=new Map([...sourceSnapshot.sources.filter(f=>!f.absent),...sourceSnapshot.evidence].map(f=>[f.path,f]));
    const check=p=>{const f=paths.get(p);assert.ok(f);const b=bytes(sourceRoot,p);assert.equal(sha(b),f.sha256);assert.equal(b.length,f.bytes);return b;};
    const meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(check(producerMetafile)));
    exact(meta,['inputs','outputs']);const inputs=Object.entries(meta.inputs);assert.ok(inputs.length>0&&inputs.length<=2000);
    for(const [p,v] of inputs){canonical(p);const f=sourceSnapshot.sources.find(f=>f.path===p&&!f.absent);assert.ok(f);assert.equal(f.bytes,v.bytes);
      assert.ok(Array.isArray(v.imports)&&v.imports.length<=1000);
      for(const imp of v.imports)assert.ok(imp.external===true?builtins.has(imp.path)||imp.path==='<runtime>':Object.hasOwn(meta.inputs,imp.path));}
    const current=relative(sourceRoot,fileURLToPath(import.meta.url)).split(sep).join('/');canonical(current);
    assert.ok(current.startsWith('.wrangler/staging/'));assert.equal(Object.keys(meta.outputs).length,1);
    const output=meta.outputs[current];assert.ok(output);assert.equal(output.entryPoint,'scripts/deploy/byok-d1-preflight-evidence.mjs');
    assert.equal(check(current).length,output.bytes);
    assert.ok(Array.isArray(output.imports)&&output.imports.every(i=>i.external===true&&builtins.has(i.path)));
    assert.ok(Object.hasOwn(meta.inputs,output.entryPoint));
    return {module:{path:current,sha256:paths.get(current).sha256},metafile:{path:producerMetafile,sha256:paths.get(producerMetafile).sha256},inputFiles:inputs.length};
  }
  try{
    assert.ok(options&&Object.keys(options).every(k=>['workspace','sourceRoot','candidate','expected','sourceFreeze','sourceSnapshot','producerMetafile','apiToken','fetchImpl','signal','timeoutMs','io'].includes(k)));
    ({sourceFreeze,apiToken,fetchImpl=fetch,signal,timeoutMs=60000,io=fs}=options);
    workspace=resolve(options.workspace);sourceRoot=resolve(options.sourceRoot);physical(workspace,workspace);physical(sourceRoot,sourceRoot);
    candidate=copy(options.candidate);expected=copy(options.expected);sourceSnapshot=copy(options.sourceSnapshot);producerMetafile=canonical(options.producerMetafile);
    assert.ok(JSON.stringify(sourceSnapshot).length<=8388608);
    assert.equal(typeof sourceFreeze?.assertCurrent,'function');assert.equal(typeof sourceFreeze?.bindCandidate,'function');
    assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
    assert.ok(signal===undefined||signal instanceof AbortSignal);assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
    for(const key of ['openSync','writeSync','fsyncSync','closeSync'])assert.equal(typeof io[key],'function');
    createByokD1IngressClosure({expected,api:()=>{throw Error('validation_only');}});
    assert.ok(expected.previousTokenIds.length<100); // Keep the operator's one owned-token observation slot.
    identity={runId:candidate.runId,candidateSha256:byokD1DeploymentFingerprint(candidate),priorManifestSha256:candidate.priorManifestSha256,scopeSha256:digest(expected)};
    for(const [role,name] of Object.entries(roles)){const w=expected.workers.find(w=>w.name===name),prior=candidate.priorWorkers[role];
      assert.equal(prior.settingsSha256,w.settingsSha256);assert.deepEqual(w.versions,[{version_id:prior.versionId,percentage:100}]);}
    checkSources();producer=producerProof();
  }catch{throw Error('byok_preflight_evidence_options_invalid');}
  const dir=resolve(workspace,'.wrangler/staging/byok-d1-preflight-evidence-reservation');
  let promise,fd,closed=false,poisoned=false,sequence=0,previous='0'.repeat(64),finishedMono,finishedWall;
  const report={version:1,result:'NOT_RUN',identity,producer,sourceEvidenceSha256:sourceSnapshot.evidenceSha256,
    observed:{sources:false,priorCode:false,paidPlan:false},missing:[...missing],fullPreflightPassed:false,
    executionReservationCreated:false,cloudWrites:0,sqlCalls:0,deployments:0,modelCalls:0,kmsCalls:0,
    firstRoundUsdCap:2,capReset:false,budgetVerified:false,atomicSnapshot:false,
    httpAttempts:0,httpHeadersSettled:0,httpFetchSettled:0,peakActive:0,artifacts:[],failedPhase:null};
  function write(fd,value){const data=Buffer.from(JSON.stringify(value)+'\n');assert.ok(data.length<=1048576&&!data.toString().includes(apiToken));
    for(let at=0;at<data.length;){const n=io.writeSync(fd,data,at,data.length-at);assert.ok(Number.isInteger(n)&&n>0&&n<=data.length-at);at+=n;}io.fsyncSync(fd);}
  function save(value){assert.ok(!closed&&sequence<32);const event={sequence:sequence+1,previous,...value},hash=digest(event);
    write(fd,{...event,sha256:hash});sequence++;previous=hash;}
  function artifact(p,max=12582912){const b=bytes(dir,p,max);const record={path:p,bytes:b.length,sha256:sha(b)};report.artifacts.push(record);return b;}
  function verifyLocal(){
    assert.ok(!poisoned&&report.result==='PARTIAL_EVIDENCE_COLLECTED');signal?.throwIfAborted();checkSources();assert.deepEqual(producerProof(),producer);
    const age=performance.now()-finishedMono,wall=Date.now()-finishedWall;
    assert.ok(age>=0&&age<60000&&wall>=0&&Math.abs(wall-age)<=1000);
    assert.ok(Date.now()<Date.parse(report.paidPlanPeriodEnd));
    for(const f of report.artifacts){const b=bytes(dir,f.path,12582912);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
    const stored=JSON.parse(bytes(dir,'result.json'));assert.deepEqual(stored,report);
    return {identity:copy(identity),evidenceSha256:report.evidenceSha256,localEvidenceUnchanged:true,remoteStateRevalidated:false,fullPreflightPassed:false};
  }
  async function execute(){
    const ac=new AbortController(),began=performance.now(),wallBegan=Date.now();let timer,phase='reservation',active=0;
    const onAbort=()=>ac.abort();signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);
    const live=()=>{assert.ok(!closed&&!poisoned&&performance.now()-began<timeoutMs);ac.signal.throwIfAborted();
      const wall=Date.now()-wallBegan;assert.ok(wall>=0&&Math.abs(wall-(performance.now()-began))<=1000);};
    async function fetchReadOnly(url,init){
      live();assert.ok(allowed.has(url)&&init.method==='GET'&&init.body===undefined&&init.redirect==='error'&&init.cache==='no-store');
      assert.ok(init.signal instanceof AbortSignal);assert.equal(init.headers.Authorization,'Bearer '+apiToken);
      assert.ok(report.httpAttempts<19&&active<4);report.httpAttempts++;active++;report.peakActive=Math.max(report.peakActive,active);
      let response;
      try{response=await fetchImpl(url,init);if(closed||ac.signal.aborted){cancel(response?.body);throw Error('preflight_read_late');}
        report.httpHeadersSettled++;live();return response;
      }finally{if(!closed){active--;report.httpFetchSettled++;}}
    }
    try{
      live();assert.equal(fs.existsSync(resolve(workspace,'.wrangler/staging/byok-d1-execution-reservation')),false);
      for(const p of [resolve(workspace,'.wrangler'),resolve(workspace,'.wrangler/staging')]){if(!fs.existsSync(p))fs.mkdirSync(p);physical(workspace,p);}
      fs.mkdirSync(dir);fd=io.openSync(resolve(dir,'journal.jsonl'),'wx',0o600);
      report.result='RUNNING';report.startedAt=new Date(wallBegan).toISOString();save({event:'RESERVED',identity,producer,sourceEvidenceSha256:sourceSnapshot.evidenceSha256,requestLimit:19});
      phase='sources-before';checkSources();assert.deepEqual(producerProof(),producer);live();report.observed.sources=true;
      phase='collect';save({event:'COLLECTION_PENDING',components:['prior-code','paid-plan']});live();
      const common={workspace:dir,apiToken,fetchImpl:fetchReadOnly,signal:ac.signal,timeoutMs};
      const priorReader=createByokD1PriorCode({...common,expected:Object.entries(roles).map(([role,name])=>({name,...candidate.priorWorkers[role]}))});
      const planReader=createByokD1PaidPlan(common);
      const outcomes=await Promise.allSettled([priorReader.run(),planReader.run()]);live();
      assert.ok(outcomes.every(r=>r.status==='fulfilled'));const [prior,plan]=outcomes.map(r=>r.value);
      report.observed.priorCode=prior.result==='CODE_OBSERVED_AND_ARCHIVED'&&prior.codeComplete===true;
      report.observed.paidPlan=plan.result==='PAID_PLAN_OBSERVED'&&plan.paidPlanObserved===true;
      assert.ok(report.observed.priorCode&&report.observed.paidPlan);assert.equal(report.httpAttempts,19);assert.equal(active,0);assert.equal(report.httpHeadersSettled,19);
      phase='archive';const priorRoot='.wrangler/staging/byok-d1-prior-code-reservation/',planRoot='.wrangler/staging/byok-d1-paid-plan-reservation/';
      assert.deepEqual(JSON.parse(artifact(priorRoot+'result.json')),prior);assert.deepEqual(JSON.parse(artifact(planRoot+'result.json')),plan);
      artifact(priorRoot+'journal.jsonl');artifact(planRoot+'journal.jsonl');
      for(const w of prior.workers){const expectedWorker=Object.entries(roles).find(([,name])=>name===w.name);assert.ok(expectedWorker);
        assert.equal(w.versionId,candidate.priorWorkers[expectedWorker[0]].versionId);assert.equal(w.settingsSha256,candidate.priorWorkers[expectedWorker[0]].settingsSha256);
        for(const m of w.modules){assert.ok(/^[A-Za-z0-9_-]+\.bin$/.test(m.filename));const b=artifact(priorRoot+m.filename);assert.equal(b.length,m.bytes);assert.equal(sha(b),m.sha256);}}
      report.paidPlanPeriodEnd=plan.observations.at(-1).selected.periodEnd;assert.ok(Date.now()<Date.parse(report.paidPlanPeriodEnd));
      phase='sources-after';checkSources();assert.deepEqual(producerProof(),producer);live();
      report.result='PARTIAL_EVIDENCE_COLLECTED';
    }catch{poisoned=true;report.result='FAILED_RETAINED';report.failedPhase=phase;ac.abort();}
    finally{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();finishedMono=performance.now();finishedWall=Date.now();
      report.finishedAt=new Date(finishedWall).toISOString();report.elapsedMs=Math.floor(finishedMono-began);
      report.unsettledFetchRequests=report.httpAttempts-report.httpFetchSettled;
      if(fd!==undefined){
        try{save({event:'FINISHED',result:report.result,observed:report.observed,fullPreflightPassed:false});}
        catch{poisoned=true;report.result='FAILED_RETAINED';report.failedPhase='journal-finish';}
        closed=true;
        try{io.closeSync(fd);report.journal={records:sequence,lastSha256:previous};
          report.artifacts.push({path:'journal.jsonl',bytes:fs.statSync(resolve(dir,'journal.jsonl')).size,sha256:sha(bytes(dir,'journal.jsonl'))});
          if(!poisoned)report.evidenceSha256=digest(report);
          let out;try{out=io.openSync(resolve(dir,'result.json'),'wx',0o600);write(out,report);}finally{if(out!==undefined)io.closeSync(out);}
        }catch{poisoned=true;report.result='FAILED_RETAINED';report.failedPhase='result-not-durable';delete report.evidenceSha256;throw Error('byok_preflight_evidence_not_durable');}
      }else closed=true;
    }
    return copy(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>copy(report),
    checkLocalEvidence(input){try{exact(input,[...Object.keys(identity),'evidenceSha256']);for(const [k,v] of Object.entries(identity))assert.equal(input[k],v);
      assert.equal(input.evidenceSha256,report.evidenceSha256);return verifyLocal();
    }catch{poisoned=true;throw Error('byok_preflight_local_evidence_unconfirmed');}},
  });
}

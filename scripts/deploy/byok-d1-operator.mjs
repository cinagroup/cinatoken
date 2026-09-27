import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {createByokD1Deployment,byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';
import {createByokD1Access} from './byok-d1-access.mjs';
import {createByokD1Management} from './byok-d1-management.mjs';
import {createByokD1InstallDispatch} from './byok-d1-install-dispatch.mjs';
import {createByokD1CaseDispatch} from './byok-d1-case-dispatch.mjs';
import {createByokD1MaintenanceDispatch} from './byok-d1-maintenance-dispatch.mjs';
import {createByokD1IngressClosure} from './byok-d1-ingress-closure.mjs';
import {createByokD1ReadTransport} from './byok-d1-read-transport.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v)),copy=v=>structuredClone(v);
const exact=(v,keys)=>assert.ok(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(','));
const hex=/^[a-f0-9]{64}$/;
const attestations=['sourcesFrozen','priorCodeComplete','exclusiveOwnership','allInvocationPathsInventoried',
  'actualPaidPlanVerified','cumulativeBudgetReserved','maintenanceTimingQualified'];

/** Fixed, once-only host composition. Import/construction does not create a
 * reservation or call the network; run() reserves before its first external I/O.
 * No CLI or automatic credential discovery. preflight + assertReady are trusted
 * read-only proof providers, NOT booleans manufactured from journal ACKs. They
 * must supply current source/prior-code/plan/budget/exclusivity/timing evidence;
 * this library does not collect those proofs or qualify a synthetic run as native.
 * Closure reads use the fixed GET-only transport and its separate durable log.
 * Unknown outcomes only trigger STOP/seal/closure/revocation, never cleanup,
 * replay, automatic rollback, fence removal or restoration of old experiments.
 */
export function createByokD1Operator(options){
  let candidate,expected,workspace,apiToken,installToken,preflight,assertReady,fetchImpl,signal;
  try{
    exact(options,['workspace','candidate','expected','apiToken','installToken','preflight','assertReady','fetchImpl','signal']);
    ({workspace,apiToken,installToken,preflight,assertReady,fetchImpl,signal}=options);
    assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.match(installToken,hex);
    for(const fn of [preflight,assertReady,fetchImpl])assert.equal(typeof fn,'function');
    assert.ok(signal===undefined||signal instanceof AbortSignal);
    candidate=copy(options.candidate);expected=copy(options.expected);byokD1DeploymentFingerprint(candidate);
    assert.equal(sha(installToken),candidate.grant.tokenHash);
    createByokD1IngressClosure({api:()=>{throw Error('validation_only');},expected}); // no reads
    assert.ok(expected.previousTokenIds.length<100,'Reserve one observer slot for this run token');
    const roles={receiver:'cinatoken-staging-usage-recovery',controller:c.worker,gateway:g.worker};
    for(const [role,name] of Object.entries(roles)){
      const w=expected.workers.find(w=>w.name===name),p=candidate.priorWorkers[role];
      assert.equal(w.settingsSha256,p.settingsSha256);assert.deepEqual(w.versions,[{version_id:p.versionId,percentage:100}]);
    }
  }catch{throw Error('byok_operator_options_invalid');}
  const identity={runId:candidate.runId,candidateSha256:byokD1DeploymentFingerprint(candidate),priorManifestSha256:candidate.priorManifestSha256};
  // The deployment fingerprint covers its three targets; independently pin the
  // complete initial observer baseline (including production, side Worker,
  // Access and revoked token IDs) in the durable preflight evidence.
  const admissionIdentity=Object.freeze({...identity,scopeSha256:hash(expected)});
  let promise,journal,access,management,dispatch,proof,committed=false,closureFresh,maintenanceIssuedAt,closedMonoAt,readTransport;
  const state={result:'NOT_RUN',phase:'reservation',completedCases:0,failedPhase:null,containmentFailures:[],
    mayReplay:false,nativeAcceptanceProved:false,databaseQuiescenceProved:false,firstRoundUsdCap:2,capReset:false};
  function live(){signal?.throwIfAborted();}
  function ready(step){
    live();assert.ok(proof);assert.equal(assertReady(Object.freeze({...admissionIdentity,step,evidenceSha256:proof.evidenceSha256})),true);live();
    if(step==='cleanup'){
      assert.ok(closureFresh&&maintenanceIssuedAt);const now=Math.floor(Date.now()/1000);
      const observed=Math.floor(Date.parse(closureFresh.report().finished.wallAt)/1000);
      assert.ok(now>=observed&&now-observed<=10&&now<maintenanceIssuedAt+60&&performance.now()-closedMonoAt<=10000,
        'Leave at least five seconds of the existing receiver freshness window');
    }
    return true;
  }
  async function step(name,fn,{closing=false}={}){
    state.phase=name;if(!closing)live();return fn();
  }
  async function closure(phase,maintenance){
    const check=createByokD1IngressClosure({api:readTransport.api,expected,signal,maintenance});
    await step('closure-'+phase,()=>journal.attempt('closure-'+phase,()=>check.run(),r=>{
      assert.equal(r.result,maintenance?'MAINTENANCE_READY':'CLOSED');return {logicalApiReads:r.logicalApiReads,evidenceSha256:r.evidenceSha256};
    }));
    return check;
  }
  function accessPin(receipt){expected.access.find(a=>a.id===receipt.appId).sha256=receipt.accessSha256;}
  async function execute(){
    state.result='RUNNING';
    try{
      live();journal=createByokD1OperatorJournal(workspace,identity);
      await step('preflight',()=>journal.attempt('preflight',async()=>{
        // A stalled proof provider may never authorize deployment. Its contract
        // is read-only; a late resolution is ignored, and no retry is available.
        const ac=new AbortController();let timer;
        try{
          const p=await Promise.race([Promise.resolve().then(()=>preflight(Object.freeze({...admissionIdentity,signal:ac.signal}))),
            new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('preflight_timeout'));},60000);})]);
          live();exact(p,['runId','candidateSha256','priorManifestSha256','scopeSha256','evidenceSha256','firstRoundUsdCap','capReset',...attestations]);
          for(const [k,v] of Object.entries(admissionIdentity))assert.equal(p[k],v);
          assert.match(p.evidenceSha256,hex);assert.equal(p.firstRoundUsdCap,2);assert.equal(p.capReset,false);
          for(const k of attestations)assert.equal(p[k],true);proof=copy(p);ready('preflight');return {evidenceSha256:hash(p)};
        }finally{clearTimeout(timer);ac.abort();}
      },v=>v));
      readTransport=createByokD1ReadTransport({journal,apiToken,fetchImpl});
      await closure('before');ready('deploy');committed=true;
      access=createByokD1Access({journal,apiToken,assertReady:ready,fetchImpl});
      management=createByokD1Management({journal,apiToken,expectedSchemaSha256:candidate.grant.fencedSchemaSha256,
        assertWriteReady:()=>ready(state.phase),fetchImpl});
      const deployment=createByokD1Deployment({journal,candidate,apiToken,assertReady:role=>ready('deploy-'+role),fetchImpl});
      for(const role of ['receiver','controller','gateway']){
        const r=await step('deploy-'+role,()=>deployment.deployNext({signal}));
        const w=expected.workers.find(w=>w.name===r.worker);w.settingsSha256=r.settingsSha256;w.versions=[{version_id:r.versionId,percentage:100}];
      }
      const credentials=await step('create-token',()=>access.createToken({signal}));
      await step('open-access',()=>access.openGatewayAccess({signal}));
      await step('open-gateway',()=>access.openGateway({signal}));
      const auth={accessClientId:credentials.accessClientId,accessClientSecret:credentials.accessClientSecret};
      const installer=createByokD1InstallDispatch({journal,grant:candidate.grant,token:installToken,...auth,fetchImpl,assertReady:()=>ready('install-fence')});
      await step('install-fence',()=>installer.run({signal}));
      await step('baseline',()=>management.captureBaseline());
      const token=randomBytes(32).toString('hex');
      const control=await step('arm',()=>management.arm(sha(token)));
      // Construct STOP capability before any possibly-unknown fence opening.
      dispatch=createByokD1CaseDispatch({journal,control,token,...auth,fetchImpl});
      await step('open-fence',()=>management.openFence());
      for(let i=0;i<10;i++){
        const receipt=await step('case-'+i,()=>{ready('case-'+i);return dispatch.runNext({signal});});
        await step('verify-case-'+i,()=>management.verifyCase(i,receipt));state.completedCases++;
      }
      await step('stop',()=>dispatch.stop(),{closing:true});
      await step('seal-fence',()=>management.sealFence(),{closing:true});
      await step('close-gateway',()=>access.closeGateway(),{closing:true});
      accessPin(await step('close-access',()=>access.closeGatewayAccess(),{closing:true}));
      // The DB fence is sealed and no maintenance permit exists yet. Prepare
      // only the no-DB cleanup controller's owned-token transport first; then
      // freshly observe producer closure with this explicit maintenance exception.
      accessPin(await step('open-controller-access',()=>access.openControllerAccess({signal})));
      await step('open-controller',()=>access.openController({signal}));
      closureFresh=await closure('fresh',{runId:identity.runId,tokenId:credentials.tokenId});closedMonoAt=performance.now();
      const maintenanceToken=randomBytes(32).toString('hex');
      const permit=await step('arm-maintenance',()=>management.armMaintenance({tokenHash:sha(maintenanceToken),closure:closureFresh}));
      maintenanceIssuedAt=permit.issuedAt;
      const cleanup=createByokD1MaintenanceDispatch({journal,runId:identity.runId,token:maintenanceToken,...auth,expectedRemovedRows:664,fetchImpl,signal,assertReady:()=>ready('cleanup')});
      await step('cleanup',()=>{ready('cleanup');return cleanup.run();});
      await step('close-controller',()=>access.closeController(),{closing:true});
      accessPin(await step('close-controller-access',()=>access.closeControllerAccess(),{closing:true}));
      await step('revoke-token',()=>access.revokeToken(),{closing:true});
      expected.previousTokenIds=[...new Set([...expected.previousTokenIds,credentials.tokenId])];
      await closure('after');
      const final=await step('final-verify',()=>management.verifyFinal());
      state.final=final;state.result='VERIFIED_RETAINED_CLOSED';state.phase='finished';
    }catch{
      state.failedPhase=state.phase;state.result='ATTENTION_REQUIRED';
      if(committed){
        // Do not reuse the user's aborted signal for containment. Each adapter
        // keeps its own finite timeout; unknown opening writes remain unknown.
        const once=async(name,fn)=>{
          const previous=journal.snapshot().attempts[name];
          if(previous){if(previous!=='ACK')state.containmentFailures.push(name);return;}
          try{await step(name,fn,{closing:true});}catch{state.containmentFailures.push(name);}
        };
        if(dispatch)await once('stop',()=>dispatch.stop());
        if(dispatch)await once('seal-fence',()=>management.sealFence());
        if(access){try{const result=await access.contain();state.containmentFailures.push(...result.failedSteps);}
          catch{state.containmentFailures.push('access-containment');}}
      }
    }finally{
      if(readTransport){await readTransport.settle();try{readTransport.close();}catch{state.result='ATTENTION_REQUIRED';state.containmentFailures.push('read-log-close');}
        state.observations=readTransport.report();}
      if(journal){try{journal.close();}catch{state.result='ATTENTION_REQUIRED';state.containmentFailures.push('journal-close');}state.journal=journal.snapshot();}
      // No credentials or provider details are returned, serialized or printed.
      state.phase=state.result==='VERIFIED_RETAINED_CLOSED'?'finished':'retained-for-review';
    }
    return copy(state);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>copy(state)});
}

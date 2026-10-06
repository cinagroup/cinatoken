import assert from 'node:assert/strict';
import {directSocketAggregate} from './direct-socket-dialect.mjs';
const id=['native-worker-reader-cancel','direct-socket-bare-destroy','direct-socket-bare-rst','direct-socket-binding-destroy','direct-socket-binding-rst'];
const digest={bytes:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'};
const value={schema:'v364-direct-socket-closed-v1',startedAt:'2026-10-06T03:00:00Z',endedAt:'2026-10-06T03:00:01Z',actualExit:0,checkoutSHA:'d'.repeat(40),activeMiniflare:0,
  results:id.map(caseId=>({caseId,actualExit:0,closed:true,baselineEligible:false})),observationFailures:[],sourceUnchanged:true,allComparisonsBaselineEligible:false,
  causeProven:false,lateObservationUpgradesPass:false,realIdentity:false,productionRequests:0,defaultOffHolderChanged:false,dependencyChanged:false,upstreamPatchApplied:false,flagsChanged:false,
  closureAuthority:'executor.closed.json; bounded Promise does not cancel underlying task',
  baseline:{closed:true,startedAt:'2026-10-06T03:00:00Z',endedAt:'2026-10-06T03:00:01Z',program:process.execPath,args:['INERT-NOT-RUN'],cwd:process.cwd(),actualExit:0,code:0,signal:null,timedOut:false,outputLimitExceeded:false,
    stdout:{file:'original-strict.stdout.txt',...digest},stderr:{file:'original-strict.stderr.txt',...digest}}};
assert.equal(Object.hasOwn(value,'fatal'),false,'Real normal main JSON omits undefined fatal');
assert.equal(directSocketAggregate(value)?.actualExit,0,'Adapter must accept exact normal source no-fatal shape as aggregate only');
console.log(JSON.stringify({sourceContractReadOutcome:0,inertSyntheticInputOnly:true,realRuntimeExecuted:false,productionRequests:0}));

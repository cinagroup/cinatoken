import assert from 'node:assert/strict';
import path from 'node:path';
const executor='v364-direct-socket-executor-closed-v1',nodeSchema='v364-direct-socket-closed-v1';
const integer=Number.isSafeInteger,bit=value=>typeof value==='boolean',hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const expectedIds=['native-worker-reader-cancel','direct-socket-bare-destroy','direct-socket-bare-rst','direct-socket-binding-destroy','direct-socket-binding-rst'].sort();
const runKeys=['GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW','GITHUB_JOB'];
const runValid=value=>value&&typeof value==='object'&&!Array.isArray(value)&&runKeys.every(key=>value[key]===null||typeof value[key]==='string');
const validFile=value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.path==='string'&&value.path!==''&&!value.path.includes('/')&&!value.path.includes('\\')&&!/[:\x00-\x1f]/u.test(value.path)&&!['.','..'].includes(value.path)&&integer(value.bytes)&&value.bytes>=0&&hash(value.sha256);
const validFiles=value=>Array.isArray(value)&&value.every(validFile)&&new Set(value.map(item=>item.path)).size===value.length;
const safeError=value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.message==='string'&&
  (value.name==null||typeof value.name==='string')&&(value.code==null||typeof value.code==='string'||integer(value.code));
const ownSchema=value=>value?.schema===executor;
function noChild(value){
  const c=value.closure;
  return value.actualExit===1&&value.actualProcessExit===null&&value.runnerOutcomeCode===1&&!value.timedOut&&!value.interrupted&&
    value.fatal?.name==='RuntimeError'&&value.fatal.message==='Requires explicit --execute-linux on an owned Linux runner'&&
    value.packageSHA256===null&&value.checkoutSHA===null&&value.reportedActualExit===null&&value.closedReportPresent===false&&
    runValid(value.run)&&runKeys.every(key=>value.run[key]===null)&&c?.authority==='this executor'&&
    c.subreaperEnabled===false&&c.directChildReaped===false&&c.groupGone===true&&c.leftoverGroupKilled===false&&
    c.apiDisposalReported===false&&c.outerUnforcedGroupClose===false&&c.gracefulWorkerdExitProven===false&&c.miniflareDisposeMaySendSIGKILL===true&&
    ['signalAttempts','reapedDescendants','processCensus','errors'].every(key=>Array.isArray(c[key])&&c[key].length===0)&&
    value.files.length===2&&value.files.map(file=>file.path).sort().join('|')==='executor.stderr.txt|executor.stdout.txt'&&value.files.find(file=>file.path==='executor.stdout.txt').bytes===0;
}
export function directSocketClosure(value){
  if(!ownSchema(value)||value.closed===false||value.terminal===false||![0,1].includes(value.actualExit)||
    !Number.isFinite(value.startedEpoch)||value.startedEpoch<=0||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0||
    !bit(value.timedOut)||!bit(value.interrupted)||!validFiles(value.files)||value.productionRequests!==0||value.ciInvocations!==0||value.causeProven!==false)return null;
  if(noChild(value))return {dialect:'v364-direct-socket-no-child-preflight-rejection-v1',actualExit:1,actualProcessExit:null,runnerOutcomeCode:1,
    actualChildExitProven:false,linuxRuntimeExecuted:false,signal:null,spawnError:null,groupGone:true,directChildReaped:false,
    fullCooperativeCleanupProven:false,gracefulWorkerdExitProven:false,gatePassDerived:false};
  const c=value.closure,last=c?.processCensus?.at(-1);
  if(!integer(value.actualProcessExit)||!integer(value.runnerOutcomeCode)||!hash(value.packageSHA256)||
    typeof value.checkoutSHA!=='string'||!/^[0-9a-f]{40}$/u.test(value.checkoutSHA)||!runValid(value.run)||
    value.run.GITHUB_SHA!==null&&value.run.GITHUB_SHA!==value.checkoutSHA||
    !(value.fatal===null||value.fatal&&typeof value.fatal==='object'&&!Array.isArray(value.fatal))||
    !bit(value.closedReportPresent)||!(value.reportedActualExit===null||[0,1].includes(value.reportedActualExit))||
    c?.authority!=='this executor'||c.subreaperEnabled!==true||c.directChildReaped!==true||c.groupGone!==true||
    !bit(c.leftoverGroupKilled)||!bit(c.apiDisposalReported)||!bit(c.outerUnforcedGroupClose)||
    c.gracefulWorkerdExitProven!==false||c.miniflareDisposeMaySendSIGKILL!==true||
    !['signalAttempts','reapedDescendants','processCensus','errors'].every(key=>Array.isArray(c[key]))||
    !last||last.label!=='final-post-reap'||last.complete!==true||last.groupExists!==false||last.live!==0||last.zombies!==0||
    !Array.isArray(last.members)||last.members.length!==0||!Array.isArray(last.unknown)||last.unknown.length!==0||
    !integer(last.pgrp)||last.pgrp<=0||last.session!==last.pgrp)return null;
  if(value.timedOut&&value.runnerOutcomeCode!==124||value.interrupted&&value.runnerOutcomeCode!==130||
    !value.timedOut&&!value.interrupted&&value.runnerOutcomeCode!==value.actualProcessExit)return null;
  if(c.leftoverGroupKilled!==c.signalAttempts.some(row=>row?.sent===true))return null;
  if(c.signalAttempts.some(row=>!row||![9,15].includes(row.signal)||!bit(row.sent)||typeof row.censusLabel!=='string'))return null;
  if(c.reapedDescendants.some(row=>!row||!integer(row.pid)||row.pid<=0||typeof row.startTimeTicks!=='string'||
    !(integer(row.waitStatus)&&integer(row.waitExitCode)||row.waitStatus===null&&row.waitExitCode===null)))return null;
  const couldPass=value.runnerOutcomeCode===0&&value.actualProcessExit===0&&value.fatal===null&&!value.timedOut&&!value.interrupted&&
    !c.leftoverGroupKilled&&c.errors.length===0&&c.apiDisposalReported&&c.outerUnforcedGroupClose&&value.closedReportPresent&&value.reportedActualExit===0;
  if(value.actualExit!==(couldPass?0:1))return null;
  return {dialect:executor,actualExit:value.actualExit,actualProcessExit:value.actualProcessExit,runnerOutcomeCode:value.runnerOutcomeCode,
    signal:null,spawnError:null,timedOut:value.timedOut,interrupted:value.interrupted,groupGone:true,directChildReaped:true,
    leftoverGroupKilled:c.leftoverGroupKilled,apiDisposalReported:c.apiDisposalReported,outerUnforcedGroupCloseReported:c.outerUnforcedGroupClose,
    actualChildExitProven:true,linuxRuntimeExecuted:true,fullCooperativeCleanupProven:false,gracefulWorkerdExitProven:false,gatePassDerived:false};
}
function baselineValid(value){
  if(!value||value.closed!==true||!timestamp(value.startedAt)||!timestamp(value.endedAt)||Date.parse(value.endedAt)<Date.parse(value.startedAt)||
    typeof value.program!=='string'||!path.isAbsolute(value.program)||typeof value.cwd!=='string'||!path.isAbsolute(value.cwd)||
    !Array.isArray(value.args)||!value.args.every(arg=>typeof arg==='string')||!bit(value.timedOut)||!bit(value.outputLimitExceeded)||
    value.actualExit!==value.code)return false;
  if(!(integer(value.code)&&value.code>=0&&value.signal===null&&(value.spawnError==null||safeError(value.spawnError))||
    integer(value.code)&&value.code<0&&value.signal===null&&safeError(value.spawnError)||
    value.code===null&&(typeof value.signal==='string'&&value.signal!==''||safeError(value.spawnError))))return false;
  return ['stdout','stderr'].every(stream=>{const d=value[stream];return d?.file===`original-strict.${stream}.txt`&&integer(d.bytes)&&d.bytes>=0&&hash(d.sha256)});
}
export function directSocketAggregate(value){
  if(value?.schema!==nodeSchema||!timestamp(value.startedAt)||!timestamp(value.endedAt)||Date.parse(value.endedAt)<Date.parse(value.startedAt)||
    ![0,1].includes(value.actualExit)||typeof value.checkoutSHA!=='string'||!/^[0-9a-f]{40}$/u.test(value.checkoutSHA)||
    !integer(value.activeMiniflare)||value.activeMiniflare<0||!Array.isArray(value.results)||value.results.length>5||
    value.results.some(row=>!row||!expectedIds.includes(row.caseId)||![0,1].includes(row.actualExit)||!bit(row.closed)||row.baselineEligible!==false)||
    new Set(value.results.map(row=>row.caseId)).size!==value.results.length||!Array.isArray(value.observationFailures)||
    !bit(value.sourceUnchanged)||value.allComparisonsBaselineEligible!==false||value.causeProven!==false||
    value.lateObservationUpgradesPass!==false||value.realIdentity!==false||value.productionRequests!==0||
    value.defaultOffHolderChanged!==false||value.dependencyChanged!==false||value.upstreamPatchApplied!==false||value.flagsChanged!==false||
    value.closureAuthority!=='executor.closed.json; bounded Promise does not cancel underlying task'||
    !(value.fatal==null||safeError(value.fatal))||
    !(value.baseline==null?value.actualExit===1&&safeError(value.fatal):baselineValid(value.baseline)))return null;
  const complete=value.results.length===5&&value.results.map(row=>row.caseId).sort().join('|')===expectedIds.join('|');
  const pass=value.fatal==null&&value.observationFailures.length===0&&value.baseline?.code===0&&value.baseline.signal===null&&
    !value.baseline.timedOut&&!value.baseline.outputLimitExceeded&&value.baseline.spawnError==null&&complete&&
    value.results.every(row=>row.actualExit===0&&row.closed)&&value.activeMiniflare===0&&value.sourceUnchanged;
  if(value.actualExit!==(pass?0:1))return null;
  return {dialect:nodeSchema,actualExit:value.actualExit,sourceSHA:value.checkoutSHA,aggregateOnly:true,childLogAuthority:false,
    gatePassDerived:false,allComparisonsBaselineEligible:false,completeComparisonShape:complete,causeProven:false,fullNativeCancelVerified:false};
}
export function validateDirectSocketFiles({receiptName,value,data,json,receiptMtime}){
  const prefix=path.posix.dirname(receiptName)==='.'?'':path.posix.dirname(receiptName)+'/';
  const named=value.files.map(file=>prefix+file.path),expected=[...data.keys()].filter(name=>name.startsWith(prefix)&&!name.slice(prefix.length).includes('/')&&name!==receiptName);
  assert.deepEqual([...named].sort(),expected.sort(),'Exact direct-socket output directory manifest set required');
  assert.ok(value.files.some(file=>file.path==='executor.stdout.txt')&&value.files.some(file=>file.path==='executor.stderr.txt'),'Both original executor streams required');
  for(const descriptor of value.files){const item=data.get(prefix+descriptor.path);assert.ok(item,'Original manifested output missing');
    assert.equal(item.bytes.length,descriptor.bytes);assert.equal(item.sha256,descriptor.sha256);assert.ok(item.mtimeMs<=receiptMtime,'Output newer than original executor receipt');}
  if(value.actualProcessExit===null){assert.ok(noChild(value),'Only exact no-child admission refusal supported');return named;}
  const start=json.get(prefix+'executor-start.json');assert.ok(start&&start.schema==='v364-direct-socket-executor-start-v1','Original executor start receipt required');
  assert.ok(typeof start.repo==='string'&&path.isAbsolute(start.repo)&&typeof start.output==='string'&&path.isAbsolute(start.output)&&start.repo!==start.output,'Original absolute repo/output start fields required');
  assert.equal(start.startedEpoch,value.startedEpoch);assert.equal(start.freshOutputCreated,true);assert.equal(start.packageSHA256,value.packageSHA256);
  assert.equal(start.checkoutSHA,value.checkoutSHA);assert.deepEqual(start.run,value.run);assert.equal(start.outerTimeoutSeconds,360);
  const node=json.get(prefix+'closed-result.json');
  if(node){assert.ok(directSocketAggregate(node),'Node direct-socket report shape or outcome unsafe');assert.equal(node.checkoutSHA,value.checkoutSHA);
    assert.deepEqual(node.executorReceipt,start,'Node report must bind original executor start receipt');
    assert.ok(value.files.some(file=>file.path==='events.json'),'Original event file required');
    const eventFile=data.get(prefix+'events.json');assert.equal(node.events?.bytes,eventFile.bytes.length);assert.equal(node.events?.sha256,eventFile.sha256);
    if(node.baseline)for(const stream of ['stdout','stderr']){const d=node.baseline[stream],file=data.get(prefix+d.file);assert.ok(file);
      assert.equal(d.bytes,file.bytes.length);assert.equal(d.sha256,file.sha256);assert.ok(value.files.some(file=>file.path===d.file));}
    if(value.closedReportPresent){assert.equal(node.results.length,5);assert.equal(value.reportedActualExit,node.actualExit);}else assert.equal(value.reportedActualExit,null);
    const api=node.activeMiniflare===0&&node.results.length===5&&node.results.every(row=>row.closed);assert.equal(value.closure.apiDisposalReported,value.closedReportPresent&&api);
  }else{assert.equal(value.closedReportPresent,false);assert.equal(value.reportedActualExit,null);assert.equal(value.closure.apiDisposalReported,false);assert.equal(value.actualExit,1);}
  const unforced=value.closure.apiDisposalReported&&value.closure.groupGone&&value.closure.directChildReaped&&!value.closure.leftoverGroupKilled&&
    value.closure.errors.length===0&&!value.timedOut&&!value.interrupted;
  assert.equal(value.closure.outerUnforcedGroupClose,unforced);
  return named;
}

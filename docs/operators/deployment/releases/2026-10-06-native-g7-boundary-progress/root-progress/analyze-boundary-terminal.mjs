import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const t="C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E";
const root=t+'/boundary-artifact/_temp/v364-boundary-once-37402302570-1';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=n=>JSON.parse(fs.readFileSync(root+'/'+n));
const raw=read('closed-result.json'),executor=read('executor.closed.json');
assert.equal(raw.checkoutSHA,'67f8b3df2f2b6e8159806767ecce1efa1904d27a');
assert.equal(executor.checkoutSHA,raw.checkoutSHA);assert.equal(executor.run.GITHUB_RUN_ID,'37402302570');
assert.equal(executor.actualProcessExit,1);assert.equal(executor.runnerOutcomeCode,1);assert.equal(executor.actualExit,1);
for(const f of executor.files){const b=fs.readFileSync(root+'/'+f.path);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
const events=fs.readFileSync(root+'/events.json');assert.equal(events.length,raw.events.bytes);assert.equal(sha(events),raw.events.sha256);
for(const [stream,f] of Object.entries({stdout:raw.baseline.stdout,stderr:raw.baseline.stderr})){const b=fs.readFileSync(root+'/original-strict.'+stream+'.txt');assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
assert.deepEqual(raw.inputsAfter,raw.inputsBefore);assert.equal(raw.sourceUnchanged,true);
assert.equal(raw.results.length,8);assert.ok(raw.results.every(x=>x.baselineEligible===false));
const baseline=fs.readFileSync(root+'/original-strict.stdout.txt','utf8');
const rows=raw.results.map(x=>({caseId:x.caseId,actualExit:x.actualExit,closed:x.closed,originalWindow:x.originalWindow??null,tail:x.tail??null,finalPreDisposeSnapshot:x.finalPreDisposeSnapshot??null,error:x.error??null}));
const report={schema:'root-v364-boundary-terminal-analysis-v1',at:new Date().toISOString(),closed:true,actualExit:0,runId:'37402302570',sourceSHA:raw.checkoutSHA,strictBaseline:raw.baseline,tap:baseline.split(/\r?\n/).filter(x=>/^# (?:tests|pass|fail|cancelled|skipped)/.test(x)),rows,executorActualExit:executor.actualExit,cleanup:executor.closure,timedOut:executor.timedOut,fatal:raw.fatal,sourceUnchanged:true,allEightBaselineEligibleFalse:true,causeProven:false,remoteZIPHashOnlyReported:JSON.parse(fs.readFileSync(t+'/owned19-boundary-artifact-list.stdout.log')).artifacts[0].digest};
fs.writeFileSync(t+'/boundary-terminal-analysis.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,cleanup:{apiDisposalReported:executor.closure.apiDisposalReported,outerUnforcedGroupClose:executor.closure.outerUnforcedGroupClose,leftoverGroupKilled:executor.closure.leftoverGroupKilled,groupGone:executor.closure.groupGone,reapedDescendants:executor.closure.reapedDescendants,gracefulWorkerdExitProven:executor.closure.gracefulWorkerdExitProven}}));

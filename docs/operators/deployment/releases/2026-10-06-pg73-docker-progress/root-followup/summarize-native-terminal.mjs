import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const t='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-platform-followup-20261006-lAiHQC';
const run=JSON.parse(fs.readFileSync(t+'/native-ci-progress-2.stdout.log','utf8'));
assert.equal(run.headSha,'b1ec8f33cf24edc07e8855c059c1498730a43113');assert.equal(run.status,'completed');assert.equal(run.conclusion,'failure');
const native=run.jobs.find(j=>j.databaseId===112046320310),dispatch=run.jobs.find(j=>j.databaseId===112046320270);
const raw=fs.readFileSync(t+'/native-linux-job-log-raw.stdout.log');
const log=raw.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
const blocks=log.split(/^.*##\[group\]Run /m);
const cases=[];
for(const block of blocks){const command=block.split('##[endgroup]')[0];const file=command.match(/node (?:--import tsx )?--test (scripts\/db\/cutover\/[^\s]+\.native\.test\.mjs)/)?.[1];if(!file)continue;const pass=block.match(/# pass (\d+)/)?.[1],fail=block.match(/# fail (\d+)/)?.[1],skip=block.match(/# skipped (\d+)/)?.[1];assert.ok(pass!==undefined&&fail!==undefined&&skip!==undefined,file);cases.push({file,pass:Number(pass),fail:Number(fail),skip:Number(skip),conclusion:Number(fail)===0&&Number(skip)===0?'success':'failure'});}
const expectedExecuted=['postgres-shared-key-usage-repair-runtime-grant','postgres-shared-key-quote-versions','postgres-shared-key-orphan-review-v348','postgres-shared-key-selected-event-gate-v351','postgres-shared-key-snapshot-earning-consumer'];
for(const name of expectedExecuted){const item=cases.find(v=>v.file.endsWith('/'+name+'.native.test.mjs'));assert.equal(item?.conclusion,'success',name);assert.equal(item.skip,0);}
const revisedNotExecuted=['postgres-shared-key-economic-delivery','postgres-shared-key-credited-usage-gap','postgres-shared-key-credited-usage-store'];
for(const name of revisedNotExecuted)assert.equal(cases.some(v=>v.file.endsWith('/'+name+'.native.test.mjs')),false,name);
assert.equal(cases.at(-1).file,'scripts/db/cutover/postgres-budget-admission-login-v350.native.test.mjs');assert.equal(cases.at(-1).fail,1);
const dRaw=fs.readFileSync(t+'/holder-dispatch-job-log-raw.stdout.log');const dl=dRaw.toString('utf8');const lastSummary=dl.slice(dl.lastIndexOf('1..8'));
assert.match(lastSummary,/# pass 7/);assert.match(lastSummary,/# fail 1/);assert.match(lastSummary,/# skipped 0/);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const result={at:new Date().toISOString(),actualExit:0,readOnly:true,runId:run.databaseId,headSha:run.headSha,status:run.status,conclusion:run.conclusion,native:{jobId:native.databaseId,failedStep:36,cases,sourceRevisionsExecutedSuccessfully:expectedExecuted,sourceRevisionsStillSkipped:revisedNotExecuted,original73AssertionPreserved:true,fullJobPassed:false},dispatch:{jobId:dispatch.databaseId,failedStep:27,strictTests:8,pass:7,fail:1,skip:0,fullJobPassed:false},otherJobs:run.jobs.filter(j=>j!==native&&j!==dispatch).map(j=>({id:j.databaseId,name:j.name,conclusion:j.conclusion})),raw:[{file:'native-linux-job-log-raw.stdout.log',bytes:raw.length,sha256:sha(raw)},{file:'holder-dispatch-job-log-raw.stdout.log',bytes:dRaw.length,sha256:sha(dRaw)}]};
fs.writeFileSync(t+'/native-terminal-summary.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,native:{...result.native,cases:cases.length,successfulCases:cases.filter(v=>v.conclusion==='success').length}}));

import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [out,progressName]=process.argv.slice(2),head='dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc';
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
function verifyReceipt(file){const bytes=readFileSync(file),r=JSON.parse(bytes);assert.deepEqual(info(readFileSync(r.stdout)),r.stdoutInfo,file+' stdout');assert.deepEqual(info(readFileSync(r.stderr)),r.stderrInfo,file+' stderr');assert(r.finishedAt>=r.at);return {...r,receiptFile:file,receiptInfo:info(bytes)};}
const progressReceipt=verifyReceipt(join(out,progressName+'.closed.json'));assert.equal(progressReceipt.actualExit,0);
const nativeReceipt=verifyReceipt(join(out,'native-terminal.closed.json'));assert.equal(nativeReceipt.actualExit,0);
const dispatchReceipt=verifyReceipt(join(out,'dispatch-failed-terminal-final.closed.json'));assert.equal(dispatchReceipt.actualExit,0);
const run=JSON.parse(readFileSync(progressReceipt.stdout));assert.equal(run.databaseId,37412060008);assert.equal(run.headSha,head);assert.equal(run.status,'completed');
const job=run.jobs.find(j=>j.name==='native-financial-consumer');assert.equal(job.databaseId,112102451588);assert.equal(job.status,'completed');
const sourceBytes=readFileSync(join(out,'source-inputs-v3.json')),sources=JSON.parse(sourceBytes);assert.equal(sources.headSha,head);assert.equal(sources.records.length,59);assert.equal(sources.records.filter(r=>r.preparedTarget).length,26);
for(const c of sources.commands){assert.equal(c.actualExit,0);assert.deepEqual(info(readFileSync(c.stdout)),c.stdoutInfo);assert.deepEqual(info(readFileSync(c.stderr)),c.stderrInfo);}
const nativeBytes=readFileSync(nativeReceipt.stdout),native=nativeBytes.toString('utf8'),workflowLines=readFileSync(sources.workflow.snapshot,'utf8').split('\n');
const records=[];
for(const r of sources.records){
 assert.deepEqual(info(readFileSync(r.source.snapshot)),{bytes:r.source.bytes,sha256:r.source.sha256});
 const step=job.steps.find(s=>s.number===r.step);assert(step);assert.equal(step.status,'completed');
 const workflowStart=r.workflowLine-1;let workflowEnd=workflowStart+1;while(workflowEnd<workflowLines.length&&!/^      - /.test(workflowLines[workflowEnd]))workflowEnd++;
 const command=workflowLines.slice(workflowStart,workflowEnd).find(l=>/node .*--test /.test(l)).trim();assert(command.includes(r.fixture));
 const at=native.indexOf(command);let group=null,tap=null,rawExitCodes=[],failureLocations=[];
 if(step.conclusion==='skipped'){assert.equal(at,-1,'skipped must not have executed command step '+r.step);}
 else{
  assert(at>=0,'executed command missing step '+r.step);
  const start=native.lastIndexOf('##[group]',at);let end=native.indexOf('##[group]',at);if(end<0)end=native.length;assert(start>=0&&end>at);
  const bytes=Buffer.from(native.slice(start,end),'utf8');const file=join(out,'group-step-'+r.step+'.raw.log');writeFileSync(file,bytes,{flag:'wx'});group={file,...info(bytes),startStringOffset:start,endStringOffset:end};
  const metrics={};for(const name of ['tests','pass','fail','cancelled','skipped','todo']){const matches=[...bytes.toString('utf8').matchAll(new RegExp('# '+name+' ([0-9]+)','g'))];assert.equal(matches.length,1,'TAP '+name+' step '+r.step);metrics[name]=Number(matches[0][1]);}
  tap=metrics;assert.equal(metrics.tests,metrics.pass+metrics.fail+metrics.cancelled+metrics.skipped+metrics.todo,'TAP totals step '+r.step);
  rawExitCodes=[...bytes.toString('utf8').matchAll(/##\[error\]Process completed with exit code ([0-9]+)\./g)].map(m=>Number(m[1]));
  failureLocations=[...new Set([...bytes.toString('utf8').matchAll(/(?:file:\/\/\/__w\/cinatoken\/cinatoken\/)?((?:scripts|packages|src)\/[^\s'"()]+?\.(?:mjs|ts)):(\d+):(\d+)/g)].map(m=>({file:m[1],line:Number(m[2]),column:Number(m[3])})))];
  if(step.conclusion==='success'){assert.equal(metrics.fail,0);assert.equal(metrics.skipped,0);assert.equal(metrics.cancelled,0);assert(metrics.pass>0);assert.equal(rawExitCodes.length,0);}
  else if(step.conclusion==='failure'){assert(metrics.fail>0 || metrics.cancelled>0);assert(rawExitCodes.some(n=>n!==0));}
 }
 records.push({...r,workflowCommand:command,authoritativeStep:step,actualExecuted:at>=0,tap,rawExitCodes,group,failureLocations});
}
const counts=rows=>Object.fromEntries(['success','failure','skipped','cancelled'].map(k=>[k,rows.filter(r=>r.authoritativeStep.conclusion===k).length]));
const targets=records.filter(r=>r.preparedTarget),failures=records.filter(r=>r.authoritativeStep.conclusion==='failure');
const dispatchBytes=readFileSync(dispatchReceipt.stdout),dispatchText=dispatchBytes.toString('utf8'),dispatchJob=run.jobs.find(j=>j.name==='dispatch-safety');assert.equal(dispatchJob.databaseId,112102451353);assert.equal(dispatchJob.status,'completed');
const dispatchTap={};for(const name of ['tests','pass','fail','cancelled','skipped','todo']){const ms=[...dispatchText.matchAll(new RegExp('# '+name+' ([0-9]+)','g'))];assert.equal(ms.length,1,'dispatch '+name);dispatchTap[name]=Number(ms[0][1]);}
const closedFiles=readdirSync(out).filter(n=>n.endsWith('.closed.json')).sort();const receipts=closedFiles.map(n=>verifyReceipt(join(out,n)));const failedReaders=receipts.filter(r=>r.actualExit!==0);
const report={schema:'cinatoken.native26-ci-independent-peer.final.v1',finishedAt:new Date().toISOString(),verdict:{collectionAndSourceAuditComplete:true,businessFullProxyPass:run.conclusion==='success',nativeJobPass:job.conclusion==='success',whole55to113Pass:counts(records).success===59,all26TargetsExecutedPass:counts(targets).success===26&&targets.every(r=>r.actualExecuted&&r.tap?.fail===0&&r.tap?.skipped===0),nextActualNativeFailure:failures[0]??null},run,sourceInputs:{file:join(out,'source-inputs-v3.json'),...info(sourceBytes)},nativeJob:job,chain55to113:{count:records.length,counts:counts(records),records},preparedTargets26:{count:targets.length,counts:counts(targets),records:targets},nativeFailures:failures,dispatch:{job:dispatchJob,tap:dispatchTap,rawExitCodes:[...dispatchText.matchAll(/##\[error\]Process completed with exit code ([0-9]+)\./g)].map(m=>Number(m[1])),rawLog:{file:dispatchReceipt.stdout,...info(dispatchBytes)}},rawEvidence:{authoritativeProgress:progressReceipt,nativeLog:nativeReceipt,dispatchFailedLog:dispatchReceipt},commandReceipts:receipts,readerFailures:failedReaders,toolReaderFailures:[{file:join(out,'inspect-step83-tool-failed.json'),...info(readFileSync(join(out,'inspect-step83-tool-failed.json'))),originalToolResult:JSON.parse(readFileSync(join(out,'inspect-step83-tool-failed.json')))}],scope:{repoWrites:0,mdWrites:0,gitWrites:0,ciWrites:0,ciReruns:0,dbWrites:0,productionWrites:0,localAppTestsRun:0,localSyntaxTestsRun:0,readOnlyGitAndGhAndNodeAudit:true},limitations:['Native observed runtime is the original workflow PostgreSQL container; source/collection exit zero is not business pass.','This report does not establish full G7/G8, PG16 production-role identities, actual money-chain SSE or rollback completion.','Raw successful Node exit zero is inferred only via authoritative Actions step success and TAP; raw error exit codes are separately preserved.']};
writeFileSync(join(out,'FINAL-native26-ci-independent-peer.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({run:run.databaseId,headSha:head,overall:run.conclusion,nativeJob:job.conclusion,chain:report.chain55to113.counts,targets:report.preparedTargets26.counts,nextNativeFailure:failures[0]?.step??null,dispatch:dispatchTap,commandReceipts:receipts.length,failedReaders:failedReaders.length,final:join(out,'FINAL-native26-ci-independent-peer.json')}));
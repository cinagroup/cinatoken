import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const evidence='C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E';
const producer='C:/Users/cina/AppData/Local/Temp/cinatoken-native-next-six-8d357e3fd84b4810a7210ece167eb07a';
const currentSha='07d19c1c941cc373019811be3dbf553c441a0ff3',ciSha='00858e90592d55fa1d58b15bf1a4ebec1883b848';
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
async function readEvidence(root,name){const path=join(root,name),bytes=await readFile(path);return{path,...info(bytes),bytes};}
async function readJson(root,name){const r=await readEvidence(root,name);return{path:r.path,bytes:r.bytes.length,sha256:r.sha256,value:JSON.parse(r.bytes.toString('utf8'))};}
const closed=[];
function git(label,args,input){const at=new Date().toISOString(),r=spawnSync('git',args,{cwd:repo,windowsHide:true,maxBuffer:64*1024*1024,input});const receipt={at,finishedAt:new Date().toISOString(),executable:'git',args,cwd:repo,actualExit:r.status,signal:r.signal,stdout:label+'.stdout.log',stderr:label+'.stderr.log'};closed.push(receipt);assert.equal(r.status,0);assert.equal(r.signal,null);return{r,receipt};}
const head=git('head',['rev-parse','HEAD']);assert.equal(head.r.stdout.toString('utf8').trim(),currentSha);
const producerFinal=await readJson(producer,'FINAL-next-five-pg73-repair.json');assert.equal(producerFinal.bytes,75500);assert.equal(producerFinal.sha256,'030316e3c0943e672eb02605f206ffadb1755f3310d014e26f19257d598a0a1f');
const producerClosed=await readJson(producer,'finalize-five.closed.json');assert.equal(producerClosed.value.actualExit,0);assert.equal(producerClosed.value.signal,null);
const peer=await readJson(evidence,'native-five-root-review.json'),peerClosed=await readJson(evidence,'native-five-root-review.result.json');assert.equal(peer.value.actualExit,0);assert.equal(peerClosed.value.actualExit,0);assert.equal(peer.value.originalAssertions,276);assert.equal(peer.value.originalGrantCalls,7);assert.equal(peer.value.rawSourceTextExact,true);assert.equal(peer.value.sourceProducerHashExact,true);assert.equal(peer.value.realPGExecuted,false);
const terminal=await readJson(evidence,'native-five-all-ci-terminal.stdout.log'),terminalClosed=await readJson(evidence,'native-five-all-ci-terminal.result.json');assert.equal(terminalClosed.value.actualExit,0);assert.equal(terminal.value.length,5);assert.ok(terminal.value.every(run=>run.headSha===ciSha&&run.status==='completed'));
const proxy=await readJson(evidence,'native-five-proxy-progress-2.stdout.log'),proxyClosed=await readJson(evidence,'native-five-proxy-progress-2.result.json');assert.equal(proxyClosed.value.actualExit,0);assert.equal(proxy.value.headSha,ciSha);assert.equal(proxy.value.status,'completed');assert.equal(proxy.value.conclusion,'failure');
const native=proxy.value.jobs.find(job=>job.name==='native-financial-consumer');assert.equal(native.databaseId,112075179249);assert.equal(native.conclusion,'failure');assert.deepEqual(native.candidateSteps.map(s=>({number:s.number,status:s.status,conclusion:s.conclusion})),[47,48,49,50,51,52].map(number=>({number,status:'completed',conclusion:'success'})));assert.deepEqual(native.failed.map(step=>step.number),[53]);
const log=await readEvidence(evidence,'native-five-native-terminal-log.stdout.log'),logClosed=await readJson(evidence,'native-five-native-terminal-log.result.json');assert.equal(logClosed.value.actualExit,0);assert.deepEqual(logClosed.value.args,['run','view','--job','112075179249','--log']);
const lines=log.bytes.toString('utf8').split(/\r?\n/u),cases=[];
for(const [index,name] of ['secretless-plan-v365','send-start-v365','private-route-reader-v366','read-grant-bridge-v367','result-facts-v366','result-client-digest-v367','legacy-reaper-fence-v366'].entries()){
 const file='scripts/db/cutover/postgres-complete-text-'+name+'.native.test.mjs';
 const matches=lines.flatMap((line,i)=>line.includes('node --import tsx --test '+file)?[i]:[]);assert.equal(matches.length,1);
 const commandLine=matches[0];const next=lines.findIndex((line,i)=>i>commandLine&&line.includes('##[group]Run gosu postgres'));
 const end=next<0?lines.findIndex((line,i)=>i>commandLine&&line.includes('Post job cleanup')):next;
 assert.ok(end>commandLine);const block=lines.slice(commandLine,end).join('\n');
 const pass=Number(block.match(/# pass (\d+)/u)?.[1]),fail=Number(block.match(/# fail (\d+)/u)?.[1]),skipped=Number(block.match(/# skipped (\d+)/u)?.[1]);
 const step=47+index;assert.equal(pass,step===53?0:1);assert.equal(fail,step===53?1:0);assert.equal(skipped,0);
 const directTap=lines.slice(commandLine,end).filter(line=>/\bok 1 -|not ok 1 -|# pass |# fail |# skipped |81 !== 73|legacy-reaper-fence-v366.native.test.mjs:117:14|Process completed with exit code 1\./u.test(line));
 if(step===53){assert.ok(block.includes('81 !== 73'));assert.ok(block.includes('legacy-reaper-fence-v366.native.test.mjs:117:14'));assert.ok(block.includes('Process completed with exit code 1.'));}
 cases.push({step,file,commandLine:commandLine+1,pass,fail,skipped,directTap});
}
const sourcePaths=producerFinal.value.files.map(f=>f.file),batch=git('five-git-source-bytes',['cat-file','--batch'],[...sourcePaths.map(p=>ciSha+':'+p),...sourcePaths.map(p=>currentSha+':'+p)].join('\n')+'\n');
let offset=0;const verifiedSourceBytes=[];
for(const [index,file]of [...sourcePaths,...sourcePaths].entries()){
 const end=batch.r.stdout.indexOf(10,offset),[blob,type,size]=batch.r.stdout.subarray(offset,end).toString('utf8').split(' ');assert.equal(type,'blob');const bytes=batch.r.stdout.subarray(end+1,end+1+Number(size));offset=end+1+Number(size)+1;
 const record=producerFinal.value.files.find(f=>f.file===file);assert.deepEqual(info(bytes),record.after);assert.ok(bytes.equals(await readFile(join(repo,file))));verifiedSourceBytes.push({sourceSha:index<5?ciSha:currentSha,file,blob,...info(bytes),producerFinalHashExact:true});
}assert.equal(offset,batch.r.stdout.length);
for(const item of closed){const r=item===head.receipt?head.r:batch.r;await writeFile(join(out,item.stdout),r.stdout,{flag:'wx'});await writeFile(join(out,item.stderr),r.stderr,{flag:'wx'});await writeFile(join(out,item.stdout.replace('.stdout.log','.closed.json')),JSON.stringify(item,null,2)+'\n',{flag:'wx'});}
const suggestedMd='00858e90592d55fa1d58b15bf1a4ebec1883b848 的原 Linux PostgreSQL 18.6 CI run37403320556 中，五个 PG73 夹具（native steps47–51）均真实成功，未改的 step52 JSONB/digest 也成功；六项均 TAP pass1/fail0/skip0。native 随后在 step53 legacy-reaper-fence-v366:117:14 因 81!=73 失败，Proxy dispatch safety 整体仍失败，原 dispatch-safety step27 strict 取消失败也保留；后续 native 步骤未获验证。本地 276 原 assert/7 grant、181 保护源及惰性桥接证据只证明源码与局部控制边界，真实 Linux 成功由该独立 CI 证明；不据此关闭完整数据库、取消、G7/G8 或生产部署门槛。';
const report={schema:'cinatoken.native-five-ci-readonly-review.v1',at:new Date().toISOString(),actualExit:0,currentHead:currentSha,actualCiSource:ciSha,runId:37403320556,jobId:112075179249,conclusionSupported:true,cases,
 producerReport:{path:producerFinal.path,bytes:producerFinal.bytes,sha256:producerFinal.sha256,closedReceipt:producerClosed.path,closedReceiptActualExit:producerClosed.value.actualExit},
 peerReport:{path:peer.path,bytes:peer.bytes,sha256:peer.sha256,closedReceipt:peerClosed.path,closedReceiptActualExit:peerClosed.value.actualExit,kind:'Root independent readonly source review of these five files',notHistoricalEightPeer:true,notRuntimePeer:true},
 sourceGitBytes:verifiedSourceBytes,
 evidence:[terminal,terminalClosed,proxy,proxyClosed,logClosed].map(({path,bytes,sha256})=>({path,bytes,sha256})).concat({path:log.path,bytes:log.bytes.length,sha256:log.sha256}),
 boundary:{fiveNativeActuallyPassedInOriginalLinuxCi:true,unchangedDigestActuallyPassed:true,firstNextFailure:{step:53,file:cases.at(-1).file,line:117,column:14,actual:81,expected:73},fullProxyWorkflowStillFailed:true,producerLocalInertNotRealPg:true,ciSourceNotCurrentHead:true,sourceFilesExactBetweenProducerCiAndCurrentHead:true,productionDeploymentNotProvenByTheseChecks:true,fullGatesNotClosed:true,originalLaterNativeStepsNotClaimedPassed:true,readOnlyChecksOnly:true},suggestedMd,gitReadReceipts:closed,repositoryWrites:0,ciWrites:0,productionWrites:0,databaseExecutions:0};
const reportPath=join(out,'FINAL-native-five-ci-readonly-review.json'),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');await writeFile(reportPath,bytes,{flag:'wx'});await writeFile(join(out,'suggested-md.txt'),suggestedMd+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,reportPath,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sixPasses:cases.filter(c=>c.pass===1).length,nextFailureStep:53,peerPath:peer.path,producerPath:producerFinal.path})+'\n');

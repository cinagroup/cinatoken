import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2],hash=b=>createHash('sha256').update(b).digest('hex');
const desc=p=>{const b=readFileSync(p);return {path:relative(root,p).replaceAll('\\','/'),bytes:b.length,sha256:hash(b)};};
const program=join(root,'final-audit-and-report.mjs');
const startedAt=new Date().toISOString();
const r=spawnSync(process.execPath,[program,root],{cwd:root,encoding:null,timeout:30000,windowsHide:true,maxBuffer:1024*1024});
const endedAt=new Date().toISOString();
const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
writeFileSync(join(root,'final-audit.stdout.log'),stdout,{flag:'wx'});
writeFileSync(join(root,'final-audit.stderr.log'),stderr,{flag:'wx'});
const rec={label:'final-audit',command:[process.execPath,program,root],cwd:root,startedAt,endedAt,actualExit:r.status,signal:r.signal??null,spawnError:r.error?{code:r.error.code,message:r.error.message}:null,timeoutConfiguredMs:30000,timedOutObserved:r.error?.code==='ETIMEDOUT',sourceProgram:desc(program),stdout:desc(join(root,'final-audit.stdout.log')),stderr:desc(join(root,'final-audit.stderr.log')),collectionOnly:true,businessOrProductionPassDerived:false};
writeFileSync(join(root,'final-audit.closed.json'),JSON.stringify(rec,null,2)+'\n',{flag:'wx'});
if(r.status!==0||r.signal||r.error){console.log(JSON.stringify(rec));process.exitCode=1;}else{
 const files=[];
 const walk=p=>{for(const n of readdirSync(p).sort()){const q=join(p,n),s=statSync(q);if(s.isDirectory())walk(q);else if(s.isFile())files.push(desc(q));else throw Error('Unexpected owned entry');}};
 walk(root);
 const seal={schema:'owned-whole-candidate-root-STOPWRITE-seal-v1',root,frozenAt:new Date().toISOString(),completeFileCountExcludingSeal:files.length,files,finalAuditActualExit:0,closedChildren:11,actualZero:6,actualOne:4,actual128:1,originalBaselineRedAndGitFailuresRetained:true,repoModified:false,productionRequests:0,rootCauseConfirmed:false,STOPWRITE:true};
 writeFileSync(join(root,'STOPWRITE.json'),JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({root,FINAL:desc(join(root,'FINAL-cinatoken-resource-candidate.json')),seal:desc(join(root,'STOPWRITE.json')),patch:desc(join(root,'patch-reviewable.diff')),completeOwnedFiles:files.length+1,actualFinalAuditExit:0,STOPWRITE:true}));
}


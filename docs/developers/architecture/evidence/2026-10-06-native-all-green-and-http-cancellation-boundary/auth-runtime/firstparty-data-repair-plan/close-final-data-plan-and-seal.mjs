import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync,readdirSync,statSync} from "node:fs";
import {join,relative} from "node:path";
import {createHash} from "node:crypto";
const root=process.argv[2],sha=b=>createHash("sha256").update(b).digest("hex");
const desc=p=>{const b=readFileSync(p);return {path:relative(root,p).replaceAll("\\","/"),bytes:b.length,sha256:sha(b)};};
const program=join(root,"final-static-data-repair-audit.mjs"),startedAt=new Date().toISOString();
const r=spawnSync(process.execPath,[program,root],{cwd:root,encoding:null,timeout:15000,windowsHide:true,maxBuffer:1024*1024});
const endedAt=new Date().toISOString();
writeFileSync(join(root,"final-audit.stdout.log"),r.stdout??Buffer.alloc(0),{flag:"wx"});
writeFileSync(join(root,"final-audit.stderr.log"),r.stderr??Buffer.alloc(0),{flag:"wx"});
const receipt={command:[process.execPath,program,root],cwd:root,startedAt,endedAt,actualExit:r.status,signal:r.signal??null,error:r.error?{code:r.error.code,message:r.error.message}:null,timeoutConfiguredMs:15000,timedOutObserved:r.error?.code==="ETIMEDOUT",sourceProgram:desc(program),stdout:desc(join(root,"final-audit.stdout.log")),stderr:desc(join(root,"final-audit.stderr.log")),collectionOnly:true,productionRequests:0,noLiveRepairPassDerived:true};
writeFileSync(join(root,"final-audit.closed.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
if(r.status!==0||r.signal||r.error){console.log(JSON.stringify(receipt));process.exitCode=1;}else{
 const files=[];for(const n of readdirSync(root).sort()){const p=join(root,n);if(!statSync(p).isFile())throw Error("Unexpected owned directory");files.push(desc(p));}
 const seal={schema:"whole-owned-data-repair-plan-STOPWRITE-v1",root,frozenAt:new Date().toISOString(),files,completeFileCountExcludingSeal:files.length,actualClosedChildren:2,actualZero:2,actualFailure:0,
 SQLiteNineCasesPassed:true,PGOrProductionRepairVerified:false,originalLiveMetadataAuthority:"Root message, not new request/claim",repoModified:false,oldRootsModified:false,STOPWRITE:true};
 writeFileSync(join(root,"STOPWRITE.json"),JSON.stringify(seal,null,2)+"\n",{flag:"wx"});
 console.log(JSON.stringify({root,FINAL:desc(join(root,"FINAL-firstparty-link-data-repair-plan.json")),seal:desc(join(root,"STOPWRITE.json")),candidate:desc(join(root,"repair-cinatoken-client-link.mjs")),wholeFiles:files.length+1,finalAuditClosed:receipt,STOPWRITE:true}));
}


import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync,readdirSync,statSync} from "node:fs";
import {join,relative} from "node:path";
import {createHash} from "node:crypto";
const root=process.argv[2],sha=b=>createHash("sha256").update(b).digest("hex");
const desc=p=>{const b=readFileSync(p);return {path:relative(root,p).replaceAll("\\","/"),bytes:b.length,sha256:sha(b)};};
const program=join(root,"review-v2-and-approval-status.mjs"),startedAt=new Date().toISOString();
const r=spawnSync(process.execPath,[program,root],{cwd:root,encoding:null,windowsHide:true,timeout:15000,maxBuffer:1024*1024});
const endedAt=new Date().toISOString();
writeFileSync(join(root,"static-review.stdout.log"),r.stdout??Buffer.alloc(0),{flag:"wx"});
writeFileSync(join(root,"static-review.stderr.log"),r.stderr??Buffer.alloc(0),{flag:"wx"});
const receipt={command:[process.execPath,program,root],cwd:root,startedAt,endedAt,actualExit:r.status,signal:r.signal??null,error:r.error?{code:r.error.code,message:r.error.message}:null,sourceProgram:desc(program),stdout:desc(join(root,"static-review.stdout.log")),stderr:desc(join(root,"static-review.stderr.log")),collectionOnly:true,productionWriteApprovalRejectedHasNoChild:true,noLiveRepairPassDerived:true};
writeFileSync(join(root,"static-review.closed.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
if(r.status!==0||r.signal||r.error){console.log(JSON.stringify(receipt));process.exitCode=1;}else{
 const files=readdirSync(root).sort().map(n=>{const p=join(root,n);if(!statSync(p).isFile())throw Error("Unexpected owned directory");return desc(p);});
 const seal={schema:"complete-v2-approval-static-review-STOPWRITE-v1",root,frozenAt:new Date().toISOString(),files,completeFileCountExcludingSeal:files.length,ownedActualClosedChildren:1,actualZero:1,previousNineCaseSQLChildReferencedNotRerun:true,productionRejectedCreateProcessHasNoChild:true,productionRepairExecuted:false,oldFrozenRootsModified:false,STOPWRITE:true};
 writeFileSync(join(root,"STOPWRITE.json"),JSON.stringify(seal,null,2)+"\n",{flag:"wx"});
 console.log(JSON.stringify({root,FINAL:desc(join(root,"FINAL-firstparty-link-v2-approval-review.json")),seal:desc(join(root,"STOPWRITE.json")),closed:receipt,ownedFiles:files.length+1,STOPWRITE:true}));
}


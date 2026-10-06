import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
const root=process.argv[2],sha=b=>createHash("sha256").update(b).digest("hex");
const source=join(root,"repair-cinatoken-client-link.test.mjs"),candidate=join(root,"repair-cinatoken-client-link.mjs");
const startedAt=new Date().toISOString();
const r=spawnSync(process.execPath,["--test",source],{cwd:root,windowsHide:true,encoding:null,timeout:15000,maxBuffer:1024*1024,env:{...process.env,TEMP:root,TMP:root}});
const endedAt=new Date().toISOString(),stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
writeFileSync(join(root,"sqlite-tests.stdout.log"),stdout,{flag:"wx"});
writeFileSync(join(root,"sqlite-tests.stderr.log"),stderr,{flag:"wx"});
const receipt={schema:"actual-child-closed-v1",command:[process.execPath,"--test",source],cwd:root,startedAt,endedAt,actualExit:r.status,signal:r.signal??null,error:r.error?{code:r.error.code,message:r.error.message}:null,timeoutConfiguredMs:15000,timedOutObserved:r.error?.code==="ETIMEDOUT",
sourceProgram:{path:source,bytes:readFileSync(source).length,sha256:sha(readFileSync(source))},
candidate:{path:candidate,bytes:readFileSync(candidate).length,sha256:sha(readFileSync(candidate))},
stdout:{path:"sqlite-tests.stdout.log",bytes:stdout.length,sha256:sha(stdout)},stderr:{path:"sqlite-tests.stderr.log",bytes:stderr.length,sha256:sha(stderr)},
method:"Actual candidate function against in-memory SQLite transaction adapter; FOR UPDATE and SET LOCAL deliberately not accepted as PG proof.",
productionRequests:0,actualPGConnections:0,noLiveRepairPassDerived:true};
writeFileSync(join(root,"sqlite-tests.closed.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify(receipt));
process.exitCode=r.status===0&&!r.signal&&!r.error?0:1;


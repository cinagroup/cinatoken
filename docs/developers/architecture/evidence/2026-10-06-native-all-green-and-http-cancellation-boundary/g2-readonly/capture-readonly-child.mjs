import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root=process.argv[2];
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceProgram=join(root,'read-next-real-acceptance.mjs');
const startedAt=new Date().toISOString();
const result=spawnSync(process.execPath,[sourceProgram,root],{encoding:null,timeout:15000,windowsHide:true,cwd:'C:/cinagroup/cinatoken',maxBuffer:1024*1024});
const endedAt=new Date().toISOString();
const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
writeFileSync(join(root,'readonly-source.stdout.log'),stdout,{flag:'wx'});
writeFileSync(join(root,'readonly-source.stderr.log'),stderr,{flag:'wx'});
const receipt={
schema:'actual-spawnSync-child-closed-v1',
startedAt,endedAt,command:[process.execPath,sourceProgram,root],
cwd:'C:/cinagroup/cinatoken',
actualExit:result.status,signal:result.signal??null,
spawnError:result.error?{name:result.error.name,code:result.error.code,message:result.error.message}:null,
timeoutConfiguredMs:15000,timedOutObserved:result.error?.code==='ETIMEDOUT',
sourceProgram:{path:sourceProgram,bytes:readFileSync(sourceProgram).length,sha256:sha(readFileSync(sourceProgram))},
stdout:{path:'readonly-source.stdout.log',bytes:stdout.length,sha256:sha(stdout)},
stderr:{path:'readonly-source.stderr.log',bytes:stderr.length,sha256:sha(stderr)},
collectionOnly:true,readOnlySourceAndPresence:true,
businessOrNativePassDerived:false
};
writeFileSync(join(root,'readonly-source.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
process.exitCode=result.status===0&&!result.signal&&!result.error?0:1;


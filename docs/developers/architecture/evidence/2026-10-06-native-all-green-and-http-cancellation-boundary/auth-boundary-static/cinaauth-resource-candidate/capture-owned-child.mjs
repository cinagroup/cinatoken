import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2],label=process.argv[3],exe=process.argv[4],args=process.argv.slice(5);
const hash=b=>createHash('sha256').update(b).digest('hex');
const startedAt=new Date().toISOString();
const result=spawnSync(exe,args,{cwd:root,encoding:null,windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:{...process.env,TEMP:root,TMP:root}});
const endedAt=new Date().toISOString(),stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
writeFileSync(join(root,label+'.stdout.log'),stdout,{flag:'wx'});
writeFileSync(join(root,label+'.stderr.log'),stderr,{flag:'wx'});
const data={label,command:[exe,...args],cwd:root,startedAt,endedAt,actualExit:result.status,signal:result.signal??null,spawnError:result.error?{code:result.error.code,message:result.error.message}:null,timeoutConfiguredMs:120000,timedOutObserved:result.error?.code==='ETIMEDOUT',stdout:{path:label+'.stdout.log',bytes:stdout.length,sha256:hash(stdout)},stderr:{path:label+'.stderr.log',bytes:stderr.length,sha256:hash(stderr)},sourceProgram:{path:args[0],bytes:readFileSync(args[0]).length,sha256:hash(readFileSync(args[0]))},businessOrProductionPassDerived:false};
writeFileSync(join(root,label+'.closed.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(data));
process.exitCode=result.status===0&&!result.signal&&!result.error?0:1;


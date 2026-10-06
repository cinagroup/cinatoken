import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1')),sha=b=>createHash('sha256').update(b).digest('hex');
const [id,...args]=process.argv.slice(2);if(!/^[a-z0-9-]+$/u.test(id))throw new Error('Invalid fresh tool record id');
const at=new Date().toISOString(),r=spawnSync(process.execPath,args,{cwd:'C:/cinagroup/cinatoken',timeout:60000,maxBuffer:24*1024*1024,encoding:null,windowsHide:true}),outputs={};
for(const [stream,bytes]of [['stdout',r.stdout??Buffer.alloc(0)],['stderr',r.stderr??Buffer.alloc(0)]]){const file=path.join(root,id+'.'+stream+'.log');fs.writeFileSync(file,bytes,{flag:'wx'});outputs[stream]={path:file,bytes:bytes.length,sha256:sha(bytes)}}
const result={at,finishedAt:new Date().toISOString(),executable:process.execPath,args,cwd:'C:/cinagroup/cinatoken',actualExit:r.status,signal:r.signal,spawnError:r.error?.code??null,...outputs,
  scope:'Original exact child return of Temp evidence tool only; no application/native/G7/runtime or production run'};
fs.writeFileSync(path.join(root,id+'.result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));process.exitCode=r.status??1;

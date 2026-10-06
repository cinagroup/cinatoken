import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const [id,...args]=process.argv.slice(2);
if(!/^[a-z0-9-]+$/u.test(id))throw new Error('Fresh capture id required');
const at=new Date().toISOString();
const result=spawnSync(process.execPath,args,{cwd:'C:/cinagroup/cinatoken',timeout:60000,maxBuffer:4*1024*1024,windowsHide:true,encoding:null});
const outputs=[];
for(const [stream,b]of [['stdout',result.stdout??Buffer.alloc(0)],['stderr',result.stderr??Buffer.alloc(0)]]){
 const file=id+'.'+stream+'.log';fs.writeFileSync(path.join(root,file),b,{flag:'wx'});outputs.push({file,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
}
const record={schema:'quote-packet-peer-exact-node-closed-v1',at,finishedAt:new Date().toISOString(),executable:process.execPath,args,cwd:'C:/cinagroup/cinatoken',actualExit:result.status,signal:result.signal,spawnError:result.error?.code??null,outputs,scope:'Original exact Node child return for bounded read-only evidence audit only; not native/application/PG/CI or production execution'};
fs.writeFileSync(path.join(root,id+'.closed.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(record));process.exitCode=result.status??1;

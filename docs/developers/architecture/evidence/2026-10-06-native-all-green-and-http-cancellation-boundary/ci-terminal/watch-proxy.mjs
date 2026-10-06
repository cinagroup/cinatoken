import {spawn} from 'node:child_process';
import {open,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const label='proxy-watch-1',stdoutPath=join(out,label+'.stdout.log'),stderrPath=join(out,label+'.stderr.log');
const stdout=await open(stdoutPath,'wx'),stderr=await open(stderrPath,'wx');
const program='C:/Program Files/GitHub CLI/gh.exe',args=['run','watch','37429192670','--repo','cinagroup/cinatoken','--interval','45','--exit-status'];
const at=new Date().toISOString(),child=spawn(program,args,{cwd:'C:/cinagroup/cinatoken',windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});
let spawnError=null;child.once('error',error=>spawnError=String(error));
console.log(JSON.stringify({watchHandle:37429192670,pid:child.pid,intervalSeconds:45,startedAt:at,sourceSha:'757490181564aa822f960f5d8704857b98b230d0'}));
const result=await new Promise(resolve=>child.once('close',(actualExit,signal)=>resolve({actualExit,signal})));
await stdout.close();await stderr.close();
const digest=async path=>({path,...info(await readFile(path))});
const receipt={at,finishedAt:new Date().toISOString(),program,args,cwd:'C:/cinagroup/cinatoken',...result,spawnError,
 stdout:await digest(stdoutPath),stderr:await digest(stderrPath),collectionOnly:true,ciActions:0,watchExitIsNotTerminalMetadata:true};
await writeFile(join(out,label+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));process.exitCode=Number.isInteger(result.actualExit)&&!result.signal&&!spawnError?result.actualExit:1;

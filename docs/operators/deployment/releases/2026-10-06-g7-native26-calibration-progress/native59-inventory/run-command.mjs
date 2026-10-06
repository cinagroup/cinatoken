import{spawn}from'node:child_process';
import{open,readFile,writeFile}from'node:fs/promises';
import{dirname,join}from'node:path';
import{fileURLToPath}from'node:url';
import{createHash}from'node:crypto';
const out=dirname(fileURLToPath(import.meta.url)),[label,executable,...args]=process.argv.slice(2);if(!/^[a-z0-9-]+$/.test(label))throw Error('Invalid label');
const stdoutPath=join(out,label+'.stdout.log'),stderrPath=join(out,label+'.stderr.log'),stdout=await open(stdoutPath,'wx'),stderr=await open(stderrPath,'wx'),at=new Date().toISOString();
const child=spawn(executable,args,{cwd:'C:/cinagroup/cinatoken',windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]}),result=await new Promise(resolve=>{child.once('error',error=>resolve({actualExit:null,signal:null,spawnError:String(error)}));child.once('close',(actualExit,signal)=>resolve({actualExit,signal}));});await stdout.close();await stderr.close();const hash=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});const receipt={at,finishedAt:new Date().toISOString(),executable,args,...result,stdout:stdoutPath,stderr:stderrPath,stdoutInfo:hash(await readFile(stdoutPath)),stderrInfo:hash(await readFile(stderrPath))};await writeFile(join(out,label+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(receipt)+'\n');process.exitCode=Number.isInteger(result.actualExit)?result.actualExit:1;

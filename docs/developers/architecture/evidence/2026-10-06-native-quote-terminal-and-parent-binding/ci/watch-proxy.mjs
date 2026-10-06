import{spawn}from'node:child_process';import{open,readFile,writeFile}from'node:fs/promises';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),label=process.argv[2]??'proxy-watch-1';
if(!/^proxy-watch-\d+$/.test(label))throw Error('Owned watch label');
const stdoutPath=join(root,label+'.stdout.log'),stderrPath=join(root,label+'.stderr.log');
const stdout=await open(stdoutPath,'wx'),stderr=await open(stderrPath,'wx');
const program='C:/Program Files/GitHub CLI/gh.exe',args=['run','watch','37421461373','--repo','cinagroup/cinatoken','--interval','45','--exit-status'];
const at=new Date().toISOString(),child=spawn(program,args,{cwd:'C:/cinagroup/cinatoken',windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});
let spawnError=null;child.once('error',error=>spawnError=String(error));
console.log(JSON.stringify({watchHandle:37421461373,pid:child.pid,intervalSeconds:45,startedAt:at,sourceSha:'d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a'}));
const result=await new Promise(resolve=>child.once('close',(actualExit,signal)=>resolve({actualExit,signal})));
await stdout.close();await stderr.close();const digest=async path=>{const b=await readFile(path);return{path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}};
const receipt={at,finishedAt:new Date().toISOString(),program,args,cwd:'C:/cinagroup/cinatoken',...result,spawnError,stdout:await digest(stdoutPath),stderr:await digest(stderrPath),
 collectionOnly:true,ciActions:0,gatePassDerived:false,watchExitIsNotTerminalMetadata:true};
await writeFile(join(root,label+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));process.exitCode=Number.isInteger(result.actualExit)&&!result.signal&&!spawnError?result.actualExit:1;

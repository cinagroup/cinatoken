import {spawn} from 'node:child_process';
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{join,dirname}from'node:path';
import{fileURLToPath}from'node:url';
export const out=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
export const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
export async function command(label,executable,args,input){
 const at=new Date().toISOString(),chunks=[],errors=[];
 const child=spawn(executable,args,{cwd:repo,windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>errors.push(b));
 let spawnError=null;child.once('error',e=>spawnError=String(e));
 child.stdin.end(input);
 const result=await new Promise(resolve=>child.once('close',(actualExit,signal)=>resolve({actualExit,signal})));
 const stdout=Buffer.concat(chunks),stderr=Buffer.concat(errors),stdoutPath=join(out,label+'.stdout.log'),stderrPath=join(out,label+'.stderr.log');
 await writeFile(stdoutPath,stdout,{flag:'wx'});await writeFile(stderrPath,stderr,{flag:'wx'});
 const receipt={at,finishedAt:new Date().toISOString(),executable,args,cwd:repo,...result,spawnError,stdout:{path:stdoutPath,...info(stdout)},stderr:{path:stderrPath,...info(stderr)}};
 await writeFile(join(out,label+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 return{receipt,stdout,stderr};
}
export async function file(label,path){
 const at=new Date().toISOString();let bytes=Buffer.alloc(0),actualExit=0,error=null;
 try{bytes=await readFile(path)}catch(e){actualExit=null;error={code:e.code,message:e.message}}
 const stdoutPath=join(out,label+'.stdout.log'),stderr=Buffer.from(error?JSON.stringify(error)+'\n':'');
 const stderrPath=join(out,label+'.stderr.log');await writeFile(stdoutPath,bytes,{flag:'wx'});await writeFile(stderrPath,stderr,{flag:'wx'});
 const receipt={at,finishedAt:new Date().toISOString(),operation:'readFile',path,actualExit,signal:null,error,stdout:{path:stdoutPath,...info(bytes)},stderr:{path:stderrPath,...info(stderr)}};
 await writeFile(join(out,label+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return{receipt,stdout:bytes};
}
export function success(result){if(result.receipt.actualExit!==0||result.receipt.signal||result.receipt.spawnError)throw Error('Read command failed: '+JSON.stringify(result.receipt));return result.stdout;}

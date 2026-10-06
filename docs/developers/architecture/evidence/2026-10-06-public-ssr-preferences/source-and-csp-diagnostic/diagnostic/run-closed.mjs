import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const dir=path.dirname(fileURLToPath(import.meta.url)),at=new Date().toISOString()
const stdout=fs.openSync(path.join(dir,'diagnostic.stdout.log'),'wx'),stderr=fs.openSync(path.join(dir,'diagnostic.stderr.log'),'wx')
const child=spawn(process.execPath,[path.join(dir,'diagnose.mjs')],{cwd:'C:/cinagroup/cinatoken',windowsHide:true,stdio:['ignore',stdout,stderr]})
child.once('error',error=>{fs.closeSync(stdout);fs.closeSync(stderr);fs.writeFileSync(path.join(dir,'closed-result.json'),JSON.stringify({at,processStarted:false,error:{message:error.message,code:error.code},actualExitCode:null},null,2)+'\n',{flag:'wx'});process.exitCode=1})
child.once('close',(actualExitCode,signal)=>{
  fs.closeSync(stdout);fs.closeSync(stderr)
  const files=['diagnostic.stdout.log','diagnostic.stderr.log'].map(name=>{const bytes=fs.readFileSync(path.join(dir,name));return{path:path.join(dir,name),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}})
  const result={at,closedAt:new Date().toISOString(),processStarted:true,pid:child.pid,actualExitCode,signal,files}
  fs.writeFileSync(path.join(dir,'closed-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify(result));process.exitCode=actualExitCode??1
})

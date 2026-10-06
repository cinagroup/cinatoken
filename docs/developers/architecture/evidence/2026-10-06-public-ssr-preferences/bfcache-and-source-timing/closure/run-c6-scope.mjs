import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const own=path.dirname(fileURLToPath(import.meta.url))
const mode=process.argv[2],label=process.argv[3]
assert.ok(mode==='prepare'||mode==='final')
assert.match(label??'',/^[a-z0-9][a-z0-9-]{0,63}$/)
const startedAt=new Date().toISOString()
const target=mode==='prepare'?'prepare-c6-v2.mjs':'compare-c6.mjs'
const child=spawnSync(process.execPath,[path.join(own,target),...(mode==='final'?[label]:[])],{
  cwd:'C:/cinagroup/cinatoken',windowsHide:true,encoding:null,timeout:30000,maxBuffer:8*1024*1024
})
const saved=[]
for(const stream of ['stdout','stderr']){
  const target=path.join(own,label+'.'+stream+'.log'),bytes=child[stream]??Buffer.alloc(0)
  fs.writeFileSync(target,bytes,{flag:'wx'})
  saved.push({path:target,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
}
const result={
  mode,label,startedAt,closedAt:new Date().toISOString(),actualExitCode:child.status,signal:child.signal,
  error:child.error?{name:child.error.name,message:child.error.message}:null,
  readOnly:true,noProductionActions:true,files:saved
}
const resultFile=path.join(own,label+'.process-closed.json')
fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({resultFile,...result}))
if(child.stdout?.length)process.stdout.write(child.stdout)
if(child.stderr?.length)process.stderr.write(child.stderr)
process.exitCode=child.status===0&&child.signal===null&&!child.error?0:1
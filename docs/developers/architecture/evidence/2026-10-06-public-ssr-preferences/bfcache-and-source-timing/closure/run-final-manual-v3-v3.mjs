import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const own=path.dirname(fileURLToPath(import.meta.url))
const startedAt=new Date().toISOString()
const child=spawnSync('C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',[path.join(own,'review-final-md-595-v3-v3.py')],{
  cwd:own,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}
})
const files=[]
for(const stream of ['stdout','stderr']){
 const file=path.join(own,'final-md-595-v3-manual-v3.'+stream+'.log'),bytes=child[stream]??Buffer.alloc(0)
 fs.writeFileSync(file,bytes,{flag:'wx'})
 files.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
}
const result={
 startedAt,closedAt:new Date().toISOString(),actualExitCode:child.status,signal:child.signal,
 spawnError:child.error?{name:child.error.name,message:child.error.message}:null,
 readOnly:true,networkRequestsMade:0,browserOperationsMade:0,benchmarkRerunsMade:0,files
}
const target=path.join(own,'final-md-595-v3-manual-v3.process-closed.json')
fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({receipt:target,...result}))
if(child.stdout?.length)process.stdout.write(child.stdout)
if(child.stderr?.length)process.stderr.write(child.stderr)
process.exitCode=child.status===0&&child.signal===null&&!child.error?0:1
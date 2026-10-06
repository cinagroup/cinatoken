import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const own=path.dirname(fileURLToPath(import.meta.url))
const executable='C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
const args=[path.join(own,'review-bfcache-source-timing-archive.py')]
const startedAt=new Date().toISOString()
const child=spawnSync(executable,args,{cwd:'C:/cinagroup/cinatoken',windowsHide:true,timeout:60000,maxBuffer:1024*1024})
const proof=(name,data)=>{
 const file=path.join(own,name);data??=Buffer.alloc(0);fs.writeFileSync(file,data,{flag:'wx'})
 return {path:file,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}
}
const files=[proof('bfcache-source-timing-archive-review.stdout.log',child.stdout),proof('bfcache-source-timing-archive-review.stderr.log',child.stderr)]
const receipt={startedAt,closedAt:new Date().toISOString(),executable,args,pid:child.pid??null,actualExitCode:child.status,signal:child.signal,spawnError:child.error?{name:child.error.name,message:child.error.message}:null,networkRequestsMade:0,browserOperationsMade:0,benchmarkRerunsMade:0,files}
fs.writeFileSync(path.join(own,'bfcache-source-timing-archive-review-process-closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(receipt));if(child.stdout?.length)console.log(child.stdout.toString());if(child.stderr?.length)console.error(child.stderr.toString())
process.exitCode=child.status===0&&child.signal===null&&!child.error?0:1

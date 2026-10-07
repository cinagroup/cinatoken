import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const OWN=dirname(fileURLToPath(import.meta.url)),label=process.argv[2],kind=process.argv[3],argv=process.argv.slice(4);
assert(/^[a-z0-9][a-z0-9-]{0,63}$/u.test(label??''));
const exe=kind==='node'?'C:/Program Files/nodejs/node.exe':kind==='python'?'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe':null;
assert(exe&&argv.length);
const startedAt=new Date().toISOString(),stdout=[],stderr=[];
const child=spawn(exe,argv,{cwd:'C:/cinagroup/cinatoken',windowsHide:true,stdio:['ignore','pipe','pipe']});
let spawnError=null;child.once('error',e=>spawnError=String(e));
child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));
const sha=b=>createHash('sha256').update(b).digest('hex');
await new Promise(done=>child.once('close',(actualExitCode,signal)=>{
const streams={};for(const [name,bytes]of[['stdout',Buffer.concat(stdout)],['stderr',Buffer.concat(stderr)]]){const p=join(OWN,label+'.'+name+'.log');writeFileSync(p,bytes,{flag:'wx'});streams[name]={path:p,bytes:bytes.length,sha256:sha(bytes)};}
const receipt={label,executable:exe,args:argv,cwd:'C:/cinagroup/cinatoken',startedAt,closedAt:new Date().toISOString(),actualExitCode,signal,spawnError,streams};
const file=join(OWN,label+'.process-closed.json');writeFileSync(file,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({receipt:file,...receipt}));if(stdout.length)process.stdout.write(Buffer.concat(stdout));
process.exitCode=actualExitCode===0&&signal===null&&!spawnError?0:actualExitCode||1;done();}));

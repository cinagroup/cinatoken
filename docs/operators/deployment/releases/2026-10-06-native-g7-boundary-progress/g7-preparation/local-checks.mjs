import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out=dirname(fileURLToPath(import.meta.url));
const root='C:/cinagroup/cinatoken';
const directory='scripts/verification/web-platform-g7';
const names=readdirSync(join(root,directory)).map(name=>`${directory}/${name}`).concat('.github/workflows/web-platform-g7.yml');
const hash=b=>createHash('sha256').update(b).digest('hex');
const inventory=()=>names.map(path=>{const b=readFileSync(join(root,path));return{path,bytes:b.length,sha256:hash(b)}});
const snapshot=join(out,'before-format');mkdirSync(snapshot);
for(const path of names){const target=join(snapshot,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(root,path)),{flag:'wx'})}
writeFileSync(join(out,'before-format-source.json'),JSON.stringify({preparedAtHead:'6658ec978009afa5fe3f4beccf6bde358590b663',files:inventory()},null,2)+'\n',{flag:'wx'});
const receipts=[];
function run(id,args){const begin=new Date().toISOString();const r=spawnSync(process.execPath,args,{cwd:root,encoding:null,timeout:120000,maxBuffer:8000000});for(const [stream,b]of[['stdout',r.stdout],['stderr',r.stderr]])writeFileSync(join(out,`${id}.${stream}.log`),b??Buffer.alloc(0),{flag:'wx'});const receipt={id,program:process.execPath,args,begin,endedAt:new Date().toISOString(),closed:true,actualExit:r.status,signal:r.signal,errorCode:r.error?.code??null};writeFileSync(join(out,`${id}.result.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});receipts.push(receipt);return r.status===0&&r.signal===null&&!r.error;}
const prettier=['node_modules/prettier/bin-prettier.js'];
const formatted=names.filter(path=>/\.(?:mjs|md|yml)$/.test(path));
run('format-before',[...prettier,'--check',...formatted]);
const checks=[];
checks.push({id:'format-write',pass:run('format-write',[...prettier,'--write',...formatted])});
checks.push({id:'format-after',pass:run('format-after',[...prettier,'--check',...formatted])});
for(const [i,path]of names.filter(path=>path.endsWith('.mjs')).entries())checks.push({id:`syntax-${i}`,pass:run(`syntax-${i}`,['--check',path])});
checks.push({id:'admission-tests',pass:run('admission-tests',['--test',`${directory}/admission.test.mjs`])});
checks.push({id:'windows-runtime-rejected',pass:!run('windows-runtime-rejected',[`${directory}/run-owned-linux.mjs`,'--execute-owned-linux','--sha','6658ec978009afa5fe3f4beccf6bde358590b663','--out',join(out,'never-created-runtime')])});
writeFileSync(join(out,'local-checks-report.json'),JSON.stringify({schema:'g7-tls-pg-package-local-preparation-v1',actualExit:checks.every(c=>c.pass)?0:1,checks,receipts,files:inventory(),realLinuxDockerExecuted:false,actualTLSExecuted:false,realDatabaseExecuted:false,productionRequests:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:checks.every(c=>c.pass)?0:1,out,checks}));process.exitCode=checks.every(c=>c.pass)?0:1;

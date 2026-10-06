import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2];
const hash=b=>createHash('sha256').update(b).digest('hex');
const desc=path=>{const b=readFileSync(join(root,path));return {path,bytes:b.length,sha256:hash(b)};};
const startedAt=new Date().toISOString();
const program=join(root,'readonly-fallback-source.mjs');
const result=spawnSync(process.execPath,[program,root],{encoding:null,timeout:15000,maxBuffer:1024*1024,windowsHide:true,cwd:'C:/cinagroup/cinatoken'});
const endedAt=new Date().toISOString();
writeFileSync(join(root,'readonly-fallback.stdout.log'),result.stdout??Buffer.alloc(0),{flag:'wx'});
writeFileSync(join(root,'readonly-fallback.stderr.log'),result.stderr??Buffer.alloc(0),{flag:'wx'});
const receipt={schema:'actual-spawnSync-child-closed-v1',startedAt,endedAt,
command:[process.execPath,program,root],cwd:'C:/cinagroup/cinatoken',
actualExit:result.status,signal:result.signal??null,
spawnError:result.error?{code:result.error.code,message:result.error.message}:null,
timeoutConfiguredMs:15000,timedOutObserved:result.error?.code==='ETIMEDOUT',
sourceProgram:desc('readonly-fallback-source.mjs'),
stdout:desc('readonly-fallback.stdout.log'),stderr:desc('readonly-fallback.stderr.log'),
collectionOnly:true,browserLaunched:false,profileRead:false,noBusinessPassDerived:true};
writeFileSync(join(root,'readonly-fallback.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
if(result.status!==0||result.signal||result.error){console.log(JSON.stringify(receipt));process.exitCode=1;}else{
 const files=readdirSync(root).sort().map(path=>{if(!statSync(join(root,path)).isFile())throw Error('Unexpected owned directory');return desc(path);});
 const seal={schema:'owned-complete-root-STOPWRITE-seal-v1',frozenAt:new Date().toISOString(),root,files,
 completeFileCountExcludingSeal:files.length,actualReadonlyChildExit:0,
 priorNonterminatingCacheReaderErrorPreserved:true,browserLaunches:0,networkRequests:0,
 userChromeEdgeProfilesCookiesPasswordsRead:false,repoModified:false,STOPWRITE:true};
 writeFileSync(join(root,'STOPWRITE.json'),JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({root,receipt,FINAL:desc('FINAL-playwright-fallback-readonly.json'),seal:desc('STOPWRITE.json'),completeFiles:files.length+1,STOPWRITE:true}));
}


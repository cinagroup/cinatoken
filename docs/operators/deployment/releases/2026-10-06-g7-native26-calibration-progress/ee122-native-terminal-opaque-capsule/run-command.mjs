import fs from'node:fs';import path from'node:path';import crypto from'node:crypto';import{spawn}from'node:child_process';
const root=path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?:([A-Za-z]:))/, '$1');
const commands={python:'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',node:'C:/Program Files/nodejs/node.exe'};
const[label,command,...args]=process.argv.slice(2);
if(!/^[a-z0-9-]+$/.test(label??'')||!commands[command]||!args.length||path.resolve(path.dirname(args[0]))!==path.resolve(root))throw Error('Only owned scripts');
const stdoutFile=path.join(root,label+'.stdout.log'),stderrFile=path.join(root,label+'.stderr.log'),resultFile=path.join(root,label+'.result.json');
for(const f of[stdoutFile,stderrFile,resultFile])if(fs.existsSync(f))throw Error('Refusing overwrite');
const stdoutFd=fs.openSync(stdoutFile,'wx'),stderrFd=fs.openSync(stderrFile,'wx'),beganAt=new Date().toISOString();
let spawnError=null,timedOut=false;
const child=spawn(commands[command],args,{cwd:root,windowsHide:true,stdio:['ignore',stdoutFd,stderrFd]});
const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},180000);
child.on('error',error=>spawnError={name:error.name,code:error.code??null});
const descriptor=f=>{const b=fs.readFileSync(f);return{path:f.replaceAll('\\','/'),bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}};
child.on('close',(actualExit,signal)=>{
 clearTimeout(timer);fs.closeSync(stdoutFd);fs.closeSync(stderrFd);
 const result={schema:'cinatoken-owned-opaque-capsule-real-close-v1',closed:true,beganAt,endedAt:new Date().toISOString(),program:commands[command],args,cwd:root,
  actualExit,signal,spawnError,timedOut,stdout:descriptor(stdoutFile),stderr:descriptor(stderrFile),collectionOnly:true,applicationExecution:false,ciExecution:false,gatePassDerived:false};
 fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 if(label==='finalize'&&actualExit===0&&!signal&&!spawnError&&!timedOut){
  const sealPath=path.join(root,'CAPSULE-SEAL.json'),names=fs.readdirSync(root).sort();
  const entries=names.map(name=>{const file=path.join(root,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Unexpected owned entry');return{relative:name,...descriptor(file)}});
  const seal={schema:'cinatoken-ee122-opaque-capsule-seal-v1',frozenAt:new Date().toISOString(),collectionOnly:true,sourceRootRecursiveInclusion:false,
   entries,sealedFileCount:entries.length,selfExcluded:'CAPSULE-SEAL.json',producerClosedReceipt:'package.result.json',finalizerClosedReceipt:'finalize.result.json',ownerStopWrites:true};
  fs.writeFileSync(sealPath,JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({FINAL:descriptor(path.join(root,'FINAL-ee122-opaque-capsule.json')),seal:descriptor(sealPath),ZIP:descriptor(path.join(root,'ee122-frozen-root-lossless-opaque.zip')),sealedFiles:entries.length}));
 }
 console.log(JSON.stringify({receipt:descriptor(resultFile),closed:true,actualExit,signal,timedOut,collectionOnly:true}));
 process.exitCode=Number.isInteger(actualExit)&&!signal&&!spawnError&&!timedOut?actualExit:1;
});

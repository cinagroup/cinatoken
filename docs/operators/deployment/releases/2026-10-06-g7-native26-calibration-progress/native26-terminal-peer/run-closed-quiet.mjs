import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [out,name,executable,...args]=process.argv.slice(2);
const at=new Date().toISOString();
const r=spawnSync(executable,args,{cwd:'C:/cinagroup/cinatoken',encoding:null,maxBuffer:64*1024*1024,windowsHide:true});
const finishedAt=new Date().toISOString();
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
writeFileSync(join(out,name+'.stdout.log'),stdout,{flag:'wx'});
writeFileSync(join(out,name+'.stderr.log'),stderr,{flag:'wx'});
const receipt={schema:'cinatoken.native26-ci-independent-peer.command.v1',at,finishedAt,executable,args,cwd:'C:/cinagroup/cinatoken',actualExit:r.status,signal:r.signal??null,spawnError:r.error?String(r.error):null,stdout:join(out,name+'.stdout.log'),stderr:join(out,name+'.stderr.log'),stdoutInfo:info(stdout),stderrInfo:info(stderr)};
writeFileSync(join(out,name+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(receipt)+'\n');

process.stderr.write(stderr);
process.exitCode=r.status??1;
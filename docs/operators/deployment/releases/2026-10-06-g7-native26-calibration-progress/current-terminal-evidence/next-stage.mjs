import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const [mode]=process.argv.slice(2);assert.ok(['stage','audit'].includes(mode));
const native=JSON.parse(fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-native26-pg73-repair-908e0528cf5e44508d04e761c4540713/FINAL-native26-pg73-preparation.json'));
const direct=JSON.parse(fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-v364-direct-socket-prep-99dlWu/FINAL-v364-direct-socket-preparation.json'));
const md='docs/developers/architecture/web-frontend-migration.md',mdProof=JSON.parse(fs.readFileSync(path.join(out,'terminal-and-next-checklist-proof.json')));
const inputs=[...native.finalFiles.map(r=>({path:r.file,...r.after})),...direct.sources.map(r=>({path:r.relative,bytes:r.bytes,sha256:r.sha256})),{path:md,bytes:mdProof.bytes,sha256:mdProof.sha256}];assert.equal(inputs.length,34);
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const input of inputs){const b=fs.readFileSync(path.join(root,input.path));assert.equal(b.length,input.bytes);assert.equal(sha(b),input.sha256);}
const git=(...args)=>{const r=spawnSync('C:/Program Files/Git/cmd/git.exe',['-c','core.longpaths=true',...args],{cwd:root,encoding:null,windowsHide:true});assert.equal(r.status,0,r.stderr?.toString());return r.stdout;};
assert.equal(git('rev-parse','HEAD').toString().trim(),'473de5fc520fc7d64db700db88a76c7a6b45c241');
if(mode==='stage'){
 const startedAt=new Date().toISOString();const args=['-c','core.longpaths=true','add','--',...inputs.map(r=>r.path)];const r=spawnSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:root,windowsHide:true,encoding:null});
 const stdout=path.join(out,'next-stage-git.stdout.log'),stderr=path.join(out,'next-stage-git.stderr.log');fs.writeFileSync(stdout,r.stdout??Buffer.alloc(0),{flag:'wx'});fs.writeFileSync(stderr,r.stderr??Buffer.alloc(0),{flag:'wx'});fs.writeFileSync(path.join(out,'next-stage-git.result.json'),JSON.stringify({at:startedAt,finishedAt:new Date().toISOString(),executable:'C:/Program Files/Git/cmd/git.exe',args,cwd:root,actualExit:r.status,signal:r.signal,stdout,stderr},null,2)+'\n',{flag:'wx'});assert.equal(r.status,0,r.stderr?.toString());console.log(JSON.stringify({actualExit:0,stagedFiles:inputs.length}));
}else{
 assert.deepEqual(git('diff','--cached','--name-only','-z').toString().split('\0').filter(Boolean).sort(),inputs.map(r=>r.path).sort());
 for(const r of inputs){const clean=git('hash-object','--path='+r.path,r.path).toString().trim();assert.equal(git('rev-parse',':'+r.path).toString().trim(),clean);r.stagedBlob=clean;}
 for(const r of native.protection){const b=fs.readFileSync(path.join(root,r.file));assert.equal(b.length,r.bytes);assert.equal(sha(b),r.sha256);assert.equal(git('rev-parse','HEAD:'+r.file).toString().trim(),r.blob);}
 assert.equal(native.protection.length,302);assert.equal(git('diff','--check','--cached').length,0);
 const base=fs.readFileSync(path.join(out,'checklist-before.md'),'utf8'),current=fs.readFileSync(path.join(root,md),'utf8');for(const re of [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm])assert.deepEqual(current.match(re)??[],base.match(re)??[]);
 fs.writeFileSync(path.join(out,'next-stage-proof.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,inputs,protectedInputs:302,originalScopeAndStateLinesExact:true},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExit:0,stagedFiles:inputs.length,protectedInputs:302,originalScopeAndStateLinesExact:true}));
}

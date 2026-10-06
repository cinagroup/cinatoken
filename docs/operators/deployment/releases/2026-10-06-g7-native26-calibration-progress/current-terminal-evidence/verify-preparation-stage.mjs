import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const root='C:/cinagroup/cinatoken';
const git=(...args)=>{const r=spawnSync('C:/Program Files/Git/cmd/git.exe',['-c','core.longpaths=true',...args],{cwd:root,encoding:null,windowsHide:true});assert.equal(r.status,0, r.stderr?.toString());return r.stdout;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const native=JSON.parse(fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-native-four-repair-38a94fb93d9842929dc7ae9cf6b378da/FINAL-native-four-pg73-preparation.json'));
const g7=JSON.parse(fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-g7-observe-dependency-fix-02e2061ea37b4d18af99a3675ec1b7fc/FINAL-g7-observe-dependency-owner-review-v2.json'));
const md='docs/developers/architecture/web-frontend-migration.md';
const mdProof=JSON.parse(fs.readFileSync(path.join(out,'preparation-checklist-final-proof.json')));
const expected=[...native.files.map(r=>({path:r.file,...r.after})),...g7.finalFiles,{path:md,bytes:mdProof.bytes,sha256:mdProof.sha256}];
assert.equal(git('rev-parse','HEAD').toString().trim(),'702c4d71379acb697024ef846725871582bff94f');
assert.deepEqual(git('diff','--cached','--name-only','-z').toString().split('\0').filter(Boolean).sort(),expected.map(r=>r.path).sort());
const checked=[];
for(const input of expected){const b=fs.readFileSync(path.join(root,input.path));assert.equal(b.length,input.bytes);assert.equal(sha(b),input.sha256);const clean=git('hash-object','--path='+input.path,input.path).toString().trim();assert.equal(git('rev-parse',':'+input.path).toString().trim(),clean);checked.push({...input,stagedBlob:clean});}
const protectedInputs=[];
for(const input of native.protection){const b=fs.readFileSync(path.join(root,input.file));assert.equal(b.length,input.bytes);assert.equal(sha(b),input.sha256);assert.equal(git('rev-parse','HEAD:'+input.file).toString().trim(),input.blob);protectedInputs.push(input.file);}
const before=fs.readFileSync(path.join(out,'checklist-before.md'),'utf8'),after=fs.readFileSync(path.join(root,md),'utf8');
for(const re of [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm])assert.deepEqual(after.match(re)??[],before.match(re)??[]);
assert.equal(git('diff','--check','--cached').length,0);
const proof={at:new Date().toISOString(),actualExit:0,checked,protectedInputs,originalScopeAndStateLinesExact:true};fs.writeFileSync(path.join(out,'preparation-stage-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExit:0,stagedFiles:checked.length,protectedInputs:protectedInputs.length,originalScopeAndStateLinesExact:true}));

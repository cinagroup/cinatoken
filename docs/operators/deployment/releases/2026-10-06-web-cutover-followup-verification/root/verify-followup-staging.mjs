import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import zlib from 'node:zlib';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const workspace='C:/cinagroup/cinatoken',temp="C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4";
const git='C:/Program Files/Git/cmd/git.exe';
function gitBytes(args){const r=spawnSync(git,args,{cwd:workspace,windowsHide:true,maxBuffer:32_000_000});assert.equal(r.status,0,r.stderr.toString());return r.stdout;}
const names=gitBytes(['diff','--cached','--name-only','-z']).toString().split('\0').filter(Boolean);
const folder='docs/operators/deployment/releases/2026-10-06-web-cutover-followup/';
const reportPath='docs/operators/deployment/releases/2026-10-06-web-cutover-followup.json';
const docs=['.gitattributes','docs/developers/architecture/web-frontend-migration.md','docs/operators/deployment/cloudflare-web.md'];
assert.ok(names.every(n=>docs.includes(n)||n===reportPath||n.startsWith(folder)));
const hashes=[];
for(const n of names){const staged=gitBytes(['show',':'+n]),disk=fs.readFileSync(path.join(workspace,n));if(docs.includes(n)||n===reportPath)assert.equal(staged.toString().replace(/\r\n/g,'\n'),disk.toString().replace(/\r\n/g,'\n'));else assert.deepEqual(staged,disk);hashes.push({path:n,stagedBytes:staged.length,stagedSHA256:crypto.createHash('sha256').update(staged).digest('hex')});}
const report=JSON.parse(gitBytes(['show',':'+reportPath]));for(const e of report.immutableEvidence.index){const b=gitBytes(['show',':'+folder+e.storedPath]);assert.equal(b.length,e.stored.bytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),e.stored.sha256);const raw=e.encoding==='gzip-lossless'?zlib.gunzipSync(b):b;assert.equal(raw.length,e.original.bytes);assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),e.original.sha256);}
const scope=JSON.parse(fs.readFileSync(temp+'/checklist-final-scope.json'));const current=fs.readFileSync(workspace+'/'+docs[1]);assert.equal(crypto.createHash('sha256').update(current).digest('hex'),scope.current.sha256);
const result={at:new Date().toISOString(),actualExit:0,stagedFileCount:names.length,allStagedEvidenceExact:true,allOriginalRoundTripsExact:true,scopeStatesStillExact:true,productionChanged:false,hashes};fs.writeFileSync(temp+'/followup-staged-verification.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,hashes:undefined}));

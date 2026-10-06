import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo='C:/cinagroup/cinatoken';
const dir='scripts/diagnostics/v364-direct-socket';
const prepared=path.join(here,'package-candidate-v2-lf');
const retention='scripts/db/cutover/postgres-shared-key-buyer-receipt-retention-v346.native.test.mjs';
const retentionCandidate='C:/Users/cina/AppData/Local/Temp/cinatoken-retention-v346-time-text-candidate-1a110046edafc3b0b4778a3a/candidate-retention-time-text.native.test.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const oldSeal=JSON.parse(fs.readFileSync(path.join(repo,dir,'sealed-package.json')));
for(const item of oldSeal.files){const b=fs.readFileSync(path.join(repo,dir,item.path));assert.equal(b.length,item.bytes);assert.equal(sha(b),item.sha256);}
assert.equal(sha(fs.readFileSync(path.join(repo,dir,'run-direct-socket.mjs'))),'621cb7384b32a25af7c37d411cd12c2d51bf47c241d9d1f24c1c3ee3989723f3');
assert.equal(sha(fs.readFileSync(path.join(repo,retention))),'c9093cb5c5f167f8e7604b9b91c4d937c8b638a8b0cd1f2dbcdeb88a140dc984');
assert.equal(sha(fs.readFileSync(retentionCandidate)),'12c37aa3f7151ccab6b39b98fe720661a95695351806c0c802454d8b22c560e6');
assert.equal(fs.existsSync(path.join(repo,dir,'queued-write-source.mjs')),false);
const seal=JSON.parse(fs.readFileSync(path.join(prepared,'sealed-package.json')));
assert.equal(sha(fs.readFileSync(path.join(prepared,'sealed-package.json'))),'69cfacc9b02d66531a0624cdf980fb39a4f998745949970c2962b4691bfc17a5');
assert.deepEqual(seal.workflow,oldSeal.workflow);
for(const name of ['native-reader-calibration.mjs','execute-owned-linux.py','source-inputs.json'])assert.deepEqual(seal.files.find(v=>v.path===name),oldSeal.files.find(v=>v.path===name));
const before=path.join(here,'sources-before');fs.mkdirSync(before);
const changes=[];
for(const name of ['run-direct-socket.mjs','queued-write-source.mjs','README.md','sealed-package.json']) {
 const relative=dir+'/'+name;const destination=path.join(repo,relative),b=fs.readFileSync(path.join(prepared,name));
 if(fs.existsSync(destination))fs.copyFileSync(destination,path.join(before,name),fs.constants.COPYFILE_EXCL);
 changes.push({path:relative,bytes:b.length,sha256:sha(b)});
}
fs.copyFileSync(path.join(repo,retention),path.join(before,'retention.before.native.test.mjs'),fs.constants.COPYFILE_EXCL);
for(const name of ['run-direct-socket.mjs','queued-write-source.mjs','README.md','sealed-package.json'])fs.copyFileSync(path.join(prepared,name),path.join(repo,dir,name));
fs.copyFileSync(retentionCandidate,path.join(repo,retention));
const b=fs.readFileSync(path.join(repo,retention));changes.push({path:retention,bytes:b.length,sha256:sha(b)});
for(const item of seal.files){const bytes=fs.readFileSync(path.join(repo,dir,item.path));assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256);}
for(const item of changes){const bytes=fs.readFileSync(path.join(repo,item.path));assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256);}
const workflowBytes=fs.readFileSync(path.join(repo,seal.workflow.path));assert.equal(workflowBytes.length,seal.workflow.bytes);assert.equal(sha(workflowBytes),seal.workflow.sha256);
fs.writeFileSync(path.join(here,'applied-source-pins.json'),JSON.stringify({applied:true,nativeExecuted:false,productionChanged:false,changes},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({applied:true,nativeExecuted:false,productionChanged:false,files:changes,unchangedExecutorAndCalibration:true}));

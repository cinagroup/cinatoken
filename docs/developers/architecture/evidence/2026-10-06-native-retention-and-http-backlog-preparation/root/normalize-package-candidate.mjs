import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const from=path.join(here,'package-candidate');
const to=path.join(here,'package-candidate-lf');
fs.mkdirSync(to);
const sha=b=>createHash('sha256').update(b).digest('hex');
const seal=JSON.parse(fs.readFileSync(path.join(from,'sealed-package.json')));
for(const name of ['run-direct-socket.mjs','queued-write-source.mjs','README.md']) {
 const original=fs.readFileSync(path.join(from,name));
 const normalized=Buffer.from(original.toString('utf8').replaceAll('\r\n','\n'));
 if(name!=='README.md')assert.deepEqual(normalized,original);
 fs.writeFileSync(path.join(to,name),normalized,{flag:'wx'});
 const item=seal.files.find(v=>v.path===name);assert.ok(item);item.bytes=normalized.length;item.sha256=sha(normalized);
}
fs.writeFileSync(path.join(to,'sealed-package.json'),JSON.stringify(seal,null,'\t')+'\n',{flag:'wx'});
console.log(JSON.stringify({preparedOnly:true,repoWrites:0,output:to,files:fs.readdirSync(to).map(name=>{const b=fs.readFileSync(path.join(to,name));assert.equal(b.includes(13),false);return {name,bytes:b.length,sha256:sha(b)};}),runtimeExecuted:false,firstMixedEOLCandidateRetained:true}));

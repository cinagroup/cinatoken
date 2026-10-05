import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const root='C:/cinagroup/cinatoken',temp='C:/Users/cina/AppData/Local/Temp/cinatoken-web-retention-40bda77a453343d89d5fe50706d58326';
const ids=['3847955ccdb4c670f0f9aa099ef976889357e6b2','c13a64b9c3b2c90adcf736910ea408868d7854f1'];
const release=id=>JSON.parse(fs.readFileSync(root+'/.release/web/'+id+'/manifest.json','utf8'));
const [old,current]=ids.map(release);
const compare=(before,after)=>{const map=new Map(before.map(f=>[f.path,f]));return after.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256,previous:map.has(f.path)?{bytes:map.get(f.path).bytes,sha256:map.get(f.path).sha256}:null,same:map.get(f.path)?.bytes===f.bytes&&map.get(f.path)?.sha256===f.sha256}));};
const a=compare(old.files,current.files),s=compare(old.serverFiles,current.serverFiles);
const proof={schema:'cinatoken-web-retention-runtime-comparison-v1',at:new Date().toISOString(),readOnly:true,previousSourceCommit:ids[0],currentSourceCommit:ids[1],assets:a,server:s,identicalHashedAssets:a.filter(f=>/^static\//.test(f.path)&&f.same).length,changedHashedAssets:a.filter(f=>/^static\//.test(f.path)&&!f.same),changedServer:s.filter(f=>!f.same),actualExit:0};
assert.equal(proof.changedHashedAssets.length,0);
for(const f of [...a.filter(f=>/^static\//.test(f.path)),...s])for(const id of ids){const kind=a.includes(f)?'assets':'server';const b=fs.readFileSync(root+'/.release/web/'+id+'/'+kind+'/'+f.path);const descriptor=id===ids[1]?f:f.previous;assert.equal(b.length,descriptor.bytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),descriptor.sha256);}
fs.writeFileSync(temp+'/runtime-comparison.proof.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({identicalHashedAssets:proof.identicalHashedAssets,changedHashedAssets:proof.changedHashedAssets,changedServer:proof.changedServer,actualExit:0}));

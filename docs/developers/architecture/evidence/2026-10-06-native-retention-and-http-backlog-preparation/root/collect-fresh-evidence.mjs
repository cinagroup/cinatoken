import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
const config=JSON.parse(fs.readFileSync(process.argv[2]));
const sha=b=>createHash('sha256').update(b).digest('hex');
const target=path.resolve(config.target);
assert.equal(fs.existsSync(target),false);
fs.mkdirSync(target,{recursive:true});
const entries=[];
const groups=[];
function copy(group,root,relative,pin) {
 assert.equal(path.isAbsolute(relative),false);assert.equal(relative.split(/[\\/]/).includes('..'),false);
 const source=path.join(root,relative);const raw=fs.readFileSync(source);
 if(pin){assert.equal(raw.length,pin.bytes);assert.equal(sha(raw),pin.sha256);}
 const compress=raw.length>131072 && (/\.(?:log|md)$/i.test(relative));
 const stored=compress?gzipSync(raw,{level:9,mtime:0}):raw;
 const storedRelative=[group,relative.replaceAll('\\','/')+(compress?'.gz':'')].join('/');
 const destination=path.join(target,storedRelative);
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,stored,{flag:'wx'});
 assert.deepEqual(compress?gunzipSync(fs.readFileSync(destination)):fs.readFileSync(destination),raw);
 entries.push({group,source,sourceRelative:relative.replaceAll('\\','/'),storedRelative,rawBytes:raw.length,rawSha256:sha(raw),compression:compress?'gzip':null,storedBytes:stored.length,storedSha256:sha(stored)});
}
for(const g of config.sealedGroups) {
 const root=path.resolve(g.root),sealPath=path.join(root,g.seal);
 const sealBytes=fs.readFileSync(sealPath),seal=JSON.parse(sealBytes);
 const pins=g.pinArray==='entries'?seal.entries:seal.files;
 assert.ok(Array.isArray(pins));
 const normalized=pins.map(p=>({relative:p.relative??p.name??p.file??p.relativePath??path.relative(root,p.path),bytes:p.bytes,sha256:p.sha256}));
 const names=new Set(normalized.map(v=>v.relative));assert.equal(names.size,normalized.length);
 for(const p of normalized) copy(g.name,root,p.relative,p);
 assert.equal(names.has(g.seal),false);copy(g.name,root,g.seal,{bytes:sealBytes.length,sha256:sha(sealBytes)});
 groups.push({name:g.name,sourceRoot:root,sourceSeal:g.seal,sealBytes:sealBytes.length,sealSha256:sha(sealBytes),copiedFiles:normalized.length+1});
}
for(const g of config.explicitGroups) {
 for(const name of g.files)copy(g.name,g.root,name);
 groups.push({name:g.name,sourceRoot:g.root,explicitSubset:true,copiedFiles:g.files.length});
}
const index={schema:'cinatoken-native-retention-http-backlog-direct-evidence-v1',at:new Date().toISOString(),ciSourceCommit:'6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa',nextSourcePreparedOnly:true,nextSourceRuntimeExecuted:false,productionCommit:'c13a64b9c3b2c90adcf736910ea408868d7854f1',collectionOnly:true,gatePassDerived:false,liveRootCauseConfirmed:false,fullG7:false,fullG8:false,groups,files:entries.length,rawBytes:entries.reduce((s,v)=>s+v.rawBytes,0),storedBytes:entries.reduce((s,v)=>s+v.storedBytes,0),entries};
fs.writeFileSync(path.join(target,'collection.json'),JSON.stringify(index,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(target,'README.md'),config.readme+'\n',{flag:'wx'});
console.log(JSON.stringify({collectionOnly:true,gatePassDerived:false,target,files:entries.length+2,rawBytes:index.rawBytes,storedBytes:index.storedBytes,indexSha256:sha(fs.readFileSync(path.join(target,'collection.json')))}));

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-d537-terminal-packet-peer-Fvm9uF';
const digest=b=>createHash('sha256').update(b).digest('hex');
for(const name of ['original-terminal-audit.closed.json','final-packet-audit.closed.json']){const j=JSON.parse(fs.readFileSync(path.join(root,name)));assert.equal(j.actualExit,0);assert.equal(j.signal,null);assert.equal(j.spawnError,null);}
const entries=fs.readdirSync(root).sort().map(file=>{const p=path.join(root,file),s=fs.lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink());const b=fs.readFileSync(p);return {file,bytes:b.length,sha256:digest(b)}});
const seal={schema:'native-quote-terminal-packet-peer-stopwrite-v1',sealedAt:new Date().toISOString(),sourceRoot:root,filesBeforeSelf:entries.length,totalBytesBeforeSelf:entries.reduce((n,e)=>n+e.bytes,0),entries,selfExcludedOnly:true,STOPWRITE:true,noFurtherWrites:true,collectionOnly:true,gatePassDerived:false,rootCauseConfirmed:false,nativeExecutedHere:false,ciRequestsHere:0,productionRequestsHere:0,sealDataOperationNotChildReceipt:true};
const file=path.join(root,'STOPWRITE-peer-seal.json');fs.writeFileSync(file,JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
const final=fs.readFileSync(path.join(root,'FINAL-native-quote-terminal-packet-readonly-peer.json')),b=fs.readFileSync(file);
console.log(JSON.stringify({root,filesIncludingSelf:entries.length+1,FINAL:{bytes:final.length,sha256:digest(final)},seal:{bytes:b.length,sha256:digest(b)},STOPWRITE:true}));

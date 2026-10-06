import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out,info} from './capture.mjs';
const closed=await command('close-audit',process.execPath,[join(out,'close-audit.mjs')]);success(closed);
const names=(await readdir(out)).sort();assert.ok(!names.includes('TERMINAL-STOPWRITE-SEAL.json'));
const entries=[];
for(const name of names){const path=join(out,name),s=await stat(path);assert.ok(s.isFile());entries.push({path,name,...info(await readFile(path)),mtimeMs:s.mtimeMs});}
for(const e of entries){const s=await stat(e.path);assert.equal(s.mtimeMs,e.mtimeMs);assert.deepEqual(info(await readFile(e.path)),{bytes:e.bytes,sha256:e.sha256});}
const receipts=[];
for(const e of entries.filter(e=>e.name.endsWith('.closed.json'))){const r=JSON.parse(await readFile(e.path,'utf8'));receipts.push({name:e.name,actualExit:r.actualExit,signal:r.signal,spawnError:r.spawnError??null});}
const audit=JSON.parse(await readFile(join(out,'CLOSED-byte-and-semantic-audit.json'),'utf8'));
const seal={schema:'cinatoken-d537-ci-terminal-stopwrite-seal-v1',at:new Date().toISOString(),root:out,
 sourceSha:'d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a',collectionOnly:true,rootCauseConfirmed:false,repositoryWrites:0,ciActions:0,
 sourceCollectionAndSecondReadAllExact:true,files:entries.length,totalBytes:entries.reduce((n,e)=>n+e.bytes,0),entries,
 actualClosedAudit:closed.receipt,actualCloses:receipts.length,zero:receipts.filter(r=>r.actualExit===0).length,
 nonzero:receipts.filter(r=>r.actualExit!==0),null:receipts.filter(r=>r.actualExit===null),
 originalFullLogs:{native:audit.failureObservations[0].rawSHA,dispatch:audit.failureObservations[1].rawSHA},
 final:audit.final,afterClose:true,selfExcluded:'TERMINAL-STOPWRITE-SEAL.json',stopWrite:true,
 truthBoundary:'This seal verifies captured file bytes and read-only collection. Original native and dispatch failures remain failures. No source/CI/application/database operation was rerun.'};
const sealPath=join(out,'TERMINAL-STOPWRITE-SEAL.json');await writeFile(sealPath,JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({STOPWRITE:true,root:out,filesBeforeSeal:entries.length,actualCloses:seal.actualCloses,zero:seal.zero,nonzero:seal.nonzero,null:seal.null,final:seal.final,seal:{path:sealPath,...info(await readFile(sealPath))}}));

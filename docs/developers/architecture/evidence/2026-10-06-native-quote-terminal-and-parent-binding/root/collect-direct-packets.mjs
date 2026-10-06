import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const [configPath]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const repo='C:/cinagroup/cinatoken',out=path.resolve(repo,config.relativeOut);
assert(config.relativeOut.startsWith('docs/developers/architecture/evidence/'));
assert(out.startsWith(path.resolve(repo,'docs/developers/architecture/evidence')+path.sep));
assert(!fs.existsSync(out));
const digest=b=>createHash('sha256').update(b).digest('hex');
const describe=p=>{const b=fs.readFileSync(p);return {bytes:b.length,sha256:digest(b)};};
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);assert(!e.isSymbolicLink());return e.isDirectory()?walk(p):e.isFile()?[p]:(assert.fail('Nonregular '+p),[]);}).sort();
for(const pin of config.requiredPins)assert.deepEqual(describe(pin.path),{bytes:pin.bytes,sha256:pin.sha256});
const plan=[];
for(const entry of config.roots){assert(/^[a-z0-9-]+$/.test(entry.label));for(const p of walk(entry.path))plan.push({label:entry.label,source:p,relative:entry.label+'/'+path.relative(entry.path,p).replaceAll('\\','/'),...describe(p)});}
for(const p of config.rootFiles){assert.equal(path.dirname(path.resolve(p)),path.resolve(root));plan.push({label:'root',source:p,relative:'root/'+path.basename(p),...describe(p)});}
assert.equal(new Set(plan.map(e=>e.relative)).size,plan.length);
const storedSet=new Set(),entries=[];
for(const e of plan){const raw=fs.readFileSync(e.source);assert.equal(raw.length,e.bytes);assert.equal(digest(raw),e.sha256);const gzip=raw.length>131072&&/\.(?:log|cc|h)$/.test(e.relative);const storedRelative=e.relative+(gzip?'.gz':'');assert(!storedSet.has(storedRelative));storedSet.add(storedRelative);const stored=gzip?gzipSync(raw,{level:9}):raw;const p=path.join(out,storedRelative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,stored,{flag:'wx'});const reread=fs.readFileSync(p);assert.deepEqual(gzip?gunzipSync(reread):reread,raw);assert.deepEqual(describe(e.source),{bytes:e.bytes,sha256:e.sha256});entries.push({...e,storedRelative,gzip,stored:{bytes:reread.length,sha256:digest(reread)}});}
const report={schema:'cinatoken-d537-direct-terminal-evidence.collection.v1',at:new Date().toISOString(),sourceCommit:'d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a',ciSourceCommit:'d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a',parentRepair:{preparedOnly:true,ciExecuted:false,sourceCommit:null,beforeSha256:'8b6aae0e4250604a60446f3d02ae0c3683416c26a7d01de58cc26cd66bba7f18',afterSha256:'7acb429e3c22ce959daa9e925f7d460ea30902eb077f09f39caa949cc8220f7a'},productionSource:'c13a64b9c3b2c90adcf736910ea408868d7854f1',productionVersion:'2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9',collectionOnly:true,gatePassDerived:false,rootCauseConfirmed:false,quoteTimingRootCauseConfirmed:false,httpCancelRootCauseConfirmed:false,fullG7:false,fullG8:false,sourceFileCount:entries.length,rawBytes:entries.reduce((n,e)=>n+e.bytes,0),storedBytes:entries.reduce((n,e)=>n+e.stored.bytes,0),rootFilesAreExplicitSubset:true,oldArchivesCopied:false,derivedCiSlicesCreated:false,entries};
fs.writeFileSync(path.join(out,'collection.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'README.md'),config.readme,{flag:'wx'});
const proof={out,sourceFileCount:report.sourceFileCount,rawBytes:report.rawBytes,storedBytes:report.storedBytes,collection:describe(path.join(out,'collection.json')),collectionOnly:true,gatePassDerived:false};
fs.writeFileSync(path.join(root,'terminal-collection-summary.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(proof));

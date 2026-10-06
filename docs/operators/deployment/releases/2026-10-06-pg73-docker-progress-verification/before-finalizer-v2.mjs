import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const meta='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-durable-meta-e44792174d9f42358287aa571b1ba35e';
const workspace='C:/cinagroup/cinatoken';
const slug='2026-10-06-pg73-docker-progress';
const source='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-docker-evidence-stage-39f9d554-203b-4685-8f45-59f5de0da974/'+slug+'.json';
const base='docs/operators/deployment/releases/';
const destination=workspace+'/'+base+slug+'.json';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b,{flag:'wx'});assert.deepEqual(fs.readFileSync(p),b);};
const copy=(s,d)=>{assert.ok(fs.lstatSync(s).isFile()&&!fs.lstatSync(s).isSymbolicLink());const b=fs.readFileSync(s);write(d,b);return {source:s,file:d,bytes:b.length,sha256:hash(b)};};
const reportBytes=fs.readFileSync(source);
assert.equal(reportBytes.length,951099);assert.equal(hash(reportBytes),'a59328455ed71b0be08d8c4d22e81a0db21c94cad3dc179bad893a6fd03e0ced');
const report=JSON.parse(reportBytes);
assert.equal(report.sourceCommit,'fc17551b3016d3533c17cc4ec9b0151a4eedae44');
assert.equal(report.entries.length,739);assert.equal(report.exclusions.length,0);assert.equal(report.gatePassDerived,false);
const mode=process.argv[2];
if(mode==='copy'){
 const attrs=workspace+'/.gitattributes',before=fs.readFileSync(attrs);write(meta+'/gitattributes-before',before);
 assert.equal(hash(before),'70b64e4c49da4826b8462828527da43d2284bb4bf8abb8646f577c909a1e389d');
 const additions=[base+slug+'/** -text',base+slug+'-verification/** -text'];
 assert.ok(additions.every(x=>!before.toString().includes(x)));
 fs.writeFileSync(attrs,Buffer.concat([before,Buffer.from(additions.join('\n')+'\n')]));
 copy(source,destination);
 for(const item of report.entries){const b=fs.readFileSync(path.join(path.dirname(source),slug,item.storedRelative));assert.equal(b.length,item.storedBytes);assert.equal(hash(b),item.storedSha256);write(path.join(workspace,base,slug,item.storedRelative),b);}
 const receipt={at:new Date().toISOString(),closed:true,actualExitCode:0,copiedFiles:740,reportBytes:reportBytes.length,reportSha256:hash(reportBytes),storedBytes:report.totals.storedBytes,originalSourceEvidenceNotModified:true,gatePassDerived:false,attributesBeforeSha256:hash(before),attributesAfterSha256:hash(fs.readFileSync(attrs))};
 write(meta+'/repository-copy-proof.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}else if(mode==='archive'){
 const names=['run-command.mjs','finalize-durable-evidence.mjs','gitattributes-before','root-final-audit.json','source-verification.json','repository-verification.json','repository-copy-proof.json'];
 for(const label of ['evidence-final-audit','evidence-collect','evidence-source-verify','evidence-repository-copy','evidence-repository-verify']){for(const ext of ['stdout.log','stderr.log','result.json'])names.push(label+'.'+ext);}
 for(const name of names.filter(n=>n.endsWith('.result.json'))){const r=JSON.parse(fs.readFileSync(meta+'/'+name));assert.equal(r.actualExit,0);assert.ok(r.finishedAt);assert.equal(r.signal,null);}
 const proofs=names.map(name=>copy(meta+'/'+name,workspace+'/'+base+slug+'-verification/'+name));
 const peerAudit='C:/Users/cina/AppData/Local/Temp/cinatoken-durable-final-audit-Saph0u/';
 for(const name of ['final-all-roots-audit.json','final-all-roots-audit.stdout.log','final-all-roots-audit.stderr.log','final-all-roots-audit.result.json'])proofs.push(copy(peerAudit+name,workspace+'/'+base+slug+'-verification/producer-final-audit/'+name));
 const verification={at:new Date().toISOString(),closed:true,actualExitCode:0,collectionOnly:true,gatePassDerived:false,mainReport:base+slug+'.json',mainReportBytes:reportBytes.length,mainReportSha256:hash(reportBytes),filesVerified:739,rawBytes:report.totals.originalBytes,storedBytes:report.totals.storedBytes,sourceByteComparisonPassed:true,repositoryByteComparisonPassed:true,sourceCommit:report.sourceCommit,platformSourceCommit:report.semantics.platformSourceCommit,diagnosticSourceCommit:report.semantics.diagnosticSourceCommit,productionSourceCommit:report.semantics.currentProduction.sourceCommit,productionVersion:report.semantics.currentProduction.webVersion,checklist:report.semantics.mainChecklist,preparationFieldsDescribeTheirOriginalPreCollectionPhase:true,fullProductGatesRemainPending:true,metadata:proofs.map(p=>({...p,file:p.file.slice(workspace.length+1)}))};
 write(workspace+'/'+base+slug+'-verification.json',JSON.stringify(verification,null,2)+'\n');
 write(meta+'/repository-archive-proof.json',JSON.stringify({at:new Date().toISOString(),closed:true,actualExitCode:0,files:proofs.length+1,gatePassDerived:false},null,2)+'\n');console.log(JSON.stringify({metadataFiles:proofs.length,gatePassDerived:false}));
}else if(mode==='stage-proof'){
 const enumerate=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert.ok(!e.isSymbolicLink());const p=path.join(dir,e.name);return e.isDirectory()?enumerate(p):[p.slice(workspace.length+1).replaceAll('\\','/')];});
 const expected=['.gitattributes','docs/developers/architecture/web-frontend-migration.md',base+slug+'.json',base+slug+'-verification.json',...enumerate(workspace+'/'+base+slug),...enumerate(workspace+'/'+base+slug+'-verification')].sort();
 const git='C:/Program Files/Git/cmd/git.exe';
 const list=spawnSync(git,['diff','--cached','--name-only','-z'],{cwd:workspace,windowsHide:true,maxBuffer:8*1024*1024});
 assert.equal(list.status,0);const actual=list.stdout.toString('utf8').split('\0').filter(Boolean).sort();assert.deepEqual(actual,expected);
 const blobs=spawnSync(git,['cat-file','--batch'],{cwd:workspace,windowsHide:true,input:expected.map(p=>':'+p+'\n').join(''),maxBuffer:64*1024*1024});assert.equal(blobs.status,0);
 let cursor=0;const records=[];
 for(const file of expected){const end=blobs.stdout.indexOf(10,cursor);assert.ok(end>cursor);const header=blobs.stdout.subarray(cursor,end).toString('utf8').split(' ');assert.equal(header[1],'blob');const n=Number(header[2]);assert.ok(Number.isSafeInteger(n));const b=blobs.stdout.subarray(end+1,end+1+n);const current=fs.readFileSync(workspace+'/'+file);assert.deepEqual(b,current,file+' staged bytes changed');assert.equal(blobs.stdout[end+1+n],10);cursor=end+1+n+1;records.push({file,bytes:n,sha256:hash(b),gitBlob:header[0]});}
 assert.equal(cursor,blobs.stdout.length);
 const md=records.find(x=>x.file==='docs/developers/architecture/web-frontend-migration.md');assert.equal(md.bytes,776589);assert.equal(md.sha256,'7eec7bbefeef52ca19a5113526c8c441af681c426afc5659292bec83406ec404');
 const receipt={at:new Date().toISOString(),closed:true,actualExitCode:0,allStagedFilesExact:true,exactStagedSet:true,files:records.length,records,gitCatFileActualExit:blobs.status,gatePassDerived:false};
 write(meta+'/staged-bytes-proof.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({files:records.length,allStagedFilesExact:true,exactStagedSet:true,gatePassDerived:false}));
}else throw new Error('mode must be copy, archive, stage-proof');

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root='C:/cinagroup/cinatoken';
const own=path.dirname(fileURLToPath(import.meta.url));
const [archiveDir,candidatePath,metadataPath,receiptPath,galleryDir]=process.argv.slice(2);
assert(archiveDir&&candidatePath&&metadataPath&&receiptPath&&galleryDir);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=f=>fs.readFileSync(f);
const json=f=>JSON.parse(read(f));
const doc=path.join(root,'docs/developers/architecture/web-frontend-migration.md');
const expectedBaseline='63ce789bc24f546c873440d2b6fa68eea109b3cabe6a6457b1429efa79fe99a0';
assert.equal(digest(read(doc)),expectedBaseline,'Do not overwrite a changed checklist');
const target=path.resolve(root,'docs/developers/architecture/evidence/2026-10-07-private-preferences-and-route-recovery');
assert(target.startsWith(path.resolve(root)+path.sep)&&!fs.existsSync(target));
const index=json(path.join(archiveDir,'index.json'));
const recipe=json(path.join(archiveDir,'archive-input-plan.json'));
const verification=json(path.join(archiveDir,'archive-verification.json'));
assert.equal(recipe.status,'READY_FOR_ARCHIVE');assert.deepEqual(recipe.pending,[]);
assert.equal(index.verification.allOriginalBytesEqualDecodedZip,true);
assert.equal(index.verification.allOriginalMtimeUnchanged,true);
assert.equal(index.verification.allPriorProofBytesMtimeUnchanged,true);assert.equal(index.verification.crcErrors,0);
assert.equal(index.bundle.path,'raw-evidence.zip');assert(index.bundle.bytes<100*1024*1024,'Keep single Git blob below GitHub hard limit');
const archive=read(path.join(archiveDir,index.bundle.path));assert.equal(archive.length,index.bundle.bytes);assert.equal(digest(archive),index.bundle.sha256);
const archiveReceipt=json(receiptPath);assert.equal(archiveReceipt.actualExitCode,0);assert.equal(archiveReceipt.signal,null);assert(!archiveReceipt.spawnError&&archiveReceipt.closedAt);
assert.equal(verification.output.replaceAll('\\','/'),path.resolve(archiveDir).replaceAll('\\','/'));
const meta=json(metadataPath);assert.equal(meta.status,'ACTUAL_PUBLISHED_METADATA');assert.equal(meta.sourceCommit,'3494dca3fd14f8433ede2679fcb54916256a9113');
assert.equal(meta.versionId,'c5314d77-ba0d-4f7e-9b38-f8241e2d4424');assert.equal(meta.deploymentId,'c7c90b4c-aa1e-4fbc-a0f5-0a988423a1a4');assert.equal(meta.trafficPercent,100);
const candidate=read(candidatePath);const text=candidate.toString('utf8');
assert(text.includes(meta.introductionLine)&&text.includes(meta.publicationLine)&&text.includes('### 5.96 '));
assert.deepEqual(text.match(/[^\n]*\[[ xX]\][^\n]*(?:\n|$)/gu),read(doc).toString('utf8').match(/[^\n]*\[[ xX]\][^\n]*(?:\n|$)/gu));
assert.equal(index.finalSources.length,11);
for(const row of index.finalSources){const b=read(path.join(root,row.relative));assert.equal(b.length,row.bytes);assert.equal(digest(b),row.sha256);}
const selected=[];
function select(from,relative){const abs=path.resolve(from);const stat=fs.lstatSync(abs);assert(stat.isFile()&&!stat.isSymbolicLink());const b=read(abs);selected.push({from:abs,relative,bytes:b.length,sha256:digest(b),data:b});}
for(const name of fs.readdirSync(archiveDir)){assert(!name.includes('/')&&!name.includes('\\'));select(path.join(archiveDir,name),name);}
select(metadataPath,'actual-publication-metadata.json');
select(receiptPath,'archive-process-closed.json');
for(const stream of ['stdout','stderr']){const binding=archiveReceipt[stream]??archiveReceipt.streams?.[stream];assert(binding?.path);const b=read(binding.path);assert.equal(b.length,binding.bytes);assert.equal(digest(b),binding.sha256);select(binding.path,'archive.'+stream+'.log');}
for(const name of fs.readdirSync(galleryDir)){assert(!name.includes('/')&&!name.includes('\\'));select(path.join(galleryDir,name),'gallery/'+name);}
assert.equal(new Set(selected.map(x=>x.relative)).size,selected.length);
fs.mkdirSync(target,{recursive:true});
for(const item of selected){const out=path.resolve(target,item.relative);assert(out.startsWith(target+path.sep));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,item.data,{flag:'wx'});const b=read(out);assert.equal(b.length,item.bytes);assert.equal(digest(b),item.sha256);}
assert.equal(digest(read(doc)),expectedBaseline,'Main checklist changed during evidence copy');
fs.writeFileSync(doc,candidate);assert.deepEqual(read(doc),candidate);
const result={at:new Date().toISOString(),installedChecklist:{path:doc,bytes:candidate.length,sha256:digest(candidate)},sourceCommit:meta.sourceCommit,publication:{versionId:meta.versionId,deploymentId:meta.deploymentId,trafficPercent:100},baselineSha256:expectedBaseline,target,files:selected.map(({data,...row})=>row),archiveReceipt:{path:receiptPath,actualExitCode:0,closedAt:archiveReceipt.closedAt},limits:['Installation and original-byte copy only; independent final scope/publication/link review and Git publication still required','No browser, login, Cloudflare mutation or product acceptance performed by this installer']};
fs.writeFileSync(path.join(own,'installed-final-evidence-596.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({installed:doc,bytes:candidate.length,sha256:digest(candidate),evidenceFiles:selected.length,archiveBytes:archive.length})+'\n');

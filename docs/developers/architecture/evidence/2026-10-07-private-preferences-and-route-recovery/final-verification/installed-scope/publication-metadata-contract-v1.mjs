import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const proof=file=>{const bytes=fs.readFileSync(file);return {path:path.resolve(file),bytes:bytes.length,sha256:hash(bytes)};};
export function publicationContract(metadataPath,baselineBytes){
 const meta=JSON.parse(fs.readFileSync(metadataPath));
 assert.equal(meta.status,'ACTUAL_PUBLISHED_METADATA');
 assert.equal(meta.date,'2026-10-07');assert.equal(meta.sourceCommit,'3494dca3fd14f8433ede2679fcb54916256a9113');assert.equal(meta.trafficPercent,100);
 for(const field of ['versionId','deploymentId'])assert.match(meta[field]??'',/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
 const lines=baselineBytes.toString('utf8').split('\n'),unique=prefix=>{const found=lines.filter(x=>x.startsWith(prefix));assert.equal(found.length,1);return found[0];};
 const oldIntroduction=unique('**可行性结论：可行。**'),oldDate=unique('最近更新：2026-10-06。'),oldPublication=unique('当前发布（2026-10-06）：');
 for(const field of ['introductionLine','publicationLine'])assert(typeof meta[field]==='string'&&meta[field]&&!/[\r\n]/u.test(meta[field]));
 assert(meta.introductionLine.startsWith('**可行性结论：可行。**'));
 assert(meta.publicationLine.startsWith('当前发布（2026-10-07）：'));
 for(const value of [meta.sourceCommit,meta.versionId,meta.deploymentId,'100%'])assert(meta.publicationLine.includes(value),'Publication requires actual '+value);
 const newDate=oldDate.replace('最近更新：2026-10-06。','最近更新：2026-10-07。');
 assert(Array.isArray(meta.actualEvidence)&&meta.actualEvidence.length>=3);
 const roles=new Set();
 const evidence=meta.actualEvidence.map(item=>{
   assert(item.role&&!roles.has(item.role));roles.add(item.role);const p=proof(item.path);
   assert.equal(p.bytes,item.bytes);assert.equal(p.sha256,item.sha256);
   if(item.expectedActualExitCode!==undefined){assert.equal(item.expectedActualExitCode,0);const r=JSON.parse(fs.readFileSync(item.path));assert.equal(r.actualExitCode,0);assert.equal(r.signal,null);assert(!r.spawnError&&!r.error&&r.closedAt);}
   return {...item,physical:p};
 });
 for(const role of ['actual-upload-receipt','actual-deploy-receipt','post-publish-web-guard-receipt']){
  const item=evidence.find(x=>x.role===role);assert(item,'Missing actual evidence '+role);assert.equal(item.expectedActualExitCode,0);
 }
 return {meta,metadataFile:proof(metadataPath),oldIntroduction,oldDate,newDate,oldPublication,evidence};
}


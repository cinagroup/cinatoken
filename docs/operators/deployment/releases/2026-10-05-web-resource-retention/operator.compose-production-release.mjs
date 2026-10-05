import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {packageRelease,verifyRelease} from 'file:///C:/cinagroup/cinatoken/packages/web/scripts/package-release.mjs';
import {isRetainableAsset} from 'file:///C:/cinagroup/cinatoken/packages/web/scripts/asset-policy.mjs';
const [sha,label] = process.argv.slice(2);
assert.match(sha??'',/^[a-f0-9]{40}$/);assert.match(label??'',/^[a-z0-9-]+$/);
const temp=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const production='3847955ccdb4c670f0f9aa099ef976889357e6b2',old='bdc1bfcf15d93a9b2769d3f52352bfa39eab8928';
const inputs=[sha,production,old].map(id=>verifyRelease(root,id));
const at=new Date().toISOString(),bridgeId='retention-'+production.slice(0,8)+'-'+old.slice(0,8)+'-20261005',activationId='web-'+sha.slice(0,12)+'-20261005-retained';
const raw = file=>{const b=fs.readFileSync(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const snapshots=inputs.map(r=>({id:r.manifest.releaseId,manifestSha256:r.manifestSha256,buildContract:r.manifest.buildContract,assetFiles:r.manifest.files.length,serverFiles:r.manifest.serverFiles.length,currentArchive:r.manifest.sourceDelivery.currentArchive}));
const bridge=packageRelease({root,id:bridgeId,at,previous:old,currentRelease:production,retentionDays:14});
const activation=packageRelease({root,id:activationId,at,previous:bridgeId,currentRelease:sha,retentionDays:14});
const [base,live,original]=inputs;
for(const r of inputs) assert.equal(verifyRelease(root,r.manifest.releaseId).manifestSha256,r.manifestSha256,'Frozen input must not change');
assert.deepEqual(bridge.manifest.buildContract,live.manifest.buildContract);
assert.deepEqual(activation.manifest.buildContract,base.manifest.buildContract);
assert.deepEqual(activation.manifest.serverFiles,base.manifest.serverFiles);
const targetFiles=new Map(activation.manifest.files.map(f=>[f.path,f]));
for(const f of base.manifest.files.filter(f=>!f.path.startsWith('sources/'))) {
 const target=targetFiles.get(f.path); assert.ok(target);assert.equal(target.source,'current');
 assert.equal(target.sha256,f.sha256);assert.equal(target.bytes,f.bytes);
}
const checks=[];
for(const input of [live,original])for(const f of input.manifest.files.filter(f=>isRetainableAsset(f.path))) {
 if(Date.parse(at)-Date.parse(f.lastCurrentAt)>14*86400000)continue;
 const output=targetFiles.get(f.path);assert.ok(output,'Unexpired published resource must survive: '+f.path);
 assert.equal(output.sha256,f.sha256);assert.equal(output.bytes,f.bytes);
 checks.push({input:input.manifest.releaseId,path:f.path,sha256:f.sha256,bytes:f.bytes,source:output.source});
}
for(const input of [base,live,original])assert.ok(activation.manifest.sourceDelivery.archives.some(a=>a.path===input.manifest.sourceDelivery.currentArchive));
assert.equal(activation.manifest.sourceDelivery.currentArchive,base.manifest.sourceDelivery.currentArchive);
assert.equal(activation.manifest.sourceDelivery.coverageComplete,base.manifest.sourceDelivery.coverageComplete);
const proof={at,finishedAt:new Date().toISOString(),actualExit:0,inputFrozen:snapshots,bridge:{releaseId:bridgeId,manifestSha256:bridge.manifestSha256,previousReleaseId:bridge.manifest.previousReleaseId,currentReleaseId:bridge.manifest.currentReleaseId},activation:{releaseId:activationId,manifestSha256:activation.manifestSha256,previousReleaseId:activation.manifest.previousReleaseId,currentReleaseId:activation.manifest.currentReleaseId,buildContract:activation.manifest.buildContract,assetFiles:activation.manifest.files.length,serverFiles:activation.manifest.serverFiles.length,sourceDelivery:activation.manifest.sourceDelivery},retainedChecks:checks,script:raw(fileURLToPath(import.meta.url)),packagingSources:['package-release.mjs','source-delivery.mjs'].map(p=>raw(root+'/packages/web/scripts/'+p)),frozenInputsUnchanged:true,serverInventoryExactlyBase:true,currentAssetsExactlyBase:true,rootDistRead:false,wholeMigrationComplete:false};
fs.writeFileSync(path.join(temp,label+'.composition-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,releaseId:activationId,manifestSha256:activation.manifestSha256,assetFiles:activation.manifest.files.length,serverFiles:activation.manifest.serverFiles.length,archives:activation.manifest.sourceDelivery.archives.map(a=>({path:a.path,source:a.source,lastCurrentAt:a.lastCurrentAt})),retainedChecks:checks.length}));

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { enumerate, stableRead, sha256 } from 'file:///C:/Users/cina/AppData/Local/Temp/cinatoken-native59-info-evidence-tools-6a81f21b197047159394b64addf8eb59/evidence-lib.mjs';
const out = path.dirname(fileURLToPath(import.meta.url));
const temp = 'C:/Users/cina/AppData/Local/Temp';
const tool = `${temp}/cinatoken-native59-info-evidence-tools-6a81f21b197047159394b64addf8eb59`;
const indexPath = `${temp}/cinatoken-native26-g7-terminal-archive-meta-a4e5aa1b47564ae5b5bb81281df27d1d/frozen-current-root-index.json`;
const startedAt = new Date().toISOString();
const pin = p => { const s = stableRead(p); return { file:p, bytes:s.bytes.length, sha256:s.sha256 }; };
const scanned = root => enumerate(root).map(relative=>({relative,...stableRead(path.join(root,relative))}));
const write = (n,v) => { const p=path.join(out,n); fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'}); return pin(p); };
const bytes = stableRead(indexPath);
assert.equal(bytes.bytes.length,375872);
assert.equal(bytes.sha256,'cedbf58fb411c7a183c60d183f6d36da8c853236ec7711f0b3ad679da2c2f467');
const frozen = JSON.parse(bytes.bytes);
assert.equal(frozen.schema,'cinatoken-current-root-frozen-input-index-v1');
assert.equal(frozen.files,981); assert.equal(frozen.totalBytes,11305947);
const currentRoot=`${temp}/cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504`;
assert.equal(path.resolve(frozen.sourceRoot),path.resolve(currentRoot));
const current=scanned(currentRoot), previous=new Map(frozen.entries.map(e=>[e.file,e]));
assert.equal(previous.size,981); assert.equal(current.length,981);
let currentBytes=0;
for(const e of current){ const old=previous.get(e.relative); assert.ok(old,`Unexpected frozen file ${e.relative}`); assert.equal(e.bytes.length,old.bytes); assert.equal(e.sha256,old.sha256); assert.equal(path.resolve(old.originalPath),path.resolve(currentRoot,e.relative)); currentBytes+=e.bytes.length; }
assert.equal(currentBytes,11305947);
const indexRoot=fs.mkdtempSync(path.join(os.tmpdir(),'cinatoken-current-frozen-index-input-'));
const copiedIndex=path.join(indexRoot,'frozen-current-root-index.json'); fs.writeFileSync(copiedIndex,bytes.bytes,{flag:'wx'}); assert.deepEqual(fs.readFileSync(copiedIndex),bytes.bytes);
fs.writeFileSync(path.join(indexRoot,'COPY-PROVENANCE.json'),JSON.stringify({schema:'frozen-current-root-index-byte-copy-v1',copiedAt:new Date().toISOString(),source:pin(indexPath),copy:pin(copiedIndex),sourceRoot:currentRoot,files:981,totalBytes:11305947,byteExact:true,sourceUnchanged:true,newBusinessExecutionClaimed:false,collectorMetadataRootIncluded:false,stopWrite:true},null,2)+'\n',{flag:'wx'});
const configPath=`${tool}/native59-supported-subset-config.json`,base=JSON.parse(fs.readFileSync(configPath));
assert.equal(base.roots.length,16);
const added=[
 ['current-terminal-evidence','cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504','closed-ci-evidence'],
 ['native26-terminal-peer','cinatoken-native26-ci-terminal-independent-peer-cc2708922c0e4f64a9cca948194a20d9','source-peer-review'],
 ['native-pin94-readonly','cinatoken-native-pin94-readonly-385d45490c944bcb892427d92c3de287','source-peer-review'],
 ['v364-url-calibration-owner','cinatoken-v364-direct-actual-review-DjepMs','source-peer-review'],
 ['v364-url-calibration-peer','cinatoken-v364-address-repair-peer-readonly-ec894dc1d1004d33ae29d0a3c0d5857b','source-peer-review'],
 ['v364-partial-existing-reads-peer','cinatoken-v364-calibration-address-independent-peer-c08eb1896ea747ab8895d1ed6c01f5b8','source-peer-review'],
 ['old-meta-opaque-snapshot','cinatoken-old-meta-opaque-snapshot-eEXPR6','historical-and-current'],
 ['old-meta-opaque-peer','cinatoken-old-meta-opaque-peer-readonly-ctkbvuoa','source-peer-review'],
 ['direct-socket-evidence-tools','cinatoken-direct-socket-evidence-tools-327af4cf66284756b16383a24e304610','prepared-only'],
 ['direct-socket-tool-source-peer','cinatoken-direct-socket-tool-source-peer-readonly-541b7711f55b4066b8c28eb33962c0a0','source-peer-review'],
 ['native59-info-evidence-tools','cinatoken-native59-info-evidence-tools-6a81f21b197047159394b64addf8eb59','prepared-only'],
 ['native59-info-tool-source-peer','cinatoken-native59-info-peer-readonly-eq34crj5','source-peer-review'],
 ['canonical-calibration-terminal-peer','cinatoken-canonical-calibration-terminal-independent-peer-7c64bf0f365242ed9e43c275ac46721a','source-peer-review'],
 ['native-frozen94-109-prepare','cinatoken-native-frozen94-109-prepare-1a3b08f2b97c427989de588e9e4cd450','prepared-only']
];
const config=structuredClone(base);
config.releaseSlug='2026-10-06-g7-native26-calibration-progress';
config.sourceCommit='dc7be6f8597333151c450bae3ae15e6585e3b2eb';
config.outputDirectory=path.join(out,'future-collection-output-not-created');
for(const [id,name,phase] of added) config.roots.push({id,path:`${temp}/${name}`,phase});
config.roots.push({id:'current-frozen-index-input',path:indexRoot,phase:'prepared-only'});
const ids=new Set(),paths=new Set(), inventory=[];
for(const r of config.roots){assert.equal(ids.has(r.id),false);ids.add(r.id);const rp=fs.realpathSync(r.path).toLowerCase();assert.equal(paths.has(rp),false);paths.add(rp);assert.ok(!r.excludeDirectories?.length);const items=scanned(r.path); inventory.push({id:r.id,path:r.path,files:items.length,bytes:items.reduce((n,e)=>n+e.bytes.length,0),entries:items.map(e=>({file:e.relative,bytes:e.bytes.length,sha256:e.sha256}))});}
assert.equal(config.roots.length,31);
assert.equal(paths.has(fs.realpathSync(path.dirname(indexPath)).toLowerCase()),false);
config.semantics={collectionOnly:true,gatePassDerived:false,fullG7Verified:false,fullG8Verified:false,fullNativeCancelVerified:false,productionRequests:0,noExclusions:true,syntheticDialectControlsNotApplicationTests:true,originalAdmission1Preserved:true,collectorMetadataRootNotIncluded:true,allListedSourceRootsFrozen:true,currentRootStopWrite:true,currentRootVerifiedAgainstExternalIndex:{files:981,totalBytes:11305947,indexSha256:bytes.sha256},sourceLayers:{releaseSourceCommit:config.sourceCommit,g7ActualSourceCommit:'473de5fc520fc7d64db700db88a76c7a6b45c241',native26ActualSourceCommit:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',originalDirectDiagnosticActualSourceCommit:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',newCalibrationDiagnosticActualSourceCommit:config.sourceCommit,productionSourceCommitPrefix:'c13',productionWorkerVersionPrefix:'2a0',productionTrafficPercent:100,productionReadPerformedHere:false},businessOutcomeScope:'Root-reported original frozen artifacts retained: calibration actual0/cancelKV observed; four direct runtime cases and original strict baseline actual1, overall process1. Pure evidence admission does not change those outcomes.',oldDurableMeta:{directOriginalRootIncluded:false,losslessOpaqueReplacementRootId:'old-meta-opaque-snapshot',originalFiles:2353,allOriginalBytesRetainedInZip:true,copiedHistoricalReceiptsNotFreshExecution:true},pendingFutureFrozenRoots:['native-four-historical-snapshot-repair-peer'],scope:'All currently explicitly frozen roots; additional in-progress peer/repair roots require later freeze and exact explicit config addition before final collection.'};
config.sourceCommitAdmission='Full exact Root-reported release source dc7be6f8597333151c450bae3ae15e6585e3b2eb. Root supplied actual source layers; this operation only prepares frozen-input evidence admission and does not run CI or business tests.';
config.requiredRootIds=config.roots.map(r=>r.id);
const configPin=write('all-frozen-config.json',config);
const inventoryPin=write('all-frozen-input-inventory.json',{schema:'all-explicitly-frozen-root-inventory-v1',startedAt,finishedAt:new Date().toISOString(),roots:inventory.length,files:inventory.reduce((n,r)=>n+r.files,0),bytes:inventory.reduce((n,r)=>n+r.bytes,0),sourceRoots:inventory,config:configPin,baseConfig:pin(configPath),externalFrozenIndex:pin(indexPath),copiedFrozenIndex:pin(copiedIndex),noBusinessExecution:true,noExclusions:true});
write('PREPARED-all-frozen-config.json',{schema:'all-frozen-config-preparation-v1',startedAt,finishedAt:new Date().toISOString(),actualCheckExit:0,currentRootFiles:981,currentRootBytes:currentBytes,all981SetBytesAndSha256Match:true,roots:config.roots.length,config:configPin,inventory:inventoryPin,indexRoot,externalIndex:pin(indexPath),noCollection:true,noRepoGitCiProductionMutation:true,futureUnfrozenRootsNotIncluded:config.semantics.pendingFutureFrozenRoots});
console.log(JSON.stringify({roots:config.roots.length,current981Exact:true,indexRoot,config:configPin,inventory:inventoryPin}));

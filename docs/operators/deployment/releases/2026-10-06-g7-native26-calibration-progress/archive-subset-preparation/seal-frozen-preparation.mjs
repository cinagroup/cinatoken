import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enumerate, stableRead } from './enhanced-tools/evidence-lib.mjs';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const pin=file=>{const value=stableRead(file);return {bytes:value.bytes.length,sha256:value.sha256}};
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const manifestFile='FINAL-preparation-readonly-seal.json';assert.equal(fs.existsSync(path.join(root,manifestFile)),false);
assert.equal(fs.existsSync(path.join(root,'future-output-not-created')),false);
const advisory=read('FINAL-frozen-subset-archive-preparation-advisory.json');assert.equal(advisory.preparationOutcome,0);
assert.equal(advisory.fullG7Verified,false);assert.equal(advisory.fullG8Verified,false);
const before=enumerate(root),resultFiles=before.filter(file=>file.endsWith('.result.json')&&!file.startsWith('historical-observer-original-reference/'));
const terminals=[];
for(const file of resultFiles){const receipt=read(file);assert.ok(Number.isSafeInteger(receipt.actualExit));assert.equal(receipt.signal,null);assert.equal(receipt.spawnError,null);
  for(const stream of ['stdout','stderr']){const actual=pin(receipt[stream].path);assert.equal(actual.bytes,receipt[stream].bytes);assert.equal(actual.sha256,receipt[stream].sha256)}
  terminals.push({file,...pin(path.join(root,file)),actualExit:receipt.actualExit,at:receipt.at,finishedAt:receipt.finishedAt});}
assert.equal(terminals.length,9);assert.equal(terminals.filter(receipt=>receipt.actualExit===1).length,1);
const plan=read('enhanced-four-root-bound-audit.json');for(const entry of plan.entries){const actual=pin(entry.sourcePath);assert.equal(actual.bytes,entry.originalBytes);assert.equal(actual.sha256,entry.originalSha256)}
for(const item of read('original-frozen-tools-index.json').pins){for(const file of [item.source,path.join(root,'tools',item.file)]){const actual=pin(file);assert.equal(actual.bytes,item.bytes);assert.equal(actual.sha256,item.sha256)}}
const files=before.map(file=>({file,...pin(path.join(root,file))}));assert.deepEqual(enumerate(root),before);
const manifest={schema:'cinatoken-archive-preparation-readonly-seal-v1',directory:root,createdAt:new Date().toISOString(),
  regularFilesBeforeSelf:files.length,regularFilesIncludingSelf:files.length+1,selfExcludedFromHashList:manifestFile,
  fileSetBeforeSelfExact:true,allFiles:files,originalOwnCommandTerminals:terminals,
  sourceCommit:advisory.sourceCommit,scope:'Final immutable Temp package; preparation subset only, not current CI or runtime gate acceptance',
  repositoryWrites:0,productionRequests:0,fullG7Verified:false,fullG8Verified:false,currentCiResultsCollected:false,
  negativeOwnCommandReceiptCount:1,preparationReadOnlyPathFailuresDeclaredSeparately:true,
  frozenFourProducerRootsAndSelectedReferencesRemainExact:true,originalFrozenV2ToolBytesUnchanged:true,
  writesStopAfterThisManifest:true};
const file=path.join(root,manifestFile);fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
assert.deepEqual(enumerate(root),[...before,manifestFile].sort());
console.log(JSON.stringify({closedSealWrite:true,seal:{path:file,...pin(file)},advisory:{path:path.join(root,'FINAL-frozen-subset-archive-preparation-advisory.json'),...pin(path.join(root,'FINAL-frozen-subset-archive-preparation-advisory.json'))},regularFilesIncludingSelf:files.length+1,originalOwnCommandReceipts:terminals.length,ownWritesStopped:true,runtimeOrGatePassClaimed:false}));

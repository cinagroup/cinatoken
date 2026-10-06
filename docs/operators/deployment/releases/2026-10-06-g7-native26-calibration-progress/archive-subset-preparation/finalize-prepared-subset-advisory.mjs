import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stableRead } from './enhanced-tools/evidence-lib.mjs';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const pin=file=>{const value=stableRead(file);return {path:file,bytes:value.bytes.length,sha256:value.sha256}};
const proof=read('prepared-subset-final-proof.json'),terminal=read('final-prepared-subset-audit.result.json');
assert.equal(terminal.actualExit,0);assert.equal(proof.auditOutcome,0);assert.equal(proof.completeOrdinaryFiles,149);
for(const stream of ['stdout','stderr']){const actual=pin(terminal[stream].path);assert.equal(actual.bytes,terminal[stream].bytes);assert.equal(actual.sha256,terminal[stream].sha256)}
const peerPath='C:/Users/cina/AppData/Local/Temp/cinatoken-four-frozen-archive-peer-readonly-93dbd146546645cbb2495a763acf6c1e/FINAL-four-frozen-archive-peer-review.json';
const peer=pin(peerPath);assert.equal(peer.bytes,84268);assert.equal(peer.sha256,'ec332cae646d1072fdf28f969cc8ab4a6b8ea54dc34d02157932857befbf9c7d');
const runnerPeerPath='C:/Users/cina/AppData/Local/Temp/cinatoken-archive-receipt-dialect-peer-readonly-e41d1f26433548dea9ff73e133e0dc4b/FINAL-current-run-closed-dialect-peer-review.json';
const runnerPeer=pin(runnerPeerPath);assert.equal(runnerPeer.bytes,7884);assert.equal(runnerPeer.sha256,'acdecdb41dec18038860b3761e7bedccc4f10300b9eed25e784159f3cda276ac');
const report={schema:'cinatoken-native-four-g7-frozen-subset-archive-preparation-advisory-v1',closed:true,preparationOutcome:0,
  sourceCommit:'473de5fc520fc7d64db700db88a76c7a6b45c241',scope:'Temp-only subset preparation; no current CI evidence or full G7/G8 collection/acceptance',
  completeFrozenProducerAndPeerRoots:4,frozenFourRootFiles:140,selectedHistoricalReferenceRoots:1,selectedHistoricalReferenceFiles:9,
  preparedFiles:149,preparedOriginalCommandReceipts:28,separateAggregateReportEntries:4,exclusions:0,
  originalV2FirstAudit:{actualExit:1,blockers:24,admittedFiles:120,unadmittedOriginalRaw:20,preserved:true},
  enhancedSubsetAudit:{actualExit:0,blockers:0,admittedFiles:149},
  exactG7OwnerBinding:{originalCommandReceipts:8,originalRawStreams:16,originalStatusTimingAndDescriptorsPinned:true,aggregateReportStatusUsedAsCommandAuthority:false},
  controlledChildren:{count:6,actualChildExit:[0,1,1,1,1,1],onlyNestedParentRaw:true,independentExternalStreamsOrToolReceiptsInvented:false,realSQLDatabase:false,nativeLinuxAcceptance:false},
  preservedNegativeScopes:['Original V2 audit actual1 with all24 blockers and original raw','Original G7 owner reader glob mismatch actual1 metadata','Original G7 peer reader path failure actual1 metadata',
    'Original historical Admin observer1, Proxy observer0, runtime aggregate1, wire aggregate0 kept separately','Two preparation read-only filename/path failures actual1 as original conversation tool returns, no reconstructed streams'],
  controls:{newSynthetic:37,unchangedSyntheticSuites:[12,10,28],eachParentProcessActualExit:0,oldTestSourceBytesUnchanged:true,
    originalRealEvidenceDescriptorSuiteNotRerun:true,oldEvidenceFullAuditRepeated:false},
  finalReadonlyProof:pin(path.join(root,'prepared-subset-final-proof.json')),finalProofOriginalTerminal:pin(path.join(root,'final-prepared-subset-audit.result.json')),
  config:pin(path.join(root,'four-frozen-roots-bound-config.json')),enhancedLib:pin(path.join(root,'enhanced-tools/evidence-lib.mjs')),
  originalToolPins:pin(path.join(root,'original-frozen-tools-index.json')),patchScope:pin(path.join(root,'new-tool-patch-scope.json')),
  toolReturnProvenance:pin(path.join(root,'preparation-tool-return-provenance.json')),usage:pin(path.join(root,'PREPARED-ONLY-USAGE.md')),
  independentPeer:peer,independentCurrentRootRunnerDialectPeer:runnerPeer,
  futureRootRequirement:'After CI terminal, create a fresh full config and output destination with complete concrete current Root/CI artifact/diagnostic/peer roots. If whole preparation root is included, point immutable schema-copy references to its historical-observer-original-reference paths and remove overlapping child root; no exclusions.',
  currentRootReadScope:'Single run-closed.mjs source snapshot only; not enumerated, audited, collected or mutated',
  currentRootRunnerHelperChangeRequired:false,currentRootActualProcessNullNotConvertedToWrapperExit:true,
  originalFrozenToolsModified:false,originalFrozenProducerOrPeerRootsModified:false,repositoryWrites:0,gitCommands:0,ciQueriesOrInvocations:0,
  currentCiResultsCollected:false,productionRequests:0,applicationRuntimeOrDatabaseTestsRunByPreparer:false,
  fullG7Verified:false,fullG8Verified:false,gatePassDerived:false,collectionIntoRepositoryPerformed:false};
const finalPath=path.join(root,'FINAL-frozen-subset-archive-preparation-advisory.json');fs.writeFileSync(finalPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({preparationOutcome:0,final:pin(finalPath),separateRuntimeOrGatePassClaimed:false}));

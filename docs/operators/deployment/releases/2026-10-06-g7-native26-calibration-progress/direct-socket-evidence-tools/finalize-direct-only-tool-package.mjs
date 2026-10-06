import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {enumerate,stableRead} from './evidence-lib.mjs';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const pin=file=>{const value=stableRead(file);return {path:file,bytes:value.bytes.length,sha256:value.sha256}};
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const sourcePins=read('original-enhanced-tools-pins.json');
for(const item of sourcePins.pins){const actual=pin(item.source);assert.equal(actual.bytes,item.bytes);assert.equal(actual.sha256,item.sha256);
  if(item.file!=='evidence-lib.mjs'){const copy=pin(path.join(root,item.file));assert.equal(copy.bytes,item.bytes);assert.equal(copy.sha256,item.sha256)}}
const receipts=enumerate(root).filter(file=>file.endsWith('.result.json')).map(file=>{const value=read(file);assert.ok(Number.isSafeInteger(value.actualExit));assert.equal(value.signal,null);assert.equal(value.spawnError,null);
  for(const stream of ['stdout','stderr']){const actual=pin(value[stream].path);assert.equal(actual.bytes,value[stream].bytes);assert.equal(actual.sha256,value[stream].sha256)}
  return {file,...pin(path.join(root,file)),actualExit:value.actualExit,at:value.at,finishedAt:value.finishedAt,stdout:value.stdout,stderr:value.stderr};});
const find=id=>receipts.find(item=>item.file===id+'.result.json');
assert.equal(find('no-fatal-source-contract-first').actualExit,1);assert.equal(find('no-fatal-source-contract-final').actualExit,0);
assert.equal(find('frozen-expanded-audit-first').actualExit,1);assert.equal(find('frozen-candidate-audit-final').actualExit,0);
const controls=[];for(const [id,expected]of [['direct-socket-controls-first',49],['direct-socket-controls-final',61],['direct-socket-controls-final-v2',64],
 ['unchanged-g7-producer-controls',37],['unchanged-generic-controls',12],['unchanged-closure-controls',10],['unchanged-association-controls',28]]){
 const receipt=find(id);assert.equal(receipt.actualExit,0);const proof=JSON.parse(fs.readFileSync(receipt.stdout.path,'utf8'));assert.equal(proof.pass,expected);assert.equal(proof.fail,0);assert.equal(proof.skipped,0);controls.push({id,pass:proof.pass,receipt:pin(path.join(root,receipt.file))});}
const direct=read('frozen-candidate-audit-final.json'),expanded=read('frozen-expanded-audit-first.json');
assert.equal(direct.entries.length,674);assert.equal(direct.receipts.length,122);assert.equal(direct.blockers.length,0);assert.equal(direct.exclusions.length,0);
assert.equal(expanded.blockers.length,956);assert.equal(expanded.exclusions.length,0);
const finalSources=['evidence-lib.mjs','direct-socket-dialect.mjs','direct-socket-dialect-controls.mjs','real-no-fatal-shape-contract.mjs'].map(file=>({file,...pin(path.join(root,file))}));
const report={schema:'cinatoken-direct-socket-evidence-reader-preparation-final-v1',closed:true,actualPreparationReviewOutcome:0,
  preparationBaseSHA:'473de5fc520fc7d64db700db88a76c7a6b45c241',rootReportedPushedSHA:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',runtimeSHAAndResultVerifiedByThisProducer:false,
  exactSchemas:['v364-direct-socket-executor-closed-v1','v364-direct-socket-closed-v1'],finalSources,controls,originalActualCommandReceipts:receipts,
  directSubset:{actualExit:0,frozenRoots:14,files:674,commandReceipts:122,exclusions:0,blockers:0},
  expandedSubset:{actualExit:1,frozenRoots:17,admittedFiles:expanded.entries.length,commandReceipts:expanded.receipts.length,aggregateEntries:expanded.aggregateReports.length,exclusions:0,blockers:956,
   blockersByScope:{native59InfoOnlyRaw:4,previousDurableMetaCopiedArchive:952},negativeReportAndRawPreserved:true},
  sourceContractCorrection:{normalNodeUndefinedFatalAbsentSupported:true,originalFirstActual1Preserved:true,onlyNodeGuardChanged:true,
   originalBaseline0WithFailureFlagsRemains0AndNodeAggregate1:true,partialNegativeReportNotLost:true,fakeAggregate0WithFailureFlagsBlocked:true},
  exactNoChildPreflight:{processExit:null,aggregateExit:1,actualChildExitProven:false,linuxRuntimeExecuted:false},
  signedProcessAndRunnerKeptSeparately:true,completeExecutorManifestSetBytesShaMtimeRequired:true,nodeAggregateOnly:true,rawAuthorityExecutorOnly:true,
  forcedCleanupTimeoutOrUnknownCannotUpgradePass:true,allComparisonsBaselineEligible:false,
  originalToolDirectoryAndSuitesUnchanged:true,oldInventoryAdmission1Preserved:true,applicationNativeG7MiniflareTestsRun:false,
  actualRuntimeReceiptsManufactured:false,productionRequests:0,repositoryWrites:0,gitCommands:0,ciQueriesOrDispatches:0,growingRootWalked:false,
  collectMetadataRootIncluded:false,priorSourceFullGateRepeated:false,fullNativeCancelVerified:false,fullG7Verified:false,fullG8Verified:false,causeProven:false,
  futureScope:'Fresh copy may add exact pinned native59 Info binding. Root owns lossless opaque oldDurableMeta ZIP/index and final actual runtime/config/collection after independent reader review.',
  expandedNegativePlan:pin(path.join(root,'frozen-expanded-audit-first.json')),directFinalPlan:pin(path.join(root,'frozen-candidate-audit-final.json')),
  directConfig:pin(path.join(root,'prepared-frozen-roots-config.json')),expandedConfig:pin(path.join(root,'prepared-expanded-frozen-roots-config.json'))};
const final=path.join(root,'FINAL-direct-only-reader-preparation.json');fs.writeFileSync(final,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const names=enumerate(root),files=names.map(file=>({file,...pin(path.join(root,file))}));
const seal=path.join(root,'FINAL-direct-only-reader-seal.json');fs.writeFileSync(seal,JSON.stringify({schema:'cinatoken-direct-only-evidence-tool-seal-v1',files,
  filesBeforeSelf:files.length,filesIncludingSelf:files.length+1,selfExcluded:'FINAL-direct-only-reader-seal.json',writesStop:true,
  actualRuntimeReceiptsManufactured:false,growingRootNotWalked:true,expandedAdmission1Preserved:true,productionRequests:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({preparationReviewOutcome:0,expandedArchiveAdmissionOutcome:1,final:pin(final),seal:pin(seal),filesIncludingSelf:files.length+1,writesStop:true}));

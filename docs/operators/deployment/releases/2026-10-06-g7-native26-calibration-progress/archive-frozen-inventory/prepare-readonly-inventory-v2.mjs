import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { enumerate, stableRead, prepare } from 'file:///C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd/enhanced-tools/evidence-lib.mjs';
const out=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const tmp='C:/Users/cina/AppData/Local/Temp/';
const toolRoot=tmp+'cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd';
const pin=file=>{const data=stableRead(file);return {path:file,bytes:data.bytes.length,sha256:data.sha256}};
const roots=[
  ['native-four-owner','cinatoken-native-four-repair-38a94fb93d9842929dc7ae9cf6b378da','local-validation'],
  ['native-four-peer','cinatoken-native-four-independent-peer-1f17397bef8049cb9cd030679e23dc70','source-peer-review'],
  ['g7-observe-owner','cinatoken-g7-observe-dependency-fix-02e2061ea37b4d18af99a3675ec1b7fc','local-validation'],
  ['g7-observe-peer','cinatoken-g7-observer-connection-peer-readonly-13a3b38c25d74da1be0d64feed3c75d5','source-peer-review'],
  ['archive-subset-preparation','cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd','prepared-only'],
  ['archive-subset-peer','cinatoken-four-frozen-archive-peer-readonly-93dbd146546645cbb2495a763acf6c1e','source-peer-review'],
  ['archive-runner-dialect-peer','cinatoken-archive-receipt-dialect-peer-readonly-e41d1f26433548dea9ff73e133e0dc4b','source-peer-review'],
  ['native26-owner','cinatoken-native26-pg73-repair-908e0528cf5e44508d04e761c4540713','local-validation'],
  ['native26-peer','cinatoken-native26-independent-peer-815d52a48c5d44fc9146dd59579e27f2','source-peer-review'],
  ['direct-socket-owner','cinatoken-v364-direct-socket-prep-99dlWu','prepared-only'],
  ['direct-socket-peer','cinatoken-v364-direct-socket-peer-readonly-19dc03ece33840d28acfca66a68a3863','source-peer-review'],
  ['native-g7-terminal-peer','cinatoken-native-g7-terminal-independent-peer-9a6f592ed14641fe9af1029826dbd775','source-peer-review'],
].map(([id,directory,phase])=>({id,path:tmp+directory,phase}));
const entries=[];
for(const root of roots){assert.ok(fs.existsSync(root.path));const names=enumerate(root.path);
  entries.push({id:root.id,path:root.path,phase:root.phase,ordinaryFiles:names.length,files:names.map(file=>({file,...pin(path.join(root.path,file))}))});}
const oldConfig=JSON.parse(fs.readFileSync(path.join(toolRoot,'four-frozen-roots-bound-config.json'),'utf8'));
const config={...oldConfig,releaseSlug:'2026-10-06-native26-direct-socket-prepared-subset',sourceCommit:null,
  sourceCommitAdmission:'Await Root exact committed and actually executed SHA; prepared base473 is not future runtime SHA',
  outputDirectory:path.join(out,'future-output-not-created'),roots,
  semantics:{collectionOnly:true,gatePassDerived:false,fullG7Verified:false,fullG8Verified:false,fullNativeCancelVerified:false,
    pendingNewCiAndDiagnostics:true,growingCurrentRootIncluded:false,productionRequests:0,noExclusions:true,inventoryOnly:true},
  immutableSchemaCopies:oldConfig.immutableSchemaCopies.map(value=>({...value,originalRootId:'archive-subset-preparation',
    originalFile:'historical-observer-original-reference/'+value.originalFile,
    includedLogCopies:value.includedLogCopies.map(item=>({...item,originalFile:'historical-observer-original-reference/'+item.originalFile}))})),
};
fs.writeFileSync(path.join(out,'frozen-roots-inventory.json'),JSON.stringify({schema:'cinatoken-frozen-candidate-root-inventory-v1',
  capturedAt:new Date().toISOString(),scope:'Read/hash frozen roots only; no changing Root or current metadata, application/CI/production execution',
  roots:entries,rootCount:entries.length,fileCount:entries.reduce((sum,value)=>sum+value.ordinaryFiles,0),
  sourceCommitKnownPreparationBase:'473de5fc520fc7d64db700db88a76c7a6b45c241',futureRuntimeSHA:null,productionRequests:0,
  excludesGrowingCurrentRoot:true,exclusions:[]},null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'future-subset-config-advisory.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
const plan=prepare(config);
fs.writeFileSync(path.join(out,'unmodified-enhanced-tool-preparation-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
const extra=entries.flatMap(root=>root.files.filter(file=>/\.closed\.json$|\.result\.json$|FINAL|seal/iu.test(file.file)).map(file=>({root:root.id,...file})));
fs.writeFileSync(path.join(out,'receipt-and-report-candidate-index.json'),JSON.stringify(extra,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({readHashInventoryOutcome:0,roots:entries.map(({id,ordinaryFiles})=>({id,ordinaryFiles})),
  candidateFiles:entries.reduce((sum,value)=>sum+value.ordinaryFiles,0),admittedFiles:plan.entries.length,
  originalCommandReceipts:plan.receipts.length,aggregates:plan.aggregateReports.length,
  blockers:plan.blockers,archiveAdmissionOutcome:plan.blockers.length?1:0,exclusions:plan.exclusions,
  noApplicationTestsRun:true,currentRuntimeResultsNotClaimed:true}));

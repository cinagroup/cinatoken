import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),pin=file=>{const bytes=fs.readFileSync(file);return {path:file,bytes:bytes.length,sha256:sha(bytes)}};
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const inventory=read('frozen-roots-inventory.json'),plan=read('unmodified-enhanced-tool-preparation-plan.json');
assert.equal(inventory.rootCount,12);assert.equal(inventory.fileCount,660);assert.equal(plan.entries.length,658);assert.equal(plan.blockers.length,2);assert.equal(plan.exclusions.length,0);
assert.deepEqual(plan.blockers.map(item=>item.file).sort(),['windows-negative/executor.stderr.txt','windows-negative/executor.stdout.txt']);
for(const sourceRoot of inventory.roots){for(const file of sourceRoot.files){const current=pin(file.path);assert.equal(current.bytes,file.bytes);assert.equal(current.sha256,file.sha256)}}
const lib=pin('C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd/enhanced-tools/evidence-lib.mjs');
assert.equal(lib.sha256,'1a94e0682a2f9782a0bcc28c4736ff49c0bf4db0b9e0cfe0f34ecb6918b22cb7');
const observations={schema:'cinatoken-original-readonly-inventory-tool-observations-v1',
  scope:'Exact available conversation tool terminal observations; no invented stdout/stderr files or application process receipts',
  executions:[{chunk_id:'1ceece',actualToolExit:1,reason:'Read-only requested nonexistent v364-owned-linux-direct-socket path; proper source path subsequently read; no runtime or source mutation'},
    {chunk_id:'9d90aa',actualToolExit:1,reason:'Initial new inventory reader used unsupported Windows C: ESM import; first script preserved unchanged'},
    {chunk_id:'3d77d1',actualToolExit:0,wall_time_seconds:4.0089195,reason:'New v2 reader uses file URL; read/hash inventory completes, original helper admission remains1 with2blockers'}],
  independentRawStreamsClaimed:false,applicationOrCiTestsRun:false,productionRequests:0};
fs.writeFileSync(path.join(root,'original-readonly-tool-observations.json'),JSON.stringify(observations,null,2)+'\n',{flag:'wx'});
const report={schema:'cinatoken-native26-direct-socket-frozen-inventory-advisory-v1',inventoryReadHashOutcome:0,
  originalEnhancedToolArchiveAdmissionOutcome:1,closedReadonlyPreparation:true,
  scope:'Only frozen roots; current growing Root and CI artifact not read/collected; no application/native/G7 test execution',
  sourcePreparationBase:'473de5fc520fc7d64db700db88a76c7a6b45c241',rootReportedNewSourceCommit:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',
  newCommitClaimSource:'Root message only; not fresh Git/CI read',futureLinuxResult:null,
  inventory:pin(path.join(root,'frozen-roots-inventory.json')),configAdvisory:pin(path.join(root,'future-subset-config-advisory.json')),
  unsupportedOriginalHelperPlan:pin(path.join(root,'unmodified-enhanced-tool-preparation-plan.json')),originalTool:lib,
  roots:inventory.roots.map(({id,path,phase,ordinaryFiles})=>({id,path,phase,ordinaryFiles})),candidateRootCount:12,candidateOrdinaryFiles:660,
  admittedFiles:658,originalCommandReceipts:plan.receipts.length,originalNumericNonzeroReceipts:plan.receipts.filter(item=>Number.isSafeInteger(item.actualExit)&&item.actualExit!==0).length,
  distinctAggregateEntries:plan.aggregateReports.length,blockers:plan.blockers,exclusions:[],
  strictNewSchemaNotYetSupported:true,negativeRawNotExcluded:true,
  smallestFutureAdapter:{executorSchema:'v364-direct-socket-executor-closed-v1',nodeSchema:'v364-direct-socket-closed-v1',
    noChildNegativeMustRemainNull:true,nodeIsAggregateNotRawAuthority:true,
    requirements:['Schema-restricted numeric actualProcessExit and runnerOutcomeCode, preserve negative signal wait statuses and final0/1 separately',
      'Exact no-child Windows admission failure only, processnull no native/subreaper/directReap claim; bind just original two declared raw',
      'Actual owned Linux closure requires executor authority, subreaper/directChildReaped/groupGone with closed census/errors and exact manifest descriptors',
      'Executor manifest all original output bytes/SHA/set/time authority must bind original strict baseline stdout/stderr and Node diagnostics',
      'Node report cannot authorize logs or turn original baseline1 intoPASS; five comparisons baselineEligiblefalse and cause/workerd grace stillfalse',
      'Keep timeout/interruption/forced kill outcomes, unknown or inconsistent actuals and mutated/missing outputs blocked or strictly negative; never upgrade toPASS']},
  prospectiveConfig:'Needs exact final runtime source SHA and finished Root/CI/diagnostic roots; preserve prepared base473, no guessing current Linux result. Whole tools root uses nested historical reference paths, no overlapping reference child root.',
  helperSourceModified:false,repositoryWrites:0,gitCommands:0,ciQueries:0,applicationRuntimeTests:0,productionRequests:0,
  fullG7Verified:false,fullG8Verified:false,fullNativeCancelVerified:false,gatePassDerived:false,oldFailuresPreserved:true};
const reportPath=path.join(root,'FINAL-readonly-inventory-advisory.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const names=fs.readdirSync(root).sort(),files=names.map(file=>({file,...pin(path.join(root,file))}));
const sealPath=path.join(root,'FINAL-readonly-inventory-seal.json');fs.writeFileSync(sealPath,JSON.stringify({schema:'cinatoken-frozen-readonly-inventory-seal-v1',files,
  filesBeforeSelf:files.length,filesIncludingSelf:files.length+1,selfExcluded:'FINAL-readonly-inventory-seal.json',
  inventoryReadHashOutcome:0,archiveAdmissionOutcome:1,exclusions:0,growingCurrentRootNotEnumerated:true,productionRequests:0,writesStop:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({inventoryReadHashOutcome:0,archiveAdmissionOutcome:1,final:pin(reportPath),seal:pin(sealPath),writesStop:true}));

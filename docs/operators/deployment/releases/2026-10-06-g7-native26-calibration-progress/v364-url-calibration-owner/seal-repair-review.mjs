import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken',sha=b=>createHash('sha256').update(b).digest('hex');
const describe=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:sha(bytes)};};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const before=read(path.join(root,'source-before.index.json')),analysis=read(path.join(root,'actual-artifact-analysis.stdout.txt')),closedFacts=read(path.join(root,'original-closed-facts.stdout.txt')),checks=read(path.join(root,'final-repair-contracts.stdout.txt'));
assert.equal(analysis.actualReadAnalysisOutcome,0);assert.equal(analysis.actualRuntimeOutcome,1);assert.equal(analysis.artifactFileCount,16);
assert.equal(checks.actualLocalReviewOutcome,0);assert.equal(checks.checks.length,10);
assert.equal(closedFacts.aggregateActualExit,1);assert.equal(closedFacts.actualProcessExit,1);assert.equal(closedFacts.ndjsonEqualsEvents,true);
const unchangedArtifact=[...analysis.files,analysis.additionalClosedCiLog].map(item=>{assert.deepEqual(describe(item.file),item);return item;});assert.equal(unchangedArtifact.length,17);
const sourceAfter=before.files.map(row=>{const current=path.join(repo,row.relative),bytes=fs.readFileSync(current),copy=path.join(root,'source-after',row.relative);fs.mkdirSync(path.dirname(copy),{recursive:true});fs.writeFileSync(copy,bytes,{flag:'wx'});assert.deepEqual(fs.readFileSync(copy),bytes);return {...describe(current),relative:row.relative,sourceSnapshot:describe(copy),changed:sha(bytes)!==row.sha256};});
assert.deepEqual(sourceAfter.filter(x=>x.changed).map(x=>x.relative).sort(),['scripts/diagnostics/v364-direct-socket/native-reader-calibration.mjs','scripts/diagnostics/v364-direct-socket/sealed-package.json']);
const manifest=read(path.join(repo,'scripts/diagnostics/v364-direct-socket/sealed-package.json'));assert.equal(manifest.preparedAtHead,'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc');
for(const item of manifest.files){const d=describe(path.join(repo,'scripts/diagnostics/v364-direct-socket',item.path));assert.equal(d.bytes,item.bytes);assert.equal(d.sha256,item.sha256);}
const input=read(path.join(repo,'scripts/diagnostics/v364-direct-socket/source-inputs.json'));assert.equal(input.preparedAtHead,'702c4d71379acb697024ef846725871582bff94f');
for(const item of [...input.files,...input.installedFiles]){const d=describe(path.join(repo,item.path));assert.equal(d.bytes,item.bytes);assert.equal(d.sha256,item.sha256);}
const receipts=fs.readdirSync(root).filter(x=>x.endsWith('.result.json')).map(name=>{const file=path.join(root,name),row=read(file);assert.equal(row.closed,true);assert.ok([0,1].includes(row.actualExit));assert.equal(row.signal,null);assert.equal(row.spawnError,null);
 for(const stream of ['stdout','stderr']){const actual=describe(row[stream].path);assert.equal(actual.bytes,row[stream].bytes);assert.equal(actual.sha256,row[stream].sha256);}
 return {receipt:describe(file),actualExit:row.actualExit,stdout:row.stdout,stderr:row.stderr};});
for(const label of ['final-repair-contracts','final-stamped-format-check','final-owned-diff','final-owned-diff-check','final-syntax','repaired-prepare-only','original-closed-facts']){assert.equal(read(path.join(root,label+'.result.json')).actualExit,0);}
const calibration=analysis.results.find(x=>x.result.caseId==='native-worker-reader-cancel');assert.equal(calibration.result.actualExit,1);assert.equal(calibration.result.nativeWorkerExecuted,false);
const innerError=calibration.nonDiagnosticWorkerLogs.find(x=>x.level==='error');assert.ok(innerError.message.includes('-   404'));assert.ok(innerError.message.includes('+   200'));
const prep=read(path.join(root,'repair-prepared-only/prepare-only.json'));assert.equal(prep.runtimeExecuted,false);assert.equal(prep.actualExit,0);assert.equal(prep.checkoutSHA,'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc');
const report={schema:'v364-direct-address-repair-final-review-v1',closed:true,sealedAt:new Date().toISOString(),actualReadAndPreparationOutcome:0,
 observedHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 cohorts:{originalPackagePreparationHead:'702c4d71379acb697024ef846725871582bff94f',actualFailedRuntimeSource:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',actualFailedRuntimeRun:37412108171,currentRepairPreparedAtHead:manifest.preparedAtHead,futureRepairExecutionSHA:null,futureRepairExecutionNotClaimed:true},
 actualFailedRuntime:{sourceSHA:analysis.sourceSHA,aggregateActualExit:1,actualProcessExit:1,runnerOutcomeCode:1,originalStrict:closedFacts.originalStrict,
  fourDirectNativeCases:analysis.results.filter(x=>x.result.directSocket).map(x=>({caseId:x.result.caseId,actualExit:x.result.actualExit,originalWindow:x.result.originalWindow,tail:x.result.tail,finalPreDisposeSnapshot:x.result.finalPreDisposeSnapshot,directSocketProof:x.directSocketProof,workerKinds:x.workerKinds,signalAborts:x.signalAborts.map(r=>r.diagnostic)})),
  calibrationResult:calibration.result,actualCalibrationInnerError:innerError,closure:analysis.closure,closedFacts},
 originalArtifactFileHashes:analysis.files,additionalOriginalClosedCiLog:analysis.additionalClosedCiLog,verifiedOriginalArtifactsAndLog:17,artifactContainsRegularFiles:16,
 sourceBefore:before,sourceAfter,protected21Unchanged:true,installed3Unchanged:true,otherFivePackageAndWorkflowSourcesUnchanged:true,
 repair:{problem:'Diagnostic native-reader helper forwarded localhost /fixture/complete-text to the private holder, whose exact origin/path guard rejected it with 404. Its status assertion caused the outer HTTP 500 before any reader.cancel calibration.',
  actualSourceAuthority:['packages/proxy/scripts/staging/chat-holder-private-v364.ts:97-98','packages/proxy/scripts/staging/chat-holder-gateway-v364.ts:16','original artifact native-reader-calibration.mjs:29-32'],
  change:'Construct the local holder Request with the same canonical https://holder.service.invalid/complete-text-attempt target as the frozen gateway, retaining the original Request init, env and ctx. Update only its manifest bytes/SHA and latest preparation head.',
  requestMethodHeadersBodySignalPreserved:true,originalReaderAndWaitAssertionsASTUnchanged:true,ctxAndNoNewLifetimeTaskPreserved:true,fourNativeArmsUnchanged:true,originalStrictEightSourceAndAssertionsUnchanged:true,flagsAndWindowAndDependencyUnchanged:true,
  sourceInputsReviewBase702RemainsImmutableHistoricalOrigin:true,latestManifestPreparationBaseDcc6:true,canonicalTarget:checks.canonicalTarget},
 ownedDiff:describe(path.join(root,'final-owned-diff.stdout.txt')),localContractChecks:checks,
 prepareOnly:describe(path.join(root,'repair-prepared-only/prepare-only.json')),workerBundleHashes:prep.bundleHashes,receipts,
 preservedLocalFailures:{guardControlActualExit:read(path.join(root,'repair-local-contracts.result.json')).actualExit,guardControlReason:'Original if condition can return a truthy query string; Temp checker initially required literal true. Corrected only Temp Boolean coercion to preserve the original if semantics.',formatterInitialActualExit:read(path.join(root,'final-format-check.result.json')).actualExit,formatterReason:'Temp Prettier API omitted editorconfig options; actual CLI formatting restored the original tab style. Source semantics and original failed logs retained.'},
 limitations:{realWorkerdOrMiniflareStartedLocally:false,originalTestsReexecuted:false,helperOrHolderApplicationExecutedLocally:false,pureNodeRequestConstructorIsNotNativeWorkerdProof:true,newLinuxOrCiExecuted:false,productionRequests:0,gitMutation:false,workflowModified:false,mainMigrationMdModified:false,originalArtifactsModified:false,strictV364Passed:false,nativeCalibrationNowProven:false,fourDirectCasesPassed:false,fullG7Passed:false,fullG8Passed:false,gracefulWorkerdProven:false},
 nextFalsifiableStep:'Root may commit this concrete diagnostic-only address fix and run it once under a new SHA. A successful native reader calibration would qualify only active-worker explicit cancellation. Original strict and all HTTP direct cases remain independent real gates; their old failures never upgrade.'};
const output=path.join(root,'FINAL-v364-direct-address-repair.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({closed:true,actualReadAndPreparationOutcome:0,report:describe(output),changedSourceHashes:sourceAfter.filter(x=>x.changed).map(({relative,bytes,sha256})=>({path:relative,bytes,sha256})),receipts:receipts.length,originalRuntimeOutcome:1,newRuntimeExecuted:false}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken',owned='scripts/diagnostics/v364-direct-socket';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const describe=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:sha(bytes)};};
const sourceFiles=fs.readdirSync(path.join(repo,owned)).map(p=>owned+'/'+p).concat('.github/workflows/v364-direct-socket.yml').sort();
assert.equal(sourceFiles.length,7);
const packageFile=path.join(repo,owned,'sealed-package.json'),manifest=JSON.parse(fs.readFileSync(packageFile,'utf8'));
assert.equal(manifest.schema,'v364-direct-socket-sealed-package-v1');assert.equal(manifest.files.length,5);
assert.deepEqual(manifest,JSON.parse(fs.readFileSync(path.join(root,'sealed-package.before-format.json'),'utf8')),'manifest formatting is semantic identity');
for(const row of [...manifest.files.map(x=>({...x,file:path.join(repo,owned,x.path)})),{...manifest.workflow,file:path.join(repo,manifest.workflow.path)}]){
 const item=describe(row.file);assert.equal(item.bytes,row.bytes);assert.equal(item.sha256,row.sha256);
}
const input=JSON.parse(fs.readFileSync(path.join(repo,owned,'source-inputs.json'),'utf8'));
for(const row of [...input.files,...input.installedFiles]){const d=describe(path.join(repo,row.path));assert.equal(d.bytes,row.bytes);assert.equal(d.sha256,row.sha256);}
fs.mkdirSync(path.join(root,'source-after'));
const sources=sourceFiles.map(relative=>{const current=path.join(repo,relative),bytes=fs.readFileSync(current);assert.ok(!/[ \t]+$/mu.test(bytes.toString('utf8')),'no trailing whitespace');
 const copy=path.join(root,'source-after',relative);fs.mkdirSync(path.dirname(copy),{recursive:true});fs.writeFileSync(copy,bytes,{flag:'wx'});assert.deepEqual(fs.readFileSync(copy),bytes);return {...describe(current),relative,sourceSnapshot:describe(copy)};});
const receipts=fs.readdirSync(root).filter(p=>p.endsWith('.result.json')).map(relative=>{
 const file=path.join(root,relative),value=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(value.closed,true);
 for(const stream of ['stdout','stderr']){const item=value[stream],d=describe(item.path);assert.equal(d.bytes,item.bytes);assert.equal(d.sha256,item.sha256);}
 assert.ok(Number.isSafeInteger(value.actualExit));assert.equal(value.signal,null);assert.equal(value.spawnError,null);
 return {relative,receipt:describe(file),actualExit:value.actualExit,stdout:value.stdout,stderr:value.stderr,operation:value.operation};
});
const contract=JSON.parse(fs.readFileSync(path.join(root,'local-contracts-corrected.stdout.txt'),'utf8'));assert.equal(contract.actualOutcome,0);assert.equal(contract.checks.length,13);
const negative=JSON.parse(fs.readFileSync(path.join(root,'windows-negative/executor.closed.json'),'utf8'));
assert.equal(negative.actualExit,1);assert.equal(negative.actualProcessExit,null);assert.equal(negative.closedReportPresent,false);assert.equal(negative.closure.directChildReaped,false);
const prep=JSON.parse(fs.readFileSync(path.join(root,'prepared-only/prepare-only.json'),'utf8'));assert.equal(prep.actualExit,0);assert.equal(prep.runtimeExecuted,false);
const expectedExits={'generator-second':0,'input-seal':0,'formatter-write':0,'refine-runner':0,'runner-format':0,'main-syntax':0,'calibration-syntax':0,'actual-prepare':0,'local-contracts':1,'local-contracts-corrected':0,'python-syntax':0,'final-formatter-check':0,'package-seal':0,'manifest-format-check':1,'manifest-format-write':0,'all-final-format-check':0,'windows-executor-admission':1,'existing-output-negative':1};
for(const [label,expected] of Object.entries(expectedExits)){const receipt=receipts.find(r=>r.relative===label+'.result.json');assert.ok(receipt);assert.equal(receipt.actualExit,expected);}
const report={schema:'v364-direct-socket-final-preparation-v1',closed:true,actualPreparationReviewOutcome:0,sealedAt:new Date().toISOString(),
 preparedAtHead:input.preparedAtHead,observedFinalHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),executionSHAIsSeparate:true,
 sources,protectedSourceInputs:input.files,installedDirectSocketInputs:input.installedFiles,manifest:describe(packageFile),
 originalStrictBaselineUnchanged:true,allFourNativeCancellationFunctionAssertionsAndWindowASTPreserved:true,sourceProtectionAudit:contract,
 preparationResult:describe(path.join(root,'prepared-only/prepare-only.json')),workerBundles:prep.bundleHashes,
 expectedDiagnosticCases:['native-worker-reader-cancel','direct-socket-bare-destroy','direct-socket-bare-rst','direct-socket-binding-destroy','direct-socket-binding-rst'],
 originalBaselineSeparate:true,baselineFailureCannotUpgradeToAggregatePass:true,
 supervisor:{copiedFrom:'scripts/diagnostics/v364-owned-linux-boundary/execute-owned-linux.py',changes:'Exact schema/runner/workflow/5-case identifiers and counts only; cleanup/status logic retained',original:input.files.find(x=>x.path.endsWith('v364-owned-linux-boundary/execute-owned-linux.py')),timeoutSeconds:360,workflowStepMinutes:7,workflowJobMinutes:10,ownership:'new isolated Linux process group; subreaper; real direct-child wait and individually identified adopted zombies',gracefulWorkerdClaim:false},
 receipts,localChecks:{contracts:13,nodeSyntax:2,pythonSyntax:1,finalFormatterCheckActualExit:0,realPreparationBundleExit:0,freshOutputNegativeActualExit:1,windowsGuardActualExit:1,windowsNativeChildCreated:false},
 negativeEvidence:{initialGeneratorActualExit:1,initialGeneratorEvidence:describe(path.join(root,'initial-generator-failure.tool-result.json')),initialInertSchemaTestActualExit:1,inertSchemaTestRepair:'Only Temp stub changed from plain class to actual Log subclass; product candidate unchanged',initialManifestFormatActualExit:1,manifestFormatSemanticIdentity:true,windowsNegative:describe(path.join(root,'windows-negative/executor.closed.json')),originalReadDiscoveryFailures:describe(path.join(root,'local-discovery-negatives.tool-results.json')),firstGeneratorReceiptOperationWasCopiedReadOnlyLabelButActuallyLocalPreparation:true},
 limits:{actualLinuxExecuted:false,MiniflareInstantiatedLocally:false,WorkerdStartedLocally:false,originalTestsExecutedLocally:false,fixtureRuntimeTestsExecutedLocally:false,productionRequests:0,ciInvocations:0,gitMutation:false,productionSourceModified:false,oldDiagnosticSourceModified:false,oldSealedEvidenceModified:false,mainMigrationDocumentModifiedByThisAgent:false,originalStrictGatePassed:false,fullG7Passed:false,fullG8Passed:false,nativeReaderPositiveControlProven:false,gracefulWorkerdProven:false},
 preparationReportDoesNotAssertFutureRuntimeSuccess:true,ownCurrentSealCommandReceiptExcludedUntilClosed:true};
const out=path.join(root,'FINAL-v364-direct-socket-preparation.json');fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({closed:true,actualPreparationReviewOutcome:0,report:describe(out),sourceHashes:sources.map(({relative,bytes,sha256})=>({path:relative,bytes,sha256})),receiptCount:receipts.length}));

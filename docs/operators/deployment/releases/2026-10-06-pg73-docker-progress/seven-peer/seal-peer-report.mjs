import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const repo='C:/cinagroup/cinatoken';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=name=>{const target=path.join(dir,name);const bytes=fs.readFileSync(target);return {path:target,bytes:bytes.length,sha256:sha(bytes)};};
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const audit=read('v4-acorn-shared-fixture-audit.json');
assert.equal(audit.actualExit,0); assert.equal(audit.totals.orderedAssertions,356);
const labels=['acorn-peer-audit','acorn-peer-audit-v2','acorn-peer-audit-v3','acorn-peer-audit-v4','helper-load-without-loader','helper-load-with-tsx'];
const runs=labels.map(label=>{
  const proof=read(label+'.result.json');
  assert.equal(proof.signal,null); assert.equal(proof.spawnError,null);
  assert.equal(fs.statSync(proof.stdoutPath).size,proof.stdoutBytes);
  assert.equal(fs.statSync(proof.stderrPath).size,proof.stderrBytes);
  return {label,proof,result:record(label+'.result.json'),stdout:record(label+'.stdout.txt'),stderr:record(label+'.stderr.txt')};
});
assert.deepEqual(runs.map(run=>run.proof.actualExitCode),[1,1,1,0,1,0]);
const bare=fs.readFileSync(path.join(dir,'helper-load-without-loader.stderr.txt'),'utf8');
assert.ok(bare.includes('ERR_MODULE_NOT_FOUND') && bare.includes('provision-postgres-roles'));
const load=JSON.parse(fs.readFileSync(path.join(dir,'helper-load-with-tsx.stdout.txt'),'utf8'));
assert.equal(load.count,73); assert.equal(load.last,'0073_recovery_api_key_workspace_lock.sql');
assert.equal(load.postgresStarted,false); assert.equal(load.postgresConnections,0);
for(const source of audit.files) {
  const current=fs.readFileSync(path.join(repo,source.file));
  assert.equal(current.length,source.after.bytes); assert.equal(sha(current),source.after.sha256);
}
const head=spawnSync('C:/Program Files/Git/cmd/git.exe',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true});
assert.equal(head.status,0); assert.equal(head.stderr,'');
assert.equal(head.stdout.trim(),'b1ec8f33cf24edc07e8855c059c1498730a43113');
const inventory=fs.readdirSync(dir).filter(name=>fs.statSync(path.join(dir,name)).isFile()).sort().map(record);
const final={schema:'cinatoken.pg73.shared-fixture.peer-review.v1',at:new Date().toISOString(),actualExit:0,conclusion:'PASS: independent static/source review, no code blocker within the seven fixtures and one workflow loader line',baseCommit:'cecd81638e97bf919d5988e9037a10f9dbfcef3f',observedCurrentHead:head.stdout.trim(),scope: audit.files.map(item=>item.file).concat(audit.workflow.file),independentParser:{name:'Acorn',version:audit.acorn.version,assertions:356,assertionAstExact:true,assertionSourceExact:true,bigIntValues:'retained as exact decimal tagged values',regexpValues:'retained as exact pattern and flags',onlyDroppedAstMetadata:['start','end','loc']},byteChecks:{sevenBeforeSnapshotsEqualFixedBase:true,sevenAfterSnapshotsEqualCurrentSource:true,allSevenFullReverseRestorationsEqualOriginalBuffers:true,allSevenForwardReplaysEqualAfterBuffers:true,workflowSingleTsxAdditionReverseEqualsFullOriginalBuffer:true},files:audit.files.map(({file,before,after,orderedAssertions,successfulGrantAdaptations,grantNegativeCallsChanged,snapshots})=>({file,before,after,orderedAssertions,successfulGrantAdaptations,grantNegativeCallsChanged,snapshots})),workflow:audit.workflow,quoteSemantics:audit.quoteSemantics,loader:{nodeRuntimeUsedForLocalProbe:'v24.14.1 Windows',workflowConfiguredNodeVersion:22,sourceGraph:audit.loaderNecessity.topLevelDependencyGraph,withoutLoader:{actualExit:1,error:'ERR_MODULE_NOT_FOUND for extensionless provision-postgres-roles imported by grant-postgres-runtime.ts',expectedDiagnosticFailure:true},withTsx:{actualExit:0,filesystemOnly:true,pinnedCorpusCount:73,lastMigration:load.last,postgresStarted:false,postgresConnections:0},node22NativeResultClaim:false,reason:'The helper imports TypeScript at top level even for listPg73Migrations; the current extensionless TypeScript dependency graph requires the existing tsx loader convention. Six other reviewed workflow commands already have this loader.'},unchangedProductionAndHelperSources:audit.unchangedSources,rawRuns:runs,reviewerAttemptFailures:{initialAudit:'Actual exit1: Acorn BigInt literal values require explicit lossless JSON encoding in the reviewer normalizer; original raw preserved.',secondAudit:'Actual exit1: wx refused overwrite of a previously sealed quote snapshot; original raw preserved.',thirdAudit:'Actual exit1: branch HEAD had advanced to the repair commit, so mutable HEAD no longer represented workflow before; original raw preserved.',finalAudit:'Actual exit0 after explicit lossless BigInt/RegExp encoding, new wx snapshot namespace, and the fixed approved original commit. Source assertions and production fixtures were not changed by the reviewer.'},auditReport:record('v4-acorn-shared-fixture-audit.json'),rawInventory:inventory,limitations:{postgresExecuted:false,nativeFixtureExecuted:false,nativePgPassClaim:false,nativeSkipUsedAsPass:false,ciPolled:false,productionRequests:0,sourceWritesByReviewer:0,gitMutationsByReviewer:0},requiredNext:'Parent-owned real Linux PostgreSQL 18.6 CI must establish actual runtime test results; this review does not establish native PASS.'};
const target=path.join(dir,'FINAL-shared-fixture-peer-review.json');
fs.writeFileSync(target,JSON.stringify(final,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,report:record('FINAL-shared-fixture-peer-review.json'),assertions:356,files:7,workflowLoaderLines:1,nativePassClaim:false}));

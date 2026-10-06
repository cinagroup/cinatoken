import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const own=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const target='scripts/db/cutover/postgres-shared-key-usage-repair-jobs.native.test.mjs';
const raw=file=>{const b=fs.readFileSync(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const git=args=>execFileSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const proofFile=path.join(own,'local-audit.proof.json'),proof=json(proofFile);
assert.equal(proof.actualExit,0);assert.equal(proof.allOtherBytesAndOriginalAssertionsPreserved,true);
const after=raw(path.join(root,target));assert.equal(after.sha256,proof.after.sha256);assert.equal(after.bytes,proof.after.bytes);
const commands=['syntax-check','local-readonly-audit','pure-repair-builders','target-diff-check','target-patch','after-step17-inventory-v3'].map(label=>{
  const resultFile=path.join(own,label+'.result.json'),result=json(resultFile);
  assert.equal(result.actualExitCode,0);assert.equal(result.signal,null);assert.equal(result.spawnError,null);
  return {label,actualExit:0,command:[result.program,...result.arguments],result:raw(resultFile),stdout:raw(result.stdoutPath),stderr:raw(result.stderrPath)};
});
const prior='C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4';
const stateFile=path.join(prior,'pg-ci-progress-3.stdout.log'),state=json(stateFile);
assert.equal(state.headSha,'abe8eb89e8cdbac005bc085d61acf5d2213a2f23');
const native=state.jobs.find(job=>job.name==='native-financial-consumer');
const scale=native.steps.find(step=>step.number===14),failed=native.steps.find(step=>step.number===17);
assert.equal(scale.conclusion,'success');assert.equal(failed.conclusion,'failure');
const logResult=path.join(prior,'pg-native-job-log-retry.result.json'),logClosed=json(logResult);
assert.equal(logClosed.actualExit,0);assert.equal(logClosed.signal,null);
const log=fs.readFileSync(logClosed.stdout,'utf8');
assert.ok(log.includes('81 !== 73'));
assert.ok(log.includes('postgres-shared-key-usage-repair-jobs.native.test.mjs:83:14'));
const inventoryFile=path.join(own,'after-step17-inventory.json'),inventory=json(inventoryFile);
const report={
  schema:'pg73-shared-usage-jobs-repair-ready-for-linux-ci',at:new Date().toISOString(),localAuditActualExit:0,
  baselineHead:'abe8eb89e8cdbac005bc085d61acf5d2213a2f23',currentHead:git(['rev-parse','HEAD']),target,
  before:proof.before,after,beforeGitBlob:git(['rev-parse','abe8eb89e8cdbac005bc085d61acf5d2213a2f23:'+target]),
  afterWorktreeGitBlob:git(['hash-object','--',target]),onlyChangedRepositoryFileByThisAgent:target,
  originalCI:{runID:37389221454,jobID:112030043323,headSHA:state.headSha,url:state.url,jobConclusion:native.conclusion,priorScaleStep14:scale,failedUsageJobsStep17:failed,laterSkipped:native.steps.filter(step=>step.number>17&&step.conclusion==='skipped').length,
    jobState:raw(stateFile),jobStateClosedResult:raw(path.join(prior,'pg-ci-progress-3.result.json')),rawJobLogResult:raw(logResult),rawJobLog:raw(logClosed.stdout),firstLogCLIActualExit:json(path.join(prior,'pg-native-job-log.result.json')).actualExit,
    firstLogFailurePreserved:raw(path.join(prior,'pg-native-job-log.result.json')),latestRunNotRequeried:true},
  correctedSetup:{
    expression:'const files = await listPg73Migrations();',unchangedCount73:true,pinnedCorpus:proof.actualHistoricalLoader,
    grant:'await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: original owned loopback migrator URL })',
    rationale:'The current production grant requires0074. The existing PG73 test-only bridge temporarily installs0074, invokes that same unmodified production grant and audit ACL verification, then removes0074 and rechecks the exact73 ledger.',
    runtimeLogin:'This target already creates a restricted runtime LOGIN with a random password. The bridge records can_login=true, does not toggle its LOGIN flag, and finally verifies all role attributes equal the original state. The target retains the password-authenticated runtime client and SQLSTATE42501 checks.',
    preserved:'Every original schema count, six runtime ACLfalse values, real runtime permission denial, proposal activation/drift rollback, atomic credit+ledger enqueue, simulated crash rollback/retry, holder lock order,33rd SKIP LOCKED due job, balance/token totals, source digests,240s deadline and native cleanup assertion/body remains byte-identical.'},
  localValidation:{proof:raw(proofFile),commands,pureBuilders:{tests:4,passed:4,failed:0,skipped:0},exactFourSubstitutionsOnly:true,nativeFixtureExecuted:false,bridgeExecuted:false,dbConnections:0,dbWrites:0,productionRequests:0},
  nextWorkflowInventory:{report:raw(inventoryFile),counts:inventory.totals,plannedBatches:inventory.proposedBatches,notRuntimeFailures:true,
    immediateNext:'step18 backfill and19 durablecursor are alreadyPG73 pinned. Step20 runtimegrant is the next static all81/count73 candidate and requires individual NOLOGIN/0074/directLOGIN/membership-negative semantics review, not a blanket bridge replacement.'},
  toolingFailures:{inventoryInitialAndRetry:'Both local inventory attempts exited1 because the parser initially added only Set up job and omitted the automatic Initialize containers step. Both raw failures remain; the final parser includes both automatic steps, cross-checks target17, and exited0. These are inventory tool failures, not database fixture executions.'},
  pendingValidation:{result:'NOT EXECUTED LOCALLY; actual Linux PostgreSQL assertions required',workflow:'.github/workflows/proxy-dispatch-safety.yml',job:'native-financial-consumer',
    command:'gosu postgres env HOME=/var/lib/postgresql GATEWAY_NATIVE_PG_BIN=/usr/lib/postgresql/18/bin node --import tsx --test scripts/db/cutover/postgres-shared-key-usage-repair-jobs.native.test.mjs'},
  scope:{formalSQLChanges:0,proposalSQLChanges:0,productionGrantChanges:0,otherTestChanges:0,MDChanges:0,gitMutations:0,CIInvocations:0,prodDBOrFlagsChanged:false},
  permissionConcurrency:'Only owned loopback cluster/clients may execute the native fixture. Existing separate max1 migrator and holder stay unchanged; the bridge opens the normal production grant connection against the same owned test cluster only. All role changes and audit objects restore before native ACL/queue tests. Workflow cancel-in-progress can cancel a superseded push; Root owns commit/push/CI coordination.',
  sourceReferences:['scripts/db/cutover/pg73-native-fixture.mjs','scripts/db/cutover/grant-postgres-runtime.ts','packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql','packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql'].map(name=>({name,...raw(path.join(root,name))}))
};
const output=path.join(own,'FINAL-pg73-usage-jobs-repair.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:raw(output),before:report.before,after:report.after,beforeGitBlob:report.beforeGitBlob,afterWorktreeGitBlob:report.afterWorktreeGitBlob,localAuditActualExit:0,pureBuilders:report.localValidation.pureBuilders,pendingValidation:report.pendingValidation},null,2));

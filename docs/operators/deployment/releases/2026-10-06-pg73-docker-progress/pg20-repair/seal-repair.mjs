import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const own=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const target='scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs';
const raw=file=>{const b=fs.readFileSync(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const git=args=>execFileSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const proofFile=path.join(own,'change-audit.proof.json'),proof=json(proofFile);
assert.equal(proof.actualExit,0);assert.equal(proof.retainedOriginalAssertions,13);
assert.equal(proof.originalAssertCount,14);assert.equal(proof.allOtherOriginalBytesPreserved,true);
const source=path.join(root,target),afterFile=path.join(own,'after.native.test.mjs');
assert.equal(raw(source).sha256,proof.after.sha256);
fs.copyFileSync(source,afterFile,fs.constants.COPYFILE_EXCL);
assert.deepEqual(fs.readFileSync(afterFile),fs.readFileSync(source));
const labels=['syntax-check','change-audit-v2','cleanup-control-flow','pure-repair-builders','target-diff-check','target-patch'];
const commands=labels.map(label=>{
  const file=path.join(own,label+'.result.json'),result=json(file);
  assert.equal(result.actualExitCode,0);assert.equal(result.signal,null);assert.equal(result.spawnError,null);
  return {label,actualExit:result.actualExitCode,command:[result.program,...result.arguments],result:raw(file),stdout:raw(result.stdoutPath),stderr:raw(result.stderrPath)};
});
const checks=[['cleanup-control-flow',8],['pure-repair-builders',4]].map(([label,total])=>{
  const output=fs.readFileSync(path.join(own,label+'.stdout.txt'),'utf8');
  assert.ok(output.includes('tests '+total));assert.ok(output.includes('pass '+total));assert.ok(output.includes('fail 0'));assert.ok(output.includes('skipped 0'));
  return {label,tests:total,passed:total,failed:0,skipped:0};
});
const planFile='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-runtime-grant-plan-f0bc0cabd77f47cd9ff14a137cf1d6ce/FINAL-step20-runtime-grant-plan.json';
const plan=json(planFile);
const unchangedSources=plan.evidence.sources.map(item=>{
  const actual=raw(item.path);assert.equal(actual.sha256,item.sha256);assert.equal(actual.bytes,item.bytes);
  return {...actual,unchangedSinceReviewedPlan:true};
});
const baselineHead='cecd81638e97bf919d5988e9037a10f9dbfcef3f';
const report={
  schema:'pg73-runtime-grant-repair-ready-for-real-linux-ci',at:new Date().toISOString(),localChecksActualExit:0,
  baselineHead,currentHead:git(['rev-parse','HEAD']),target,
  before:raw(path.join(own,'before.native.test.mjs')),afterWorkingFile:raw(source),afterImmutableSnapshot:raw(afterFile),
  beforeGitBlob:git(['rev-parse',baselineHead+':'+target]),afterWorktreeGitBlob:git(['hash-object','--',target]),
  changedRepositoryFilesByThisAgent:[target],
  originalFailure:{source:'Root-confirmed closed CI37390678189 on5471899c8fd43daf9df1f15261d75171a6dbb8b8',step20:'actual81!=73',priorSteps14And17And18And19:'success per Root confirmation',notRequeriedByThisAgent:true},
  implementation:{
    migrationSelection:'listPg73Migrations freezes73,last0073,corpusSHA23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc and ledgerMD5ca1ea96a1b4bcd0675642f30dcf48042',
    ordinaryCalls:'Eight grantRuntime calls invoke the existing grantPg73RuntimeFixture with the original owned cluster/migrator/loopbackURL. The existing bridge calls unchanged production grant under temporary0074/directLOGIN and restores exactPG73/NOLOGIN.',
    membershipNegative:'The dedicated local helper admits only the intended shadow membership on an otherwise restrictedNOLOGIN role. It snapshots role attributes, member/parent/grantor names and all membership options, job/users table ACL/owner and both definer ACL/owner plus effective privileges. It temporarily installs0074 and LOGIN, directly calls unmodified grantPostgresRuntime and accepts onlyP0001 with the exact current directLOGIN/no-memberships message.',
    rejectionChecks:'After the actual grant rejection, role/membership state except the explicit LOGIN flag and all recorded business ACLs/effective privileges must match their pre-grant snapshots.',
    cleanup:'Attempt flags are set before await. Nested finally drops only the pre-verified absent temporary audit table withoutCASCADE, deletes only0074 ledger, restoresNOLOGIN even if audit cleanup throws, then checks exact73 ledger/audit absence and original role/membership/ACL state. Cleanup failures are not suppressed.',
    originalAssertions:'Original14 assertion calls:13 preserved (only their ordinary grant call inputs use the bridge), one obsolete later-ACL membership message updated to exact current production early-rejection policy. All other original code bytes are preserved except reviewed import/loader/wrapper/call substitutions and added local helpers.',
    unchangedSemantics:'Partial catalog rollback, optional repair table/definer exclusion, ordinary users SELECT, both42501 operations, function catalog drift, third-party shadow ACL rejection, inherited repair_table=true before role rejection, final owner-only checks,240000ms native test deadline and cluster cleanup remain.'
  },
  localEvidence:{audit:raw(proofFile),commands,tests:checks,
    controlFlowTestNature:'Eight fault tests execute the extracted unchanged candidate JavaScript helper functions against stateful inert SQL/grant stubs. They prove exact-message/SQLSTATE rejection and cleanup control flow under acknowledgement, install, ACL-drift and cleanup errors. They do not execute PostgreSQL, roles, grants, locks or the native fixture.',
    historicalCorpusNature:'Only the real listPg73Migrations filesystem function was executed. Production grant code was not invoked against a DB.',
    nativeFixtureExecuted:false,nativePGPassed:false,dbConnections:0,dbWrites:0,productionRequests:0,nodeVersion:process.version},
  preservedToolingFailure:{initialAudit:raw(path.join(own,'change-audit.result.json')),stdout:raw(path.join(own,'change-audit.stdout.txt')),stderr:raw(path.join(own,'change-audit.stderr.txt')),
    actualExit:json(path.join(own,'change-audit.result.json')).actualExitCode,reason:'The first Temp audit imported TypeScript via a Windows C: path, rejected by Node ESM before audit execution. It was corrected tofile:/// and the fresh-label change-audit-v2 exited0; the original raw remains.'},
  reviewedPlan:raw(planFile),unchangedProductAndHelperSources:unchangedSources,
  scope:{productionHelperChanges:0,formalSQLChanges:0,proposalSQLChanges:0,otherTestChanges:0,MDChanges:0,CIChanges:0,DockerChanges:0,gitMutations:0,CIInvocations:0,CIPolls:0,deploymentOperations:0,productionDBOrFlagsOrBindingsChanged:false},
  pendingValidation:{status:'NOT RUN LOCALLY; Root owns review/commit/push and the real Linux PostgreSQL fixture result',
    workflow:'.github/workflows/proxy-dispatch-safety.yml',job:'native-financial-consumer',
    command:'gosu postgres env HOME=/var/lib/postgresql GATEWAY_NATIVE_PG_BIN=/usr/lib/postgresql/18/bin node --import tsx --test scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs'},
  permissionsAndConcurrency:'All new mutations are inside the opt-in native fixture against its newly owned random loopback cluster only. The negative helper verifies the owned port, migrator URL/identity/schema ownership and pinned baseline before mutations. The deliberate membership remains until the original following REVOKE; no production policy is weakened. Root coordinates CI concurrency/cancel-in-progress; Windows skip is not counted as a pass.'
};
const output=path.join(own,'FINAL-pg73-runtime-grant-repair.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:raw(output),before:report.before,after:report.afterWorkingFile,afterImmutableSnapshot:report.afterImmutableSnapshot,beforeGitBlob:report.beforeGitBlob,afterWorktreeGitBlob:report.afterWorktreeGitBlob,localChecksActualExit:report.localChecksActualExit,tests:checks,nativePGPassed:false},null,2));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const repo = 'C:/cinagroup/cinatoken';
const info = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const auditPath = 'eight-source-audit-v2.json';
const auditBytes = await readFile(join(root,auditPath));
const audit = JSON.parse(auditBytes); assert.equal(audit.actualExit,0); assert.equal(audit.totals.assertions,409);
const labels = [ 'implement-eight-v2', 'add-original-lock-proof', 'audit-eight', 'prepare-final-local-checks',
  'syntax-1', 'syntax-2', 'syntax-3-v2', 'syntax-4', 'syntax-5', 'syntax-6', 'syntax-7', 'syntax-8',
  'existing-helper-control-flow', 'native-environment-probe', 'fix-new-lock-lines-lf', 'audit-eight-v2', 'eight-diff-check-v2' ];
const receipts = [];
for (const label of labels) {
  const receiptBytes = await readFile(join(root,label+'.closed.json'));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.actualExit,0); assert.equal(receipt.childClosed,true); assert.ok(receipt.finishedAt);
  const stdout = await readFile(join(root,receipt.stdout)); const stderr = await readFile(join(root,receipt.stderr));
  receipts.push({ label, file:label+'.closed.json', ...info(receiptBytes), actualExit:receipt.actualExit, startedAt:receipt.startedAt,
    finishedAt:receipt.finishedAt, childClosed:true, stdout:{file:receipt.stdout,...info(stdout)}, stderr:{file:receipt.stderr,...info(stderr)} });
}
const failures = [];
for (const label of ['implement-eight','eight-diff-check']) {
  const bytes = await readFile(join(root,label+'.closed.json'));
  const receipt = JSON.parse(bytes); assert.notEqual(receipt.actualExit,0); assert.equal(receipt.childClosed,true);
  failures.push({ label, file:label+'.closed.json', ...info(bytes), actualExit:receipt.actualExit,
    startedAt:receipt.startedAt,finishedAt:receipt.finishedAt, stdout:receipt.stdout,stderr:receipt.stderr,
    meaning: label==='implement-eight' ? 'Initial loader regex tooling error before any repository write; v1 script and raw stderr preserved.' : 'Six newly inserted CRLF line endings treated as trailing whitespace; corrected to original LF only, original runtime behavior unchanged.' });
}
const environment = JSON.parse(await readFile(join(root,'native-environment-probe.stdout.log'),'utf8'));
assert.equal(environment.GATEWAY_NATIVE_PG_BIN_present,false);
assert.ok(environment.availableCommands.every(record=>record.actualExit===1));
const helperStdout = await readFile(join(root,'existing-helper-control-flow.stdout.log'),'utf8');
assert.match(helperStdout,/tests 6/u); assert.match(helperStdout,/pass 6/u); assert.match(helperStdout,/fail 0/u); assert.match(helperStdout,/skipped 0/u);
const files = [];
for (const record of audit.files) {
  const source = await readFile(join(repo,record.file)); assert.deepEqual(info(source),record.after);
  const snapshot = await readFile(join(root,basename(record.file)+'.final-after-v2')); assert.ok(snapshot.equals(source));
  files.push({ file:record.file,before:record.before,after:record.after,
    beforeSnapshot:basename(record.file)+'.before',afterSnapshot:basename(record.file)+'.final-after-v2',
    allOriginalAssertionsAstAndSourceExact:true,originalAssertionCount:record.orderedOriginalAssertionCalls,
    originalGrantCallCount:record.originalGrantCalls.length,originalGrantCallsAstAndSourceExact:true,
    fullReverseByteExact:true, originalTimeoutAndSkipExact:true });
}
const rawFiles = [];
for (const name of (await readdir(root)).sort()) {
  const bytes = await readFile(join(root,name)); rawFiles.push({file:name,...info(bytes)});
}
const report = { schema:'cinatoken.pg73.next-eight.final.v1',sealedAt:new Date().toISOString(),actualExit:0,
  baseCommit:audit.baseCommit,sourceOwnership:files.map(record=>record.file),files,
  sourceFrozen:true, uniqueChecklistEdited:false,workflowEdited:false,productionCodeEdited:false,gitMutation:false,deployment:false,
  sourceAudit:{file:auditPath,...info(auditBytes),actualExit:0,originalAssertions:409,originalGrantCalls:12,unchangedSourceCount:171,
    originalAssertionsAstAndSourceExact:true,allReverseBytesExact:true,productionGrantAndSharedHelperByteExact:true},
  corpus:audit.corpus,concurrency:audit.concurrency,v359MembershipNegativeWithFinallyByteExact:true,
  localValidation:{syntax:{files:8,actualExit:0,changedV356AfterLFFixRechecked:true},diffCheck:{actualExit:0},
    existingBridgeControlFlow:{tests:6,pass:6,fail:0,skip:0,actualExit:0,
      scope:'Byte-identical pre-existing v350 inert control-flow script executes actual unchanged production grant source and PG73 helper; these cases do not execute the new v356 concurrency or model PostgreSQL MVCC/table locks.'},
    nativeEnvironment:environment},
  closedReceipts:receipts,preservedFailedAttempts:failures,rawFiles,
  nativeResult:{executed:false,pgPassClaim:false,skipCountNeverTreatedAsPass:true,
    nextAuthority:'Root same-source-SHA existing Proxy native Linux workflow using owned PostgreSQL18.6; especially v356 original lock wait, MVCC73/0074 bridge and cleanup remain pending.'},
  concurrencyReasoning:{sharedMigratorRejected:'max1 connection is held by original proposal transaction, so helper state queries would queue; independent owned direct migrator peer used instead.',
    naivePeerRejected:'The original proposal holds schema_migrations SHARE ROW EXCLUSIVE, so starting 0074 ledger INSERT after body would wait on that table before reaching production advisory wait.',
    preparation:'One session advisory lock holds the external unchanged production grant while peer helper commits temporary0074; original transaction removes only that ledger row and runs original frozen proposal on73.',
    originalInterlock:'After original SQL acquired its existing xact lock, preparation session lock is explicitly unlocked/released=true. A current-backend bigint-key granted pg_locks read must still be true, then original60x25ms wait=true and exact Request capability rejection run unchanged.',
    cleanup:'Original transaction commits/deletes temporary ledger row; unchanged helper finally drops audit and restores exact73. On transaction error, same max1 migrator releases preparation session lock after rollback; if unlock connection fails it ends only that owned session. Its nested finally settles peer helper before original client/cluster cleanup.',
    assertionCoverageLimitation:'Static exact-source and read-only lock checks reduce false-positive risk; only real PostgreSQL Linux execution can establish MVCC, lock handoff and cleanup.',
    nativeNegativeControlRecommendation:'With owned Linux and all other source bytes frozen, remove only proposal SELECT pg_advisory_xact_lock(746923553) from an isolated diagnostic body. New after-session-unlock current-backend held probe must fail even if pg_stat_activity temporarily shows the earlier session wait; preserve failure/cleanup evidence. Do not change production proposal or original test acceptance.'},
  limitations:['No Windows native fixture was run because explicit binary is absent; no skipped native test is counted as passing.',
    'No full G1/G7/G8 completion or original102 checklist task completion claim.',
    'No production database, Cloudflare route, secret or authentication identity changed by this agent.'] };
const bytes = Buffer.from(JSON.stringify(report,null,2)+'\n');
const target = join(root,'FINAL-next-eight-pg73-repair.json'); await writeFile(target,bytes,{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,path:target,...info(bytes),files:8,originalAssertions:409,originalGrants:12,nativeExecuted:false})+'\n');

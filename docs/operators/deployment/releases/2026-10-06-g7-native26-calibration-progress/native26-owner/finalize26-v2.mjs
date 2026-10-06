import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { out, repo, baseCommit, info } from './evidence-lib.mjs';

const expectedSteps = [60,61,66,69,71,72,73,74,75,76,77,78,80,81,82,83,84,85,86,88,95,96,97,98,99,106];
const readJson = async name => JSON.parse(await readFile(join(out, name), 'utf8'));
const audit = await readJson('26-source-audit.json');
const applied = await readJson('26-applied-v2.json');
const planned = await readJson('26-planned-edits-v2.json');
const syntax = await readJson('26-syntax-results.json');
for (const value of [audit, applied, planned]) {
  assert.equal(value.baseCommit, baseCommit);
  assert.equal(value.actualExit, 0);
}
assert.deepEqual(audit.files.map(f => f.step), expectedSteps);
assert.deepEqual(applied.repositoryWritePaths, audit.files.map(f => f.file));
assert.deepEqual(planned.files.map(f => f.file), applied.repositoryWritePaths);
assert.equal(planned.allPreparedBeforeAnyRepositoryWrite, true);
assert.deepEqual(audit.totals, {
  files:26, originalAssertions:2233, originalGrantCalls:35,
  originalSqlTemplates:2556, originalSqlAndTransactionCalls:3236,
  unchangedInventoryProtection:298, extraPriorFourProtection:4,
  totalUnchangedProtection:302, totalInventoryPlusExtraFour:328
});
assert.equal(audit.protection.length, 302);
assert.equal(new Set(audit.protection.map(f => f.file)).size, 302);
assert.equal(audit.realPgExecuted, false);
assert.equal(audit.productionWrites, 0);
assert.equal(audit.gitMutations, 0);
assert.equal(audit.originalFinalCorpusChecksPreserved, 4);
assert.deepEqual(audit.originalRecursiveSourceReadPreservedSteps, [81,83,84,85]);
assert.deepEqual(audit.originalIdempotentAndMarkerRejectionsPreservedSteps, [95,96]);
assert.deepEqual(audit.lateSuccessGrantPreservedSteps, [99,106]);
assert.equal(audit.originalProduction0074ContractAndHelperSourceUnchanged, true);
assert.equal(audit.originalExcluded29AndNewFourUnchanged, true);
assert.equal(audit.corpus.actualUnchangedHelperReadValidated, true);
assert.equal(audit.corpus.count, 73);
assert.equal(audit.corpus.sha256, '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc');

for (const f of audit.files) {
  assert.equal(f.allOriginalAssertionsAndGrantCallsAstAndSourceExact, true);
  assert.equal(f.allOriginalSqlAndTransactionCallsAstAndSourceExact, true);
  assert.equal(f.allOriginalTemplatesConditionsReportersCleanupOptionsAstAndSourceExact, true);
  assert.equal(f.wholeFileReverseBytesExact, true);
  assert.equal(f.oneOwnedLocalBinding, true);
  assert.equal(f.originalInitialIdempotentOrNegativeOrLateCallSourceExact, true);
  const bytes = await readFile(join(repo, f.file));
  assert.deepEqual(info(bytes), f.after, 'Current fixture bytes drifted: ' + f.file);
  assert.deepEqual(info(bytes), info(await readFile(join(out, `${basename(f.file)}.final-after`))));
  assert.deepEqual(info(bytes), info(await readFile(join(out, `${basename(f.file)}.prepared-after-v2`))));
  assert.deepEqual(info(await readFile(join(out, `${basename(f.file)}.before-v2`))), f.before);
  assert.deepEqual(f.after, {bytes:applied.files.find(x => x.step === f.step).bytes,
    sha256:applied.files.find(x => x.step === f.step).sha256});
}
const protectionGroups = {};
for (const f of audit.protection) {
  assert.equal(f.currentBaseGitBytesExact, true);
  assert.deepEqual(info(await readFile(join(repo, f.file))), {bytes:f.bytes, sha256:f.sha256},
    'Protected current bytes drifted: ' + f.file);
  protectionGroups[f.group] = (protectionGroups[f.group] ?? 0) + 1;
}
assert.deepEqual(info(await readFile(planned.inventory.path)), {
  bytes:planned.inventory.bytes, sha256:planned.inventory.sha256
});
assert.deepEqual(info(await readFile(planned.originalActualCi.path)), {
  bytes:327916, sha256:'4203c059c01c7097c650376d0148120244536cd2fe6931095ee0414b930f00a5'
});
assert.equal(syntax.results.length, 26);
assert.deepEqual(syntax.results.map(x => x.step).sort((a,b)=>a-b), expectedSteps);
for (const receipt of syntax.results) {
  assert.equal(receipt.actualExit, 0);
  assert.equal(receipt.signal, null);
}

const receiptNames = (await readdir(out)).filter(n => n.endsWith('.closed.json')).sort();
assert.equal(receiptNames.length, 41);
const commandReceipts = [];
for (const name of receiptNames) {
  const raw = await readFile(join(out, name));
  const receipt = JSON.parse(raw.toString('utf8'));
  assert.equal(Number.isInteger(receipt.actualExit), true, 'Missing actual exit: ' + name);
  assert.equal(receipt.actualExit, ['repair26.closed.json','finalize26.closed.json'].includes(name) ? 1 : 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.spawnError ?? null, null);
  assert.deepEqual(info(await readFile(receipt.stdout)), receipt.stdoutInfo);
  assert.deepEqual(info(await readFile(receipt.stderr)), receipt.stderrInfo);
  commandReceipts.push({path:join(out,name), ...info(raw), ...receipt,
    spawnError:receipt.spawnError ?? null, exception:receipt.spawnError ?? null});
}
const firstFailure = commandReceipts.find(r => r.path.endsWith('repair26.closed.json'));
assert.match(await readFile(firstFailure.stderr,'utf8'), /3\s*!==\s*2/);
const evidenceNames = ['evidence-lib.mjs','run-command.mjs','repair26.mjs','prepare-repair-v2.mjs',
  'repair26-v2.mjs','audit26.mjs','verify-static26.mjs','finalize26.mjs','prepare-finalize-v2.mjs','finalize26-v2.mjs',
  '26-planned-edits-v2.json','26-applied-v2.json','26-source-audit.json','26-syntax-results.json',
  '26-final-patch.stdout.log'];
const evidenceFiles = [];
for (const name of evidenceNames) evidenceFiles.push({path:join(out,name), ...info(await readFile(join(out,name)))});

const report = {
  schema:'cinatoken.pg73.native26-owner-preparation.final.v1',
  frozenAt:new Date().toISOString(), platform:process.platform, actualExit:0, baseCommit,
  allowedSteps:expectedSteps, repositoryWritePaths:applied.repositoryWritePaths,
  finalFiles:audit.files, preservedCounts:audit.totals, protectionGroups,
  protection:audit.protection, unchangedHelperCorpus:audit.corpus,
  frozenReadonlyInventory:planned.inventory,
  authority: {
    originalActualCi:planned.originalActualCi,
    observedFailureScope:'Only step60 v374:125:14 has the supplied actual 81 !== 73 failure; other 25 adaptations are based on original workflow/source inventory.',
    priorSuccessfulNativeSteps:'Parent reported original Linux steps53-59 SUCCESS in run37409463636. This local task did not rerun them.',
    originalStrictStatus:'Parent reported original strict 7/1 unchanged; this task did not change or execute strict checks.'
  },
  implementation: {
    helperImport:'Use existing listPg73Migrations and grantPg73RuntimeFixture.',
    initialCorpus:'Keep original variables, 73 assertions, SQL/hash loops; replace initial all-formal loader with existing PG73 loader.',
    grantCalls:'Insert one local grantPostgresRuntime binding before the first original grant; all 35 original calls remain exact in source and normalized AST.',
    finalCorpusSteps:[82,83,84,85],
    finalCorpusFailureCondition:'All four original if/sha/failure contracts are exact; only final loader RHS is wired to existing PG73 helper.',
    preservedRecursiveReaddirSteps:[81,83,84,85],
    preservedIdempotentAndMarkerRejectionSteps:[95,96],
    preservedLatePositiveGrantSteps:[99,106],
    originalProduction0074ContractAndHelperSourceUnchanged:true,
    omittedOrBlockedFiles:[]
  },
  checks: {
    independentFreshGitAstSqlSourceAndWholeFileReverseAudit:'audit26.closed.json actual 0',
    finalCurrentHashVerification:'All 26 current fixtures and 302 protected inputs match independently audited hashes at freeze time.',
    syntax:'26 node --check calls actual 0, syntax only.',
    boundedDiffCheck:'26-diff-check.closed.json actual 0.',
    staticCorpus:'Existing unchanged helper read validates 73 entries through 0073 and fixed corpus SHA/ledger MD5; no database.',
    originalAssertionCount:2233, originalGrantCallCount:35,
    originalTemplateCount:2556, originalSqlAndTransactionCallCount:3236
  },
  historicalPlanningFailure: {
    receipt:firstFailure,
    reason:'The original planning script assumed a unique initial grant anchor; step95 has two identical original initial grant lines (observed 3 split parts versus expected 2).',
    repositoryWritesAtFailure:0,
    guarantee:'Both scripts prepare every candidate before any repository write. The first planner failed before reaching its write loop. Original failed script, partial temporary snapshots, raw stdout/stderr and actual exit 1 receipt are retained.',
    resolution:'v2 inserts a single local binding at the first occurrence, retaining both original calls and every later rejection; v2 actual exit 0.'
  },
  historicalFinalizerFailure: {
    receipt:commandReceipts.find(r => r.path.endsWith('finalize26.closed.json')),
    reason:'The first read-only finalizer expected step-60.final-after; actual snapshot names use the original fixture basename. ENOENT was retained with actual exit 1.',
    repositoryWritesAtFailure:0, finalReportWrittenAtFailure:false,
    resolution:'A separate v2 finalizer uses actual basename snapshots and records both preserved preparation failures.'
  },
  evidenceFiles, commandReceipts,
  receiptCounts:{alreadyClosed:41, actualZero:39, actualOne:2, actualNull:0, signaled:0, spawnErrors:0},
  finalWriterClosedReceipt:join(out,'finalize26-v2.closed.json'),
  finalWriterReceiptBoundary:'This JSON is written before the wrapper closes the finalizer; its actual exit and raw output hashes are recorded separately in the referenced closed receipt.',
  truthBoundary: {
    realPgExecuted:false, nativeFixtureExecuted:false,
    actualLinuxPassClaim:false, productionWrites:0, sqlWrites:0, helperWrites:0,
    markdownWrites:0, gitMutations:0, ciActions:0, cliNetworkCalls:0,
    onlyRepositoryWrites:'Exactly the 26 allowlisted native fixture files.',
    productionReadClosure:'The recorded 302 protected inputs, direct source/helper and migration inventory; no claim of all npm transitive sources.',
    nextAction:'Root independently reviews, commits and runs the original Linux workflow. Local checks establish source preservation and preparation only.'
  },
  ownerStoppedWritingAfterFinalizer:true
};
const path = join(out,'FINAL-native26-pg73-preparation.json');
const bytes = Buffer.from(JSON.stringify(report,null,2)+'\n');
await writeFile(path,bytes,{flag:'wx'});
console.log(JSON.stringify({path,...info(bytes),actualExit:0,files:26,assertions:2233,grantCalls:35,
  unchangedProtectedInputs:302,closedReceiptsBeforeFinalWriter:41,syntaxPassed:26,
  realPgExecuted:false,ownerStopWrites:true}));

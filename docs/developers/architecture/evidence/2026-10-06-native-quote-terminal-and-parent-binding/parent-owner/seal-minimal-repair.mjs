import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-legacy-parent-client-binding-repair-c3e097398c054113961be652993e62b0';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: hash(b) }; };
const read = relative => JSON.parse(fs.readFileSync(`${root}/${relative}`));
const proof = read('source-repair-proof.json');
assert.equal(proof.actualSourcePreparationExit, 0);
assert.equal(proof.safeguards.reverseEntireSourceBytesExact, true);
assert.equal(proof.safeguards.entireASTExceptThreeBindingsExact, true);
assert.equal(proof.safeguards.allAssertionsASTExact, true);
assert.deepEqual(proof.bindings.map(row => row.line), [100, 149, 391]);
for (const key of ['before', 'after', 'currentTarget', 'unchangedHelper', 'helperCopy', 'minimalDiff']) assert.deepEqual(descriptor(proof[key].path), proof[key]);
const b = fs.readFileSync(proof.before.path);
const a = fs.readFileSync(proof.after.path);
assert.deepEqual(Buffer.from(a.toString('utf8').replaceAll('{ cluster, migrator: sql, migratorUrl }', '{ cluster, migrator, migratorUrl }')), b);
assert.deepEqual(fs.readFileSync(`${root}/source-before.mjs`), b);
assert.deepEqual(fs.readFileSync(`${root}/pg73-native-fixture-source.mjs`), fs.readFileSync(proof.helperCopy.path));
const receipts = [];
for (const [file, expected] of [['repair-source.result.json', 1], ['repair-source-v2.result.json', 0], ['node-check.result.json', 0]]) {
  const r = read(file);
  assert.equal(r.closed, true);
  assert.equal(r.actualExit, expected);
  assert.equal(r.signal, null);
  assert.equal(r.spawnError, null);
  if ('timedOut' in r) assert.equal(r.timedOut, false);
  for (const stream of ['stdout', 'stderr']) assert.deepEqual(descriptor(r[stream].path), r[stream]);
  receipts.push({ file: descriptor(`${root}/${file}`), actualExit: r.actualExit, stdout: r.stdout, stderr: r.stderr });
}
const report = {
  schema: 'cinatoken-legacy-parent-three-client-bindings-minimal-repair-final-v1',
  at: new Date().toISOString(), actualLocalSealVerification: 0,
  result: 'SOURCE_REPAIR_PREPARED_REAL_POSTGRES_CI_PENDING',
  originalFailure: { suppliedByRoot: true, sourceContext: 'd537 original native step110', actualExit: 1, kind: 'ReferenceError: migrator is not defined', assertionFailure: false, originalEvidenceChanged: false, oldStrictV364Still8Tests7Pass1Fail: true },
  scope: { ownedRepoFiles: proof.ownedRepositoryFiles, changedProperties: 3, changedLines: [100, 149, 391], priorValue: 'free migrator shorthand', currentValue: 'migrator: sql', existingClientDeclarationLine: 79, existingRole: 'cinatoken_gateway_migrator', existingClientsAndCleanupRemainExact: true },
  sources: { before: proof.before, after: proof.after, currentTarget: proof.currentTarget, unchangedHelper: proof.unchangedHelper, helperCopy: proof.helperCopy, proof: descriptor(`${root}/source-repair-proof.json`) },
  verification: { entireSourceReverseByteExact: true, entireASTExceptThreeBindingsExact: true, allOriginalAssertionsASTExact: true, originalAssertionsCount: proof.safeguards.originalAssertionsCount, existingClientVisibleAtEachCallASTVerified: true, exactDiff: proof.minimalDiff, changedLineWhitespaceCheckActualExit: 0, whitespaceCheckRanInsideOwnedClosedSourceCommand: 'repair-source-v2.result.json', gitDiffCheckNotInvoked: true, nodeSyntaxCheckActualExit: 0, nodeSyntaxDoesNotEvaluateModule: true, receipts },
  retainedLocalFailure: { file: 'repair-source.result.json', actualExit: 1, reason: 'Local checker used a removed loc field on canonical AST; failure occurred before target write. Original checker/source snapshots/raw remain exact, corrected checker is a separate file.' },
  limits: { newPostgresExecution: false, appExecution: false, nativeExecution: false, ciExecution: false, gitExecution: false, productionRequest: false, mdChanged: false, helperChanged: false, sqlOrRoleOrClientOrGrantContractChanged: false, originalAssertionsWaitsLocksAndCleanupChanged: false, originalSealedRootsChanged: false, realPostgresRepairValidated: false, gatePassDerived: false, fullGoalComplete: false },
};
const file = `${root}/FINAL-legacy-parent-client-binding-repair.json`;
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ final: descriptor(file), actualLocalSealVerification: 0, realPostgresRepairValidated: false, gatePassDerived: false }));

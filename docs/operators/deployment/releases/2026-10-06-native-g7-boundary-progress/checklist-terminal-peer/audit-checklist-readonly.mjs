import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const own = 'C:/Users/cina/AppData/Local/Temp/cinatoken-checklist-577-independent-ced29ba591694a8eb7267a62e38a36b5';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E';
const mdPath = 'C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const baselinePath = join(root, 'checklist-before.md');
const g7 = join(root, 'g7-artifact-after-seed/web-platform-g7-07d19c1c941cc373019811be3dbf553c441a0ff3-37403868149-1');
const sha = b => createHash('sha256').update(b).digest('hex');
const file = path => { const b = readFileSync(path); return { path, bytes: b.length, sha256: sha(b) }; };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const baseline = readFileSync(baselinePath, 'utf8');
const current = readFileSync(mdPath, 'utf8');
const lines = text => text.split('\n');
const definitions = [
  ['mainTasks', /^- \[[ xX]\] (?:P[0-8]-\d{2}|SRC-\d{2})[：:]/u, 102],
  ['matrix', /^\| (?:PUB|AUTH|ACC|ADM)-\d{2} \|/u, 54],
  ['checkboxContainingLines', /\[[ xX]\]/u, 213],
  ['gateLines', /^验收门槛 G[0-8]：/u, 9],
  ['stageRows', /^\| P[0-8] /u, 9],
  ['evidenceRows', /^\| E0[0-8] \|/u, 9],
];
const scopes = definitions.map(([name, pattern, expected]) => {
  const before = lines(baseline).filter(line => pattern.test(line)); const after = lines(current).filter(line => pattern.test(line));
  assert.equal(before.length, expected); assert.equal(after.length, expected); assert.deepEqual(after, before, name + ' complete original lines must remain exact');
  return { name, count: after.length, expected, wholeOriginalLinesExact: true, beforeSHA256: sha(JSON.stringify(before)), afterSHA256: sha(JSON.stringify(after)) };
});
const taskIDs = text => lines(text).filter(line => definitions[0][1].test(line)).map(line => line.match(/(?:P[0-8]-\d{2}|SRC-\d{2})/u)[0]);
assert.equal(new Set(taskIDs(current)).size, 102); assert.deepEqual(taskIDs(current), taskIDs(baseline));
const literalTokens = text => text.match(/\[[ xX]\]/gu) ?? [];
assert.deepEqual(literalTokens(current), literalTokens(baseline)); assert.equal(literalTokens(current).length, 214);
const tasks = text => lines(text).filter(line => /^\s*- \[[ xX]\]/u.test(line));
assert.deepEqual(tasks(current), tasks(baseline)); assert.equal(tasks(current).length, 211);
function unfencedTasks(text) {
  let fence; const rows = [];
  for (const line of lines(text)) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/u);
    if (mark) { if (!fence) fence = mark[1][0]; else if (mark[1][0] === fence) fence = undefined; continue; }
    if (!fence && /^\s*- \[[ xX]\]/u.test(line)) rows.push(line);
  }
  return rows;
}
assert.deepEqual(unfencedTasks(current), tasks(current));
const counts = { mainTasks: 102, matrixRows: 54, gates: 9, stages: 9, evidenceRows: 9,
  checkboxContainingLines: 213, literalCheckboxTokens: 214, actualTaskCheckboxLines: 211,
  allTaskCheckboxLinesOutsideCodeFences: true,
  checkedTasks: tasks(current).filter(line => /\[[xX]\]/u.test(line)).length,
  uncheckedTasks: tasks(current).filter(line => /\[ \]/u.test(line)).length,
  checkedMainTaskIDs: lines(current).filter(line => /^- \[[xX]\] (?:P[0-8]-\d{2}|SRC-\d{2})/u.test(line)).map(line => line.match(/(?:P[0-8]-\d{2}|SRC-\d{2})/u)[0]) };
assert.deepEqual(counts.checkedMainTaskIDs, ['P6-11']);
const proof = json(join(root, 'checklist-577-final-proof.json'));
assert.equal(proof.actualExit, 0); assert.deepEqual(proof.counts, [102, 54, 213, 9, 9, 9]);
const guardPath = join(root, 'cutover-batch-final.deployment-guard.json'); const guard = json(guardPath);
const guardCommand = json(join(root, 'cutover-production-batch-final-guard.result.json'));
assert.equal(guardCommand.actualExit, 0); assert.equal(guardCommand.signal, null); assert.equal(guard.actualExit, 0); assert.equal(guard.readOnly, true);
assert.equal(guard.at, '2026-10-06T02:38:45.953Z'); assert.equal(guard.finishedAt, '2026-10-06T02:38:51.728Z');
assert.deepEqual(guard.routes.map(row => [row.pattern, row.script, row.request_limit_fail_open]), [
  ['cinatoken.com/*', 'cinatoken-web', false], ['cinatoken.com/web-assets/*', 'cinatoken-web', false], ['api.cinatoken.com/*', 'cinatoken-proxy', false] ]);
assert.equal(guard.deployment.id, 'fd24618f-121e-4640-9edf-f15d243a6d75');
assert.deepEqual(guard.deployment.versions, [{ version_id: '2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9', percentage: 100 }]);
assert.equal(guard.deployment.commitTag, 'c13a64b9c3b2c90adcf736910ea408868d7854f1'); assert.deepEqual(guard.access, { enabled: false, previews_enabled: false });
const release = json(join(root, 'release-07-status-1.stdout.log')); const releaseCommand = json(join(root, 'release-07-status-1.result.json'));
assert.equal(releaseCommand.actualExit, 0); assert.equal(release.conclusion, 'success'); assert.equal(release.status, 'completed');
assert.equal(release.headSha, '07d19c1c941cc373019811be3dbf553c441a0ff3'); assert.ok(release.url.endsWith('/37403800144'));
const draft = json(join(root, 'release-draft-status-after-07.stdout.log')); const draftCommand = json(join(root, 'release-draft-status-after-07.result.json'));
assert.equal(draftCommand.actualExit, 0); assert.equal(draft.state, 'OPEN'); assert.equal(draft.isDraft, true);
assert.equal(draft.headRefOid, '117c3ba4d7c0d10c5ce8cfc264ba1d6548339812'); assert.ok(draft.url.endsWith('/pull/4'));
assert.equal(draftCommand.at, '2026-10-06T02:30:13.504Z');
const raw = json(join(g7, 'result.json')); const wire = json(join(g7, 'wire-result.json')); const qa = json(join(g7, 'qa-container-closed.json'));
const fallback = json(join(g7, 'fallback-cleanup-result.json')); const manifest = json(join(g7, 'frozen-manifest.json'));
assert.equal(raw.actualExit, 1); assert.equal(raw.fullG7Verified, false); assert.equal(raw.fullG8Verified, false);
assert.equal(raw.sourceSHA, '07d19c1c941cc373019811be3dbf553c441a0ff3'); assert.equal(raw.database.actualExit, 0);
assert.equal(raw.database.observation.server_version_num, '160015'); assert.equal(raw.database.observation.superuser, true);
assert.equal(raw.cleanup.verifiedAbsent, true); assert.deepEqual(raw.cleanup.errors, []);
assert.deepEqual([raw.cleanup.containers.length, raw.cleanup.networks.length, raw.cleanup.volumes.length], [9, 3, 1]);
assert.equal([...raw.cleanup.containers, ...raw.cleanup.networks, ...raw.cleanup.volumes].every(row => row.verifiedAbsent), true);
assert.equal(fallback.actualExit, 0); assert.equal(fallback.verifiedAbsent, true); assert.equal(fallback.rows.length, 13); assert.equal(fallback.rows.every(row => row.verifiedAbsent), true);
assert.equal(wire.actualExit, 0); assert.equal(qa.actualExit, 0); assert.equal(wire.completedPublicSSRRequests, 64); assert.equal(wire.completedResourceRequests, 270);
assert.equal(manifest.files.length, 135); assert.equal(wire.manifestSha256, file(join(g7, 'frozen-manifest.json')).sha256);
const entries = readdirSync(g7, { withFileTypes: true }); const topFiles = entries.filter(entry => entry.isFile());
function recursiveFiles(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? recursiveFiles(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : []); }
const allFiles = recursiveFiles(g7);
assert.equal(entries.length, 600); assert.equal(topFiles.length, 599); assert.equal(allFiles.length, 601);
const firstArtifactParent = join(root, 'g7-artifact-first');
const firstArtifactRoot = firstArtifactParent; // first download extracted directly here; second download has an artifact-named wrapper
const firstTopEntries = readdirSync(firstArtifactRoot, { withFileTypes: true });
const firstTopFiles = firstTopEntries.filter(entry => entry.isFile());
const firstRecursiveFiles = recursiveFiles(firstArtifactRoot);
assert.equal(firstTopFiles.length, 350); assert.equal(firstRecursiveFiles.length, 352);
const correctionPath = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7/checklist-count-correction-proof.json';
const correction = json(correctionPath);
assert.equal(correction.actualExit, 0); assert.equal(correction.afterSha256, file(mdPath).sha256);
assert.equal(correction.oldMetadataPreserved, true); assert.equal(correction.checkboxLines, 213); assert.equal(correction.checkboxTokens, 214);
assert.equal(file(mdPath).sha256, 'f11fe3bf076a6d3b1d848021a520657dbadf1b46479f5f83e20d6eb71d227cb0');
const childReceipts = topFiles.filter(entry => entry.name.endsWith('.result.json')).map(entry => [entry.name, json(join(g7, entry.name))])
  .filter(([, command]) => command.schema === 'web-platform-g7-child-command-closed-v1').map(([name, command]) => {
    assert.equal(command.closed, true); assert.equal(Number.isSafeInteger(command.actualExit), true); assert.equal(Number.isFinite(Date.parse(command.endedAt)), true);
    const outputs = ['stdout', 'stderr'].map(stream => {
      assert.equal(command[stream].file, command[stream].file.split(/[\\/]/u).at(-1));
      const output = file(join(g7, command[stream].file)); assert.equal(output.bytes, command[stream].bytes); assert.equal(output.sha256, command[stream].sha256); return output;
    });
    return { file: file(join(g7, name)), actualExit: command.actualExit, signal: command.signal, outputs };
  });
assert.equal(childReceipts.length, 194); assert.equal(childReceipts.filter(row => row.file.path.includes('/fallback-') || row.file.path.includes('\\fallback-')).length, 29);
const adminCommand = json(join(g7, '083-docker.result.json')); const proxyCommand = json(join(g7, '082-docker.result.json'));
assert.equal(adminCommand.actualExit, 1); assert.equal(proxyCommand.actualExit, 0); assert.equal(adminCommand.args.at(-1), '--observe');
assert.ok(readFileSync(join(g7, adminCommand.stderr.file), 'utf8').includes("Cannot find package 'drizzle-orm'"));
assert.ok(readFileSync(join(g7, adminCommand.stderr.file), 'utf8').includes('/app/packages/core/dist/index.js'));
const proxyObservation = json(join(g7, proxyCommand.stdout.file)); assert.equal(proxyObservation.actualExit, 0);
assert.equal(proxyObservation.observation.schemaSha256, raw.database.observation.schemaSha256);
assert.deepEqual(proxyObservation.observation.counts, raw.database.observation.counts);
const issues = [];
if (current.includes('artifact11386613030解压600文件')) issues.push({ code: 'G7_ARTIFACT_FILE_COUNT_WORDING',
  claim: '600 files', actual: '600 top-level entries =599 top-level ordinary files +1 directory containing2 certificates;601 recursively counted ordinary files',
  rootOriginalAnalysisMustRemainUnchanged: true, productionGateAffected: false, requiresLatestMDWordingCorrection: true });
const report = { schema: 'cinatoken.checklist.577.latest-independent-readonly-review.v1', at: new Date().toISOString(),
  reviewActualExit: issues.length ? 1 : 0, conclusion: issues.length ? 'ORIGINAL_STATES_PRESERVED_ARTIFACT_COUNT_WORDING_CORRECTION_REQUIRED' : 'ORIGINAL_STATES_EXACT_LATEST_FACTS_SUPPORTED',
  currentMD: file(mdPath), originalBaseline: file(baselinePath), allOriginalStatesExact: true, scopes, counts,
  originalRootFinalProof: file(join(root, 'checklist-577-final-proof.json')),
  rootProofAfterSHAEqualsCurrentMD: proof.afterSha256 === file(mdPath).sha256,
  latestRootCountCorrectionProof: file(correctionPath), latestRootCorrectionAfterSHAMatchesCurrent: true,
  originalRootFinalProofIsHistoricalBeforeCountCorrection: true,
  currentProgressLine: lines(current).find(line => line.startsWith('当前推进：')),
  currentNext18Row: lines(current).find(line => line.startsWith('| NEXT-18 |')),
  g7: { originalRuntime: file(join(g7, 'result.json')), originalWire: file(join(g7, 'wire-result.json')), originalQA: file(join(g7, 'qa-container-closed.json')),
    originalAnalysis: file(join(root, 'g7-seed-terminal-analysis-v2.json')), runtimeActualExit: 1, seedActualExit: 0, wireActualExit: 0, qaActualExit: 0,
    proxyObserveActualExit: 0, adminObserveActualExit: 1, adminFailure: 'drizzle-orm MODULE_NOT_FOUND via Core dist import',
    publicSSRRequests: 64, resources: 135, resourceRequests: 270, artifactTopLevelEntries: 600, artifactTopLevelFiles: 599,
    artifactRecursiveOrdinaryFiles: 601, subdirectoryFiles: allFiles.filter(path => !topFiles.some(entry => join(g7, entry.name) === path)).map(file),
    firstArtifactCount: { root: firstArtifactRoot, topLevelEntries: firstTopEntries.length, topLevelOrdinaryFiles: 350, recursiveOrdinaryFiles: 352 },
    originalRuntimeChildCount: 165, originalFallbackChildCount: 29, childReceipts,
    cleanup: { containers: 9, networks: 3, volumes: 1, all13Absent: true, fallbackActualExit: 0, fallback13Absent: true },
    fullG7Verified: false, fullG8Verified: false, PG16SuperuserDoesNotProveRestrictedPG18ACL: true },
  release: { originalStatus: file(join(root, 'release-07-status-1.stdout.log')), closedReadCommand: file(join(root, 'release-07-status-1.result.json')),
    conclusion: release.conclusion, sourceSHA: release.headSha, url: release.url,
    originalDraftStatus: file(join(root, 'release-draft-status-after-07.stdout.log')), closedDraftReadCommand: file(join(root, 'release-draft-status-after-07.result.json')),
    draftState: draft.state, isDraft: draft.isDraft, headRefOid: draft.headRefOid, urlPR: draft.url, doesNotProveMergeTagPublish: true },
  cloudflare: { originalGuard: file(guardPath), closedReadCommand: file(join(root, 'cutover-production-batch-final-guard.result.json')),
    actualExit: 0, at: guard.at, finishedAt: guard.finishedAt, routes: guard.routes, deployment: guard.deployment, access: guard.access,
    sourceIsTimestampedPriorReadOnlyReceipt: true, noFreshProductionRequestMadeByReviewer: true },
  issues, resolvedFinding: { code: 'G7_ARTIFACT_FILE_COUNT_WORDING', foundInMD_SHA: 'b26e4bd40adc058cfee59a53d8c9275ecb0d9da480f0ef1cbd6ec935b337b67e',
    originalClaim: 'Second G7 artifact decompressed600 files', verifiedActual: '600 top-level entries,601 recursively counted ordinary files',
    latestMDAndCorrectionMetadataResolveWording: true, originalAnalysisNotRewritten: true },
  countTerminology: { original213ScopeMeansCheckboxContainingLines: true, actualLiteralTokens214: true,
    actualTaskLines211: true, noTaskLineInsideCodeFence: true, stateComparisonStrongerThanCounts: 'All original complete lines and ordered tokens are identical, not merely their counts.' },
  limitations: ['Review uses saved original receipts, not new remote queries.', 'Original task preservation is exact; current pipeline failures are preserved and do not complete G7/G8.',
    'The future release archive link is described as future sealing; this review does not claim that future archive already exists.',
    'Analysis reviewActualExit is not the G7 runtime or Release pipeline result.'],
  reviewerActions: { repositoryWrites: 0, gitCommands: 0, ciRequests: 0, productionRequests: 0, databaseRequests: 0, onlyNewTempReportWritten: true } };
report.reviewerEntryFailurePreserved = { chunkId: '713338', actualExitCode: 1, issue: 'Reviewer assumed first artifact used the second download wrapper layout. Actual first extract is direct root; corrected only reviewer path, no original artifact or MD changed.' };
const body = Buffer.from(JSON.stringify(report, null, 2) + '\n'); const path = join(own, 'FINAL-checklist-577-independent-review.json');
writeFileSync(path, body, { flag: 'wx' }); writeFileSync(path + '.sha256', sha(body) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reviewActualExit: report.reviewActualExit, path, bytes: body.length, sha256: sha(body), counts, issueCount: issues.length }));
process.exitCode = report.reviewActualExit;

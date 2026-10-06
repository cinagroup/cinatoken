import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-next-readonly-gn9DdD';
const repo = 'C:/cinagroup/cinatoken';
const peerRoot = 'C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-native-tail-independent-peer-76364c609e694985bf7d74bf5b2c4ae9';
const ee = 'ee122dd4273e2db892daa724bc6417a9b02b280c';
const dcc = 'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc';
const fixture = 'scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs';
const proposal = 'packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql';
const beganAt = new Date().toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = (pathname, bytes = fs.readFileSync(pathname)) => ({ path: pathname.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) });
const write = (relative, value) => fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const sourceFiles = [fixture, proposal,
  'scripts/db/cutover/pg73-native-fixture.mjs', 'packages/core/src/test-support/postgres-native-cluster.mjs',
  '.github/workflows/proxy-dispatch-safety.yml', 'package-lock.json', '.nvmrc',
  'node_modules/postgres/package.json', 'node_modules/postgres/src/index.js',
  'node_modules/postgres/src/types.js', 'node_modules/postgres/src/connection.js'];
const sourceDir = path.join(root, 'source-snapshots');
fs.mkdirSync(sourceDir);
const sources = sourceFiles.map((relative, index) => {
  const source = path.join(repo, relative);
  const before = fs.lstatSync(source);
  assert(before.isFile() && !before.isSymbolicLink());
  const bytes = fs.readFileSync(source);
  const after = fs.lstatSync(source);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const copy = path.join(sourceDir, `${String(index + 1).padStart(2, '0')}-${path.basename(relative)}.snapshot`);
  fs.writeFileSync(copy, bytes, { flag: 'wx' });
  assert(fs.readFileSync(copy).equals(bytes));
  return { relative, original: descriptor(source, bytes), snapshot: descriptor(copy), byteExact: true, sourceMtimeMs: before.mtimeMs };
});
const snapshot = relative => fs.readFileSync(sources.find(source => source.relative === relative).snapshot.path, 'utf8');
assert.equal(sources[0].original.bytes, 34823);
assert.equal(sources[0].original.sha256, '16ef4b701728c9de46ea932851354d7cee2aa9d80c6ab543ceae6f4526380c83');
const gitReads = [];
const git = args => {
  const startedAt = new Date().toISOString();
  const result = spawnSync('C:/Program Files/Git/cmd/git.exe', args, { cwd: repo, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  gitReads.push({ args, startedAt, endedAt: new Date().toISOString(), actualExit: result.status, signal: result.signal,
    stdout: { bytes: result.stdout.length, sha256: sha(result.stdout) }, stderr: { bytes: result.stderr.length, sha256: sha(result.stderr) }, readOnly: true });
  return result.stdout;
};
const inspectedAtHead = git(['rev-parse', 'HEAD']).toString().trim();
for (const commit of [ee, dcc]) {
  assert.equal(git(['rev-parse', `${commit}:${fixture}`]).toString().trim(), 'da61172ea25d53bc31cdc10f2999defce06d6559');
  assert(git(['show', `${commit}:${fixture}`]).equals(fs.readFileSync(sources[0].snapshot.path)));
}
const require = createRequire(path.join(repo, 'package.json'));
const acorn = require('acorn');
const fixtureText = snapshot(fixture);
const ast = acorn.parse(fixtureText, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const nodes = [];
const visit = value => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(visit);
  if (value.type) nodes.push(value);
  for (const [key, nested] of Object.entries(value)) if (!['loc', 'start', 'end'].includes(key)) visit(nested);
};
visit(ast);
const canonicalAST = value => {
  if (Array.isArray(value)) return value.map(canonicalAST);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['loc', 'start', 'end'].includes(key)).map(([key, item]) => [key, canonicalAST(item)]));
};
const queryCalls = nodes.filter(node => node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
  && node.callee.object.name === 'competing' && node.callee.property.name === 'unsafe'
  && [470, 472, 496].includes(node.loc.start.line));
assert.equal(queryCalls.length, 3);
const querySelections = queryCalls.map(node => {
  const raw = fixtureText.slice(node.start, node.end);
  const query = node.arguments[0];
  assert.equal(query.type, 'TemplateLiteral');
  const candidateRaw = raw.replaceAll('$1::timestamptz', '$1::text::timestamptz')
    .replaceAll('$2::timestamptz', '$2::text::timestamptz')
    .replace("resolve_shared_key_quote_at_time('quote-key-a',$1)", "resolve_shared_key_quote_at_time('quote-key-a',$1::text::timestamptz)");
  assert.notEqual(candidateRaw, raw);
  return { location: node.loc, originalCallSourceExact: raw, originalCallUTF8Bytes: Buffer.byteLength(raw),
    originalCallSHA256: sha(Buffer.from(raw)), originalQueryAST: canonicalAST(query),
    originalParameterArrayAST: canonicalAST(node.arguments[1]), originalCallAST: canonicalAST(node),
    candidateCallSourcePlanOnly: candidateRaw, candidateNotWrittenOrExecuted: true };
});
const originalAssertions = nodes.filter(node => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'assert')
  .map(node => ({ line: node.loc.start.line, method: node.callee.property.name, source: fixtureText.slice(node.start, node.end), AST: canonicalAST(node) }));
write('three-original-query-AST-and-candidate-plan.json', { schema: 'cinatoken-quote-timestamp-original-query-static-selection-v1',
  originalFixture: sources[0], queries: querySelections, originalAssertions,
  parserOnly: true, fixtureImportedOrExecuted: false, databaseExecuted: false, candidateWritten: false });
const packageJSON = JSON.parse(snapshot('node_modules/postgres/package.json'));
const lock = JSON.parse(snapshot('package-lock.json'));
assert.equal(packageJSON.version, '3.4.9');
assert.equal(lock.packages['node_modules/postgres'].version, packageJSON.version);
assert.equal(packageJSON.exports.import, './src/index.js');
const peerFinalFile = path.join(peerRoot, 'FINAL-ee122-native-tail-terminal-independent-peer.json');
const peerFinalBytes = fs.readFileSync(peerFinalFile);
assert.equal(peerFinalBytes.length, 526801);
assert.equal(sha(peerFinalBytes), '1cb4680d0effb04b1784dd945738c5d3608c06c9c2423dd82784a9441aee2ebe');
const peerFinal = JSON.parse(peerFinalBytes);
assert.equal(peerFinal.sourceHead, ee);
assert.equal(peerFinal.nativeJob.databaseId, 112114951257);
assert.equal(peerFinal.nativeJob.conclusion, 'failure');
assert.equal(peerFinal.firstFailureFact.line, 499);
assert.equal(peerFinal.firstFailureFact.actual, 'quote-a-b1');
assert.equal(peerFinal.firstFailureFact.expected, 'quote-a-b2');
const stepRawFile = path.join(peerRoot, 'native-group-v2-step-24.raw.log');
const stepRaw = fs.readFileSync(stepRawFile);
const stepRawText = stepRaw.toString('utf8');
assert(stepRawText.includes("actual: 'quote-a-b1'") && stepRawText.includes("expected: 'quote-a-b2'"));
assert(stepRawText.includes('postgres-shared-key-quote-versions.native.test.mjs:499:14'));
assert(stepRawText.includes('Process completed with exit code 1.'));
const valueEvidenceTokens = ['pendingEffectiveAt', 'observedAt', 'pending.effective_at', 'effective_at:'];
const rawContainsValueTokens = valueEvidenceTokens.map(token => ({ token, present: stepRawText.includes(token) }));
assert(rawContainsValueTokens.every(row => !row.present));
const currentSourceAfter = sources.map(source => ({ relative: source.relative, ...descriptor(source.original.path), unchanged: descriptor(source.original.path).sha256 === source.original.sha256 }));
assert(currentSourceAfter.every(source => source.unchanged));
write('static-source-chain-audit.json', {
  schema: 'cinatoken-next-quote-version-timestamp-static-read-audit-v1', beganAt, endedAt: new Date().toISOString(),
  closed: true, actualReadExit: 0, inspectedAtHead, targetSourceHead: ee, historicalSourceHead: dcc,
  fixtureGitBlobBothHeads: 'da61172ea25d53bc31cdc10f2999defce06d6559', sources, sourceAfter: currentSourceAfter, gitReads,
  originalQueryAST: descriptor(path.join(root, 'three-original-query-AST-and-candidate-plan.json')),
  originalAssertionCount: originalAssertions.length,
  installedDriver: { version: packageJSON.version, importEntry: packageJSON.exports.import,
    lockVersion: lock.packages['node_modules/postgres'].version, lockIntegrity: lock.packages['node_modules/postgres'].integrity },
  runtimeFailureAuthority: { peerReport: descriptor(peerFinalFile, peerFinalBytes), originalRaw: descriptor(stepRawFile, stepRaw),
    sourceHead: ee, originalJob: 112114951257, actual: peerFinal.firstFailureFact.actual, expected: peerFinal.firstFailureFact.expected,
    failureLine: 499, rawContainsTimestampValueTokens: rawContainsValueTokens,
    limitation: 'The supplied frozen report and original step24 job raw do not print the pending/observed database timestamps. A serialization mechanism is statically supported; its activation in this failed run remains unconfirmed.' },
  originalRuntimeFailureUnchanged: true, candidateSourceWritten: false, repoWrites: 0, gitMutations: 0,
  fixtureImported: false, driverImported: false, databaseRuns: 0, testsRerun: 0, ciReadsOrDispatches: 0,
  productionRequests: 0, readOnlyDiagnosis: true, gatePassDerived: false,
});
console.log(JSON.stringify({ audit: descriptor(path.join(root, 'static-source-chain-audit.json')), originalQueries: 3,
  originalAssertions: originalAssertions.length, fixtureSHA: sources[0].original.sha256,
  actualReadExit: 0, actualOldRuntimeExit: 1, candidateCauseConfirmedForOldRun: false,
  testsRerun: 0, databaseRuns: 0, repoWrites: 0 }));

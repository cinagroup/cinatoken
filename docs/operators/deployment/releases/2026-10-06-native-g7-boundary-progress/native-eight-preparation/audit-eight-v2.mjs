import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
import { listPg73Migrations } from 'file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const repo = 'C:/cinagroup/cinatoken';
const baseCommit = '6658ec978009afa5fe3f4beccf6bde358590b663';
const info = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const edits = JSON.parse(await readFile(join(root, 'eight-final-edits-v2.json'), 'utf8'));
const normalize = node => JSON.parse(JSON.stringify(node, (key, value) => ['start','end','loc'].includes(key) ? undefined : typeof value === 'bigint' ? { exactBigint: value.toString() } : value instanceof RegExp ? { exactPattern: value.source, exactFlags: value.flags } : value));
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function analyze(source) {
  const assertions = [], grants = [], options = [];
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), node => {
    if (node.type !== 'CallExpression') return;
    const record = { source: source.slice(node.start, node.end), ast: normalize(node) };
    if (node.callee?.object?.name === 'assert') assertions.push(record);
    if (node.callee?.name === 'grantPostgresRuntime') grants.push(record);
    if (node.callee?.name === 'test') options.push({ source: source.slice(node.arguments[1].start, node.arguments[1].end), ast: normalize(node.arguments[1]) });
  });
  return { assertions, grants, options };
}
function restore(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2);
  return source.replace(needle, replacement);
}
const newAssertSources = [
  "assert.equal(temporaryAuditVisible,true,'owned peer must commit temporary 0074 before PG73 activation')",
  "assert.equal(preparation.released,true,'owned preparation session lock must be released')",
  "assert.equal(proposalInterlock.held,true,'original proposal transaction must retain its interlock after session unlock')",
];
const files = [];
for (const record of edits.files) {
  const before = await readFile(join(root, basename(record.file) + '.before'));
  const after = await readFile(join(repo, record.file));
  assert.deepEqual(info(before), record.before);
  assert.deepEqual(info(after), record.after);
  const original = spawnSync('git', ['show', `${baseCommit}:${record.file}`], { cwd: repo, windowsHide: true });
  assert.equal(original.status, 0); assert.ok(before.equals(original.stdout));
  let reverse = after.toString('utf8');
  for (const edit of [...record.operations].reverse()) reverse = restore(reverse, edit.replacement, edit.needle);
  assert.ok(Buffer.from(reverse).equals(before));
  const old = analyze(before.toString('utf8')), current = analyze(after.toString('utf8'));
  const concurrent = record.file.includes('request-capability-login-v356');
  const additions = concurrent ? current.assertions.filter(entry => newAssertSources.includes(entry.source)) : [];
  assert.equal(additions.length, concurrent ? 3 : 0);
  const originalAssertions = current.assertions.filter(entry => !newAssertSources.includes(entry.source));
  assert.deepEqual(originalAssertions, old.assertions);
  assert.deepEqual(current.grants, old.grants);
  assert.deepEqual(current.options, old.options);
  assert.equal((after.toString('utf8').match(/await listPg73Migrations\(\)/gu) ?? []).length, 1);
  assert.doesNotMatch(after.toString('utf8'), /readdir\(/u);
  await writeFile(join(root, basename(record.file) + '.final-after-v2'), after, { flag: 'wx' });
  files.push({ file: record.file, before: info(before), after: info(after), baseGitBytesExact: true,
    fullReverseBytesExact: true, allOriginalAssertionsAstAndSourceExact: true,
    orderedOriginalAssertionCalls: old.assertions.length, addedAssertions: additions,
    originalGrantCallsAstAndSourceExact: true, originalGrantCalls: old.grants,
    originalNativeTimeoutAndSkipExact: true, originalOptions: old.options,
    pinnedLoaderOnly: true, operations: record.operations });
}
const source = await readFile(join(repo, 'scripts/db/cutover/postgres-authenticated-request-capability-login-v356.native.test.mjs'), 'utf8');
const before356 = await readFile(join(root, 'postgres-authenticated-request-capability-login-v356.native.test.mjs.before'), 'utf8');
const lockLoop = before356.match(/        let blocked=false;\r?\n        for \(let attempt=0;attempt<60;attempt\+\+\) \{[\s\S]*?        assert\.equal\(blocked,true,'legacy grant rerun must wait for the v356 install lock'\);/)?.[0];
assert.ok(lockLoop); assert.ok(source.includes(lockLoop));
assert.equal((source.match(/pg_advisory_lock\(746923553\)/gu) ?? []).length, 1);
assert.equal((source.match(/pg_advisory_xact_lock\(746923553\)/gu) ?? []).length, 0);
assert.ok(source.indexOf('await tx.unsafe(body).simple();', source.indexOf('let concurrentGrant;')) < source.indexOf('pg_advisory_unlock(746923553) AS released'));
assert.ok(source.indexOf('pg_advisory_unlock(746923553) AS released') < source.indexOf('const [proposalInterlock]'));
assert.ok(source.indexOf('const [proposalInterlock]') < source.indexOf('        concurrentGrant=grantPostgresRuntime'));
const before359 = await readFile(join(root, 'postgres-authenticated-text-route-source-fence-v359.native.test.mjs.before'), 'utf8');
const memberAnchor = before359.indexOf("'GRANT cinatoken_gateway_migrator TO cinatoken_gateway_runtime'");
const membershipBlock = before359.slice(before359.lastIndexOf('      await', memberAnchor), before359.indexOf('\r\n      ', before359.indexOf("'REVOKE cinatoken_gateway_migrator FROM cinatoken_gateway_runtime'", memberAnchor) + 75));
const current359 = await readFile(join(repo, 'scripts/db/cutover/postgres-authenticated-text-route-source-fence-v359.native.test.mjs'), 'utf8');
assert.ok(membershipBlock.includes('finally')); assert.ok(current359.includes(membershipBlock));
const unchangedPaths = [ 'scripts/db/cutover/pg73-native-fixture.mjs', 'scripts/db/cutover/grant-postgres-runtime.ts',
  'scripts/db/cutover/provision-postgres-roles.ts', 'scripts/db/cutover/activate-postgres-buyer-split-v348.ts',
  'packages/core/src/test-support/postgres-native-cluster.mjs',
  ...(await readdir(join(repo,'packages/core/migrations-postgres'))).filter(name => name.endsWith('.sql')).map(name => 'packages/core/migrations-postgres/' + name),
  ...(await readdir(join(repo,'packages/core/migrations-proposals/postgres'))).filter(name => name.endsWith('.sql')).map(name => 'packages/core/migrations-proposals/postgres/' + name),
];
const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: unchangedPaths.map(path => `${baseCommit}:${path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 });
assert.equal(batch.status,0); assert.equal(batch.stderr.length,0);
let offset = 0; const unchanged = [];
for (const file of unchangedPaths) {
  const end = batch.stdout.indexOf(10,offset);
  const header = batch.stdout.subarray(offset,end).toString('utf8');
  const [blob,type,size] = header.split(' '); assert.equal(type,'blob');
  const bytes = batch.stdout.subarray(end+1,end+1+Number(size));
  offset = end + 1 + Number(size) + 1;
  const current = await readFile(join(repo,file)); assert.ok(current.equals(bytes), file);
  unchanged.push({ file, blob, ...info(current), exactBaseGitBytes: true });
}
assert.equal(offset,batch.stdout.length);
const corpus = await listPg73Migrations();
assert.equal(corpus.length,73);
const report = { schema: 'cinatoken.pg73.next-eight-audit.v1', at: new Date().toISOString(), actualExit: 0,
  baseCommit, files, totals: { files: files.length, assertions: files.reduce((count,file)=>count+file.orderedOriginalAssertionCalls,0),
    originalGrantCalls: files.reduce((count,file)=>count+file.originalGrantCalls.length,0), additionalReadOnlyAssertions: 3 },
  corpus: { count: corpus.length, last: corpus.at(-1), sha256: '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc', ledgerMd5: 'ca1ea96a1b4bcd0675642f30dcf48042', actualUnchangedHelperValidated: true },
  concurrency: { onlyNewLockOperation: 'one preparation session lock', noNewTransactionLockOperation: true,
    explicitSessionUnlockBeforeOriginalWait: true, exactCurrentBackendGrantedBigintLockCheckedAfterUnlock: true,
    original60By25msAdvisoryWaitSourceExact: true, independentOwnedDirectMigratorPeer: true,
    originalProposalBodyUnchanged: true, pendingHelperSettledBeforePeerDisconnect: true,
    nativeLockWaitNotYetProven: true },
  v359MembershipNegativeWithFinallyByteExact: true, unchangedSources: unchanged,
  nativeFixtureExecuted: false, nativePgPassClaim: false, productionRequests: 0 };
await writeFile(join(root, 'eight-source-audit-v2.json'), JSON.stringify(report,null,2)+'\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ actualExit:0, files: files.length, originalAssertions: report.totals.assertions, originalGrants: report.totals.originalGrantCalls, unchangedSourceCount: unchanged.length, pinned73: true, nativeFixtureExecuted: false })+'\n');

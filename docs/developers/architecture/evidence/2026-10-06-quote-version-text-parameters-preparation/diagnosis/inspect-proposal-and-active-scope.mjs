import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-next-readonly-gn9DdD';
const repo = 'C:/cinagroup/cinatoken';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const commands = [];
const readCommand = (program, args, expectedExit) => {
  const beganAt = new Date().toISOString();
  const result = spawnSync(program, args, { cwd: repo, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedExit);
  assert.equal(result.signal, null);
  commands.push({ program, args, beganAt, endedAt: new Date().toISOString(), actualExit: result.status,
    signal: result.signal, stdout: { bytes: result.stdout.length, sha256: sha(result.stdout), text: result.stdout.toString('utf8') },
    stderr: { bytes: result.stderr.length, sha256: sha(result.stderr), text: result.stderr.toString('utf8') }, readOnly: true,
    expectedNoSearchMatches: expectedExit === 1 });
  return result.stdout;
};
const proposal = 'packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql';
const source = JSON.parse(fs.readFileSync(path.join(root, 'static-source-chain-audit.json')));
const proposalSource = source.sources.find(row => row.relative === proposal);
for (const head of ['ee122dd4273e2db892daa724bc6417a9b02b280c', 'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc']) {
  assert.equal(readCommand('C:/Program Files/Git/cmd/git.exe', ['rev-parse', `${head}:${proposal}`], 0).toString().trim(), '3f4dfb64abf22e020aeff142d9564db1724337ed');
  assert(readCommand('C:/Program Files/Git/cmd/git.exe', ['show', `${head}:${proposal}`], 0).equals(fs.readFileSync(proposalSource.snapshot.path)));
}
const scopedQuery = ['-l', 'resolve_shared_key_quote_at_time|claim_shared_key_quote_for_dispatch',
  'packages/core/src', 'packages/proxy/src', '-g', '*.ts', '-g', '*.mjs'];
const references = readCommand('C:/Users/cina/AppData/Local/OpenAI/Codex/bin/f1e5e36960c35938/rg.exe', scopedQuery, 1);
assert.equal(references.length, 0);
const proof = {
  schema: 'cinatoken-quote-proposal-scope-readonly-v1', at: new Date().toISOString(), closed: true, actualReadExit: 0,
  proposalBothHeadsGitBlob: '3f4dfb64abf22e020aeff142d9564db1724337ed', proposalSource,
  commands, scopedActiveCoreProxyQueryReferences: [],
  scopeLimit: 'Only exact qualified selector names were searched under the active Core/Proxy src .ts/.mjs trees. This does not establish absence of every possible economic quote path.',
  proposalStatus: 'The exact proposal header labels it review-only, outside formal migration/active producer. The native fixture activates its SQL as the migrator in a fresh owned PG18.6 cluster; no product SQL change is proposed.',
  testsRerun: 0, databasesStarted: 0, productionRequests: 0, sourceWrites: 0, gitMutations: 0,
  readOnlyDiagnosis: true, gatePassDerived: false,
};
fs.writeFileSync(path.join(root, 'proposal-and-active-scope-audit.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ actualReadExit: 0, proposalSameBothHeads: true, scopedExactQueryMatches: 0,
  originalRGNoMatchesExit: commands.at(-1).actualExit, testsRerun: 0, sourceWrites: 0 }));

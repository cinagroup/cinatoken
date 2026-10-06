import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseStat } from 'file:///C:/cinagroup/cinatoken/scripts/diagnostics/v364-owned-linux-boundary/proc-census.mjs';
const repo = 'C:/cinagroup/cinatoken';
const base = `${repo}/scripts/diagnostics/v364-owned-linux-boundary`;
const temp = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-preparation-1427c951d98b46c6ae8299694b679b38';
const validation = `${temp}/validation-2`;
mkdirSync(validation);
const python = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const commands = [];
function run(id, program, args, expected, timeout = 60000) {
  const result = spawnSync(program, args, { cwd: repo, encoding: 'utf8', timeout });
  const outputs = ['stdout', 'stderr'].map(stream => {
    const b = Buffer.from(result[stream] ?? ''); const path = `${validation}/${id}.${stream}.txt`;
    writeFileSync(path, b, { flag: 'wx' }); return { path, bytes: b.length, sha256: sha(b) };
  });
  const receipt = { id, program, args, cwd: repo, timeout, status: result.status, signal: result.signal,
    error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
    expectedExit: expected, outputs, source: 'actual synchronous spawnSync return, not aggregate report', terminal: result.status !== null && !result.signal && !result.error };
  commands.push(receipt); writeFileSync(`${validation}/${id}.command-result.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  assert.equal(result.status, expected, id + ': ' + result.stderr); assert.equal(result.signal, null); assert.equal(result.error, undefined);
  return result;
}
const manifest = JSON.parse(readFileSync(`${base}/sealed-package.json`, 'utf8'));
for (const item of manifest.files) {
  const path = `${base}/${item.path}`; const bytes = Buffer.from(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
  writeFileSync(path, bytes); item.bytes = bytes.length; item.sha256 = sha(bytes);
}
writeFileSync(`${base}/sealed-package.json`, JSON.stringify(manifest, null, 2) + '\n');
for (const file of readdirSync(base).filter(v => v.endsWith('.mjs'))) run('syntax-' + file, process.execPath, ['--check', `${base}/${file}`], 0);
run('python-syntax', python, ['-c', 'import ast,sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_text()); print("AST OK")', `${base}/execute-owned-linux.py`], 0);
const inert = run('executor-inert', python, [`${temp}/check-executor-inert.py`], 0);
const inertResult = JSON.parse(inert.stdout); assert.equal(inertResult.actualExit, 0); assert.equal(inertResult.workerdExecuted, false);
checks.push({ name: 'inert Python exact parser/reap/live/Z/kill and actual receipt field branches', actualExit: 0, cases: inertResult.checks.length, realProcessSpawned: false });
const original = readFileSync(`${repo}/scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs`, 'utf8');
const current = readFileSync(`${base}/run-boundary.mjs`, 'utf8');
const strict = text => text.slice(text.indexOf('async function strictBaseline()'), text.indexOf('\nlet baseline;'));
assert.equal(strict(current), strict(original));
checks.push({ name: 'original strict baseline command/function byte-equivalent', actualExit: 0, bytes: Buffer.byteLength(strict(current)), sha256: sha(strict(current)) });
assert.equal(current.includes('request_signal_passthrough'), false);
assert.ok(current.includes("for (const kind of ['bare', 'direct', 'binding']) for (const mode of ['destroy', 'rst'])"));
assert.ok(current.includes('for (let n = 0; n < 100 && value === null; n++)'));
assert.ok(current.includes('if (value === null) await delay(10)'));
assert.ok(current.includes('usedForPass: false'));
const fake = '765 (worker ) comm (end)) S 100 765 765 ' + Array(15).fill('0').join(' ') + ' 9182 0 0';
const parsed = parseStat(fake); assert.equal(parsed.comm, 'worker ) comm (end)'); assert.equal(parsed.startTimeTicks, '9182'); assert.equal(parsed.pgrp, 765);
checks.push({ name: 'JS proc parser preserves parenthesized comm and actual start identity', actualExit: 0 });
const require = createRequire(`${repo}/package.json`);
const wfText = readFileSync(`${repo}/.github/workflows/v364-owned-linux-boundary.yml`, 'utf8');
const wf = require('yaml').parse(wfText);
assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']); assert.deepEqual(wf.permissions, { contents: 'read' });
assert.equal(wf.concurrency['cancel-in-progress'], false); assert.ok(wf.concurrency.group.startsWith('v364-owned-linux-boundary-'));
const job = wf.jobs['cancellation-boundary']; assert.equal(job['timeout-minutes'], 10);
assert.equal(job.steps.find(v => v.uses?.startsWith('actions/setup-node@')).with['node-version-file'], '.nvmrc');
assert.ok(job.steps.some(v => v.run === 'npm ci')); assert.equal(job.steps.some(v => 'continue-on-error' in v), false);
assert.equal(job.steps.find(v => v.run?.includes('execute-owned-linux.py'))['timeout-minutes'], 7);
assert.equal(job.steps.find(v => v.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
const artifact = job.steps.find(v => v.uses?.startsWith('actions/upload-artifact@'));
assert.equal(artifact.if, '${{ always() }}'); assert.equal(artifact.with['include-hidden-files'], true);
assert.ok(artifact.with.name.includes('github.sha')); assert.ok(artifact.with.name.includes('github.run_id')); assert.ok(artifact.with.name.includes('github.run_attempt'));
assert.equal(/secrets\.|wrangler|cloudflare|deploy|database/i.test(wfText), false);
checks.push({ name: 'workflow manual-only/read-only/no-secrets/strict-exit/bounded/always artifact with hidden exact workflow', actualExit: 0 });
const prepareDir = `${validation}/prepare-once`;
run('prepare', process.execPath, [`${base}/run-boundary.mjs`, '--repo', repo, '--out', prepareDir, '--prepare-only'], 0);
const preparedBytes = readFileSync(`${prepareDir}/prepare-only.json`); const prepared = JSON.parse(preparedBytes);
assert.equal(prepared.runtimeExecuted, false); assert.equal(prepared.actualExit, 0); assert.equal(prepared.sourceUnchanged, true);
assert.equal(prepared.priorRun.actualProcessExit, 1); assert.equal(prepared.priorRun.leftoverGroupKilled, true); assert.equal(prepared.bundleHashes.length, 6);
run('fresh-out-rejection', process.execPath, [`${base}/run-boundary.mjs`, '--repo', repo, '--out', prepareDir, '--prepare-only'], 1, 10000);
assert.equal(sha(readFileSync(`${prepareDir}/prepare-only.json`)), sha(preparedBytes));
run('executor-windows-rejection', python, [`${base}/execute-owned-linux.py`, '--repo', repo, '--out', `${validation}/executor-windows-rejection`, '--execute-linux'], 1, 10000);
const negative = JSON.parse(readFileSync(`${validation}/executor-windows-rejection/executor.closed.json`, 'utf8'));
assert.equal(negative.actualExit, 1); assert.equal(negative.actualProcessExit, null); assert.equal(negative.runnerOutcomeCode, 1);
assert.equal(negative.closure.directChildReaped, false); assert.equal(negative.closedReportPresent, false);
const pins = JSON.parse(readFileSync(`${base}/source-inputs.json`, 'utf8'));
const pinnedGit = pins.files.map(item => {
  const b = readFileSync(`${repo}/${item.path}`); const blob = execFileSync('git', ['show', 'HEAD:' + item.path], { cwd: repo });
  assert.equal(b.length, item.bytes); assert.equal(sha(b), item.sha256); assert.ok(b.equals(blob)); return { ...item, currentGitBlobExact: true };
});
const packageFiles = readdirSync(base).sort();
assert.deepEqual(packageFiles, [...manifest.files.map(v => v.path), 'sealed-package.json'].sort());
const allNew = packageFiles.map(name => 'scripts/diagnostics/v364-owned-linux-boundary/' + name).concat('.github/workflows/v364-owned-linux-boundary.yml');
const newFiles = allNew.map(path => {
  const b = readFileSync(`${repo}/${path}`); assert.equal(b.includes(13), false); assert.equal(b.toString().startsWith('\ufeff'), false);
  const blobSHA = createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
  const git = execFileSync('git', ['hash-object', '--path', path, path], { cwd: repo, encoding: 'utf8' }).trim(); assert.equal(git, blobSHA);
  return { path, bytes: b.length, sha256: sha(b), LF: true, gitCleanFilterPreservesBytes: true, gitBlobSHA: git };
});
const report = { schema: 'v364-boundary-portable-preparation-closed-v1', actualExit: 0, endedAt: new Date().toISOString(),
  outcome: 'PREPARED_ONLY_LINUX_RUNTIME_NOT_EXECUTED', reviewBaseHEAD: pins.reviewBaseHEAD, preparedAtHead: pins.preparedAtHead,
  auditedAtHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), executionSHAIsSeparate: true,
  commands, checks, newFiles, pinnedGit, frozen10Unchanged: true, legacyDiagnosticUnchanged: true, prepared,
  negativeWindowsReceipt: negative, negativeIsLinuxClosureProof: false,
  allowedRepositoryWrites: allNew, originalStrictFailureRetained: true, causeProven: false,
  runtimeExecuted: false, ciInvocations: 0, ciPolls: 0, productionRequests: 0, databaseRequests: 0, commits: 0,
  historicalPreparationFailure: { toolChunk: '6c6527', actualExit: 1, issue: 'Temp builder syntax error before any generated main write; subsequent repaired builder closed0 chunk414b6d. No runtime ran.' },
  historicalAuditEntryFailure: { toolChunk: '12f84c', actualExit: 1, issue: 'Temp auditor Windows static ESM import path rejected before execution; corrected to file URL. No package mutation or runtime ran in failed entry.' },
  historicalInertStubFailure: { toolChunk: '52cc24', actualExit: 1, source: `${temp}/executor-inert.command-result.json`, issue: 'Windows Python lacks signal.SIGKILL; Linux signal constants now explicit in inert stub only. Original failed stdout/stderr/result preserved; no native runtime ran.' },
  limitations: ['Inert stub checks do not prove Linux process behavior.', 'Prepare-only used local Node24.14.1; runtime requires Node22.',
    'Strict original and every new cancellation window remain unexecuted in this preparation; Root owns one actual Linux dispatch.',
    'Known old runtime cancellation failure and forced flag are retained; no cause/fix/production holder enablement is claimed.'] };
const body = Buffer.from(JSON.stringify(report, null, 2) + '\n');
const reportPath = `${temp}/FINAL-v364-boundary-portable-preparation.json`;
writeFileSync(reportPath, body, { flag: 'wx' }); writeFileSync(`${reportPath}.sha256`, sha(body) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ actualExit: 0, report: reportPath, bytes: body.length, sha256: sha(body), manifestSHA: sha(readFileSync(`${base}/sealed-package.json`)), newFiles: allNew.length, pinnedInputs: pinnedGit.length, runtimeExecuted: false }));

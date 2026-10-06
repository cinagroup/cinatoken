import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = 'C:/cinagroup/cinatoken';
const dir = join(repo, 'scripts/diagnostics/v364-owned-linux');
const workflowPath = '.github/workflows/v364-owned-linux-diagnostic.yml';
const old = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-owned-linux-diagnostic-prep-bf2a9d401d3b47acb92d8e1fae4c579b';
const sha = data => createHash('sha256').update(data).digest('hex');
const receipt = path => { const b = readFileSync(path); return { path, bytes: b.length, sha256: sha(b) }; };
const checks = [];
const files = ['gateway-observer.mjs', 'holder-observer.mjs', 'run-v364-owned-diagnostic.mjs', 'execute-owned-linux.py', 'source-inputs.json', 'README.md'];
const manifest = { schema: 'v364-owned-linux-sealed-package-v1', lineEndings: 'LF', frozenInputsVerifiedAgainstGitHEAD: true,
  files: files.map(path => { const data = readFileSync(join(dir, path)); assert.equal(data.includes(13), false, path + ' LF'); return { path, bytes: data.length, sha256: sha(data) }; }) };
writeFileSync(join(dir, 'sealed-package.json'), JSON.stringify(manifest, null, 2) + '\n');
const sourceInputs = JSON.parse(readFileSync(join(dir, 'source-inputs.json')));
const gitInputs = sourceInputs.map(item => {
  const b = readFileSync(join(repo, item.path)); const blob = execFileSync('git', ['show', 'HEAD:' + item.path], { cwd: repo });
  assert.equal(b.length, item.bytes); assert.equal(sha(b), item.sha256); assert.ok(b.equals(blob), item.path + ' exact HEAD blob');
  assert.equal(b.includes(13), false);
  return { ...item, worktreeEqualsGitBlob: true, gitBlobBytes: blob.length, LF: true };
});
checks.push({ name: '10 frozen inputs equal worktree and Git HEAD bytes', actualExit: 0 });
for (const path of files.filter(path => path.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', join(dir, path)], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  checks.push({ name: 'JS syntax ' + path, actualExit: r.status });
}
const python = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const py = spawnSync(python, ['-c', 'import ast,sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_text()); print("AST OK")', join(dir, 'execute-owned-linux.py')], { encoding: 'utf8' });
writeFileSync(join(here, 'python-syntax.stdout.txt'), py.stdout); writeFileSync(join(here, 'python-syntax.stderr.txt'), py.stderr); assert.equal(py.status, 0);
checks.push({ name: 'Python AST syntax only', actualExit: py.status });
const require = createRequire(join(repo, 'package.json'));
const yaml = require('yaml');
const workflowText = readFileSync(join(repo, workflowPath), 'utf8');
const wf = yaml.parse(workflowText);
assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']); assert.deepEqual(wf.permissions, { contents: 'read' });
assert.equal(wf.concurrency['cancel-in-progress'], false); assert.ok(wf.concurrency.group.startsWith('v364-owned-linux-diagnostic-'));
assert.deepEqual(Object.keys(wf.jobs), ['cancellation-diagnostic']); const job = wf.jobs['cancellation-diagnostic'];
assert.equal(job['timeout-minutes'], 10); assert.equal(job['runs-on'], 'ubuntu-latest');
assert.equal(job.steps.find(v => v.uses?.startsWith('actions/setup-node@')).with['node-version-file'], '.nvmrc');
assert.equal(job.steps.find(v => v.run === 'npm ci').run, 'npm ci');
const run = job.steps.find(v => v.run?.includes('execute-owned-linux.py')); assert.equal(run['timeout-minutes'], 7);
assert.ok(run.run.includes('--execute-linux')); assert.ok(run.env.DIAGNOSTIC_OUT.includes('runner.temp'));
assert.ok(run.env.DIAGNOSTIC_OUT.includes('github.run_id')); assert.ok(run.env.DIAGNOSTIC_OUT.includes('github.run_attempt'));
assert.equal(job.steps.some(v => 'continue-on-error' in v), false);
const artifact = job.steps.find(v => v.uses?.startsWith('actions/upload-artifact@')); assert.equal(artifact.if, '${{ always() }}');
assert.ok(artifact.with.name.includes('github.sha')); assert.ok(artifact.with.name.includes('github.run_id'));
assert.equal(/secrets\.|wrangler|cloudflare|deploy|database/i.test(workflowText), false);
assert.equal(job.steps.find(v => v.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
checks.push({ name: 'workflow YAML/manual-only/scope/no-secrets/timeouts/artifact bindings', actualExit: 0 });
const prepOut = join(here, 'prepare-once');
const prep = spawnSync(process.execPath, [join(dir, 'run-v364-owned-diagnostic.mjs'), '--repo', repo, '--out', prepOut, '--prepare-only'], { cwd: repo, encoding: 'utf8', timeout: 60000 });
writeFileSync(join(here, 'prepare.stdout.txt'), prep.stdout ?? ''); writeFileSync(join(here, 'prepare.stderr.txt'), prep.stderr ?? ''); assert.equal(prep.status, 0, prep.stderr);
const prepared = JSON.parse(readFileSync(join(prepOut, 'prepare-only.json'))); assert.equal(prepared.runtimeExecuted, false); assert.equal(prepared.actualExit, 0);
checks.push({ name: 'actual prepare-only bundling, no runtime', actualExit: prep.status });
const prepReceipt = receipt(join(prepOut, 'prepare-only.json'));
const reused = spawnSync(process.execPath, [join(dir, 'run-v364-owned-diagnostic.mjs'), '--repo', repo, '--out', prepOut, '--prepare-only'], { cwd: repo, encoding: 'utf8', timeout: 10000 });
writeFileSync(join(here, 'fresh-out-rejection.stdout.txt'), reused.stdout ?? ''); writeFileSync(join(here, 'fresh-out-rejection.stderr.txt'), reused.stderr ?? '');
assert.equal(reused.status, 1); assert.equal(receipt(join(prepOut, 'prepare-only.json')).sha256, prepReceipt.sha256);
checks.push({ name: 'existing prepare output rejected without overwrite', actualExit: reused.status, expectedExit: 1 });
const rejection = spawnSync(python, [join(dir, 'execute-owned-linux.py'), '--repo', repo, '--out', join(here, 'executor-windows-rejection'), '--execute-linux'], { encoding: 'utf8', timeout: 10000 });
writeFileSync(join(here, 'executor-negative.stdout.txt'), rejection.stdout ?? ''); writeFileSync(join(here, 'executor-negative.stderr.txt'), rejection.stderr ?? ''); assert.equal(rejection.status, 1);
const rejected = JSON.parse(readFileSync(join(here, 'executor-windows-rejection/executor.closed.json')));
assert.equal(rejected.actualExit, 1); assert.equal(rejected.closedReportPresent, false); assert.equal(rejected.closure.directChildReaped, false);
assert.ok(readFileSync(join(here, 'executor-windows-rejection/executor.stderr.txt')).length > 0);
checks.push({ name: 'non-Linux preflight preserves real failure/stderr/closed receipt, no child', actualExit: rejection.status, expectedExit: 1 });
const newFiles = [...files, 'sealed-package.json'].map(path => 'scripts/diagnostics/v364-owned-linux/' + path).concat(workflowPath);
const gitPortable = newFiles.map(path => {
  const b = readFileSync(join(repo, path)); assert.equal(b.includes(13), false); assert.equal(b.toString().startsWith('\ufeff'), false);
  assert.equal(/[^\n]\s+\n/.test(b.toString().split('\n').filter(v => /[\t ]+$/.test(v)).join('\n')), false);
  const computed = createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
  const filtered = execFileSync('git', ['hash-object', '--path', path, path], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(filtered, computed, path + ' Git clean filter changes bytes');
  return { ...receipt(join(repo, path)), repositoryPath: path, LF: true, gitCleanFilterPreservesBytes: true, gitBlobSHA: computed };
});
for (const item of sourceInputs) assert.equal(sha(readFileSync(join(repo, item.path))), item.sha256);
const oldSeal = receipt(join(old, 'sealed-package.json')); assert.equal(oldSeal.sha256, '3b6fbfa1591bfbe82653149b260424d3fd7e9ff66705ad4b2650dda5563446e7');
const exactEntries = readdirSync(dir).sort(); assert.deepEqual(exactEntries, [...files, 'sealed-package.json'].sort());
const report = { schema: 'v364-portable-ci-preparation-closed-v1', endedAt: new Date().toISOString(), actualExit: 0,
  outcome: 'PORTABLE_PREPARED_ONLY_NOT_DISPATCHED', checks, allowedNewFiles: newFiles, gitPortable, gitInputs,
  portableManifest: receipt(join(dir, 'sealed-package.json')), originalTempSeal: oldSeal,
  normalization: { onlyNewPortableTextNormalizedToLF: true, sourceInputsOldTempHadCRLF: true, frozenInputsHadCRLF: false,
    frozenInputsGitExact: true, sourceInputsJSONValuesPreserved: JSON.stringify(sourceInputs) === JSON.stringify(JSON.parse(readFileSync(join(old, 'source-inputs.json')))) },
  preparationReceipt: prepReceipt, prepared, authoritativeExecutor: true,
  runtimeExecuted: false, linuxExecutionStillRequired: true, productionRequests: 0, ciInvocations: 0, ciPolls: 0,
  databaseRequests: 0, realIdentityActions: 0, commits: 0, existingSourceConfigLockWorkflowChanged: false,
  limitations: ['Linux subreaper/kill/reap path is reviewed and syntax checked, not executed on Windows',
    'Promise.race cannot cancel tasks; actual group closure must come from executor.closed.json',
    'Historical original cancellation null failure remains failed; no cause or corrected runtime proved'],
  priorPreparationFailure: 'initial multi-operation apply_patch verification rejected duplicate Python path; no patch applied, split operations then succeeded',
};
const body = JSON.stringify(report, null, 2) + '\n'; writeFileSync(join(here, 'FINAL-v364-portable-ci-preparation.json'), body);
writeFileSync(join(here, 'FINAL-v364-portable-ci-preparation.sha256'), sha(body) + '\n');
console.log(JSON.stringify({ actualExit: 0, report: join(here, 'FINAL-v364-portable-ci-preparation.json'), bytes: Buffer.byteLength(body), sha256: sha(body), manifestSHA: report.portableManifest.sha256, files: newFiles.length, runtimeExecuted: false }));

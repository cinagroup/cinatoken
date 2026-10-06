import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const gh = 'C:/Program Files/GitHub CLI/gh.exe';
const [bindingPath, mode] = process.argv.slice(2);
assert(bindingPath && mode, 'Explicit Root-authorised binding file and one read-only mode required');
const binding = JSON.parse(fs.readFileSync(bindingPath));
assert.equal(binding.schema, 'cinatoken-v364-queued-linux-observation-binding-v1');
assert.equal(binding.rootAuthorisedObservation, true);
assert.match(binding.sourceSHA, /^[0-9a-f]{40}$/u);
assert.match(binding.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
assert.match(String(binding.runId), /^[1-9][0-9]+$/u);
assert(Number.isSafeInteger(binding.runAttempt) && binding.runAttempt >= 1);
const observationRoot = path.resolve(binding.observationRoot);
assert.equal(path.dirname(path.resolve(bindingPath)), observationRoot);
assert(path.basename(observationRoot).startsWith('cinatoken-v364-queued-linux-run-'));
assert(fs.existsSync(observationRoot));
const prefix = `/repos/${binding.repository}/actions/runs/${binding.runId}`;
const artifactName = `v364-direct-socket-${binding.sourceSHA}-${binding.runId}-${binding.runAttempt}`;
const closedJSON = label => {
  const receipt = JSON.parse(fs.readFileSync(path.join(observationRoot, `${label}.result.json`)));
  assert.equal(receipt.closed, true); assert.equal(receipt.actualExit, 0);
  assert.equal(receipt.signal, null); assert.equal(receipt.spawnError, null); assert.equal(receipt.timedOut, false);
  assert.equal(receipt.sourceSHA, binding.sourceSHA); assert.equal(String(receipt.runId), String(binding.runId));
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(path.dirname(path.resolve(receipt[stream].path)), observationRoot);
    const bytes = fs.readFileSync(receipt[stream].path);
    assert.equal(bytes.length, receipt[stream].bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), receipt[stream].sha256);
  }
  return JSON.parse(fs.readFileSync(receipt.stdout.path));
};
let args;
let timeoutMs = 120000;
if (mode === 'watch') { args = ['run', 'watch', String(binding.runId), '--repo', binding.repository, '--interval', '45', '--exit-status']; timeoutMs = 900000; }
else if (mode === 'run-terminal') args = ['api', '--allow-escape-sequences', prefix];
else if (mode === 'jobs-terminal') args = ['api', '--allow-escape-sequences', `${prefix}/jobs?filter=latest&per_page=100`];
else if (mode === 'artifacts-terminal') args = ['api', '--allow-escape-sequences', `${prefix}/artifacts?per_page=100`];
else if (mode === 'job-log-once') {
  const raw = closedJSON('jobs-terminal');
  assert.equal(raw.total_count, 1);
  const job = raw.jobs[0]; assert.equal(job.run_id, Number(binding.runId)); assert.equal(job.name, 'direct-socket-cancellation'); assert.equal(job.status, 'completed');
  args = ['api', '--allow-escape-sequences', `/repos/${binding.repository}/actions/jobs/${job.id}/logs`];
  timeoutMs = 180000;
}
else if (mode === 'download-artifact-once') {
  const raw = closedJSON('artifacts-terminal');
  const found = raw.artifacts.filter(a => a.name === artifactName && !a.expired && a.workflow_run?.id === Number(binding.runId) && a.workflow_run.head_sha === binding.sourceSHA);
  assert.equal(found.length, 1, 'One exact run/SHA artifact required');
  args = ['api', '--allow-escape-sequences', `/repos/${binding.repository}/actions/artifacts/${found[0].id}/zip`];
  timeoutMs = 180000;
} else throw new Error('Unknown mode; dispatch, rerun and mutation are unavailable');
if (mode !== 'watch') {
  const watchReceipt = JSON.parse(fs.readFileSync(path.join(observationRoot, 'watch.result.json')));
  assert.equal(watchReceipt.closed, true);
  assert.equal(watchReceipt.signal, null);
  assert.equal(watchReceipt.spawnError, null);
  assert.equal(watchReceipt.timedOut, false);
  assert.equal(watchReceipt.sourceSHA, binding.sourceSHA); assert.equal(String(watchReceipt.runId), String(binding.runId));
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(path.dirname(path.resolve(watchReceipt[stream].path)), observationRoot);
    const bytes = fs.readFileSync(watchReceipt[stream].path);
    assert.equal(bytes.length, watchReceipt[stream].bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), watchReceipt[stream].sha256);
  }
  assert([0, 1].includes(watchReceipt.actualExit), 'Closed watch0/1 required before terminal reads');
}
if (['jobs-terminal', 'artifacts-terminal', 'job-log-once', 'download-artifact-once'].includes(mode)) {
  const run = closedJSON('run-terminal');
  assert.equal(run.id, Number(binding.runId)); assert.equal(run.head_sha, binding.sourceSHA);
  assert.equal(run.run_attempt, binding.runAttempt); assert.equal(run.status, 'completed');
}
const out = path.join(observationRoot, `${mode}.stdout.raw`);
const err = path.join(observationRoot, `${mode}.stderr.raw`);
const result = path.join(observationRoot, `${mode}.result.json`);
for (const file of [out, err, result]) assert(!fs.existsSync(file), 'wx prevents repeated watch/API/download or overwrite');
const outFD = fs.openSync(out, 'wx'), errFD = fs.openSync(err, 'wx');
const startedAt = new Date().toISOString();
let spawnError = null, timedOut = false;
const child = spawn(gh, args, { cwd: observationRoot, windowsHide: true, stdio: ['ignore', outFD, errFD] });
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
child.once('error', error => { spawnError = { name: error.name, code: error.code ?? null }; });
console.log(JSON.stringify({ mode, sourceSHA: binding.sourceSHA, runId: binding.runId, startedAt, running: true, actualExit: null, pollIntervalSeconds: mode === 'watch' ? 45 : null }));
child.once('close', (actualExit, signal) => {
  clearTimeout(timer); fs.closeSync(outFD); fs.closeSync(errFD);
  const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
  fs.writeFileSync(result, `${JSON.stringify({ schema: 'cinatoken-v364-queued-linux-readonly-gh-command-closed-v1', closed: true, mode, program: gh, args, startedAt, endedAt: new Date().toISOString(), actualExit, signal, spawnError, timedOut, timeoutMs, stdout: descriptor(out), stderr: descriptor(err), sourceSHA: binding.sourceSHA, runId: String(binding.runId), runAttempt: binding.runAttempt, expectedArtifactName: artifactName, ciDispatched: false, workflowRerun: false, productionRequest: false, appExecuted: false, gatePassDerived: false }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ mode, receipt: result, closed: true, actualExit, signal, timedOut }));
  process.exitCode = Number.isInteger(actualExit) && !signal && !spawnError && !timedOut ? actualExit : 1;
});

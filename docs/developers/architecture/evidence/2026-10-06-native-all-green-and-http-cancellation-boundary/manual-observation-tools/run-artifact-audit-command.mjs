import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [bindingFile, mode] = process.argv.slice(2);
const binding = JSON.parse(fs.readFileSync(bindingFile));
assert.equal(binding.schema, 'cinatoken-v364-queued-linux-observation-binding-v1'); assert.equal(binding.rootAuthorisedObservation, true);
const root = path.resolve(binding.observationRoot); assert.equal(path.dirname(path.resolve(bindingFile)), root); assert(path.basename(root).startsWith('cinatoken-v364-queued-linux-run-'));
let program, args;
if (mode === 'extract-artifact') { program = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'; args = [path.join(here, 'extract-artifact.py'), bindingFile]; }
else if (mode === 'review-artifact') { program = process.execPath; args = [path.join(here, 'review-artifact.mjs'), bindingFile]; }
else throw new Error('Only decode/review owned raw artifact; no runtime or test route');
const out = path.join(root, `${mode}.stdout.raw`), err = path.join(root, `${mode}.stderr.raw`), receipt = path.join(root, `${mode}.result.json`);
for (const file of [out, err, receipt]) assert(!fs.existsSync(file));
const outFD = fs.openSync(out, 'wx'), errFD = fs.openSync(err, 'wx');
const startedAt = new Date().toISOString(); let timedOut = false, spawnError = null;
const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ['ignore', outFD, errFD] });
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180000);
child.once('error', error => { spawnError = { name: error.name, code: error.code ?? null }; });
child.once('close', (actualExit, signal) => {
  clearTimeout(timer); fs.closeSync(outFD); fs.closeSync(errFD);
  const desc = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
  fs.writeFileSync(receipt, `${JSON.stringify({ schema: 'cinatoken-v364-artifact-readonly-audit-command-closed-v1', closed: true, mode, startedAt, endedAt: new Date().toISOString(), program, args, actualExit, signal, timedOut, spawnError, stdout: desc(out), stderr: desc(err), sourceSHA: binding.sourceSHA, runId: String(binding.runId), localArtifactOnly: true, gatePassDerived: false, runtimeExecuted: false }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ mode, receipt, closed: true, actualExit, signal, timedOut }));
  process.exitCode = Number.isInteger(actualExit) && !signal && !spawnError && !timedOut ? actualExit : 1;
});

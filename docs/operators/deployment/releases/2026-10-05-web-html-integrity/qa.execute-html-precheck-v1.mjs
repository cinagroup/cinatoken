import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const temp = path.dirname(fileURLToPath(import.meta.url));
const [label, configPath] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const script = path.join(temp, 'production-html-no-transform-precheck-v1.mjs');
assert.equal(raw(script).sha256, '62c8fc0a923e361120c0709993ff3b53eb7296ea652c6df3b30aee3e10ec36a8');
const resultPath = path.join(temp, `${label}-html-precheck-closed.json`);
const executionPath = path.join(temp, `${label}-execution-closed.json`);
const stdoutPath = path.join(temp, `${label}-stdout.log`);
const stderrPath = path.join(temp, `${label}-stderr.log`);
for (const p of [resultPath, executionPath, stdoutPath, stderrPath]) assert.equal(fs.existsSync(p), false, 'new wx label');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.equal(config.gitSHA, '3847955ccdb4c670f0f9aa099ef976889357e6b2');
assert.equal(config.workerVersionId, 'dbe1800e-cd09-4f47-ba5e-b2a256898ae4');
const result = { schema: 'cinatoken-html-precheck-execution-closed-v1', label, startedAt: new Date().toISOString(),
  inputScripts: [raw(fileURLToPath(import.meta.url)), raw(script)], configRaw: raw(configPath),
  gitSHA: config.gitSHA, webVersionId: config.workerVersionId, phase: config.phase,
  commandArguments: [script, '--execute', label, configPath], processExecutable: process.execPath,
  sourceWrites: 0, gitWrites: 0, deployments: 0, databaseWrites: 0, browserRuns: 0, timedOut: false };
const stdout = fs.openSync(stdoutPath, 'wx'); const stderr = fs.openSync(stderrPath, 'wx');
let timer;
try {
  const child = spawn(process.execPath, result.commandArguments, { stdio: ['ignore', stdout, stderr], windowsHide: true, shell: false });
  timer = setTimeout(() => { result.timedOut = true; child.kill(); }, 140000);
  result.exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  result.actualExit = result.exit.code;
} catch (error) { result.actualExit = 1; result.failure = { name: error.name, message: error.message }; }
finally {
  clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
  result.finishedAt = new Date().toISOString(); result.stdout = raw(stdoutPath); result.stderr = raw(stderrPath);
  if (fs.existsSync(resultPath)) {
    result.precheckResult = raw(resultPath);
    const childResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    result.precheckActualExit = childResult.actualExit;
    result.requestsPassed = childResult.requests.filter(r => r.passed).length;
    result.liveProofRawStillSame = childResult.liveProofRawStillSame;
    if (childResult.actualExit !== 0 || childResult.liveProofRawStillSame !== true) result.actualExit = 1;
  } else { result.actualExit = 1; result.precheckResultMissing = true; }
  if (result.timedOut) result.actualExit = 1;
  fs.writeFileSync(executionPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ actualExit: result.actualExit, exit: result.exit, timedOut: result.timedOut,
    passed: result.requestsPassed, result: result.precheckResult, execution: raw(executionPath) }));
}
process.exitCode = result.actualExit ?? 1;

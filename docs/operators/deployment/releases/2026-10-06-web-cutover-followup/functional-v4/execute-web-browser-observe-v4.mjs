import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const temp = path.dirname(fileURLToPath(import.meta.url));
const [label, configPath] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const script = path.join(temp, 'production-web-browser-observe-v4.mjs');
const resultPath = path.join(temp, label + '.json');
const closedPath = path.join(temp, label + '-execution-closed.json');
const logPath = path.join(temp, label + '-stdout.log');
const errorPath = path.join(temp, label + '-stderr.log');
for (const file of [resultPath, closedPath, logPath, errorPath]) assert.equal(fs.existsSync(file), false, 'unique wx label');
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const stdout = fs.openSync(logPath, 'wx');
const stderr = fs.openSync(errorPath, 'wx');
const receipt = { schema: 'cinatoken-functional-anonymous-browser-execution-v4', label,
  startedAt: new Date().toISOString(), processExecutable: process.execPath,
  inputScripts: [raw(fileURLToPath(import.meta.url)), raw(script), raw(path.join(temp, 'web-route-matrix.mjs')), raw(path.join(temp, 'readiness-v4.mjs')), raw(path.join(temp, 'v4-sealed-plan.json'))],
  configRaw: raw(configPath), expectedGitSHA: config.gitSHA, expectedWorkerVersionId: config.workerVersionId,
  phase: config.phase, targetOrigin: config.targetOrigin, commandArguments: [script, label, configPath],
  sourceWrites: 0, deployments: 0, databaseWrites: 0, timedOut: false, scheduling: 'Original four anonymous contexts and 390/420s budgets; functional DOMContentLoaded/UI readiness; separate v4 result; no networkidle/identity/performance/fullG8 claim', deadlineMs: 420000 };
let timer;
try {
  const child = spawn(process.execPath, [script, label, configPath], { stdio: ['ignore', stdout, stderr], windowsHide: true, shell: false });
  timer = setTimeout(() => { receipt.timedOut = true; child.kill(); }, 420000);
  receipt.exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  receipt.actualExit = receipt.exit.code;
} catch (error) { receipt.actualExit = 1; receipt.failure = { name: error.name, message: error.message }; }
finally {
  clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
  receipt.finishedAt = new Date().toISOString(); receipt.stdout = raw(logPath); receipt.stderr = raw(errorPath);
  if (fs.existsSync(resultPath)) {
    receipt.browserResult = raw(resultPath);
    const browser = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    receipt.browserActualExit = browser.actualExit; receipt.outcome = browser.outcome;
    receipt.browserClosed = browser.browserClosed; receipt.contextClosed = browser.contextClosed;
    receipt.screenshots = browser.screenshots; receipt.shards = browser.shards.map(shard => ({ name: shard.name, status: shard.status, pages: shard.pages.length, contextClosed: shard.contextClosed })); receipt.pages = browser.pages.length; receipt.consoleClassificationExecuted = browser.consoleClassificationExecuted; receipt.readinessMethod = browser.readinessMethod; receipt.v4SealedBefore = browser.v4SealedBefore; receipt.v4SealedAfter = browser.v4SealedAfter;
    if (browser.actualExit !== 0 || browser.browserClosed !== true || browser.contextClosed !== true || browser.liveProofRawStillSame !== true || browser.sourceAndConfigRawStillSame !== true || browser.pages.length !== 45 || browser.shards.length !== 4 || browser.shards.some(shard => shard.contextClosed !== true) || browser.consoleClassificationExecuted !== true) receipt.actualExit = 1;
    if (!browser.v4SealedBefore?.originalInputsStillSame || !browser.v4SealedAfter?.originalInputsStillSame || browser.readinessMethod?.networkidleMeasuredOrPassed !== false || browser.outcome !== 'PASS_FUNCTIONAL_ANONYMOUS_WEB_BROWSER_V4_ONLY') receipt.actualExit = 1;
  } else { receipt.browserResultMissing = true; receipt.actualExit = 1; }
  if (receipt.timedOut) receipt.actualExit = 1;
  try {
    for (const item of receipt.inputScripts) assert.deepEqual(raw(item.path), item, 'execution input remains unchanged');
    assert.deepEqual(raw(configPath), receipt.configRaw, 'execution config remains unchanged');
    receipt.inputRawStillSame = true;
  } catch (error) { receipt.inputRawStillSame = false; receipt.inputFailure = error.message; receipt.actualExit = 1; }
  fs.writeFileSync(closedPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ actualExit: receipt.actualExit, outcome: receipt.outcome, timedOut: receipt.timedOut, evidence: raw(closedPath), result: receipt.browserResult, screenshots: receipt.screenshots }));
}
process.exitCode = receipt.actualExit ?? 1;

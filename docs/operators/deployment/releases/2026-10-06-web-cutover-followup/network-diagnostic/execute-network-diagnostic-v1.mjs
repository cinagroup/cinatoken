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
const script = path.join(temp, 'production-network-diagnostic-v1.mjs');
const preparationPath = path.join(temp, 'preparation.receipt.json');
const prep = JSON.parse(fs.readFileSync(preparationPath, 'utf8'));
assert.deepEqual(raw(script), prep.diagnosticScript); assert.deepEqual(raw(fileURLToPath(import.meta.url)), prep.executorScript);
for (const item of prep.sealedInputs) assert.deepEqual(raw(item.path), item);
const resultPath = path.join(temp, label + '.json'), closedPath = path.join(temp, label + '-execution-closed.json');
const logPath = path.join(temp, label + '-stdout.log'), stderrPath = path.join(temp, label + '-stderr.log');
for (const file of [resultPath, closedPath, logPath, stderrPath, path.join(temp, label + '-events.jsonl')]) assert.equal(fs.existsSync(file), false, 'one new execution, no evidence overwrite');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.deepEqual(raw(config.liveProof.path), config.liveProof);
const receipt = { schema: 'cinatoken-production-network-diagnostic-execution-v1', label, startedAt: new Date().toISOString(), processExecutable: process.execPath, commandArguments: [script, label, configPath], inputScripts: [raw(script), raw(fileURLToPath(import.meta.url))], preparationRaw: raw(preparationPath), configRaw: raw(configPath), liveProof: config.liveProof, sourceWrites: 0, deployments: 0, databaseWrites: 0, apiWrites: 0, deadlineMs: 180000, timedOut: false, actualExit: 1 };
let child, deadline;
const stdout = fs.openSync(logPath, 'wx'), stderr = fs.openSync(stderrPath, 'wx');
try {
  child = spawn(process.execPath, [script, label, configPath], { stdio: ['ignore', stdout, stderr], windowsHide: true, shell: false });
  receipt.childPID = child.pid;
  deadline = setTimeout(() => { receipt.timedOut = true; if (child.pid) { const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); kill.on('error', error => { receipt.processTreeKillError = error.message; child.kill(); }); kill.on('close', code => { receipt.processTreeKillExit = code; }); } else child.kill(); }, 180000);
  receipt.exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  receipt.actualExit = receipt.exit.code;
} catch (error) { receipt.actualExit = 1; receipt.failure = { name: error.name, message: error.message }; }
finally {
  clearTimeout(deadline); fs.closeSync(stdout); fs.closeSync(stderr); receipt.finishedAt = new Date().toISOString(); receipt.stdout = raw(logPath); receipt.stderr = raw(stderrPath);
  if (fs.existsSync(resultPath)) { receipt.browserResult = raw(resultPath); const r = JSON.parse(fs.readFileSync(resultPath, 'utf8')); receipt.browserActualExit = r.actualExit; receipt.outcome = r.outcome; receipt.summary = r.summary; receipt.contextClosed = r.contextClosed; receipt.browserClosed = r.browserClosed; receipt.bindingsUnchanged = r.bindingsUnchanged; receipt.screenshots = r.screenshots; if (r.actualExit !== 0 || !r.contextClosed || !r.browserClosed || !r.bindingsUnchanged) receipt.actualExit = 1; }
  else { receipt.browserResultMissing = true; receipt.actualExit = 1; }
  if (receipt.timedOut) receipt.actualExit = 1;
  try { for (const item of receipt.inputScripts) assert.deepEqual(raw(item.path), item); for (const item of prep.sealedInputs) assert.deepEqual(raw(item.path), item); assert.deepEqual(raw(configPath), receipt.configRaw); assert.deepEqual(raw(config.liveProof.path), config.liveProof); assert.deepEqual(raw(preparationPath), receipt.preparationRaw); receipt.inputRawStillSame = true; }
  catch (error) { receipt.inputRawStillSame = false; receipt.inputFailure = error.message; receipt.actualExit = 1; }
  const journalPath = path.join(temp, label + '-events.jsonl'); if (fs.existsSync(journalPath)) receipt.eventJournal = raw(journalPath);
  fs.writeFileSync(closedPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ actualExit: receipt.actualExit, timedOut: receipt.timedOut, evidence: raw(closedPath), summary: receipt.summary, contextClosed: receipt.contextClosed, browserClosed: receipt.browserClosed, inputRawStillSame: receipt.inputRawStillSame }));
}
process.exitCode = receipt.actualExit;

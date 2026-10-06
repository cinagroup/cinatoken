import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942';
const repo = 'C:/cinagroup/cinatoken';
const source = `${repo}/scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs`;
const require = createRequire(`${repo}/package.json`);
const acorn = require('acorn');
const bytes = fs.readFileSync(source);
const text = bytes.toString('utf8');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
fs.writeFileSync(`${root}/run-direct-socket.before.mjs`, bytes, { flag: 'wx' });
fs.mkdirSync(`${root}/protected-inputs`);
const protectedInputs = [];
for (const relative of ['scripts/diagnostics/v364-owned-linux-boundary/bare-async-source.mjs', 'scripts/diagnostics/v364-owned-linux/holder-observer.mjs', 'scripts/diagnostics/v364-owned-linux-boundary/proc-census.mjs', 'scripts/diagnostics/v364-direct-socket/native-reader-calibration.mjs', 'packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc', 'packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc']) {
  const b = fs.readFileSync(`${repo}/${relative}`);
  const copy = `${root}/protected-inputs/${relative.replaceAll('/', '__')}`;
  fs.writeFileSync(copy, b, { flag: 'wx' });
  protectedInputs.push({ path: `${repo}/${relative}`, copy, bytes: b.length, sha256: hash(b) });
}
const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
const fn = name => {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert(node, name);
  return text.slice(node.start, node.end);
};
const mutations = [];
let candidate = text;
function replace(old, next, reason) {
  assert.equal(candidate.split(old).length - 1, 1, reason);
  candidate = candidate.replace(old, next);
  mutations.push({ old, next, reason });
}
replace('import { processCensus } from "../v364-owned-linux-boundary/proc-census.mjs";', 'import { processCensus } from "../v364-owned-linux-boundary/proc-census.mjs";\nimport { parseStat } from "../v364-owned-linux-boundary/proc-census.mjs";\nimport { readdirSync, readlinkSync } from "node:fs";', 'only new proc-observation imports; original import unchanged');
const queuedBundle = `async function queuedWriteBundle() {\n\tconst contents = readFileSync(join(legacy, "holder-observer.mjs"), "utf8").replace("__ORIGINAL__", join(here, "queued-write-source.mjs").replaceAll("\\\\", "/"));\n\tconst built = await build({ stdin: { contents, resolveDir: here, sourcefile: "queued-write-observer.mjs", loader: "js" }, bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });\n\tassert.equal(built.outputFiles.length, 1);\n\treturn built.outputFiles[0].text;\n}\n`;
replace('const bundles = {', `${queuedBundle}const bundles = {`, 'add one bundle function, leaving original bundle functions exact');
replace('\tnativeReader: await nativeReaderBundle(),\n};', '\tnativeReader: await nativeReaderBundle(),\n\tqueuedWrite: await queuedWriteBundle(),\n};', 'add a separate helper bundle property only');
const fixture = fn('createFixture').replace('function createFixture(caseId, kind)', 'function createQueuedWriteFixture(caseId, kind)').replace('script: kind === "bare" ? bundles.bare : bundles.nativeReader,', 'script: bundles.queuedWrite,');
assert.notEqual(fixture, fn('createFixture'));
replace('async function readyFixture(f) {', `${fixture}\nasync function readyFixture(f) {`, 'copy original fixture into a separate queued-only fixture; original function exact');
let http = fn('httpClient').replace('function httpClient(caseId, url, body, mode)', 'function queuedWriteHttpClient(caseId, url, body, mode)').replace('\t\t\t\tresponse.pause();', '\t\t\t\tresponse.pause();\n\t\t\t\tsocket.pause();').replace('\t\t\t\t\tfirst,\n\t\t\t\t\tasync cancel()', '\t\t\t\t\tfirst,\n\t\t\t\t\tpressureBeforeReset: null,\n\t\t\t\t\tsocketTuple: () => ({ localAddress: socket.localAddress, localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, socketPaused: socket.isPaused() }),\n\t\t\t\t\tasync cancel(beforeReset)').replace('\t\t\t\t\t\t\t\tsocket.resetAndDestroy();', '\t\t\t\t\t\t\t\tthis.pressureBeforeReset = beforeReset();\n\t\t\t\t\t\t\t\tevent(caseId, "queued-immediate-pre-rst-backlog", this.pressureBeforeReset);\n\t\t\t\t\t\t\t\tsocket.resetAndDestroy();');
assert(http.includes('this.pressureBeforeReset = beforeReset();'));
assert(http.includes('socket.pause();'));
const extension = fs.readFileSync(`${root}/queued-pressure-extension.snippet.mjs`, 'utf8');
replace('async function observedGet(caseId, observations, key, n, phase) {', `${http}\n${extension}\nasync function observedGet(caseId, observations, key, n, phase) {`, 'add separate client and pressure observer; original client and observedGet unchanged');
let arm = fn('cancellationCase').replace('async function cancellationCase(caseId, kind, mode) {', 'async function queuedWritePressureCase() {\n\tconst caseId = "direct-socket-bare-rst-queued-write";\n\tconst kind = "queued-write";\n\tconst mode = "rst";').replace('f = createFixture(caseId, kind);', 'f = createQueuedWriteFixture(caseId, kind);').replace('httpClient(caseId, f.url, body, mode)', 'queuedWriteHttpClient(caseId, f.url, body, mode)').replace('\t\tphase(caseId, "client-cancel");', '\t\tphase(caseId, "queued-write-admission");\n\t\tresult.queuedPressureAdmission = await admitQueuedBacklog(caseId, f, client, e.attemptNonce);\n\t\tphase(caseId, "client-cancel");').replace('client.cancel(), 10000, "cancel"', 'client.cancel(() => queuedSendBacklog(f, client)), 10000, "cancel"').replace('\t\tphase(caseId, "original-poll");', '\t\tresult.immediatePreRST = client.pressureBeforeReset;\n\t\tconst prior = result.queuedPressureAdmission.samples.at(-1);\n\t\tresult.transportBacklogObservedBeforeRST = Boolean(result.queuedPressureAdmission.admitted && prior?.known && client.pressureBeforeReset?.known && prior.txBytes > 0 && client.pressureBeforeReset.txBytes > 0 && prior.inode === client.pressureBeforeReset.inode && prior.pid === client.pressureBeforeReset.pid && prior.startTimeTicks === client.pressureBeforeReset.startTimeTicks && client.pressureBeforeReset.at - prior.at < 100);\n\t\tresult.pressureStatus = result.transportBacklogObservedBeforeRST ? "owned-kernel-tx-backlog-observed-before-rst" : "unknown";\n\t\tresult.cppPendingWriteProven = false;\n\t\tphase(caseId, "original-poll");').replace('\t\tresult.actualExit = result.originalWindow.actualExit;', '\t\tresult.sourceAndSignalLogsBeforeDispose = queuedSourceLogs(caseId);\n\t\tconst logs = result.sourceAndSignalLogsBeforeDispose;\n\t\tconst observed = name => logs.filter(row => row.parsed.event === name && row.phase === "original-poll").length;\n\t\tresult.distinctCallbacks = { incomingSignalAbort: observed("signal-abort"), syntheticCleanupHookInvoke: observed("cleanup-hook-invoke"), syntheticCleanupHookReturn: observed("cleanup-hook-return"), realSourceCancelHookInvoke: observed("source-cancel-hook-invoke"), realSourceCancelHookFulfilled: observed("source-cancel-hook-fulfilled"), businessCleanupProof: false, signalListenerWritesCancelKV: false, signalListenerCallsReaderCancel: false };\n\t\tresult.actualExit = result.originalWindow.actualExit === 0 && result.transportBacklogObservedBeforeRST && Object.entries(result.distinctCallbacks).filter(([key]) => ["incomingSignalAbort", "syntheticCleanupHookInvoke", "syntheticCleanupHookReturn", "realSourceCancelHookInvoke", "realSourceCancelHookFulfilled"].includes(key)).every(([,count]) => count === 1) ? 0 : 1;').replace('\t\tresults.push(result);\n\t}\n}', '\t}\n\treturn result;\n}');
assert(arm.includes('return result;'));
assert(!arm.includes('results.push(result)'));
arm = arm.replace('row.phase === "original-poll"', '["client-cancel", "original-poll"].includes(row.phase)');
replace('async function nativeReaderCalibration() {', `${arm}\nasync function nativeReaderCalibration() {`, 'add one additional arm; original cancellationCase and reader calibration unchanged');
replace('let baseline;', 'let queuedWriteComparison;\nlet baseline;', 'independent result field; original results array remains five');
replace('\t\t}\n} catch (error) {\n\tfatal = errorSafe(error);', '\t\t}\n\tqueuedWriteComparison = await bounded(queuedWritePressureCase(), 30000, "queued write diagnostic arm");\n\tif (queuedWriteComparison.actualExit !== 0 || !queuedWriteComparison.closed) throw new Error("queued write comparison failed or pressure/callback observation unknown");\n} catch (error) {\n\tfatal = errorSafe(error);', 'append after original4 exact arm schedule, never replacing strict baseline');
replace('\t\tresults,\n\t\tfatal,', '\t\tresults,\n\t\tqueuedWriteComparison,\n\t\tfatal,', 'keep extra result separate from five original results and actualExit formula');
let reversed = candidate;
for (const edit of [...mutations].reverse()) {
  assert.equal(reversed.split(edit.next).length - 1, 1, edit.reason);
  reversed = reversed.replace(edit.next, edit.old);
}
assert.equal(reversed, text);
fs.writeFileSync(`${root}/run-direct-socket.candidate.mjs`, candidate, { flag: 'wx' });
fs.writeFileSync(`${root}/candidate-edit-index.json`, `${JSON.stringify({ source, before: { bytes: bytes.length, sha256: hash(bytes) }, candidate: { bytes: Buffer.byteLength(candidate), sha256: hash(Buffer.from(candidate)) }, reverseEntireBytesExact: true, mutations, protectedInputs, preparedOnly: true, repositoryWrite: false, runtimeExecuted: false }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ candidateBytes: Buffer.byteLength(candidate), candidateSHA256: hash(Buffer.from(candidate)), additionalArms: 1, reverseEntireBytesExact: true, repositoryWrite: false, runtimeExecuted: false }));

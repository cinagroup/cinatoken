import assert from 'node:assert/strict';
import fs from 'node:fs';
const file='C:/cinagroup/cinatoken/scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs';
let source=fs.readFileSync(file,'utf8');
const begin=source.indexOf('async function strictBaseline()'),end=source.indexOf('let baseline;',begin);
assert.ok(begin>0&&end>begin);
const replacement=`async function strictBaseline() {
  const startedAt = new Date().toISOString();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true', NO_COLOR: '1' };
  const args = ['--import', require.resolve('tsx'), '--test', 'scripts/staging/chat-holder-binding-v364.node.test.mjs', 'scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs'];
  const stdoutFile = 'original-strict.stdout.txt', stderrFile = 'original-strict.stderr.txt';
  for (const file of [stdoutFile, stderrFile]) writeFileSync(join(output, file), Buffer.alloc(0), { flag: 'wx' });
  // Share the supervisor's isolated process group. Capture original byte chunks without decoding or truncation.
  const child = spawn(process.execPath, args, { cwd: join(repo, 'packages/proxy'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false, outputLimitExceeded = false, observedBytes = 0;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
  for (const [stream, file] of [['stdout', stdoutFile], ['stderr', stderrFile]]) child[stream].on('data', bytes => {
    appendFileSync(join(output, file), bytes); observedBytes += bytes.length;
    if (observedBytes > 8 * 1024 * 1024) { outputLimitExceeded = true; child.kill('SIGKILL'); }
  });
  let spawnError; child.on('error', error => { spawnError = errorSafe(error); });
  const [code, signal] = await new Promise(resolveClose => child.once('close', (...args) => resolveClose(args)));
  clearTimeout(timer);
  const descriptor = file => { const bytes = readFileSync(join(output, file)); return { file, bytes: bytes.length, sha256: sha(bytes) }; };
  return { closed: true, startedAt, endedAt: new Date().toISOString(), program: process.execPath, args,
    cwd: join(repo, 'packages/proxy'), actualExit: code, code, signal, timedOut, outputLimitExceeded, spawnError,
    stdout: descriptor(stdoutFile), stderr: descriptor(stderrFile) };
}
function verifyNativeCalibrationObservations() {
  const result = results.find(row => row.caseId === 'native-worker-reader-cancel');
  if (!result || result.actualExit !== 0) return;
  try {
    const rows = events.filter(row => row.caseId === result.caseId && row.kind === 'workerd-log' && row.message.includes('V364_DIAG '))
      .map(row => JSON.parse(row.message.slice(row.message.indexOf('V364_DIAG ') + 'V364_DIAG '.length)));
    const count = (boundary, event, category, method) => rows.filter(row => row.boundary === boundary && row.event === event
      && (category === undefined || row.category === category) && (method === undefined || row.method === method)).length;
    const observed = { cancelPutInvoke: count('holder','kv-invoke','cancel','put'), cancelPutFulfilled: count('holder','kv-fulfilled','cancel','put'),
      waitUntilRegister: count('holder','waitUntil-register'), waitUntilFulfilled: count('holder','waitUntil-fulfilled'), waitUntilRejected: count('holder','waitUntil-rejected'),
      readerCancelInvoke: count('native-reader-calibration','reader-cancel-invoke'), readerCancelFulfilled: count('native-reader-calibration','reader-cancel-fulfilled') };
    assert.deepEqual(observed, { cancelPutInvoke:1, cancelPutFulfilled:1, waitUntilRegister:1, waitUntilFulfilled:1, waitUntilRejected:0, readerCancelInvoke:1, readerCancelFulfilled:1 });
    const releaseIndex = rows.findIndex(row => row.boundary === 'holder' && row.event === 'kv-invoke' && row.category === 'release' && row.method === 'get');
    const cancelIndex = rows.findIndex(row => row.boundary === 'native-reader-calibration' && row.event === 'reader-cancel-invoke');
    assert.ok(releaseIndex >= 0 && releaseIndex < cancelIndex, 'original async pull must be observed before explicit native reader cancel');
    result.nativeObserverEvidence = { ...observed, originalPullObservedBeforeCancel:true, addsLifetimeTask:false };
  } catch (error) { result.actualExit=1; result.nativeObservationFailure=errorSafe(error); }
}
`;
source=source.slice(0,begin)+replacement+source.slice(end);
source=source.replace('if (baseline.timedOut || baseline.spawnError || baseline.signal)','if (baseline.timedOut || baseline.outputLimitExceeded || baseline.spawnError || baseline.signal || !Number.isSafeInteger(baseline.code))');
const original='\tfor (const f of active.values()) await disposeFixture(f, "outer-finally");\n\tconst inputsAfter = snapshot();\n\tsourceUnchanged =\n\t\tJSON.stringify(inputsBefore) === JSON.stringify(inputsAfter);';
assert.equal(source.split(original).length-1,1);
source=source.replace(original,'\tfor (const f of active.values()) await disposeFixture(f, "outer-finally");\n\tawait new Promise(resolve => setImmediate(resolve));\n\tverifyNativeCalibrationObservations();\n\tconst inputsAfter = snapshot();\n\tconst installedAfter = installedSnapshot();\n\tsourceUnchanged =\n\t\tJSON.stringify(inputsBefore) === JSON.stringify(inputsAfter) && JSON.stringify(installedBefore) === JSON.stringify(installedAfter);');
assert.equal(source.split('\t\tinputsAfter,').length-1,1);
source=source.replace('\t\tinputsAfter,','\t\tinputsAfter,\n\t\tinstalledBefore,\n\t\tinstalledAfter,');
fs.writeFileSync(file,source);
console.log(JSON.stringify({refinedNewRunnerOnly:true, originalStreamAndTestSourcesModified:false}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const repo='C:/cinagroup/cinatoken';
const dir=path.join(repo,'scripts/diagnostics/v364-direct-socket');
const old=path.join(repo,'scripts/diagnostics/v364-owned-linux-boundary');
const sha=x=>createHash('sha256').update(x).digest('hex');
if(fs.existsSync(dir)) assert.deepEqual(fs.readdirSync(dir),[], 'only the empty owned directory from failed preparation may be reused');
else fs.mkdirSync(dir,{recursive:false});
let text=fs.readFileSync(path.join(old,'run-boundary.mjs'),'utf8');
const operations=[];
function replace(before,after){assert.equal(text.split(before).length-1,1,before.slice(0,80));text=text.replace(before,after);operations.push({before,after});}
replace("import { createServer, request as httpRequest } from 'node:http';","import { request as httpRequest } from 'node:http';");
replace("import { processCensus } from './proc-census.mjs';","import { processCensus } from '../v364-owned-linux-boundary/proc-census.mjs';");
replace("const legacy = join(here, '..', 'v364-owned-linux');","const legacy = join(here, '..', 'v364-owned-linux');\nconst boundary = join(here, '..', 'v364-owned-linux-boundary');");
replace("v364-owned-linux-boundary-executor-start-v1","v364-direct-socket-executor-start-v1");
replace("v364-boundary-source-inputs-v1","v364-direct-socket-source-inputs-v1");
const begin=text.indexOf('const priorAnalysis = '), end=text.indexOf('const gatewayConfig = ',begin);
assert.ok(begin>0&&end>begin);
operations.push({section:'prior artifact provenance',oldSource:text.slice(begin,end)});
text=text.slice(0,begin)+`const priorExecutor = JSON.parse(readFileSync(join(repo, sealedInputs.priorArtifactRoot, 'executor.closed.json'), 'utf8'));
const priorNode = JSON.parse(readFileSync(join(repo, sealedInputs.priorArtifactRoot, 'closed-result.json'), 'utf8'));
assert.equal(priorExecutor.schema, 'v364-owned-linux-boundary-executor-closed-v1');
assert.equal(priorNode.schema, 'v364-owned-linux-boundary-closed-v1');
assert.equal(priorExecutor.actualExit, 1); assert.equal(priorExecutor.actualProcessExit, 1); assert.equal(priorExecutor.runnerOutcomeCode, 1);
assert.equal(priorNode.actualExit, 1); assert.equal(priorNode.baseline.code, 1);
assert.equal(priorExecutor.run.GITHUB_RUN_ID, '37402302570');
assert.equal(priorExecutor.closure.groupGone, true); assert.equal(priorExecutor.closure.directChildReaped, true);
assert.equal(priorNode.results.length, 8);
assert.equal(priorNode.results.filter(v => v.originalWindow?.actual === null && v.tail?.actual === null).length, 6);
const priorEvents = gunzipSync(readFileSync(join(repo, sealedInputs.priorArtifactRoot, 'events.json.gz')));
assert.equal(sha(priorEvents), priorNode.events.sha256); assert.equal(priorEvents.length, priorNode.events.bytes);
const priorRun = { runId: '37402302570', checkoutSHA: priorExecutor.run.GITHUB_SHA,
  actualExit: priorExecutor.actualExit, actualProcessExit: priorExecutor.actualProcessExit, runnerOutcomeCode: priorExecutor.runnerOutcomeCode,
  originalStrictActualExit: priorNode.baseline.code, outerUnforcedGroupClose: priorExecutor.closure.outerUnforcedGroupClose,
  gracefulWorkerdExitProven: false, causeProven: false, unchangedHistoricalFailure: true };
`+text.slice(end);
const bStart=text.indexOf('async function boundaryBundle('),bEnd=text.indexOf('async function observedBareBundle()',bStart);
assert.ok(bStart>0&&bEnd>bStart); operations.push({section:'unused local-direct arm removed',oldSource:text.slice(bStart,bEnd)});
text=text.slice(0,bStart)+`async function nativeReaderBundle() {
  const result = await build({ entryPoints: [join(here, 'native-reader-calibration.mjs')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    plugins: [{ name: 'frozen-holder-observer', setup(plugin) {
      plugin.onResolve({ filter: /^__HOLDER_OBSERVER__$/ }, () => ({ path: join(legacy, 'holder-observer.mjs') }));
      plugin.onResolve({ filter: /^__ORIGINAL__$/ }, () => ({ path: join(source, holderConfig.main) }));
    } }],
  });
  assert.equal(result.outputFiles.length, 1); return result.outputFiles[0].text;
}
`+text.slice(bEnd);
replace("join(here, 'bare-async-source.mjs')","join(boundary, 'bare-async-source.mjs')");
replace("bare: await observedBareBundle(), direct: await boundaryBundle('direct-holder.mjs'),","bare: await observedBareBundle(), nativeReader: await nativeReaderBundle(),");
replace("v364-linux-boundary-prepare-v1","v364-direct-socket-prepare-v1");
replace("const single = { ...common, name: 'v364-boundary-' + kind, script: kind === 'bare' ? bundles.bare : bundles.direct, kvNamespaces: kv };","const single = { ...common, name: 'v364-direct-' + kind, script: kind === 'bare' ? bundles.bare : bundles.nativeReader, kvNamespaces: kv }; ");
replace("  const mf = new Miniflare(convertV4MiniflareOptions(","  workers[0].unsafeDirectSockets = [{ host: '127.0.0.1', port: 0 }];\n  const mf = new Miniflare(convertV4MiniflareOptions(");
replace("owner: kind === 'binding' ? holderConfig.name : single.name, observations: null, url: null","owner: kind === 'binding' ? holderConfig.name : single.name, entryWorkerName: workers[0].name, observations: null, url: null, entryURL: null, directURL: null");
replace("  f.url = new URL('/fixture/complete-text', await f.mf.ready);\n  assert.equal(f.url.hostname, '127.0.0.1'); assert.equal(f.url.protocol, 'http:');",`  f.entryURL = await f.mf.ready;
  f.directURL = await f.mf.unsafeGetDirectURL(f.entryWorkerName);
  for (const url of [f.entryURL, f.directURL]) { assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); }
  assert.notEqual(f.directURL.origin, f.entryURL.origin, 'diagnostic must bypass Miniflare core ENTRY_WORKER');
  f.url = new URL(f.kind === 'native-reader' ? '/fixture/native-reader-cancel' : '/fixture/complete-text', f.directURL);
  event(f.caseId, 'direct-socket-ready', { entryWorkerName: f.entryWorkerName, directURL: f.directURL.origin, coreEntryURL: f.entryURL.origin, coreEntryBypassed: true });`);
replace("baselineEligible: false, diagnosticVariant: true, originalWindow","baselineEligible: false, diagnosticVariant: true, directSocket: true, coreEntryBypassed: true, originalWindow");
const cStart=text.indexOf('async function calibration(mode)'),cEnd=text.indexOf('async function strictBaseline()',cStart);
assert.ok(cStart>0&&cEnd>cStart); operations.push({section:'Node socket calibration replaced by native worker reader cancellation',oldSource:text.slice(cStart,cEnd)});
text=text.slice(0,cStart)+`async function nativeReaderCalibration() {
  const caseId = 'native-worker-reader-cancel';
  const result = { caseId, calibrationOnly: true, baselineEligible: false, nativeWorkerExecuted: false, actualExit: 1, closed: false };
  let f; let request;
  try {
    f = createFixture(caseId, 'native-reader'); await bounded(readyFixture(f), 10000, 'native calibration readiness');
    const e = envelope(); const body = JSON.stringify(e); f.url.searchParams.set('attemptNonce', e.attemptNonce);
    phase(caseId, 'native-reader-calibration');
    const response = await bounded(new Promise((resolveResponse, reject) => {
      request = httpRequest(f.url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('native calibration HTTP timeout')));
      request.once('response', incoming => {
        const chunks = []; let bytes = 0;
        incoming.on('error', reject);
        incoming.on('data', chunk => { bytes += chunk.length; if (bytes > 2048) { incoming.destroy(); request.destroy(); reject(new Error('native calibration JSON bound exceeded')); } else chunks.push(chunk); });
        incoming.once('end', () => resolveResponse({ status: incoming.statusCode, contentType: incoming.headers['content-type'], complete: incoming.complete, body: Buffer.concat(chunks).toString('utf8') }));
      }); request.end(body);
    }), 15000, 'native calibration result');
    assert.equal(response.status, 200); assert.equal(response.contentType, 'application/json'); assert.equal(response.complete, true);
    const received = JSON.parse(response.body);
    assert.deepEqual(received, { nativeReaderCancel: true, firstFrame: ': holder-ready\\n\\n',
      pendingReadSettledBeforeCancel: false, pendingReadAfterCancelDone: true, cancel: 'observed', release: null, accepted: 'one' });
    assert.equal(await observedGet(caseId, f.observations, 'cancel:' + e.attemptNonce, 0, 'native-calibration'), 'observed');
    assert.equal(await observedGet(caseId, f.observations, 'release:' + e.attemptNonce, 0, 'native-calibration'), null);
    assert.equal(await observedGet(caseId, f.observations, 'accepted:' + e.attemptNonce, 0, 'native-calibration'), 'one');
    result.nativeWorkerExecuted = true; result.received = received; result.actualExit = 0;
  } catch (error) { result.error = errorSafe(error); }
  finally { request?.destroy(); if (f) result.closed = await disposeFixture(f, 'native-reader-finally');
    event(caseId, 'case-closed', { actualExit: result.actualExit, closed: result.closed, calibrationOnly: true, baselineEligible: false }); results.push(result); }
}
`+text.slice(cEnd);
replace("  for (const mode of ['destroy', 'rst']) await bounded(calibration(mode), 15000, 'calibration case');\n  for (const kind of ['bare', 'direct', 'binding']) for (const mode of ['destroy', 'rst']) {\n    await bounded(cancellationCase('locked-' + kind + '-' + mode, kind, mode), 30000, 'boundary cancellation case');\n  }",`  await bounded(nativeReaderCalibration(), 30000, 'native worker reader-cancel calibration');
  for (const kind of ['bare', 'binding']) for (const mode of ['destroy', 'rst']) {
    await bounded(cancellationCase('direct-socket-' + kind + '-' + mode, kind, mode), 30000, 'direct socket cancellation case');
  }`);
replace("results.length === 8","results.length === 5");
replace("const report = { schema: 'v364-owned-linux-boundary-closed-v1'", "const report = { schema: 'v364-direct-socket-closed-v1'");
replace("'STRICT_SYNTHETIC_BOUNDARY_COMPARISON_ONLY'","'STRICT_SYNTHETIC_DIRECT_SOCKET_COMPARISON_ONLY'");
replace("    limitations: ['Bare stream simplifies envelope validation and has no gateway/holder import; timing perturbation remains possible.',\n      'Direct arm changes request execution context topology by calling original holder locally and contains synthetic private literals; it cannot pass the original binding baseline.',",`    limitations: ['Bare stream simplifies envelope validation and has no gateway/holder import; timing perturbation remains possible.',
      'Direct sockets change transport entry topology only and cannot pass the unchanged original mf.ready baseline.',
      'Native reader-cancel calibration runs within an active worker fetch; it cannot prove transport cancellation or original pending pull quiescence.',`);
fs.writeFileSync(path.join(dir,'run-direct-socket.mjs'),text,{flag:'wx'});
let py=fs.readFileSync(path.join(old,'execute-owned-linux.py'),'utf8');
const changes=[
 ['Owned Linux boundary executor.', 'Owned Linux direct-socket executor.'],
 ['v364-owned-linux-boundary-sealed-package-v1','v364-direct-socket-sealed-package-v1'],
 [".github/workflows/v364-owned-linux-boundary.yml",".github/workflows/v364-direct-socket.yml"],
 ['v364-owned-linux-boundary-executor-start-v1','v364-direct-socket-executor-start-v1'],
 ['run-boundary.mjs','run-direct-socket.mjs'],
 ["expected_ids = {'node-http-calibration-' + mode for mode in ('destroy', 'rst')}\n        expected_ids.update('locked-' + kind + '-' + mode for kind in ('bare', 'direct', 'binding') for mode in ('destroy', 'rst'))", "expected_ids = {'native-worker-reader-cancel'}\n        expected_ids.update('direct-socket-' + kind + '-' + mode for kind in ('bare', 'binding') for mode in ('destroy', 'rst'))"],
 ['v364-owned-linux-boundary-closed-v1','v364-direct-socket-closed-v1'],
 ["len(raw['results']) != 8","len(raw['results']) != 5"],
 ['Invalid/incomplete eight-case Node closure shape','Invalid/incomplete five-case Node closure shape'],
 ["len(raw.get('results', [])) == 8","len(raw.get('results', [])) == 5"],
 ['v364-owned-linux-boundary-executor-closed-v1','v364-direct-socket-executor-closed-v1'],
 ['STRICT_SYNTHETIC_BOUNDARY_COMPARISON_ONLY','STRICT_SYNTHETIC_DIRECT_SOCKET_COMPARISON_ONLY']
];
for(const [before,after] of changes){assert.equal(py.split(before).length-1,1,before);py=py.replace(before,after);}
fs.writeFileSync(path.join(dir,'execute-owned-linux.py'),py,{flag:'wx'});
const record={schema:'v364-direct-copy-transforms-v1',originalRunner:{bytes:fs.readFileSync(path.join(old,'run-boundary.mjs')).length,sha256:sha(fs.readFileSync(path.join(old,'run-boundary.mjs')))},originalExecutor:{bytes:fs.readFileSync(path.join(old,'execute-owned-linux.py')).length,sha256:sha(fs.readFileSync(path.join(old,'execute-owned-linux.py')))},runnerChanges:operations,executorChanges:changes};
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')),'copy-transforms.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({files:['run-direct-socket.mjs','execute-owned-linux.py'],sourceModifiedOnlyNew:true}));

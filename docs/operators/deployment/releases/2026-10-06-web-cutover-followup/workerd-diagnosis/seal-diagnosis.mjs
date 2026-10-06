import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const own = path.dirname(fileURLToPath(import.meta.url));
const root = 'C:/cinagroup/cinatoken';
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = args => execFileSync('C:/Program Files/Git/cmd/git.exe', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const labels = ['issue6832', 'pr6833', 'pr7600', 'locked-release-ref', 'locked-standard', 'locked-readable', 'locked-compatibility', 'locked-worker-entrypoint', 'pr7600-files'];
const apiReads = labels.map(label => {
  const resultFile = path.join(own, label + '.result.json'), result = json(resultFile);
  assert.equal(result.actualExitCode, 0); assert.equal(result.signal, null); assert.equal(result.spawnError, null);
  assert.equal(result.program, 'gh'); assert.equal(result.arguments[0], 'api');
  assert.equal(result.arguments.length, 2); assert.equal(result.stderrBytes, 0);
  return { label, startedAt: result.startedAt, completedAt: result.completedAt, actualExit: result.actualExitCode, result: raw(resultFile), stdout: raw(result.stdoutPath), stderr: raw(result.stderrPath) };
});
const states = ['issue6832','pr6833','pr7600'].map(label => {
  const item = json(path.join(own,label+'.stdout.txt'));
  assert.equal(item.state, 'open');
  if (item.number !== 6832) { assert.equal(item.merged, false); assert.equal(item.merged_at, null); }
  return { number:item.number, title:item.title, state:item.state, updatedAt:item.updated_at, merged:item.merged??null, mergedAt:item.merged_at??null, headSHA:item.head?.sha??null, url:item.html_url };
});
const ref = json(path.join(own,'locked-release-ref.stdout.txt'));
assert.equal(ref.ref, 'refs/tags/v1.20260828.1'); assert.equal(ref.object.type, 'commit');
assert.equal(ref.object.sha, '8ea63498c7aa107995f9b2ffee7789631707e09f');
const decodedSources = ['locked-standard','locked-readable','locked-compatibility','locked-worker-entrypoint'].map(label => {
  const item = json(path.join(own,label+'.stdout.txt'));
  const decoded = fs.readFileSync(path.join(own,label+'.source.txt'));
  assert.deepEqual(decoded, Buffer.from(item.content,'base64'));
  const blobSHA = crypto.createHash('sha1').update('blob '+decoded.length+'\0').update(decoded).digest('hex');
  assert.equal(blobSHA,item.sha);
  return { label, repositoryPath:item.path, gitBlobSHA:item.sha, url:item.html_url, source:raw(path.join(own,label+'.source.txt')) };
});
const standard = fs.readFileSync(path.join(own,'locked-standard.source.txt'),'utf8');
const readable = fs.readFileSync(path.join(own,'locked-readable.source.txt'),'utf8');
const compat = fs.readFileSync(path.join(own,'locked-compatibility.source.txt'),'utf8');
const entrypoint = fs.readFileSync(path.join(own,'locked-worker-entrypoint.source.txt'),'utf8');
assert.ok(standard.includes('addNoopDeferredProxy(pumpToImpl(ioContext, kj::mv(reader), kj::mv(sink), end))'));
assert.ok(standard.includes('reader.cancel(js, error.getHandle(js))'));
assert.ok(!standard.includes('cancelSourceOfDroppedPump'));
assert.ok(readable.includes('DrainingReader::~DrainingReader()'));
assert.ok(readable.includes('stream->getController().releaseReader(addPtrToThis(), kj::none)'));
assert.ok(compat.includes('$compatEnableFlag("enable_request_signal")'));
assert.ok(!compat.includes('ENABLE_DRAINING_READ_ON_STANDARD_STREAMS'));
assert.ok(entrypoint.includes('ctrl->getSignal()->triggerAbort('));
const prFiles = json(path.join(own,'pr7600-files.stdout.txt'));
const prStandard = prFiles.find(item => item.filename === 'src/workerd/api/streams/standard.c++');
const currentPR = states.find(item => item.number === 7600);
assert.ok(prStandard.raw_url.includes(currentPR.headSHA));
assert.ok(prStandard.patch.includes('cancelSourceOfDroppedPump'));
assert.ok(prStandard.patch.includes('pumpInvocation.isCanceling()'));
assert.ok(prStandard.patch.includes('context.addWaitUntil'));
const localNames = [
  'package-lock.json', '.github/workflows/proxy-dispatch-safety.yml',
  'packages/proxy/scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs',
  'packages/proxy/scripts/staging/chat-holder-private-v364.ts',
  'packages/proxy/scripts/staging/chat-holder-gateway-v364.ts',
  'packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc',
  'packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc'
];
const localSources = localNames.map(name => {
  const currentBlob = git(['rev-parse','HEAD:'+name]);
  const historicalBlob = git(['rev-parse','bdc1bfcf15d93a9b2769d3f52352bfa39eab8928:'+name]);
  assert.equal(currentBlob,historicalBlob);
  return {name,currentGitBlob:currentBlob,historicalGitBlob:historicalBlob,identicalToKnownFailedSource:true,workingFile:raw(path.join(root,name))};
});
const lock = json(path.join(root,'package-lock.json'));
assert.equal(lock.packages['node_modules/workerd'].version,'1.20260828.1');
assert.equal(lock.packages['node_modules/miniflare'].dependencies.workerd,'1.20260828.1');
const gateway = json(path.join(root,'packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc'));
const holder = json(path.join(root,'packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc'));
for (const config of [gateway,holder]) assert.ok(config.compatibility_flags.includes('enable_request_signal'));
const baselineFile = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-ci-inventory-d7b57ac3c0804fc0a7fbddb860e5bc8e/FINAL-native-ci-inventory-v2.json';
const baseline = json(baselineFile);
const baselineExcerpt = baseline.failureExcerpts.find(item=>item.text.includes("null !== 'observed'"));
assert.ok(baselineExcerpt);
const report = {
  schema:'workerd-v364-cancel-readonly-upstream-diagnosis', at:new Date().toISOString(), localAuditActualExit:0,
  currentHead:git(['rev-parse','HEAD']),
  scope:{repositoryChanges:0,dependencyUpgrades:0,fixtureAssertionChanges:0,CIInvocations:0,CIPolls:0,localWorkerdExecutions:0,productionRequests:0,DBConnections:0,DBWrites:0,productionBindingsOrFlagsChanged:false},
  lockedRuntime:{workerd:lock.packages['node_modules/workerd'].version,miniflare:lock.packages['node_modules/miniflare'].version,wrangler:lock.packages['node_modules/wrangler'].version,releaseRef:ref.ref,releaseCommit:ref.object.sha},
  historicalStrictFailure:{runID:baseline.latestProxyRun.runId,headSHA:baseline.latestProxyRun.headSha,url:baseline.latestProxyRun.url,readAt:baseline.generatedAt,inventory:raw(baselineFile),latestRunNotRequeried:true,assertion:'null !== observed at http-cancel-successor.test.mjs:278',counts:{tests:8,passed:7,failed:1,skipped:0},excerpt:baselineExcerpt,rawLog:raw(path.join(path.dirname(baselineFile),baselineExcerpt.source)),runtimePass:false},
  sourceFindings:[
    {id:'knownLockedDropPath',evidence:'locked-standard lines3540-3610 and3743-3775; locked-readable284-287; locked-standard291-324',finding:'The locked JS controller always pumps via DrainingReader. The coroutine cancels the reader only in its exception path. Frame teardown destroys DrainingReader, whose destructor releases the reader with no isolate lock; that release path does not invoke source cancel.'},
    {id:'fixtureMatchesAsyncSource',evidence:'private-holder65-91; gateway10-28; successor260-281',finding:'The synthetic holder enqueues an initial SSE frame and awaits asynchronous KV/timer work in pull. The gateway forwards this one response body. The dedicated HTTP client destroys request and response after the first frame and asserts incomplete socket closure. The strict source-cancel KV observation remains null in the known Linux run.'},
    {id:'requestSignalNotMissing',evidence:'both frozen JSONC configs6; successor120-129; locked-compatibility794-798; locked-worker-entrypoint427-468',finding:'Both fixture Workers already explicitly opt into enable_request_signal. The flag creates an incoming request AbortSignal and the entrypoint triggers abort on disconnect; it does not add source cancel to the dropped pump. Private syntheticStream has no abort listener. Its waitUntil retains an observation only after cancel is invoked.'},
    {id:'compatibilityDateDoesNotFixDrop',evidence:'successor28 and120/128; locked-standard3743-3775',finding:'The local successor uses supported runtime date2026-09-04 while frozen configs stay2026-09-25. The locked pump path has no old-draining implementation selection. Changing the compatibility date or claiming a flag waiver does not establish cancellation correctness.'},
    {id:'currentUpstreamProposedFix',evidence:'pr7600 raw file diff pinned955f31cf92df5461463e48fae6c870f86a07b537',finding:'PR7600 adds a cancellation-aware pump frame teardown and schedules source cancellation through a weak IoContext reference and waitUntil. That mechanism is absent in the locked release source. The PR remains open and unmerged at this audit.'}
  ],
  confidence:{proven:'The locked runtime contains the exact missing drop-cancel mechanism described by upstream issue6832, and the project failure reaches the matching async SSE/socket-close boundary.',inference:'An upstream runtime regression is a strong candidate for the project null cancellation observation.',notYetProven:['No isolated differential execution with a fixed runtime was run; the exact project failure causal chain remains unconfirmed.','The one-second observation poll and KV request lifetime are not independently ruled out as contributing factors.','No production Web SSE defect or general Service Binding/RPC cancellation failure is established.'],strictFailedTestRetained:true},
  nextValidation:{readyOnly:true,steps:['Use an isolated Linux reproduction with an async source and explicit socket close to compare the locked release and a known corrected runtime; record request abort and source cancel separately without satisfying source assertions from an abort listener.','Only after an upstream fix is merged and packaged, evaluate an isolated compatible Miniflare/workerd pair and rerun the unchanged full strict holder test plus dispatch suite.','Keep the private-holder source cancel observation, socket incomplete close, exactly one acceptance, no release, original body/header/secret isolation assertions. No success record or gate change before execution.'],excluded:['Blind global dependency upgrade','A synthetic abort hook that writes the source-cancel observation itself','Relaxing the null assertion or extending the timeout without evidence','Production holder enablement or flags/bindings changes']},
  apiReads,upstreamStates:states,decodedSources,localSources,
  citations:['https://github.com/cloudflare/workerd/issues/6832','https://github.com/cloudflare/workerd/pull/6833','https://github.com/cloudflare/workerd/pull/7600','https://github.com/cnluzhang/workerd-stream-cancel-repro'],
  limitations:'Read-only diagnosis, not a runtime PASS. All upstream data is primary source and exact-tag source blobs are checked; the original failed native result remains authoritative for its run.'
};
const output = path.join(own,'FINAL-workerd-v364-cancel-diagnosis.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:raw(output),scope:report.scope,upstreamStates:report.upstreamStates,lockedRuntime:report.lockedRuntime,confidence:report.confidence},null,2));

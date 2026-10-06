import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const repo='C:/cinagroup/cinatoken';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const descriptor=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:sha(bytes)};};
const sourcePaths=[
 'scripts/diagnostics/v364-owned-linux-boundary/run-boundary.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/bare-async-source.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/direct-holder.mjs',
 'scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs',
 'scripts/diagnostics/v364-owned-linux/gateway-observer.mjs',
 'scripts/diagnostics/v364-owned-linux/holder-observer.mjs',
 'packages/proxy/scripts/staging/chat-holder-private-v364.ts',
 'packages/proxy/scripts/staging/chat-holder-gateway-v364.ts',
 'packages/proxy/scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs',
 'packages/proxy/src/runtime/complete-text-holder-worker-v390.ts',
 'packages/proxy/src/services/credential-free-chat-ingress-v401.ts',
 'node_modules/miniflare/package.json', 'node_modules/workerd/package.json',
 'node_modules/miniflare/dist/src/index.js','node_modules/miniflare/dist/src/index.d.ts',
 'node_modules/miniflare/dist/src/workers/core/entry.worker.js'
];
const commandFiles=fs.readdirSync(root).filter(name=>name.endsWith('.result.json'));
const commands=commandFiles.map(name=>{
 const file=path.join(root,name), row=JSON.parse(fs.readFileSync(file));
 assert.equal(row.closed,true);
 for(const stream of ['stdout','stderr']){const item=row[stream]; const raw=fs.readFileSync(item.path);assert.equal(raw.length,item.bytes);assert.equal(sha(raw),item.sha256);}
 assert.ok(Number.isSafeInteger(row.actualExit)||row.actualExit===null);
 return {receipt:descriptor(file),actualExit:row.actualExit,signal:row.signal,spawnError:row.spawnError,stdout:row.stdout,stderr:row.stderr};
});
const parsed=JSON.parse(fs.readFileSync(path.join(root,'actual-archived-boundary-analysis.stdout.txt'),'utf8'));
assert.equal(parsed.actualReadAnalysisOutcome,0); assert.equal(parsed.runtimeOutcome,1);
const report={...JSON.parse(fs.readFileSync(path.join(root,'diagnosis-content.json'),'utf8')),
 sealedAt:new Date().toISOString(), closed:true, actualReadOnlyReviewOutcome:0,
 sourceInputs:sourcePaths.map(p=>({...descriptor(path.join(repo,p)),relative:p})),
 actualArtifactSummary:parsed.results.map(r=>({caseId:r.caseId,actualExit:r.actualExit,originalWindow:r.originalWindow,tail:r.tail,workerKinds:r.workerKinds,signalAborts:r.cancellationRelevantWorkerRows.filter(x=>x.diagnostic.event==='signal-abort').map(x=>({phase:x.phase,diagnostic:x.diagnostic}))})),
 commands,readCommandCounts:{total:commands.length,exit0:commands.filter(x=>x.actualExit===0).length,exit1:commands.filter(x=>x.actualExit===1).length,unknownSpawnErrors:commands.filter(x=>x.actualExit===null).length},
 commandNegativeEvidencePreserved:true,reportProducerCurrentCommandReceiptExcludedUntilClosed:true};
const output=path.join(root,'FINAL-v364-next-readonly-diagnosis.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({closed:true,actualReadOnlySealOutcome:0,report:descriptor(output),sources:report.sourceInputs.length,commands:commands.length,limits:report.limits})+'\n');

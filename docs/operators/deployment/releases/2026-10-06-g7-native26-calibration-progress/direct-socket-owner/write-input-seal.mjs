import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const repo='C:/cinagroup/cinatoken';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const describe=relative=>{const bytes=fs.readFileSync(path.join(repo,relative));return {path:relative,bytes:bytes.length,sha256:sha(bytes)};};
const priorArtifactRoot='docs/operators/deployment/releases/2026-10-06-native-g7-boundary-progress/root-progress/boundary-artifact/_temp/v364-boundary-once-37402302570-1';
const inputs=[
 'packages/proxy/scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs',
 'packages/proxy/scripts/staging/chat-holder-binding-v364.node.test.mjs',
 'packages/proxy/scripts/staging/chat-holder-gateway-v364.ts',
 'packages/proxy/scripts/staging/chat-holder-private-v364.ts',
 'packages/proxy/scripts/staging/chat-holder-synthetic-v364.ts',
 'packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc',
 'packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc',
 'package-lock.json','.nvmrc',
 'scripts/diagnostics/v364-owned-linux/gateway-observer.mjs',
 'scripts/diagnostics/v364-owned-linux/holder-observer.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/bare-async-source.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/proc-census.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/run-boundary.mjs',
 'scripts/diagnostics/v364-owned-linux-boundary/execute-owned-linux.py',
 'scripts/diagnostics/v364-owned-linux-boundary/source-inputs.json',
 'scripts/diagnostics/v364-owned-linux-boundary/sealed-package.json',
 '.github/workflows/v364-owned-linux-boundary.yml',
 ...['closed-result.json','executor.closed.json','events.json.gz'].map(p=>priorArtifactRoot+'/'+p),
];
const installedFiles=['node_modules/miniflare/dist/src/index.js','node_modules/miniflare/dist/src/index.d.ts','node_modules/miniflare/dist/src/workers/core/entry.worker.js'].map(describe);
const report={schema:'v364-direct-socket-source-inputs-v1',reviewBaseHEAD:'702c4d71379acb697024ef846725871582bff94f',preparedAtHead:'702c4d71379acb697024ef846725871582bff94f',executionSHAIsSeparate:true,priorArtifactRoot,files:inputs.map(describe),installedFiles};
fs.writeFileSync(path.join(repo,'scripts/diagnostics/v364-direct-socket/source-inputs.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')),'protected-before.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceInputs:report.files.length,installedInputs:installedFiles.length}));

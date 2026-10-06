import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const sealedGroups=[
 ['ci-6e2','cinatoken-6e2-ci-terminal-observer-dbbc0b1231e543eb99e18eb9bbe45370','TERMINAL-STOPWRITE-SEAL.json','entries'],
 ['queued-v1-owner','cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942','STOPWRITE.json','files'],
 ['queued-v1-peer','cinatoken-v364-queued-source-peer-60rqza','STOPWRITE-peer-seal.json','entries'],
 ['queued-v2-owner','cinatoken-v364-queued-write-v2-8e7e441d5c7547dc93ae0c2c76898bf8','STOPWRITE.json','files'],
 ['queued-v2-peer','cinatoken-v364-queued-v2-local-peer-ktrh58','STOPWRITE-peer-seal.json','entries'],
 ['retention-owner','cinatoken-retention-v346-time-text-candidate-1a110046edafc3b0b4778a3a','STOPWRITE.json','entries'],
 ['retention-peer','cinatoken-retention-seven-casts-independent-review-efe3bd65f96244679d75b90f992fc733','STOPWRITE-seal.json','entries'],
].map(([name,folder,seal,pinArray])=>({name,root:path.join(path.dirname(root),folder),seal,pinArray}));
const records=['current-head','package-byte-attributes','guard-web-current','prepare-package-integration','normalize-package-candidate','integrate-v2-package','apply-prepared-candidates','retention-syntax','prepare-diagnostic-bundles','source-diff-check','update-checklist-retention'];
const files=[
 ...records.flatMap(label=>['stdout.log','stderr.log','result.json'].map(suffix=>label+'.'+suffix)),
 'guard-web-current.deployment-guard.json','applied-source-pins.json',
 'run-closed-compact.mjs','guard-live-cutover.mjs','prepare-package-integration.mjs','normalize-package-candidate.mjs','integrate-v2-package.mjs','apply-prepared-candidates.mjs','update-checklist-retention.mjs','collect-fresh-evidence.mjs','configure-evidence.mjs','audit-staged-fresh.mjs',
 'checklist-before.md','prepared-bundles/prepare-only.json',
 ...['run-direct-socket.mjs','README.md','sealed-package.json','retention.before.native.test.mjs'].map(name=>'sources-before/'+name),
 'package-candidate/README.md','package-candidate/sealed-package.json',
 ...['run-direct-socket.mjs','queued-write-source.mjs','README.md','sealed-package.json'].map(name=>'package-candidate-v2-lf/'+name),
];
const config={target:'C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-native-retention-and-http-backlog-preparation',sealedGroups,explicitGroups:[{name:'root',root,files}],readme:'# Native retention and HTTP backlog preparation\n\nCI source: 6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa. The original native run failed at step 90 (expected true, actual false), leaving 23 later financial steps skipped. The original dispatch cancellation gate failed with TAP 8/7/1. Full original job logs and both watch failures are retained. Download or collection success does not pass either gate.\n\nThe next source candidates preserve seven retention timestamp inputs and add one separate finite queued-data comparison. All original strict assertions, four HTTP cases, native reader calibration and observation windows remain. These are reviewed preparations; the new original Linux CI and one manual diagnostic are still pending. No production deployment occurred.\n\ncollection.json maps each exact source byte/hash to stored files. Large complete raw logs and the prior checklist snapshot use gzip, verified by full round-trip. Candidate/review tools and their first failures remain in their own groups. Prior evidence packets are referenced by the main checklist and are not copied here. Live timing cause, C++ pump cause, full G7 and G8 remain unproven.'};
fs.writeFileSync(path.join(root,'evidence-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({configured:true,sealedGroups:sealedGroups.length,rootExplicitFiles:files.length,sourceOnly:true}));

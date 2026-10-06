import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const repo='C:/cinagroup/cinatoken';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:\/)/i,'$1'));
const owner='C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942';
const packageDir=path.join(repo,'scripts/diagnostics/v364-direct-socket');
const output=path.join(here,'package-candidate');
fs.mkdirSync(output);
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=fs.readFileSync(path.join(owner,'run-direct-socket.candidate.mjs'));
const helper=fs.readFileSync(path.join(owner,'queued-write-source.mjs'));
const edits=JSON.parse(fs.readFileSync(path.join(owner,'candidate-edit-index.json')));
assert.equal(sha(run),edits.candidate.sha256);
assert.equal(sha(fs.readFileSync(path.join(packageDir,'run-direct-socket.mjs'))),edits.before.sha256);
const oldReadme=fs.readFileSync(path.join(packageDir,'README.md'));
const extra=`
A separate finite queued-data case runs after those five original comparisons. It uses the same bare direct socket and RST client operation, pauses client reads after the ready frame, and triggers exactly 8 MiB of data (128 views of 64 KiB). It leaves the source open. The original async source, all four HTTP cases, native reader calibration, compatibility settings and original cancellation window remain unchanged.

Admission records two consecutive nonzero server TCP send-queue observations and another observation immediately before RST. Each observation binds the direct listener/client ports, server socket inode and file descriptor to the single owned Workerd process, its process group, session and start time. Missing, ambiguous or unreadable observations remain pressure unknown. This proves only observed kernel send backlog, not the C++ stream pump's pending-write branch.

The extra source reports request-signal abort, a synthetic cleanup hook and the real source cancel callback separately. The signal listener only drops its local payload reference and logs; it never calls reader.cancel() or writes cancel KV. Only the source cancel callback writes that observation and registers its same promise once with ctx.waitUntil. A returned synthetic cleanup hook does not prove business cleanup or payload reclamation.

The extra result is queuedWriteComparison with baselineEligible=false; results still contains the five original comparisons. Original strict failure always keeps the whole diagnostic failed. Missing pressure, callbacks, closure or extra-case success also keeps failure. The extra case cannot satisfy G7/G8 or establish production HTTP cancellation.
`;
const readme=Buffer.concat([oldReadme,Buffer.from(extra.replaceAll('\n','\r\n'))]);
fs.writeFileSync(path.join(output,'run-direct-socket.mjs'),run,{flag:'wx'});
fs.writeFileSync(path.join(output,'queued-write-source.mjs'),helper,{flag:'wx'});
fs.writeFileSync(path.join(output,'README.md'),readme,{flag:'wx'});
const seal=JSON.parse(fs.readFileSync(path.join(packageDir,'sealed-package.json')));
const beforeSeal=structuredClone(seal);
seal.preparedAtHead='6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa';
for(const [name,bytes] of [['run-direct-socket.mjs',run],['README.md',readme]]) {
 const item=seal.files.find(v=>v.path===name);assert.ok(item);item.bytes=bytes.length;item.sha256=sha(bytes);
}
assert.equal(seal.files.some(v=>v.path==='queued-write-source.mjs'),false);
seal.files.push({path:'queued-write-source.mjs',bytes:helper.length,sha256:sha(helper)});
fs.writeFileSync(path.join(output,'sealed-package.json'),JSON.stringify(seal,null,'\t')+'\r\n',{flag:'wx'});
assert.deepEqual(seal.workflow,beforeSeal.workflow);
for(const item of seal.files) {
 const current=fs.readFileSync(path.join(fs.existsSync(path.join(output,item.path))?output:packageDir,item.path));
 assert.equal(current.length,item.bytes);assert.equal(sha(current),item.sha256);
}
console.log(JSON.stringify({preparedOnly:true,repoWrites:0,output,files:fs.readdirSync(output).map(name=>{const b=fs.readFileSync(path.join(output,name));return {name,bytes:b.length,sha256:sha(b)};}),workflowUnchanged:true,executorUnchanged:true,sourceInputsUnchanged:true,runtimeExecuted:false}));

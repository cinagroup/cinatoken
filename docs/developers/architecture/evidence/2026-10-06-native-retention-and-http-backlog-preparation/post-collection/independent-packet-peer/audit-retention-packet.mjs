import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const out=path.dirname(fileURLToPath(import.meta.url));
const repo='C:/cinagroup/cinatoken';
const packet=repo+'/docs/developers/architecture/evidence/2026-10-06-native-retention-and-http-backlog-preparation';
const mdPath=repo+'/docs/developers/architecture/web-frontend-migration.md';
const sha=b=>createHash('sha256').update(b).digest('hex');
const norm=p=>path.resolve(p).replaceAll('\\','/').toLowerCase();
const pin=(b,d,label)=>{assert.equal(b.length,d.bytes??d.rawBytes,label+' bytes');assert.equal(sha(b),d.sha256??d.rawSha256,label+' sha256');};
const file=p=>{const st=fs.lstatSync(p);assert(st.isFile()&&!st.isSymbolicLink(),'ordinary file required: '+p);return fs.readFileSync(p);};
const walk=(r,base=r)=>fs.readdirSync(r,{withFileTypes:true}).flatMap(d=>{assert(!d.isSymbolicLink(),'symlink forbidden: '+d.name);const p=path.join(r,d.name);return d.isDirectory()?walk(p,base):[path.relative(base,p).replaceAll('\\','/')];}).sort();
const inside=(r,p)=>{const relative=path.relative(r,path.resolve(p));assert(relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),'path escape: '+p);};
const indexBytes=file(packet+'/collection.json');
pin(indexBytes,{bytes: indexBytes.length,sha256:'f8b2c0cee65ef6ea5646fd731e3efb2878539e9f405863a850002e15ec6ce564'},'primary index');
const c=JSON.parse(indexBytes);
assert.equal(c.schema,'cinatoken-native-retention-http-backlog-direct-evidence-v1');
assert.equal(c.ciSourceCommit,'6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa');
assert.equal(c.productionCommit,'c13a64b9c3b2c90adcf736910ea408868d7854f1');
for(const k of ['nextSourcePreparedOnly','collectionOnly'])assert.equal(c[k],true,k);
for(const k of ['nextSourceRuntimeExecuted','gatePassDerived','liveRootCauseConfirmed','fullG7','fullG8'])assert.equal(c[k],false,k);
assert.equal(c.entries.length,253);assert.equal(c.files,253);
assert.equal(c.groups.length,8);
const entries=new Map(),sources=new Map(),raws=new Map(),checked=[];
let rawTotal=0,storedTotal=0,gzipCount=0;
for(const e of c.entries){
  assert.deepEqual(Object.keys(e).sort(),['group','source','sourceRelative','storedRelative','rawBytes','rawSha256','compression','storedBytes','storedSha256'].sort());
  assert(!entries.has(e.storedRelative),'duplicate stored path');assert(!sources.has(norm(e.source)),'duplicate source path');
  const group=c.groups.find(g=>g.name===e.group);assert(group,'unknown group');
  assert.equal(norm(e.source),norm(path.join(group.sourceRoot,e.sourceRelative)),'source root binding');inside(group.sourceRoot,e.source);inside(packet,path.join(packet,e.storedRelative));
  assert.equal(e.storedRelative,e.group+'/'+e.sourceRelative+(e.compression==='gzip'?'.gz':''),'stored relative binding');
  const raw=file(e.source),stored=file(path.join(packet,e.storedRelative));
  pin(raw,{bytes:e.rawBytes,sha256:e.rawSha256},e.sourceRelative+' source');
  pin(stored,{bytes:e.storedBytes,sha256:e.storedSha256},e.storedRelative+' stored');
  assert(e.compression===null||e.compression==='gzip');
  const decoded=e.compression==='gzip'?gunzipSync(stored):stored;
  assert(decoded.equals(raw),'full decoded/source bytes: '+e.storedRelative);
  if(e.compression==='gzip')gzipCount++;
  rawTotal+=raw.length;storedTotal+=stored.length;
  entries.set(e.storedRelative,e);sources.set(norm(e.source),e);raws.set(e.group+'/'+e.sourceRelative,raw);
  checked.push({group:e.group,source:e.source,sourceRelative:e.sourceRelative,storedRelative:e.storedRelative,rawBytes:raw.length,rawSha256:sha(raw),compression:e.compression,storedBytes:stored.length,storedSha256:sha(stored),decodedEqualsSource:true});
}
assert.equal(rawTotal,8235947);assert.equal(storedTotal,2257407);assert.equal(c.rawBytes,rawTotal);assert.equal(c.storedBytes,storedTotal);
assert.deepEqual(walk(packet),[...entries.keys(),'README.md','collection.json'].sort());
const groupPins=[];
for(const g of c.groups){
  const own=c.entries.filter(e=>e.group===g.name);assert.equal(own.length,g.copiedFiles);
  if(g.explicitSubset){assert.equal(g.name,'root');assert.equal(own.length,57);groupPins.push({...g,verification:'All explicit 57 source bindings verified. The larger active producer Temp is intentionally not claimed as a whole frozen root.'});continue;}
  assert.deepEqual(walk(g.sourceRoot),own.map(e=>e.sourceRelative).sort(),'complete frozen source set '+g.name);
  const sealBytes=file(path.join(g.sourceRoot,g.sourceSeal));pin(sealBytes,{bytes:g.sealBytes,sha256:g.sealSha256},g.name+' seal');
  const s=JSON.parse(sealBytes),manifest=Array.isArray(s.entries)?s.entries:Array.isArray(s.files)?s.files:null;assert(manifest,'seal manifest missing '+g.name);
  for(const d of manifest){const rel=d.relative??d.name??path.relative(g.sourceRoot,d.path).replaceAll('\\','/');const e=own.find(e=>e.sourceRelative===rel);assert(e,'sealed member absent '+g.name+'/'+rel);assert.equal(d.bytes,e.rawBytes);assert.equal(d.sha256,e.rawSha256);if(d.path)assert.equal(norm(d.path),norm(e.source));}
  assert.deepEqual(manifest.map(d=>d.relative??d.name??path.relative(g.sourceRoot,d.path).replaceAll('\\','/')).sort(),own.filter(e=>e.sourceRelative!==g.sourceSeal).map(e=>e.sourceRelative).sort(),'seal/full set '+g.name);
  groupPins.push({...g,verifiedSealMembers:manifest.length,completeFrozenRootSetExact:true});
}
const json=(group,relative)=>JSON.parse(raws.get(group+'/'+relative).toString('utf8'));
const ci=json('ci-6e2','FINAL-ci-terminal-observer.json');
assert.equal(ci.sourceSha,c.ciSourceCommit);assert.equal(ci.collectionOnly,true);assert.equal(ci.rootCauseConfirmed,false);assert.equal(ci.nativeExecutedLocally,false);
const proxyMetadata=json('ci-6e2','proxy-terminal.stdout.log');assert.equal(proxyMetadata.headSha,c.ciSourceCommit);assert.equal(proxyMetadata.conclusion,'failure');
const job=proxyMetadata.jobs.find(j=>j.databaseId===112142276121),dispatchJob=proxyMetadata.jobs.find(j=>j.databaseId===112142275908);
assert.equal(job.conclusion,'failure');assert.equal(dispatchJob.conclusion,'failure');
const financial=job.steps.filter(s=>s.number>=8&&s.number<=113),countBy=a=>a.reduce((m,e)=>(m[e.conclusion]=(m[e.conclusion]??0)+1,m),{});
assert.equal(financial.length,106);assert.deepEqual(countBy(financial),{success:82,failure:1,skipped:23});
assert.deepEqual(ci.native.financial8to113.actualCounts,countBy(financial));
assert.deepEqual(countBy(financial.filter(s=>s.number>=55)),{success:35,failure:1,skipped:23});
assert.deepEqual(ci.native.chain55to113.actualCounts,{success:35,failure:1,skipped:23});
assert.equal(ci.native.target26.count,26);assert.deepEqual(ci.native.target26.actualCounts,{success:20,skipped:6});assert.deepEqual(countBy(ci.native.target26.steps),{success:20,skipped:6});
assert.equal(ci.native.remaining6.count,6);assert.deepEqual(ci.native.remaining6.actualCounts,{skipped:6});assert(ci.native.remaining6.steps.every(s=>job.steps.find(j=>j.number===s.step).conclusion==='skipped'));
for(const s of [ci.native.frozen94,ci.native.frozen109,...ci.native.tail110to113]){assert.equal(s.actual.conclusion,'skipped');assert.equal(s.tap,null);assert.equal(job.steps.find(j=>j.number===s.step).conclusion,'skipped');}
assert.equal(ci.native.firstFailure.actual.number,90);
for(const r of ci.runs){assert.equal(r.headSha,c.ciSourceCommit);assert.equal(r.status,'completed');assert.equal(r.conclusion,r.slug==='proxy'?'failure':'success');const m=JSON.parse(file(r.metadata.path));assert.equal(m.headSha,c.ciSourceCommit);assert.equal(m.status,r.status);assert.equal(m.conclusion,r.conclusion);pin(file(r.metadata.path),r.metadata,'run metadata');}
const nativeRaw=raws.get('ci-6e2/native-terminal.stdout.log'),dispatchRaw=raws.get('ci-6e2/dispatch-terminal.stdout.log');
pin(nativeRaw,{bytes:537587,sha256:'339c0ac8f83d71356a22f9f6d90988dc88db358d3206aea2025c78eca8fb7334'},'complete original native log');
pin(dispatchRaw,{bytes:5161564,sha256:'03104a72d0feba1bbf242015c16c4aeeca6cd4edab9132f290700e5cadf3149b'},'complete original dispatch log');
const verifyTap=(mapped,raw,expected)=>{assert(mapped.tap);assert.equal(norm(mapped.tap.range.path),norm(mapped===ci.dispatch.firstFailure?ci.logs.dispatch.stdout.path:ci.logs.native.stdout.path));const range=raw.subarray(mapped.tap.range.startByte,mapped.tap.range.endByte);for(const [key,n]of Object.entries(expected)){const d=mapped.tap.counters[key];assert.equal(d.value,n);assert(d.byteOffset>=mapped.tap.range.startByte&&d.byteOffset<mapped.tap.range.endByte);assert(raw.subarray(d.byteOffset,d.byteOffset+100).toString('utf8').startsWith('# '+key+' '+n));const values=[...range.toString('utf8').matchAll(new RegExp('# '+key+' (\\d+)(?:\\r?\\n|$)','g'))].map(m=>Number(m[1]));assert.equal(values.at(-1),n);}};
verifyTap(ci.native.firstFailure.fixture,nativeRaw,{tests:1,pass:0,fail:1,skipped:0});
verifyTap(ci.native.bootstrap7,nativeRaw,{tests:1,pass:1,fail:0,skipped:0});verifyTap(ci.native.quote24,nativeRaw,{tests:1,pass:1,fail:0,skipped:0});
verifyTap(ci.dispatch.firstFailure,dispatchRaw,{tests:8,pass:7,fail:1,skipped:0});
assert(nativeRaw.toString('utf8').includes('native.test.mjs:235:14'));
assert.equal(ci.native.firstFailure.fixture.tap.fields.expected.value,'true');assert.equal(ci.native.firstFailure.fixture.tap.fields.actual.value,'false');
const ciSeal=json('ci-6e2','TERMINAL-STOPWRITE-SEAL.json');assert.equal(ciSeal.actualCloses,24);assert.equal(ciSeal.zero,22);assert.deepEqual(ciSeal.nonzeroOrNull.map(d=>d.actualExit),[1,1]);
const ciReceipts=c.entries.filter(e=>e.group==='ci-6e2'&&e.sourceRelative.endsWith('.closed.json'));assert.equal(ciReceipts.length,24);
for(const e of ciReceipts){const r=json('ci-6e2',e.sourceRelative);assert(Number.isInteger(r.actualExit));assert.equal(r.signal,null);assert.equal(r.spawnError??null,null);for(const k of ['stdout','stderr']){const d=r[k];assert(d&&d.path);const streamEntry=sources.get(norm(d.path));assert(streamEntry,'closed raw missing');assert.equal(streamEntry.rawBytes,d.bytes);assert.equal(streamEntry.rawSha256,d.sha256);}}
assert.equal(ciReceipts.filter(e=>json('ci-6e2',e.sourceRelative).actualExit===0).length,22);
const before=raws.get('root/checklist-before.md'),after=file(mdPath);
pin(after,{bytes:824691,sha256:'d7bac9842393e8cd699922dedfa2eeb338834e2e811cc46e403873983496bca3'},'current checklist');
pin(before,{bytes:821293,sha256:'cddfaa752a4386863b87d4868e29dbec220571f03ba1d1528eec0caefea326b8'},'prior checklist');
const b=before.toString('utf8'),a=after.toString('utf8');
const patterns=[/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm];
const scope=s=>patterns.map(re=>s.match(re)??[]);assert.deepEqual(scope(a),scope(b));assert.deepEqual(scope(a).map(v=>v.length),[102,54,9,9,9,213]);
const tasks=s=>{let fenced=false;return s.split(/\r?\n/).filter(line=>{if(/^\s*```/.test(line)){fenced=!fenced;return false;}return !fenced&&/^\s*- \[[ x]\]/.test(line);});};
assert.deepEqual(tasks(a),tasks(b));assert.equal(tasks(a).length,211);assert.equal((a.match(/\[[ x]\]/g)??[]).length,214);
const current=a.split(/\r?\n/).find(l=>l.startsWith('当前推进：')),next18=a.split(/\r?\n/).find(l=>l.startsWith('| NEXT-18 |')),start=a.indexOf('### 5.85 ');assert(start>=0);const section=a.slice(start,a.indexOf('\n### ',start+10)<0?undefined:a.indexOf('\n### ',start+10));
for(const t of [current,next18,section]){assert(t.includes('6e2'));assert(/下一SHA|下一提交/.test(t));assert(/待验|待下一|尚未运行到|未执行/.test(t));assert(t.includes('8/7/1'));assert(t.includes('G7/G8'));}
assert(section.includes('rootCauseConfirmed')===false);assert(section.includes('live根因仍未证'));assert(section.includes('baselineEligible=false'));assert(section.includes('未执行Workerd'));assert(section.includes('不推导native/HTTP/G7/G8通过'));assert(section.includes('339c0ac8f83d71356a22f9f6d90988dc88db358d3206aea2025c78eca8fb7334'));assert(section.includes('03104a72d0feba1bbf242015c16c4aeeca6cd4edab9132f290700e5cadf3149b'));
const applied=json('root','applied-source-pins.json');assert.equal(applied.applied,true);assert.equal(applied.nativeExecuted,false);assert.equal(applied.productionChanged,false);assert.equal(applied.changes.length,5);
for(const d of applied.changes)pin(file(path.join(repo,d.path)),d,'current applied source '+d.path);
const packageRoot=repo+'/scripts/diagnostics/v364-direct-socket',packageSeal=file(packageRoot+'/sealed-package.json');pin(packageSeal,{bytes:1190,sha256:'69cfacc9b02d66531a0624cdf980fb39a4f998745949970c2962b4691bfc17a5'},'current package seal');
const pkg=JSON.parse(packageSeal);assert.equal(pkg.preparedAtHead,c.ciSourceCommit);assert.equal(pkg.executionSHAIsSeparate,true);for(const d of pkg.files)pin(file(path.join(packageRoot,d.path)),d,'sealed package '+d.path);pin(file(path.join(repo,pkg.workflow.path)),pkg.workflow,'unchanged manual workflow');
const inputs=JSON.parse(file(packageRoot+'/source-inputs.json'));assert.equal(inputs.files.length,10);for(const d of inputs.files)pin(file(path.join(repo,d.path)),d,'frozen original input '+d.path);
const rootCloses=[];for(const name of ['apply-prepared-candidates','prepare-diagnostic-bundles','retention-syntax','update-checklist-retention']){const r=json('root',name+'.result.json');assert.equal(r.actualExit,0);assert.equal(r.signal,null);assert.equal(r.spawnError??null,null);assert(r.finishedAt>=r.at);assert(r.executable.endsWith('node.exe'));for(const stream of ['stdout','stderr']){const d=r[stream],e=sources.get(norm(d.path));assert(e);assert.equal(d.bytes,e.rawBytes);assert.equal(d.sha256,e.rawSha256);}rootCloses.push({name,...r});}
assert(rootCloses.find(r=>r.name==='prepare-diagnostic-bundles').args.includes('--prepare-only'));assert(rootCloses.find(r=>r.name==='retention-syntax').args.includes('--check'));
const prepared=json('root','prepared-bundles/prepare-only.json');assert(!JSON.stringify(prepared).includes('"runtimeExecuted":true'));
const guard=json('root','guard-web-current.deployment-guard.json');assert.equal(guard.actualExit,0);assert.equal(guard.readOnly,true);assert.equal(guard.secretValuesRecorded,false);assert.equal(guard.deployment.commitTag,c.productionCommit);assert.deepEqual(guard.deployment.versions,[{version_id:'2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9',percentage:100}]);assert.deepEqual(guard.routes.map(r=>[r.pattern,r.script]),[['cinatoken.com/*','cinatoken-web'],['cinatoken.com/web-assets/*','cinatoken-web'],['api.cinatoken.com/*','cinatoken-proxy']]);
const final={schema:'native-retention-backlog-final-independent-readonly-peer-v1',at:new Date().toISOString(),auditAssertionsCompleted:true,actualCommandExitNotPredicted:true,collectionOnly:true,repositoryWrites:0,newProductionRequests:0,newCiOrRuntimeExecutions:0,packet:{root:packet,primaryIndex:{bytes:indexBytes.length,sha256:sha(indexBytes)},ordinaryFiles:255,sourceCopies:253,rawBytes:rawTotal,storedBytes:storedTotal,gzipCount,exactStoredSet:true,allSourceStoredDecodedBytesExact:true,entries:checked,groups:groupPins},checklist:{path:mdPath,bytes:after.length,sha256:sha(after),beforeBytes:before.length,beforeSha256:sha(before),scopeCounts:[102,54,9,9,9,213],allScopeLinesExact:true,actualTaskCheckboxLines:211,actualTaskCheckboxLinesExact:true,literalCheckboxTokens:214,current,next18,section5_85PendingNewOriginalLinux:true},originalCi:{sourceSha:ci.sourceSha,proxyRun:37424911830,nativeJob:112142276121,dispatchJob:112142275908,financialSteps:106,financialCounts:{success:82,failure:1,skipped:23},chain55to113:{success:35,failure:1,skipped:23},target26:{success:20,skipped:6},remaining6:'all skipped',frozen94and109:'skipped',tail110to113:'all skipped',firstNativeFailure:{step:90,sourceLine:'235:14',expected:true,actual:false,tap:{tests:1,pass:0,fail:1}},dispatchTap:{tests:8,pass:7,fail:1,skipped:0},nativeCompleteLog:{bytes:nativeRaw.length,sha256:sha(nativeRaw)},dispatchCompleteLog:{bytes:dispatchRaw.length,sha256:sha(dispatchRaw)},closedChildren:24,closedZero:22,closedOne:2,otherFourRuns:'same exact 6e2 source completed success',noPriorD537Promotion:true,originalReaderDownloadSuccessIsNotGatePass:true},currentRepo:{appliedChanges:applied.changes,packageSeal:{bytes:packageSeal.length,sha256:sha(packageSeal)},sealedRuntimeFiles:pkg.files,frozenOriginalInputsChecked:inputs.files,workflow:pkg.workflow,gitBlobAudit:'Parent owns separate stage/blob audit; this peer verifies actual filesystem bytes only.'},producerPreparations:rootCloses,productionSnapshot:{readOnly:true,at:guard.at,finishedAt:guard.finishedAt,actualExit:guard.actualExit,deployment:guard.deployment,noNewRequestByThisPeer:true},limitations:['This audit proves source-to-storage preservation and current reviewed-byte/scope equivalence only. It does not run native, HTTP, Workerd, CI or production.', 'The 6e2 strict dispatch failure and native retention failure remain actual failures; new source and queued comparison are prepared only.', 'Finite allocation and kernel send backlog do not prove a C++ pending-write branch or a live cancellation root cause.', 'Collection/download/preparation success does not establish G7/G8 or identity/ACL/funds/SSE/rollback completion.', 'The earlier local metadata inspection tool exit 1 is retained in read-setup-observation.json without inventing raw streams or original child terminal authority.'],fullG7:false,fullG8:false,rootCauseConfirmed:false,findings:[]};
fs.writeFileSync(path.join(out,'FINAL-retention-backlog-packet-independent-peer.json'),JSON.stringify(final,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({auditAssertionsCompleted:true,packetFiles:255,sourceCopies:253,rawBytes:rawTotal,storedBytes:storedTotal,gzipCount,scope:[102,54,9,9,9,213],tasks:211,tokens:214,originalNativeFailure:90,originalStrictFailure:'8/7/1',sourcePreparedOnly:true,fullG7:false,fullG8:false,findings:[]}));

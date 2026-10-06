import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
import { listPg73Migrations } from 'file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const file='scripts/db/cutover/postgres-budget-admission-login-v350.native.test.mjs';
const before=fs.readFileSync(path.join(dir,'before.native.test.mjs'));
const after=fs.readFileSync(path.join(repo,file));
const info=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const insertion="      // Keep both original grant calls, including the buyer-split rejection,\n      // behind the owned PG73 bridge so the production 0074 preflight still runs.\n      const grantPostgresRuntime = ({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n";
const edits=[
  {from:"import { readFile, readdir, writeFile } from 'node:fs/promises';",to:"import { readFile, writeFile } from 'node:fs/promises';"},
  {from:"import { grantPostgresRuntime } from './grant-postgres-runtime.ts';",to:"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';"},
  {from:"const names = (await readdir(migrations))\n        .filter(name => name.endsWith('.sql')).sort();",to:"const names = await listPg73Migrations();"},
  {from:"        + `@127.0.0.1:${cluster.port}/postgres`;\n      report.sourceSha256.runtimeGrant",to:"        + `@127.0.0.1:${cluster.port}/postgres`;\n"+insertion+"      report.sourceSha256.runtimeGrant"}
];
let replay=before.toString(),reverse=after.toString();
for(const edit of edits){assert.equal(replay.split(edit.from).length-1,1);replay=replay.replace(edit.from,edit.to);}
for(const edit of [...edits].reverse()){assert.equal(reverse.split(edit.to).length-1,1);reverse=reverse.replace(edit.to,edit.from);}
assert.ok(Buffer.from(replay).equals(after)); assert.ok(Buffer.from(reverse).equals(before));
const normalize=node=>JSON.parse(JSON.stringify(node,(key,value)=>['start','end','loc'].includes(key)?undefined:typeof value==='bigint'?{bigIntExact:value.toString()}:value instanceof RegExp?{patternExact:value.source,flagsExact:value.flags}:value));
function collect(source){const nodes=[];const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&node.callee.object?.name==='assert')nodes.push({ast:normalize(node),source:source.slice(node.start,node.end)});for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));return nodes;}
const assertionsBefore=collect(before.toString()),assertionsAfter=collect(after.toString());
assert.deepEqual(assertionsAfter,assertionsBefore);
const grants=(before.toString().match(/grantPostgresRuntime\(\{ DATABASE_URL: migratorUrl \}\)/g)||[]).length;
assert.equal(grants,2); assert.equal((after.toString().match(/grantPostgresRuntime\(\{ DATABASE_URL: migratorUrl \}\)/g)||[]).length,2);
const corpus=await listPg73Migrations();
assert.equal(corpus.length,73);
const unchanged=[];
for(const source of ['scripts/db/cutover/pg73-native-fixture.mjs','scripts/db/cutover/grant-postgres-runtime.ts','scripts/db/cutover/activate-postgres-buyer-split-v348.ts','.github/workflows/proxy-dispatch-safety.yml']){
  const current=fs.readFileSync(path.join(repo,source));const original=spawnSync('C:/Program Files/Git/cmd/git.exe',['show',`b1ec8f33cf24edc07e8855c059c1498730a43113:${source}`],{cwd:repo,encoding:null,windowsHide:true});
  assert.equal(original.status,0);assert.ok(current.equals(original.stdout));unchanged.push({file:source,...info(current),exactBaseBytes:true});
}
const candidates=['postgres-ordinary-budget-recovery-v354.native.test.mjs','postgres-guardrail-budget-admission-login-v351.native.test.mjs','postgres-guardrail-budget-lifecycle-v353.native.test.mjs','postgres-guardrail-budget-dispatched-extension-v355.native.test.mjs'];
const followup=candidates.map(name=>{const source=fs.readFileSync(path.join(repo,'scripts/db/cutover',name));const body=source.toString();const pinned=/listPg73Migrations\(/.test(body);return {file:'scripts/db/cutover/'+name,...info(source),readOnly:true,alreadyPinnedPg73:pinned,allCurrentMigrationLoader:/readdir\(migrations\)/.test(body),directProductionGrantCalls:(body.match(/grantPostgresRuntime\(/g)||[]).length,plan:pinned?'No loader repair proposed; preserve existing bridge and wait for actual CI.':'Static candidate only: retain original73/corpus and introduce existing pinned loader; review each grant and exact negative preflight before proposing a patch.',actualLinuxFailureKnown:false};});
fs.writeFileSync(path.join(dir,'after.native.test.mjs'),after,{flag:'wx'});
fs.writeFileSync(path.join(dir,'reverse-before.native.test.mjs'),Buffer.from(reverse),{flag:'wx'});
const report={at:new Date().toISOString(),actualExit:0,file,before:info(before),after:info(after),allowedEdits:edits,allOtherTextByteExact:true,fullReverseBeforeByteExact:true,allOriginalAssertAstAndSourceExact:true,originalAssertionCalls:assertionsBefore.length,currentAssertionCalls:assertionsAfter.length,originalGrantCallsUnchanged:2,originalSuccessfulGrants:1,originalBuyerSplitRejectGrants:1,pinnedCorpus:{count:corpus.length,last:corpus.at(-1)},originalNativeTimeoutAndSkipUnchanged:after.toString().includes("{ timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }"),originalRolesAndAclAndCleanupCoveredByFullByteReverse:true,unchangedSources:unchanged,followupReadOnly:followup,nativeFixtureExecuted:false,productionRequests:0};
fs.writeFileSync(path.join(dir,'budget-repair-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,...report.after,assertionCalls:report.originalAssertionCalls,exactAssertAstAndSource:true,reverseBytesExact:true,pinned73:true}));

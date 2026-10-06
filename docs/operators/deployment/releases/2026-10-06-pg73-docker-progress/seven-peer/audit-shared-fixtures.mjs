import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
const own = path.dirname(fileURLToPath(import.meta.url));
const repo = 'C:/cinagroup/cinatoken';
const upstream = 'C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-platform-followup-20261006-lAiHQC';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = bytes => ({bytes:bytes.length,sha256:sha(bytes)});
const write = (name,bytes) => { const target=path.join(own,name); fs.writeFileSync(target,bytes,{flag:'wx'}); return {path:target,...info(Buffer.from(bytes))}; };
const normalize = node => JSON.parse(JSON.stringify(node,(key,value)=>['start','end','loc'].includes(key)?undefined:value));
function walk(node,visit,ancestors=[]) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node,ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child,visit,[...ancestors,node]);
    else if (value && typeof value === 'object') walk(value,visit,[...ancestors,node]);
  }
}
function analyze(source) {
  const ast = parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const assertions=[],grants=[];
  walk(ast,(node,ancestors)=>{
    if (node.type !== 'CallExpression') return;
    const callee=node.callee;
    if ((callee.type==='MemberExpression' && callee.object.type==='Identifier' && callee.object.name==='assert') || (callee.type==='Identifier' && callee.name==='assert')) assertions.push({ast:normalize(node),source:source.slice(node.start,node.end)});
    if (callee.type==='Identifier' && ['grantPostgresRuntime','grantPg73RuntimeFixture'].includes(callee.name)) grants.push({callee:callee.name,ast:normalize(node),source:source.slice(node.start,node.end),directAwait:ancestors.at(-1)?.type==='AwaitExpression' && ancestors.at(-2)?.type==='ExpressionStatement',assertEnclosing:ancestors.some(parent=>parent.type==='CallExpression' && parent.callee?.type==='MemberExpression' && parent.callee.object?.name==='assert')});
  });
  return {ast,assertions,grants};
}
const sourceRecords=['next-shared-fixture-repair.json','remaining-shared-fixture-repair.json'].map(name=>{
  const bytes=fs.readFileSync(path.join(upstream,name));
  return {name,...info(bytes),json:JSON.parse(bytes)};
});
const records=sourceRecords.flatMap(record=>record.json.records);
const expectedNames=['quote-versions','orphan-review-v348','selected-event-gate-v351','snapshot-earning-consumer','economic-delivery','credited-usage-gap','credited-usage-store'];
assert.deepEqual(records.map(record=>path.basename(record.file)),expectedNames.map(name=>`postgres-shared-key-${name}.native.test.mjs`));
const fsFrom="import { readFile, readdir, writeFile } from 'node:fs/promises';";
const fsTo="import { readFile, writeFile } from 'node:fs/promises';";
const nativeImport="import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';";
const helperImport="import { listPg73Migrations } from './pg73-native-fixture.mjs';";
const loaderFrom=["const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();","const names = (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();","const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();",...Array(4).fill("const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();")];
const proofs=[];
let assertionsTotal=0;
for (const [index,record] of records.entries()) {
  const name=path.basename(record.file);
  const before=fs.readFileSync(path.join(upstream,name+'.before'));
  const after=fs.readFileSync(path.join(upstream,name+'.after'));
  assert.deepEqual(info(before),record.before);
  assert.deepEqual(info(after),record.after);
  const current=fs.readFileSync(path.join(repo,record.file));
  assert.ok(current.equals(after),name+' current source equals sealed after');
  const allowed=[{from:fsFrom,to:fsTo,count:1}];
  if (index===0) {
    allowed.push({from:"import { grantPostgresRuntime } from './grant-postgres-runtime.ts';",to:"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';",count:1});
    allowed.push({from:'await grantPostgresRuntime({ DATABASE_URL: url });',to:'await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: url });',count:2});
  } else allowed.push({from:nativeImport,to:nativeImport+'\n'+helperImport,count:1});
  allowed.push({from:loaderFrom[index],to:`const ${index===1||index===2?'names':'files'} = await listPg73Migrations();`,count:1});
  assert.deepEqual(record.edits,allowed,name+' edits match independent fixed whitelist');
  let reverse=after.toString('utf8'),replay=before.toString('utf8');
  for (const edit of [...allowed].reverse()) {
    assert.equal(reverse.split(edit.to).length-1,edit.count,'reverse count');
    reverse=reverse.split(edit.to).join(edit.from);
  }
  for (const edit of allowed) {
    assert.equal(replay.split(edit.from).length-1,edit.count,'forward count');
    replay=replay.split(edit.from).join(edit.to);
  }
  assert.ok(Buffer.from(reverse).equals(before),name+' complete reverse restoration equals original bytes');
  assert.ok(Buffer.from(replay).equals(after),name+' complete forward replay equals after bytes');
  const oldAnalysis=analyze(before.toString('utf8')),newAnalysis=analyze(after.toString('utf8'));
  assert.deepEqual(newAnalysis.assertions,oldAnalysis.assertions,name+' ordered assertion AST and exact source');
  assert.equal(oldAnalysis.assertions.length,record.orderedOriginalAssertionCalls);
  assert.equal(oldAnalysis.grants.length,index===0?2:0);
  assert.equal(newAnalysis.grants.length,index===0?2:0);
  if (index===0) {
    assert.ok(oldAnalysis.grants.every(call=>call.callee==='grantPostgresRuntime' && call.directAwait && !call.assertEnclosing));
    assert.ok(newAnalysis.grants.every(call=>call.callee==='grantPg73RuntimeFixture' && call.directAwait && !call.assertEnclosing));
    assert.ok(before.toString().includes("CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}'"));
    assert.ok(before.toString().includes("const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');"));
    assert.ok(before.toString().includes("return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',"));
    assert.ok(before.toString().includes("const url = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;"));
    const membershipBefore=before.toString().match(/for \(const inheritedRole of \['cinatoken_gateway_migrator','pg_read_all_data','pg_write_all_data'\]\) \{[\s\S]*?\n      \}/)?.[0];
    assert.ok(membershipBefore && membershipBefore.includes('GRANT ${inheritedRole} TO cinatoken_gateway_runtime') && membershipBefore.includes('REVOKE ${inheritedRole} FROM cinatoken_gateway_runtime'));
    assert.ok(after.toString().includes(membershipBefore));
    assert.equal(oldAnalysis.grants.filter(call=>call.assertEnclosing).length,0);
  }
  assertionsTotal += oldAnalysis.assertions.length;
  const snapshots={before:write(name+'.before',before),after:write(name+'.after',after),reversed:write(name+'.reversed',Buffer.from(reverse))};
  proofs.push({file:record.file,before:info(before),after:info(after),workingSourceExact:true,allowedEdits:allowed,forwardReplayByteExact:true,reverseOriginalByteExact:true,orderedAssertions:oldAnalysis.assertions.length,assertionAstExact:true,assertionSourceExact:true,originalGrantNegativeCalls:0,grantNegativeCallsChanged:0,successfulGrantAdaptations:index===0?2:0,grantCallDetails:{before:oldAnalysis.grants,after:newAnalysis.grants},snapshots});
}
assert.equal(assertionsTotal,356);
const workflowPath='.github/workflows/proxy-dispatch-safety.yml';
const git=spawnSync('C:/Program Files/Git/cmd/git.exe',['show',`HEAD:${workflowPath}`],{cwd:repo,encoding:null,windowsHide:true});
assert.equal(git.status,0); assert.equal(git.stderr.length,0);
const workflowBefore=git.stdout,workflowAfter=fs.readFileSync(path.join(repo,workflowPath));
const from='node --test scripts/db/cutover/postgres-shared-key-credited-usage-store.native.test.mjs';
const to='node --import tsx --test scripts/db/cutover/postgres-shared-key-credited-usage-store.native.test.mjs';
assert.equal(workflowBefore.toString().split(from).length-1,1);
assert.equal(workflowAfter.toString().split(to).length-1,1);
const workflowReverse=Buffer.from(workflowAfter.toString().replace(to,from));
assert.ok(workflowReverse.equals(workflowBefore),'complete workflow reverse equals HEAD bytes');
const workflow={file:workflowPath,before:info(workflowBefore),after:info(workflowAfter),onlySingleLoaderAddition:true,reverseOriginalByteExact:true,from,to,snapshots:{before:write('proxy-dispatch-safety.yml.before',workflowBefore),after:write('proxy-dispatch-safety.yml.after',workflowAfter),reverse:write('proxy-dispatch-safety.yml.reversed',workflowReverse)}};
const helperFile='scripts/db/cutover/pg73-native-fixture.mjs';
const grantFile='scripts/db/cutover/grant-postgres-runtime.ts';
const provisionFile='scripts/db/cutover/provision-postgres-roles.ts';
const unchangedSources=[];
for (const file of [helperFile,grantFile,provisionFile,'.nvmrc']) {
  const current=fs.readFileSync(path.join(repo,file));
  const original=spawnSync('C:/Program Files/Git/cmd/git.exe',['show',`HEAD:${file}`],{cwd:repo,encoding:null,windowsHide:true});
  assert.equal(original.status,0); assert.equal(original.stderr.length,0); assert.ok(current.equals(original.stdout),file+' unchanged from HEAD');
  unchangedSources.push({file,...info(current),exactHeadBytes:true,snapshot:write(path.basename(file)+'.source',current)});
}
const helper=fs.readFileSync(path.join(repo,helperFile),'utf8'),grant=fs.readFileSync(path.join(repo,grantFile),'utf8');
assert.ok(helper.includes("import { grantPostgresRuntime } from './grant-postgres-runtime.ts';"));
assert.ok(grant.includes("} from './provision-postgres-roles';"));
assert.equal(fs.readFileSync(path.join(repo,'.nvmrc'),'utf8').trim(),'22');
assert.ok(helper.includes('!originalRuntime.has_memberships'));
assert.ok(helper.includes('if (!originalRuntime.can_login)'));
assert.ok(helper.includes('assert.deepEqual(await runtimeState(), originalRuntime'));
for (const suffix of expectedNames.slice(0,6)) assert.ok(workflowAfter.toString().includes(`node --import tsx --test scripts/db/cutover/postgres-shared-key-${suffix}.native.test.mjs`));
const report={at:new Date().toISOString(),actualExit:0,review:'PASS_WITH_NO_CODE_BLOCKER',reviewType:'independent read-only Acorn and byte review, no native test execution',acorn:{version:JSON.parse(fs.readFileSync(path.join(repo,'node_modules/acorn/package.json'))).version,ecmaVersion:'latest',sourceType:'module',removedAstMetadata:['start','end','loc']},sourceRecords:sourceRecords.map(({json,...rest})=>rest),files:proofs,totals:{files:7,orderedAssertions:assertionsTotal,assertionAstAndSourceUnchanged:assertionsTotal,fullReverseByteRestorations:7,grantSuccessBridges:2,originalGrantNegativeCalls:0,grantNegativeCallsChanged:0},workflow,unchangedSources,quoteSemantics:{ownedLoopbackMigratorUrl:true,migratorClientMaxOne:true,runtimeInitiallyLoginWithRandomPassword:true,originalRuntimeMembershipNegativeRoles:['cinatoken_gateway_migrator','pg_read_all_data','pg_write_all_data'],membershipNegativeLoopIncludingRevokeUnchanged:true,proxyHasMigratorMembership:true,runtimeMembershipAtSuccessfulGrant:'Static flow creates no runtime membership except the unchanged negative loop which revokes each membership before continuation; the existing bridge independently requires no memberships at each real grant call.',temporary0074:'Existing unchanged bridge checks exactly PG73/ledger/corpus, temporarily installs only audit 0074 for unchanged production grant, verifies INSERT-only audit ACL, drops it and restores ledger/role.',productionGrantUnchanged:true},loaderNecessity:{workflowNodeVersion:22,topLevelDependencyGraph:[helperFile,grantFile,provisionFile],extensionlessTypeScriptTransitiveImport:true,sixOtherReviewedFixturesAlreadyUseTsx:true,onlyFilesystemLoaderProbePlanned:true},limitations:{nativeFixtureExecuted:false,nativePgPassClaim:false,postgresConnectionCount:0,productionRequestCount:0,ciPolling:false,sourceChangesByReviewer:false},risks:['Linux PostgreSQL 18.6 runtime result is still required; static review does not establish native test passing.','These proposal fixtures intentionally retain the frozen historical 73-migration corpus; this review does not change the current 81-migration production contract.']};
const target=write('acorn-shared-fixture-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({actualExit:0,report:target,assertions:assertionsTotal,files:7,reverseByteExact:true,workflowSingleLoaderAddition:true}));

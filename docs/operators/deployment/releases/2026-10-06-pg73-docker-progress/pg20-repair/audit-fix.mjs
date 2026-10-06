import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'file:///C:/cinagroup/cinatoken/node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
const own=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const target=path.join(root,'scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs');
const beforeFile=path.join(own,'before.native.test.mjs'),before=await fs.readFile(beforeFile,'utf8'),after=await fs.readFile(target,'utf8');
const parse=(name,body)=>ts.createSourceFile(name,body,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const oldTree=parse('before.mjs',before),newTree=parse('after.mjs',after);
const collect=(tree,predicate)=>{const found=[];const visit=node=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};visit(tree);return found;};
const assertCalls=tree=>collect(tree,node=>ts.isCallExpression(node)&&node.expression.getText(tree).startsWith('assert.'));
const originalAsserts=assertCalls(oldTree);
const oldMembership=originalAsserts.find(node=>node.getText(oldTree).includes('/Ordinary runtime retains shared-key usage repair privilege/'));
assert.ok(oldMembership&&ts.isAwaitExpression(oldMembership.parent));
const retained=originalAsserts.filter(node=>node!==oldMembership).map(node=>node.getText(oldTree).replaceAll('grantPostgresRuntime({ DATABASE_URL: databaseUrl })','grantRuntime()'));
const currentAssertText=assertCalls(newTree).map(node=>node.getText(newTree));
for(const text of retained) assert.ok(currentAssertText.includes(text),'Original assertion missing: '+text);
let expected=before;
expected=expected.replace(oldMembership.parent.getText(oldTree),'await rejectMembershipBeforeRuntimeGrant({ cluster, migrator, databaseUrl })');
assert.equal(expected.split('grantPostgresRuntime({ DATABASE_URL: databaseUrl })').length-1,8);
expected=expected.replaceAll('grantPostgresRuntime({ DATABASE_URL: databaseUrl })','grantRuntime()');
expected=expected.replace("import { readFile, readdir } from 'node:fs/promises';","import { readFile } from 'node:fs/promises';");
const eol=before.includes('\r\n')?'\r\n':'\n';
expected=expected.replace("import { grantPostgresRuntime } from './grant-postgres-runtime.ts';",
  "import { grantPostgresRuntime } from './grant-postgres-runtime.ts';"+eol+"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';");
expected=expected.replace('const files = (await readdir(migrations)).filter(name => name.endsWith(\'.sql\')).sort();','const files = await listPg73Migrations();');
expected=expected.replace(/(\t{3}const databaseUrl = [^\r\n]+;)(\r?\n)/,
  '$1$2\t\t\tconst grantRuntime = () => grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: databaseUrl });$2');
const helpers=newTree.statements.filter(node=>ts.isFunctionDeclaration(node)&&['pg73State','runtimeState','repairAclState','rejectMembershipBeforeRuntimeGrant'].includes(node.name?.text));
assert.equal(helpers.length,4);
const helperStart=after.lastIndexOf(eol,helpers[0].getStart(newTree)-1)+eol.length;
const testStatement=newTree.statements.find(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(newTree)==='test');
const withoutAddedHelpers=after.slice(0,helperStart)+after.slice(testStatement.getStart(newTree));
assert.equal(withoutAddedHelpers,expected,'All original bytes must differ only by reviewed setup/call substitutions and the one expectation');
const directCalls=collect(newTree,node=>ts.isCallExpression(node)&&node.expression.getText(newTree)==='grantPostgresRuntime');
assert.equal(directCalls.length,1);
const ordinaryCalls=collect(newTree,node=>ts.isCallExpression(node)&&node.expression.getText(newTree)==='grantRuntime');
assert.equal(ordinaryCalls.length,8);
const negativeFunction=helpers.find(node=>node.name?.text==='rejectMembershipBeforeRuntimeGrant');
const negativeText=negativeFunction.getText(newTree);
assert.ok(negativeText.includes("error?.code === 'P0001'"));
assert.ok(negativeText.includes("error?.message === 'Runtime must be a restricted direct LOGIN without role memberships'"));
assert.ok(negativeText.includes('auditAttempted = true'));
assert.ok(negativeText.includes('loginAttempted = true'));
assert.ok(!negativeText.includes('CASCADE'));
const {listPg73Migrations}=await import('file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs');
const files=await listPg73Migrations();
assert.equal(files.length,73);assert.equal(files.at(-1),'0073_recovery_api_key_workspace_lock.sql');
const all= (await fs.readdir(path.join(root,'packages/core/migrations-postgres'))).filter(name=>name.endsWith('.sql'));
assert.equal(all.length,81);
const raw=async file=>{const b=await fs.readFile(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const proof={schema:'pg73-runtime-grant-change-audit',at:new Date().toISOString(),actualExit:0,before:await raw(beforeFile),after:await raw(target),
  originalAssertCount:originalAsserts.length,retainedOriginalAssertions:retained.length,currentAssertCount:currentAssertText.length,
  exactlyOneOriginalExpectationUpdated:{old:'Ordinary runtime retains shared-key usage repair privilege',new:'P0001 + exact Runtime must be a restricted direct LOGIN without role memberships',reason:'Current actual production reconciler rejects memberships before the optional repair ACL branch; the direct call bypasses the fixture bridge membership precheck.'},
  allOtherOriginalBytesPreserved:true,ordinaryBridgeCalls:ordinaryCalls.length,actualDirectGrantCalls:directCalls.length,
  historicalCorpus:{count:files.length,last:files.at(-1),corpusSha256:'23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc',ledgerMd5:'ca1ea96a1b4bcd0675642f30dcf48042',allCurrentCount:all.length},
  dbConnections:0,dbWrites:0,nativeFixtureExecuted:false,limits:['This checks AST/bytes and runs only the historical file-list function. The real grant, roles, catalog ACLs and teardown await Linux PostgreSQL execution.']};
const output=path.join(own,'change-audit.proof.json');await fs.writeFile(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({proof:await raw(output),...proof},null,2));

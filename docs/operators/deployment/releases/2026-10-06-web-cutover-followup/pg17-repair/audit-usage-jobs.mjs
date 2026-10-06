import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const own = path.dirname(fileURLToPath(import.meta.url));
const root = 'C:/cinagroup/cinatoken';
const target = path.join(root,'scripts/db/cutover/postgres-shared-key-usage-repair-jobs.native.test.mjs');
const beforeFile = path.join(own,'before.native.test.mjs');
const before = await fs.readFile(beforeFile,'utf8'), after = await fs.readFile(target,'utf8');
const replacements = [
  ["import { readFile, readdir, writeFile } from 'node:fs/promises';","import { readFile, writeFile } from 'node:fs/promises';"],
  ["import { grantPostgresRuntime } from './grant-postgres-runtime.ts';","import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';"],
  ["const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();","const files = await listPg73Migrations();"],
  ['await grantPostgresRuntime({ DATABASE_URL:','await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl:']
];
let expected = before;
for (const [oldLine,newLine] of replacements) {
  assert.equal(expected.split(oldLine).length-1,1);
  expected = expected.replace(oldLine,newLine);
}
assert.equal(after,expected,'Only four reviewed setup/grant substitutions may differ');
const migrationDir = path.join(root,'packages/core/migrations-postgres');
const allFiles = (await fs.readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort();
let beforeFailure;
try { assert.equal(allFiles.length,73); } catch (error) {
  beforeFailure={name:error.name,code:error.code,actual:error.actual,expected:error.expected};
}
assert.deepEqual(beforeFailure,{name:'AssertionError',code:'ERR_ASSERTION',actual:81,expected:73});
const { listPg73Migrations } = await import('file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs');
const files = await listPg73Migrations();
assert.equal(files.length,73); assert.equal(files.at(-1),'0073_recovery_api_key_workspace_lock.sql');
const corpus = await Promise.all(files.map(async name=>name+'\n'+await fs.readFile(path.join(migrationDir,name),'utf8')));
const corpusSha256=crypto.createHash('sha256').update(corpus.join('\n')).digest('hex');
const ledgerMd5=crypto.createHash('md5').update(files.join('\n')).digest('hex');
assert.equal(corpusSha256,'23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc');
assert.equal(ledgerMd5,'ca1ea96a1b4bcd0675642f30dcf48042');
assert.ok(after.includes('CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD'));
assert.ok(after.includes('assert.equal(files.length, 73);'));
assert.ok(after.includes('error => error?.code === \'42501\''));
const raw = async file => { const b=await fs.readFile(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}; };
const proof = {schema:'pg73-usage-jobs-local-readonly-audit',at:new Date().toISOString(),actualExit:0,
  before:await raw(beforeFile),after:await raw(target),exactReviewedSubstitutions:replacements.length,
  allOtherBytesAndOriginalAssertionsPreserved:true,beforeFailure,
  actualHistoricalLoader:{count:files.length,last:files.at(-1),corpusSha256,ledgerMd5,
    excludedCurrentMigrations:allFiles.filter(name=>!files.includes(name))},
  runtimeLoginCreationUnchanged:true,bridgeExecuted:false,nativeFixtureExecuted:false,dbConnections:0,dbWrites:0,
  limitations:['Only the historical migration list function was executed; the runtime bridge, role restoration, locks, earning/ledger and queue assertions await true Linux PostgreSQL CI.','The all-81 mismatch was reproduced from filesystem enumeration, not by executing a database fixture.']};
const output=path.join(own,'local-audit.proof.json');await fs.writeFile(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({proof:await raw(output),...proof},null,2));

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const baseCommit='4e2ed5196a26cc43c2a3cb7ea852f1fc6284ff27';
const paths=['secretless-plan-v365','send-start-v365','private-route-reader-v366','read-grant-bridge-v367','result-facts-v366'].map(name=>'scripts/db/cutover/postgres-complete-text-'+name+'.native.test.mjs');
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const files=[];
for (const file of paths) {
  const before=await readFile(join(repo,file));
  const git=spawnSync('git',['show',baseCommit+':'+file],{cwd:repo,windowsHide:true});
  assert.equal(git.status,0); assert.ok(before.equals(git.stdout),file);
  await writeFile(join(root,basename(file)+'.before'),before,{flag:'wx'});
  let source=before.toString('utf8'); const operations=[];
  function replace(needle,replacement) { assert.equal(source.split(needle).length,2,needle); source=source.replace(needle,replacement); operations.push({needle,replacement}); }
  replace('readFile, readdir, writeFile','readFile, writeFile');
  replace("import { grantPostgresRuntime } from './grant-postgres-runtime.ts';","import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';");
  const loader=source.match(/const (?:names|migrationNames)=\(await readdir\((?:migrations|migrationDir)\)\)\.filter\(x=>x\.endsWith\('\.sql'\)\)\.sort\(\);/u)?.[0];
  assert.ok(loader); const variable=loader.match(/^const (\w+)=/u)[1];
  replace(loader,`const ${variable}=await listPg73Migrations();`);
  const originalCall='      await grantPostgresRuntime({DATABASE_URL:migratorUrl});';
  replace(originalCall,'      // Keep original grant calls and rejection checks on the owned PG73 ledger.\n      const grantPostgresRuntime = ({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n'+originalCall);
  const after=Buffer.from(source);
  await writeFile(join(root,basename(file)+'.after'),after,{flag:'wx'});
  await writeFile(join(repo,file),after);
  files.push({file,before:info(before),after:info(after),operations});
}
await writeFile(join(root,'five-edits.json'),JSON.stringify({baseCommit,files},null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,files:files.length,paths,nativeExecuted:false})+'\n');

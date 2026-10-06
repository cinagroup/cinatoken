import assert from'node:assert/strict';
import{readFile,writeFile,access}from'node:fs/promises';
import{join,basename}from'node:path';
import{out,repo,baseCommit,files,info,gitRead}from'./evidence-lib.mjs';
const head=await gitRead('before-head',['rev-parse','HEAD']);assert.equal(head.stdout.toString('utf8').trim(),baseCommit);
await gitRead('before-four-status',['status','--short','--',...files]);
const agentPaths=['C:/AGENTS.md','C:/cinagroup/AGENTS.md','C:/cinagroup/cinatoken/AGENTS.md','C:/cinagroup/cinatoken/scripts/AGENTS.md','C:/cinagroup/cinatoken/scripts/db/AGENTS.md','C:/cinagroup/cinatoken/scripts/db/cutover/AGENTS.md'],instructions=[];
for(const path of agentPaths){try{const bytes=await readFile(path);instructions.push({path,present:true,...info(bytes)});}catch(error){assert.equal(error.code,'ENOENT');instructions.push({path,present:false});}}
assert.ok(instructions.every(item=>!item.present));
const batch=await gitRead('before-four-git',['cat-file','--batch'],files.map(file=>baseCommit+':'+file+'\n').join(''));let offset=0;const edits=[];
for(const file of files){const end=batch.stdout.indexOf(10,offset),[blob,type,size]=batch.stdout.subarray(offset,end).toString('utf8').split(' ');assert.equal(type,'blob');const original=batch.stdout.subarray(end+1,end+1+Number(size));offset=end+1+Number(size)+1;const before=await readFile(join(repo,file));assert.ok(before.equals(original),file);await writeFile(join(out,basename(file)+'.before'),before,{flag:'wx'});let source=before.toString('utf8');const operations=[];
 function replace(needle,replacement){assert.equal(source.split(needle).length,2,needle);source=source.replace(needle,replacement);operations.push({needle,replacement});}
 const fsLine=source.match(/^import \{ readFile, readdir, writeFile \} from 'node:fs\/promises';\r?\n/mu)?.[0];assert.ok(fsLine);replace(fsLine,"import { readFile, writeFile } from 'node:fs/promises';\n");
 const grantLine=source.match(/^import \{ grantPostgresRuntime \} from '\.\/grant-postgres-runtime.ts';\r?\n/mu)?.[0];assert.ok(grantLine);replace(grantLine,"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';\n");
 const loader=source.match(/^      const migrationNames=\(await readdir\(migrationDir\)\)\.filter\(x=>x\.endsWith\('\.sql'\)\)\.sort\(\);\r?\n/mu)?.[0];assert.ok(loader);replace(loader,'      const migrationNames=await listPg73Migrations();\n');
 const call='      await grantPostgresRuntime({DATABASE_URL:migratorUrl});';replace(call,'      // Keep original grant calls and rejection checks on the owned PG73 ledger.\n      const grantPostgresRuntime = ({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n'+call);
 const after=Buffer.from(source);await writeFile(join(out,basename(file)+'.after'),after,{flag:'wx'});await writeFile(join(repo,file),after);edits.push({file,baseGitBlob:blob,before:info(before),after:info(after),operations});
}assert.equal(offset,batch.stdout.length);
await writeFile(join(out,'four-edits.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,baseCommit,files:edits,instructions,repositoryWritePaths:files,gitMutations:0},null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({actualExit:0,changedFiles:files.length,paths:files,productionWrites:0,nativePgExecuted:false})+'\n');

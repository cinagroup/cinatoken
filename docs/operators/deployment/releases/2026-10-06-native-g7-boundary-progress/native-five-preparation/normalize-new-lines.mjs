import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join,dirname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const edits=JSON.parse(await readFile(join(root,'five-edits.json'),'utf8'));
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
let normalized=0;
for(const file of edits.files){
  const before=await readFile(join(repo,file.file));let source=before.toString('utf8');
  const exactRows=["import { readFile, writeFile } from 'node:fs/promises';","import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';",...['names','migrationNames'].map(name=>`      const ${name}=await listPg73Migrations();`)];
  const changes=[];
  for(const row of exactRows){if(source.includes(row+'\r\n')){assert.equal(source.split(row+'\r\n').length,2);source=source.replace(row+'\r\n',row+'\n');changes.push({row,from:'CRLF',to:'LF'});normalized++;}}
  const after=Buffer.from(source);await writeFile(join(repo,file.file),after);await writeFile(join(root,basename(file.file)+'.after-v2'),after,{flag:'wx'});
  file.after=info(after);file.normalizedChangedLines=changes;
}
assert.equal(normalized,8);await writeFile(join(root,'five-edits-v2.json'),JSON.stringify(edits,null,2)+'\n',{flag:'wx'});
let audit=await readFile(join(root,'audit-five.mjs'),'utf8');
const anchor='  let reconstructed=a;';assert.equal(audit.split(anchor).length,2);
audit=audit.replace(anchor,anchor+`\n  // Restore only newly changed rows to their original CRLF for full byte reversal.\n  const linePairs = [\n    [\"import { readFile, readdir, writeFile } from 'node:fs/promises';\",\"import { readFile, writeFile } from 'node:fs/promises';\"],\n    [\"import { grantPostgresRuntime } from './grant-postgres-runtime.ts';\",\"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';\"],\n  ];\n  const priorLoader=b.match(/      const (?:names|migrationNames)=\\(await readdir\\((?:migrations|migrationDir)\\)\\)\\.filter\\(x=>x\\.endsWith\\('\\.sql'\\)\\)\\.sort\\(\\);/u)?.[0];\n  assert.ok(priorLoader); const priorName=priorLoader.match(/const (\\w+)=/u)[1];\n  linePairs.push([priorLoader,'      const '+priorName+'=await listPg73Migrations();']);\n  for(const [originalRow,currentRow] of linePairs){if(b.includes(originalRow+'\\r\\n')){assert.equal(reconstructed.split(currentRow+'\\n').length,2);assert.ok(!reconstructed.includes(currentRow+'\\r\\n'));reconstructed=reconstructed.replace(currentRow+'\\n',currentRow+'\\r\\n');}}`);
audit=audit.replace("join(root,'five-source-audit.json')","join(root,'five-source-audit-v2.json')");
await writeFile(join(root,'audit-five-v2.mjs'),audit,{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,changedNewRowsNormalized:normalized,originalAssertionsNotEdited:true})+'\n');

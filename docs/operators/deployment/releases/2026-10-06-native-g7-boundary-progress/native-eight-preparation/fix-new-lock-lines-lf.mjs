import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const repo = 'C:/cinagroup/cinatoken';
const info = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const old = JSON.parse(await readFile(join(root, 'eight-final-edits.json'), 'utf8'));
const file = 'scripts/db/cutover/postgres-authenticated-request-capability-login-v356.native.test.mjs';
const record = old.files.find(entry => entry.file === file);
const bytes = await readFile(join(repo,file)); assert.deepEqual(info(bytes),record.after);
const needle = record.operations.at(-1).replacement;
assert.equal((needle.match(/\r\n/gu) ?? []).length,6);
const replacement = needle.replaceAll('\r\n','\n');
const source = bytes.toString('utf8'); assert.equal(source.split(needle).length,2);
const after = Buffer.from(source.replace(needle,replacement));
assert.equal((after.toString('utf8').match(/\r\n/gu) ?? []).length,0);
await writeFile(join(root,basename(file)+'.before-lf-fix'),bytes,{flag:'wx'});
await writeFile(join(root,basename(file)+'.after-lf-fix'),after,{flag:'wx'});
await writeFile(join(repo,file),after);
const next = { ...old, completedAt:new Date().toISOString(), originalCandidate:'eight-final-edits.json', files: old.files.map(entry => entry.file===file?{
  ...entry, after:info(after), operations:[...entry.operations,{needle,replacement}],
}:entry) };
await writeFile(join(root,'eight-final-edits-v2.json'),JSON.stringify(next,null,2)+'\n',{flag:'wx'});
const audit = await readFile(join(root,'audit-eight.mjs'),'utf8');
await writeFile(join(root,'audit-eight-v2.mjs'),audit.replace("'eight-final-edits.json'","'eight-final-edits-v2.json'").replace("'.final-after'","'.final-after-v2'").replace("'eight-source-audit.json'","'eight-source-audit-v2.json'"),{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,file,before:info(bytes),after:info(after),onlySixNewLineEndingBytesRemoved:true})+'\n');

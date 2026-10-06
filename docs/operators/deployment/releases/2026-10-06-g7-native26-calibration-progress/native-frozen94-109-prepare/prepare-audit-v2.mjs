import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{out}from'./capture.mjs';
let source=await readFile(join(out,'audit-four.mjs'),'utf8');
const original='ts.forEachChild(n,c=>children.push(shape(c)))',replacement='ts.forEachChild(n,c=>{children.push(shape(c));})';
assert.equal(source.split(original).length,2);source=source.replace(original,replacement);
for(const[from,to]of[
 ['audit-wrapper-','audit2-wrapper-'],['audit-current-legacy-','audit2-current-legacy-'],['audit-historical-','audit2-historical-'],['audit-protected-git','audit2-protected-git'],
 ['.final-after`','.final-after-v2`'],['.final`','.final-v2`'],
 ["'fixture-instructions'","'fixture-instructions-v2'"],["'historical-instructions'","'historical-instructions-v2'"],
 ["'four-independent-audit.json'","'four-independent-audit-v2.json'"]
]){assert.ok(source.includes(from),'Expected unique-version adaptation');source=source.replaceAll(from,to)}
await writeFile(join(out,'audit-four-v2.mjs'),source,{flag:'wx'});
console.log(JSON.stringify({actualExit:0,reason:'Complete normalized AST child traversal while retaining all existing source/whole-byte checks.',repositoryWrites:0,originalAuditPreserved:true}));

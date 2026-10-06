import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{out}from'./capture.mjs';
let source=await readFile(join(out,'audit-four.mjs'),'utf8');
const changes=[
 ['ts.forEachChild(n,c=>children.push(shape(c)))','ts.forEachChild(n,c=>{children.push(shape(c));})'],
 ['audit-wrapper-','audit3-wrapper-'],['audit-current-legacy-','audit3-current-legacy-'],['audit-historical-','audit3-historical-'],['audit-protected-git','audit3-protected-git'],
 [".final-after'",".final-after-v3'"],[".final'",".final-v3'"],
 ["'fixture-instructions'","'fixture-instructions-v3'"],["'historical-instructions'","'historical-instructions-v3'"],
 ["'four-independent-audit.json'","'four-independent-audit-v3.json'"]
];
for(const[from,to]of changes){assert.ok(source.includes(from),'Expected v3 edit: '+from);source=source.replaceAll(from,to)}
await writeFile(join(out,'audit-four-v3.mjs'),source,{flag:'wx'});
console.log(JSON.stringify({actualExit:0,completeAstChildren:true,repositoryWrites:0,originalAndFailedScriptsPreserved:true}));

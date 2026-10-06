import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{out}from'./capture.mjs';
let source=await readFile(join(out,'prepare-workflow-map.mjs'),'utf8');
const from='const match=/node\\s+--import\\s+tsx\\s+--test\\s+(\\S+)/.exec(s.text)',to='const match=/node(?:\\s+--import\\s+tsx)?\\s+--test\\s+(\\S+)/.exec(s.text)';
assert.equal(source.split(from).length,2);source=source.replace(from,to).replace("'original-workflow-map.json'","'original-workflow-map-v2.json'");
await writeFile(join(out,'prepare-workflow-map-v2.mjs'),source,{flag:'wx'});
console.log(JSON.stringify({actualExit:0,reason:'Include the original node --test entry without --import tsx; keep actual/YAML offset authority.',ciQueries:0,oldFailedScriptPreserved:true}));

import assert from'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{join}from'node:path';
import{out,runClosed}from'./evidence-lib.mjs';
const plan=JSON.parse(await readFile(join(out,'26-applied-v2.json'),'utf8')),queue=[...plan.files],results=[];
async function worker(){for(;;){const item=queue.shift();if(!item)return;const receipt=await runClosed('syntax-step-'+item.step,process.execPath,['--check',item.file]);results.push({step:item.step,file:item.file,...receipt});}}
await Promise.all(Array.from({length:4},worker));results.sort((a,b)=>a.step-b.step);await writeFile(join(out,'26-syntax-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n',{flag:'wx'});assert.equal(results.length,26);assert.ok(results.every(r=>r.actualExit===0&&r.signal===null));
const diff=await runClosed('26-diff-check','git',['diff','--check','--',...plan.files.map(f=>f.file)]);assert.equal(diff.actualExit,0);const patch=await runClosed('26-final-patch','git',['diff','--',...plan.files.map(f=>f.file)]);assert.equal(patch.actualExit,0);process.stdout.write(JSON.stringify({actualExit:0,syntax:results.length,syntaxFailures:0,diffCheckActualExit:diff.actualExit,nativeFixtureExecuted:false})+'\n');

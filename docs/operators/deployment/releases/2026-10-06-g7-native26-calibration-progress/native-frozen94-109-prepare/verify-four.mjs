import{command,success,out}from'./capture.mjs';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
const inputs=JSON.parse(await readFile(join(out,'base-inputs.json'),'utf8'));
const jobs=[...inputs.targets.map(t=>['syntax-'+t.step,process.execPath,['--check',t.wrapper]]),
 ['four-diff-check','git',['diff','--check','--',...inputs.allowedPaths]],
 ['four-current-patch','git',['diff','--',...inputs.allowedPaths]],
 ['four-current-status','git',['status','--short','--',...inputs.allowedPaths]]];
const results=await Promise.allSettled(jobs.map(async([label,exe,args])=>{const r=await command(label,exe,args);success(r);return{label,receipt:r.receipt}}));
for(const r of results)if(r.status==='rejected')throw r.reason;
await writeFile(join(out,'four-static-command-checks.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,results:results.map(r=>r.value),
 nativeExecuted:false,syntaxOnly:true,diffBoundary:'Tracked wrapper edits are covered by git diff/check; both new untracked text snapshots are covered by independent byte equality against historical Git blobs.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,syntaxPassed:2,diffCheckActualExit:0,nativeExecuted:false}));

import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{out,command,success}from'./capture.mjs';
const input=JSON.parse(await readFile(join(out,'inputs.json'),'utf8'));
const jobs=[['syntax',process.execPath,['--check',input.target]],['diff-check','git',['diff','--check','--',input.target]],
 ['final-source-patch','git',['diff','--',input.target]],['target-status','git',['status','--short','--',input.target]]];
const results=await Promise.allSettled(jobs.map(async([label,exe,args])=>{const r=await command(label,exe,args);success(r);return{label,receipt:r.receipt}}));
for(const r of results)if(r.status==='rejected')throw r.reason;
await writeFile(join(out,'static-checks.json'),JSON.stringify({actualExit:0,at:new Date().toISOString(),results:results.map(r=>r.value),nativeExecuted:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,syntaxPassed:true,diffCheckActualExit:0,nativeExecuted:false}));

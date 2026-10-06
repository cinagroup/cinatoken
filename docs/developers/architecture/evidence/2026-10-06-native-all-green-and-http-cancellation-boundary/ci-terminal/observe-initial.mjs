import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out} from './capture.mjs';
const sha='757490181564aa822f960f5d8704857b98b230d0',gh='C:/Program Files/GitHub CLI/gh.exe';
const runs=JSON.parse(await readFile(join(out,'commit-runs.stdout.log'),'utf8'));assert.equal(runs.length,5);for(const r of runs){assert.equal(r.headSha,sha);assert.equal(r.event,'push');}
const results=await Promise.allSettled(runs.map(async r=>{
 const slug=r.workflowName==='Proxy dispatch safety'?'proxy':r.workflowName==='Web frontend'?'web':r.workflowName==='Release'?'release':r.workflowName==='Verify package versions'?'verify':'compose';
 const result=await command(slug+'-initial',gh,['run','view',String(r.databaseId),'--repo','cinagroup/cinatoken','--json','databaseId,name,headSha,status,conclusion,url,jobs,createdAt,updatedAt']);
 const view=JSON.parse(success(result));assert.equal(view.headSha,sha);assert.equal(view.databaseId,r.databaseId);
 return{slug,runId:view.databaseId,name:view.name,headSha:view.headSha,status:view.status,conclusion:view.conclusion,url:view.url,receipt:result.receipt,
  jobs:view.jobs.map(j=>({jobId:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,lastCompletedStep:j.steps.filter(s=>s.status==='completed').at(-1)??null,currentStep:j.steps.find(s=>s.status==='in_progress')??null}))};
}));for(const r of results)if(r.status==='rejected')throw r.reason;
success(await command('original-proxy-workflow','git',['show',sha+':.github/workflows/proxy-dispatch-safety.yml']));
const data={schema:'cinatoken-757-original-ci-initial-v1',at:new Date().toISOString(),sourceSha:sha,runs:results.map(r=>r.value),ciActions:0,repositoryWrites:0,nativeExecutedLocally:false};
await writeFile(join(out,'INITIAL-ci-state.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:sha,runs:data.runs.map(r=>({slug:r.slug,runId:r.runId,status:r.status,conclusion:r.conclusion,jobs:r.jobs}))}));

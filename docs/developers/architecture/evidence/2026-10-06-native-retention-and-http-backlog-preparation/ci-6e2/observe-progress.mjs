import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out} from './capture.mjs';
const r=await command('proxy-progress-1','C:/Program Files/GitHub CLI/gh.exe',['run','view','37424911830','--repo','cinagroup/cinatoken','--json','databaseId,name,headSha,status,conclusion,url,jobs,createdAt,updatedAt']);
const view=JSON.parse(success(r));assert.equal(view.headSha,'6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa');assert.equal(view.databaseId,37424911830);
const map=JSON.parse(await readFile(join(out,'original-workflow-map.json'),'utf8'));
const native=view.jobs.find(j=>j.name==='native-financial-consumer');assert.equal(native.databaseId,112142276121);
const current=native.steps.find(s=>s.status==='in_progress'),last=native.steps.filter(s=>s.status==='completed').at(-1);
console.log(JSON.stringify({receipt:r.receipt,runId:view.databaseId,status:view.status,conclusion:view.conclusion,headSha:view.headSha,
 native:{jobId:native.databaseId,status:native.status,conclusion:native.conclusion,lastCompleted:last,current,currentFixture:current?map.fixtures.find(f=>f.step===current.number)??null:null,failed:native.steps.filter(s=>s.conclusion==='failure')},
 otherJobs:view.jobs.filter(j=>j!==native).map(j=>({id:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,failed:j.steps.filter(s=>s.conclusion==='failure')})),collectionOnly:true}));

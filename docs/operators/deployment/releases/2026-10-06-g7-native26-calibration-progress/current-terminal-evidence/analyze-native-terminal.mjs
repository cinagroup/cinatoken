import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=JSON.parse(fs.readFileSync(path.join(out,'proxy-progress-2.raw.stdout.log')));
assert.equal(run.headSha,'473de5fc520fc7d64db700db88a76c7a6b45c241');assert.equal(run.status,'completed');assert.equal(run.conclusion,'failure');
const native=run.jobs.find(j=>j.databaseId===112094395119),dispatch=run.jobs.find(j=>j.databaseId===112094395070);
const bytes=fs.readFileSync(path.join(out,'native-terminal-log.stdout.log'));assert.equal(sha(bytes),'4203c059c01c7097c650376d0148120244536cd2fe6931095ee0414b930f00a5');
const text=bytes.toString();
const cases=['postgres-complete-text-legacy-reaper-fence-v366.native.test.mjs','postgres-complete-text-all-hold-renewal-v367.native.test.mjs','postgres-complete-text-buyer-counter-cutover-v367.native.test.mjs','postgres-complete-text-legacy-buyer-held-v368.native.test.mjs','postgres-buyer-held-opt-in-gap-v370.native.test.mjs','postgres-legacy-buyer-window-accountant-v371.native.test.mjs','postgres-legacy-buyer-windowed-app-v372.native.test.mjs','postgres-legacy-buyer-windowed-app-privileges-v374.native.test.mjs'];
const results=[];
for(let i=0;i<cases.length;i++){
 const step=native.steps.find(s=>s.number===53+i);assert.ok(step);assert.equal(step.conclusion,i===7?'failure':'success');
 const at=text.indexOf('node --import tsx --test scripts/db/cutover/'+cases[i]);assert.ok(at>=0);const start=text.lastIndexOf('##[group]',at);let end=text.indexOf('##[group]',at);if(end<0)end=text.indexOf('\tPost Run actions/checkout@v4\t',at);assert.ok(start>=0&&end>at);const group=text.slice(start,end);
 const metric=n=>{const m=[...group.matchAll(new RegExp('# '+n+' ([0-9]+)','g'))];assert.equal(m.length,1);return Number(m[0][1]);};
 const tests=metric('tests'),pass=metric('pass'),fail=metric('fail'),skip=metric('skipped');assert.equal(tests,1);assert.equal(skip,0);assert.equal(pass,i===7?0:1);assert.equal(fail,i===7?1:0);
 if(i===7){assert.match(group,/81 !== 73/);assert.ok(group.includes(cases[i]+':125:14'));assert.match(group,/Process completed with exit code 1\./);}
 results.push({step:53+i,file:cases[i],conclusion:step.conclusion,startedAt:step.startedAt,completedAt:step.completedAt,tests,pass,fail,skip,rawGroupSha256:sha(Buffer.from(group)),sourceFixInThisBatch:i<4});
}
assert.equal(dispatch.steps.find(s=>s.number===27).conclusion,'failure');const d=fs.readFileSync(path.join(out,'dispatch-terminal-failed.stdout.log'));for(const value of ['# tests 8','# pass 7','# fail 1','# skipped 0','Process completed with exit code 1.'])assert.ok(d.toString().includes(value));
const proof={schema:'native-four-terminal-analysis-v1',at:new Date().toISOString(),actualExit:0,analysisOnly:true,sourceCommit:run.headSha,runId:run.databaseId,overallCI:run.conclusion,nativeJobId:native.databaseId,nativeOverall:native.conclusion,results,dispatch:{jobId:dispatch.databaseId,originalStrictStep27:'failure',tests:8,pass:7,fail:1,skip:0,rawBytes:d.length,rawSha256:sha(d)},fullPipelinePassDerived:false,fullG7Verified:false,fullG8Verified:false};
fs.writeFileSync(path.join(out,'native-terminal-analysis.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExit:0,source:run.headSha,newFour:results.slice(0,4),unchanged57To59:results.slice(4,7),nextFailure:results[7],strict:proof.dispatch,fullPipelinePassDerived:false}));

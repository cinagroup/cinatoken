import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const sha='6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa';
const proxy=JSON.parse(await readFile(join(out,'proxy-initial.stdout.log'),'utf8'));assert.equal(proxy.headSha,sha);
const native=proxy.jobs.find(j=>j.name==='native-financial-consumer'),raw=await readFile(join(out,'original-proxy-workflow.stdout.log')),lines=raw.toString('utf8').split('\n');
const start=lines.findIndex(l=>/^  native-financial-consumer:/.test(l));assert.ok(start>=0);
let stop=lines.findIndex((l,i)=>i>start&&/^  [A-Za-z0-9_-]+:\s*$/.test(l));if(stop===-1)stop=lines.length;
const steps=[];
for(let i=start;i<stop;i++)if(/^      - /.test(lines[i])){let end=i+1;while(end<stop&&!/^      - /.test(lines[end]))end++;steps.push({yamlStep:steps.length+1,workflowLine:i+1,text:lines.slice(i,end).join('\n')});}
const checkout=steps.find(s=>s.text.includes('uses: actions/checkout@v4')),actualCheckout=native.steps.find(s=>s.name.includes('actions/checkout@v4'));
assert.ok(checkout&&actualCheckout);const offset=actualCheckout.number-checkout.yamlStep;assert.equal(offset,2);
const fixtures=steps.flatMap(s=>{const match=/node(?:\s+--import\s+tsx)?\s+--test\s+(\S+)/.exec(s.text);return match?[{yamlStep:s.yamlStep,workflowLine:s.workflowLine,fixture:match[1],step:s.yamlStep+offset}]:[];}).filter(s=>s.step>=7&&s.step<=113);
assert.equal(fixtures.length,107);assert.deepEqual(fixtures.map(s=>s.step),Array.from({length:107},(_,i)=>i+7));
assert.equal(fixtures.find(s=>s.step===24).fixture,'scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs');
assert.equal(fixtures.find(s=>s.step===110).fixture,'scripts/db/cutover/postgres-legacy-parent-activation.native.test.mjs');
const map={sourceSha:sha,originalWorkflow:info(raw),nativeJobId:native.databaseId,yamlActualOffset:offset,checkout:{yamlStep:checkout.yamlStep,actual:actualCheckout},fixtures,
 target26Steps:[60,61,66,69,71,72,73,74,75,76,77,78,80,81,82,83,84,85,86,88,95,96,97,98,99,106],remaining6Steps:[95,96,97,98,99,106],collectionOnly:true};
await writeFile(join(out,'original-workflow-map.json'),JSON.stringify(map,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:sha,fixtures:107,financialFixtures:106,target26:26,remaining6:6,nativeJobId:native.databaseId,offset}));

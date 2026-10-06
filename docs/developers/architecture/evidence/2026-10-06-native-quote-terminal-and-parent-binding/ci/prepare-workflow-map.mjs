import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{out,info}from'./capture.mjs';
const initial=JSON.parse(await readFile(join(out,'INITIAL-ci-state.json'),'utf8'));
const proxy=initial.runs.find(r=>r.slug==='proxy'),native=proxy.view.jobs.find(j=>j.name==='native-financial-consumer');assert.ok(native);
const raw=await readFile(join(out,'original-proxy-workflow.stdout.log')),lines=raw.toString('utf8').split('\n');
const start=lines.findIndex(l=>/^  native-financial-consumer:/.test(l));assert.notEqual(start,-1);
let stop=lines.findIndex((l,i)=>i>start&&/^  [A-Za-z0-9_-]+:\s*$/.test(l));if(stop===-1)stop=lines.length;
const sourceSteps=[];
for(let i=start;i<stop;i++)if(/^      - /.test(lines[i])){const end=(()=>{let n=i+1;while(n<stop&&!/^      - /.test(lines[n]))n++;return n})();sourceSteps.push({yamlStep:sourceSteps.length+1,workflowLine:i+1,text:lines.slice(i,end).join('\n')})}
const checkout=sourceSteps.find(s=>s.text.includes('uses: actions/checkout@v4')),actualCheckout=native.steps.find(s=>s.name.includes('actions/checkout@v4'));
assert.ok(checkout&&actualCheckout);const offset=actualCheckout.number-checkout.yamlStep;assert.equal(offset,2);
const fixtures=sourceSteps.flatMap(s=>{const match=/node\s+--import\s+tsx\s+--test\s+(\S+)/.exec(s.text);return match?[{...s,fixture:match[1],step:s.yamlStep+offset}]:[]});
const quote=fixtures.find(s=>s.fixture==='scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs');assert.equal(quote.step,24);
const chain=fixtures.filter(s=>s.step>=55&&s.step<=113);assert.equal(chain.length,59);assert.deepEqual(chain.map(s=>s.step),Array.from({length:59},(_,i)=>i+55));
const targets=[60,61,66,69,71,72,73,74,75,76,77,78,80,81,82,83,84,85,86,88,95,96,97,98,99,106];
assert.ok(chain.find(s=>s.step===94).fixture.includes('runtime-buyer-client-successor'));assert.ok(chain.find(s=>s.step===109).fixture.includes('backend-lifecycle-successor'));
const result={at:new Date().toISOString(),sourceSha:initial.sourceSha,workflowBytes:info(raw),nativeJobId:native.databaseId,
 yamlActualStepOffset:offset,offsetAuthority:{yamlCheckoutStep:checkout.yamlStep,actualCheckoutStep:actualCheckout},
 nativeFixtureSteps:fixtures,chain55to113:chain,target26Steps:targets,remaining6Steps:[95,96,97,98,99,106],quote24:quote,
 initialQuote24ActualStatus:native.steps.find(s=>s.number===24),collectionOnly:true};
await writeFile(join(out,'original-workflow-map.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:initial.sourceSha,actualOffset:offset,chainFixtures:59,targetFixtures:26,quote24InitialActual:result.initialQuote24ActualStatus,derivedCiSlices:false}));

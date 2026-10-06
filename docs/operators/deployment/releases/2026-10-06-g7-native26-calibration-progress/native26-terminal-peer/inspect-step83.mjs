import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const out=process.argv[2];
const run=JSON.parse(readFileSync(join(out,'proxy-progress-7.stdout.log')));
const step=run.jobs.find(j=>j.name==='native-financial-consumer').steps.find(s=>s.number===83);
const lines=readFileSync(join(out,'v2-source-step-83.stdout.log'),'utf8').split('\n');
process.stdout.write(JSON.stringify({step,timeoutLines:lines.map((text,i)=>({line:i+1,text})).filter(r=>r.text.includes('timeout:'))}));
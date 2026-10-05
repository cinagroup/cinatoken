import fs from 'node:fs';import crypto from 'node:crypto';
const p='C:/Users/cina/AppData/Local/Temp/cinatoken-web-retention-40bda77a453343d89d5fe50706d58326/inventory-before.json',b=fs.readFileSync(p),v=JSON.parse(b);
const safe={zone:{id:v.zone.id},routes:v.routes.map(r=>({id:r.id,pattern:r.pattern,script:r.script,request_limit_fail_open:r.request_limit_fail_open})),workers:v.workers.filter(w=>w.deployment).map(w=>({name:w.name,deployment:{versions:w.deployment.versions.map(x=>({id:x.id}))}})),originalInventorySha256:crypto.createHash('sha256').update(b).digest('hex'),baselineScope:'Route ownership and backend deployment IDs only; configuration values deliberately omitted'};
fs.writeFileSync(p,JSON.stringify(safe,null,2)+'\n');console.log(JSON.stringify({routeCount:safe.routes.length,workers:safe.workers.map(w=>w.name),configurationValues:0}));


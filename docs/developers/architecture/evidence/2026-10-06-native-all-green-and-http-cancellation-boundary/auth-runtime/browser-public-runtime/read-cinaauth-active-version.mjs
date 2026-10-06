import fs from 'node:fs';import assert from 'node:assert/strict';const account='7ea8e46d8210bad342fa7595f7935fea';
async function get(p){const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+p,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(30000)});const j=await r.json();assert.equal(r.status,200);assert.equal(j.success,true);return j.result;}
const result={at:new Date().toISOString(),readOnly:true,secretValuesRecorded:false};
const settings=await get('/workers/scripts/cinaauth-api/settings');result.hyperdriveBindings=(settings.bindings??[]).filter(x=>x.type==='hyperdrive').map(x=>({name:x.name,id:x.id}));
const ds=await get('/workers/scripts/cinaauth-api/deployments');const d=ds.deployments[0];result.deployment={id:d.id,versions:d.versions};result.versions=[];
for(const v of d.versions){const j=await get('/workers/scripts/cinaauth-api/versions/'+v.version_id);result.versions.push({id:v.version_id,percentage:v.percentage,tag:j.annotations?.['workers/tag']??null});}
result.finishedAt=new Date().toISOString();fs.writeFileSync(new URL('cinaauth-active-version-metadata.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));


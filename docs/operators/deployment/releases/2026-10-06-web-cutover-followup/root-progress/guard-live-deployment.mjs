import fs from 'node:fs';
import assert from 'node:assert/strict';
const [label, expectedVersion, expectedCommit] = process.argv.slice(2);
assert.match(label??'',/^[a-z0-9-]+$/);assert.match(expectedVersion??'',/^[a-f0-9-]{36}$/);assert.match(expectedCommit??'',/^[a-f0-9]{40}$/);
const account='7ea8e46d8210bad342fa7595f7935fea',zone='bd42026e3facf3317ae32d55de5e2044';
const proof={at:new Date().toISOString(),actualExit:null,readOnly:true,secretValuesRecorded:false};
async function get(path){const r=await fetch('https://api.cloudflare.com/client/v4'+path,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(30000)});const j=await r.json();assert.equal(r.status,200);assert.equal(j.success,true);return j.result;}
try{
  const all=await get('/zones/'+zone+'/workers/routes');
  proof.routes=['cinatoken.com/*','cinatoken.com/web-assets/*','api.cinatoken.com/*'].map(p=>all.find(r=>r.pattern===p));
  for(let i=0;i<proof.routes.length;i++){assert.equal(proof.routes[i]?.script,i===2?'cinatoken-proxy':'cinatoken-web');assert.equal(proof.routes[i].request_limit_fail_open,false);}
  const ds=await get('/accounts/'+account+'/workers/scripts/cinatoken-web/deployments');
  const latest=ds.deployments[0];assert.equal(latest.versions.length,1);assert.equal(latest.versions[0].version_id,expectedVersion);assert.equal(latest.versions[0].percentage,100);
  const details=await get('/accounts/'+account+'/workers/scripts/cinatoken-web/versions/'+expectedVersion);assert.equal(details.annotations['workers/tag'],expectedCommit);
  proof.deployment={id:latest.id,versions:latest.versions,commitTag:expectedCommit};
  proof.access=await get('/accounts/'+account+'/workers/scripts/cinatoken-web/subdomain');assert.equal(proof.access.enabled,false);assert.equal(proof.access.previews_enabled,false);
  proof.actualExit=0;
}catch(error){proof.actualExit=1;proof.error=error.message;}
proof.finishedAt=new Date().toISOString();fs.writeFileSync(new URL(label+'.deployment-guard.json',import.meta.url),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));process.exitCode=proof.actualExit;

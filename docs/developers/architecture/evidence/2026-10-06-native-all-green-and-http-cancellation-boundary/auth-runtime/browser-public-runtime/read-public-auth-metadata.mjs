import fs from 'node:fs';import assert from 'node:assert/strict';
const account='7ea8e46d8210bad342fa7595f7935fea';
const allowed=new Set(['CINATOKEN_APP_ORIGIN','CINATOKEN_OIDC_CLIENT_ID','CINAAUTH_ISSUER','CINAAUTH_ACCOUNT_ORIGIN','CINATOKEN_REQUIRED_ROLES']);
const names=new Set(['CINATOKEN_OIDC_CLIENT_SECRET','CINATOKEN_OIDC_BRIDGE_SECRET','CINATOKEN_OIDC_TRANSACTION_SECRET','CINATOKEN_IDENTITY_EVENTS_SECRET']);
const result={at:new Date().toISOString(),readOnly:true,secretValuesRecorded:false,workers:[]};
for(const worker of ['cinatoken-web','cinatoken-admin']){
 const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/'+worker+'/settings',{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(30000)});const j=await r.json();assert.equal(r.status,200);assert.equal(j.success,true);
 const b=j.result.bindings??[];
 result.workers.push({worker,publicBindings:b.filter(x=>allowed.has(x.name)).map(x=>({name:x.name,type:x.type,value:x.text??null})),secretBindings:[...names].map(name=>({name,present:b.some(x=>x.name===name&&x.type==='secret_text')})),authService:b.filter(x=>x.name==='CINAAUTH_AUTH_SERVICE'||x.name==='ADMIN').map(x=>({name:x.name,type:x.type,service:x.service??null,environment:x.environment??null})),secretStrengthUnknown:true});
}
result.finishedAt=new Date().toISOString();fs.writeFileSync(new URL('cloudflare-public-auth-metadata.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));


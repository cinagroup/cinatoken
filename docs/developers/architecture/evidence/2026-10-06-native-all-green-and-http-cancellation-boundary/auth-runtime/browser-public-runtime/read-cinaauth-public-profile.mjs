import fs from 'node:fs';import assert from 'node:assert/strict';
const account='7ea8e46d8210bad342fa7595f7935fea',allow=new Set(['CINAAUTH_CINATOKEN_ORIGIN','CINAAUTH_CINATOKEN_CLIENT_ID']);
const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/cinaauth-api/settings',{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(30000)});const j=await r.json();
const result={at:new Date().toISOString(),readOnly:true,status:r.status,worker:'cinaauth-api',secretValuesRecorded:false};
if(r.status===200&&j.success){const b=j.result.bindings??[];result.publicBindings=[...allow].map(name=>{const x=b.find(y=>y.name===name);return {name,present:!!x,type:x?.type??null,value:x?.type==='plain_text'?x.text:null};});result.databaseBindings=b.filter(x=>x.type==='d1').map(x=>({name:x.name,type:x.type,id:x.id??null}));}else result.apiErrorCodes=j.errors?.map(x=>x.code)??[];
fs.writeFileSync(new URL('cinaauth-public-profile-metadata.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));assert.equal(r.status,200);assert.equal(j.success,true);


import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT='7ea8e46d8210bad342fa7595f7935fea';
const NAME='cinatoken-regmeta-'+randomBytes(12).toString('hex');
assert.match(NAME,/^cinatoken-regmeta-[a-f0-9]{24}$/);
const bundle=fs.readFileSync(path.join(root,'registration-runtime-v2/registration-metadata.bundle.mjs'));
assert.equal(createHash('sha256').update(bundle).digest('hex'),'a2d547c6de353ada6eb908a4068df2f597d75a7f85ca96c76d00724f008d2e67');
const report={at:new Date().toISOString(),worker:NAME,account:ACCOUNT,scriptSha256:createHash('sha256').update(bundle).digest('hex'),plan:'Temporary separate gated Worker; one BEGIN READ ONLY / SET LOCAL timeouts / fixed SELECT; then DELETE and verify404',productionWorkersChanged:false,routesChanged:false,hyperdriveSettingsChanged:false,databaseDmlOrDdl:false,metadataRequests:0,gatePersisted:false,steps:[],metadata:null,cleanup:null};
let putAttempted=false,preflightAbsent=false;
const token=process.env.CLOUDFLARE_API_TOKEN;
const gate=randomBytes(32).toString('hex');
fs.writeFileSync(path.join(root,'registration-owned-plan.json'),JSON.stringify({...report,created:false,preflight:'pending'},null,2)+'\n',{flag:'wx'});
const apiBase='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT;
async function api(label,method,suffix,body){
 const headers={Authorization:'Bearer '+token};
 if(body && !(body instanceof FormData))headers['Content-Type']='application/json';
 let response;
 try{response=await fetch(apiBase+suffix,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{report.steps.push({label,method,transport:'failed'});throw new Error(label+'_transport_failed');}
 let parsed;
 try{parsed=response.status===204?{success:true}:await response.json();}catch{report.steps.push({label,method,status:response.status,json:false});throw new Error(label+'_response_invalid');}
 report.steps.push({label,method,status:response.status,success:parsed.success===true,errorCodes:Array.isArray(parsed.errors)?parsed.errors.map(e=>Number.isInteger(e.code)?e.code:null):[]});
 return {status:response.status,success:parsed.success===true,result:parsed.result};
}
try{
 if(typeof token!=='string'||!token)throw new Error('configured_token_absent');
 const pre=await api('unique_name_preflight','GET','/workers/scripts/'+NAME+'/settings');
 if(pre.status!==404)throw new Error('unique_name_not_absent');
 preflightAbsent=true;
 fs.writeFileSync(path.join(root,'registration-owned-preflight.json'),JSON.stringify({worker:NAME,preflightStatus:404,at:new Date().toISOString(),gatePersisted:false},null,2)+'\n',{flag:'wx'});
 const domain=await api('account_workers_domain','GET','/workers/subdomain');
 if(!domain.success||typeof domain.result?.subdomain!=='string'||!/^[a-z0-9-]+$/.test(domain.result.subdomain))throw new Error('account_domain_unavailable');
 const metadata={main_module:'worker.mjs',compatibility_date:'2026-08-28',compatibility_flags:['nodejs_compat'],bindings:[{type:'hyperdrive',name:'HYPERDRIVE',id:'374f6da17aff4c968cadd8d6aa454c22'},{type:'secret_text',name:'REGISTRATION_PROBE_TOKEN',text:gate}],observability:{enabled:false},logpush:false};
 const form=new FormData();
 form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
 form.append('worker.mjs',new Blob([bundle],{type:'application/javascript+module'}),'worker.mjs');
 putAttempted=true;
 const upload=await api('upload_temporary_only','PUT','/workers/scripts/'+NAME,form);
 if(!upload.success)throw new Error('temporary_upload_failed');
 const enable=await api('enable_temporary_workers_dev','POST','/workers/scripts/'+NAME+'/subdomain',{enabled:true,previews_enabled:false});
 if(!enable.success)throw new Error('temporary_endpoint_failed');
 const origin='https://'+NAME+'.'+domain.result.subdomain+'.workers.dev';
 let ready=false;
 for(let i=0;i<8;i++){
  try{
   const response=await fetch(origin+'/__registration_probe_health',{redirect:'error',signal:AbortSignal.timeout(5000)});
   const body=await response.json();
   report.steps.push({label:'health_no_database',attempt:i+1,status:response.status,expected:response.status===404&&body.classification==='not_found'&&body.sqlstate===null});
   ready=response.status===404&&body.classification==='not_found'&&body.sqlstate===null;
  }catch{report.steps.push({label:'health_no_database',attempt:i+1,transport:'failed'});}
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(!ready)throw new Error('temporary_endpoint_not_ready');
 report.metadataRequests=1;
 let response;
 try{response=await fetch(origin+'/registration-metadata',{headers:{'x-registration-probe-token':gate},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('metadata_transport_failed');}
 const body=await response.json();
 const keys=['clientExists','clientDisabled','resourceExists','resourceDisabled','linkExists'];
 if(response.status===200&&Object.keys(body).length===5&&keys.every(k=>typeof body[k]==='boolean')){
  report.metadata={status:response.status,observedAt:new Date().toISOString(),values:Object.fromEntries(keys.map(k=>[k,body[k]]))};
 }else{
  const allowed=['relation_unavailable','read_permission_denied','query_timeout_or_canceled','database_read_failed','probe_unavailable','connection_cleanup_failed'];
  report.metadata={status:response.status,classification:allowed.includes(body.classification)?body.classification:'unexpected_response',sqlstate:typeof body.sqlstate==='string'&&/^[A-Z0-9]{5}$/.test(body.sqlstate)?body.sqlstate:null};
  throw new Error('metadata_read_failed');
 }
}catch(error){
 report.failure=typeof error.message==='string'&&/^[a-z0-9_]+$/.test(error.message)?error.message:'controlled_probe_failed';
}finally{
 if(putAttempted&&preflightAbsent){
  let deleted;
  try{
   deleted=await api('delete_owned_temporary','DELETE','/workers/scripts/'+NAME);
  }catch{report.cleanup={deleteFailure:'controlled_cleanup_failed'};}
  try{
   const verify=await api('verify_owned_script_absent','GET','/workers/scripts/'+NAME+'/settings');
   report.cleanup={...report.cleanup,deleteStatus:deleted?.status??null,deleteSuccess:deleted?.success===true||deleted?.status===404,verifyStatus:verify.status,absent:verify.status===404};
  }catch{report.cleanup={...report.cleanup,absent:false,failure:'controlled_verification_failed'};}
 }else report.cleanup={notCreated:true,absent:preflightAbsent};
 report.finishedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'registration-live-readonly.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));
 if(report.failure||report.metadata?.status!==200||report.cleanup?.absent!==true)process.exitCode=1;
}

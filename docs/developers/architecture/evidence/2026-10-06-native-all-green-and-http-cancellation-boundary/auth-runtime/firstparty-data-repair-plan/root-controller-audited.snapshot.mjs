import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT='7ea8e46d8210bad342fa7595f7935fea';
const NAME='cinatoken-reglink-'+randomBytes(12).toString('hex');
assert.match(NAME,/^cinatoken-reglink-[a-f0-9]{24}$/);
const bundle=fs.readFileSync(path.join(root,'registration-link-repair/registration-link-repair.bundle.mjs'));
assert.equal(createHash('sha256').update(bundle).digest('hex'),'2e8feaf50cad98f1cb775b58ec6d2e7e2b6da527f8560aca015fd7cdaa0d0474');
const report={at:new Date().toISOString(),worker:NAME,account:ACCOUNT,scriptSha256:createHash('sha256').update(bundle).digest('hex'),plan:'Temporary separate gated Worker; one transaction locks enabled existing fixed client/resource, INSERT only their missing association, verify before/after; then DELETE Worker and verify404',productionWorkersChanged:false,routesChanged:false,hyperdriveSettingsChanged:false,databaseDmlOrDdl:true,plannedDml:"Only INSERT fixed client-resource association; no client/resource updates or other client grants",repairRequests:0,gatePersisted:false,steps:[],repair:null,cleanup:null};
let putAttempted=false,preflightAbsent=false;
const token=process.env.CLOUDFLARE_API_TOKEN;
const gate=randomBytes(32).toString('hex');
fs.writeFileSync(path.join(root,'registration-repair-owned-plan.json'),JSON.stringify({...report,created:false,preflight:'pending'},null,2)+'\n',{flag:'wx'});
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
 fs.writeFileSync(path.join(root,'registration-repair-owned-preflight.json'),JSON.stringify({worker:NAME,preflightStatus:404,at:new Date().toISOString(),gatePersisted:false},null,2)+'\n',{flag:'wx'});
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
 report.repairRequests=1;
 let response;
 try{response=await fetch(origin+'/registration-link-repair',{method:'POST',headers:{'x-registration-probe-token':gate},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('metadata_transport_failed');}
 const body=await response.json();
 const keys=['clientExists','clientDisabled','resourceExists','resourceDisabled','linkExists'];
 const boolShape=value=>value&&Object.keys(value).length===5&&keys.every(k=>typeof value[k]==='boolean');
 if(response.status===200&&Object.keys(body).length===3&&boolShape(body.before)&&boolShape(body.after)&&typeof body.insertedClientLink==='boolean'&&body.after.clientExists&&!body.after.clientDisabled&&body.after.resourceExists&&!body.after.resourceDisabled&&body.after.linkExists){
  report.repair={status:response.status,observedAt:new Date().toISOString(),before:body.before,after:body.after,insertedClientLink:body.insertedClientLink};
 }else{
  const allowed=['registration_policy_blocked','registration_link_not_created','relation_unavailable','read_permission_denied','query_timeout_or_canceled','database_read_failed','probe_unavailable','connection_cleanup_failed'];
  report.repair={status:response.status,classification:allowed.includes(body.classification)?body.classification:'unexpected_response',sqlstate:typeof body.sqlstate==='string'&&/^[A-Z0-9]{5}$/.test(body.sqlstate)?body.sqlstate:null};
  throw new Error('repair_failed');
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
 fs.writeFileSync(path.join(root,'registration-live-link-repair.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));
 if(report.failure||report.repair?.status!==200||report.cleanup?.absent!==true)process.exitCode=1;
}

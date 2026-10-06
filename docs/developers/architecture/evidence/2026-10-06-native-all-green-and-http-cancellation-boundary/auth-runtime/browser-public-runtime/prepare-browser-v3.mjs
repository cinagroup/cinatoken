import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));let s=fs.readFileSync(path.join(root,'browser-session-v2.mjs'),'utf8');
s=s.replace("import readline from 'node:readline';\n",'').replace("'browser-v2-observations.ndjson'","'browser-v3-observations.ndjson'");
const old="context.on('response',r=>network.push({method:r.request().method(),url:location(r.url()),status:r.status()}));";
assert(s.includes(old));
s=s.replace(old,`const errors=new Set(['invalid_request','invalid_client','unauthorized_client','unsupported_response_type','invalid_scope','access_denied','server_error','temporarily_unavailable','login_required','interaction_required','account_selection_required','consent_required','invalid_target','invalid_resource']);
context.on('response',r=>{
 const u=new URL(r.url()), auth=/\\/api\\/auth\\/(?:cinaauth\\/(?:login|callback)|oauth2\\/authorize)$/.test(u.pathname), e=u.searchParams.get('error');
 network.push({method:r.request().method(),url:location(r.url()),status:r.status(),...(auth?{hasError:u.searchParams.has('error'),error:e?(errors.has(e)?e:'other'):null,hasCode:u.searchParams.has('code'),hasState:u.searchParams.has('state')}: {})});
});`);
const marker="const input=readline.createInterface";const i=s.indexOf(marker);assert(i>0);
s=s.slice(0,i)+`const requests=path.join(root,'browser-v3-requests.ndjson');fs.writeFileSync(requests,'',{flag:'wx'});let processed=0,n=1,running=true;
emit({event:'command-bridge-ready'});
while(running){
 const lines=fs.readFileSync(requests,'utf8').split(/\\r?\\n/).filter(Boolean);
 for(const line of lines.slice(processed)){
  processed++;
  try{
   const c=JSON.parse(line),p=context.pages()[c.page??0];
   if(c.op==='state'){await state();continue;}
   if(c.op==='click'){
    const l=p.getByRole(c.role??'button',{name:c.name,exact:c.exact??true});if(await l.count()!==1)throw Error('Expected unique observed locator');
    emit({event:'action',operation:'click',role:c.role??'button',name:safe(c.name),page:c.page??0});await l.click({timeout:15000});await state();continue;
   }
   if(c.op==='screenshot'){
    const file=path.join(root,'public-auth-v3-'+(n++)+'.png');await p.screenshot({path:file,fullPage:false});emit({event:'screenshot',file,url:location(p.url()),noCredentialsEnteredByAgent:true});continue;
   }
   if(c.op==='close'){await browser.close();emit({event:'closed'});running=false;break;}
   throw Error('Unsupported operation');
  }catch(e){emit({event:'operation-error',message:safe(e.message)});}
 }
 if(running)await new Promise(resolve=>setTimeout(resolve,100));
}
process.exit(0);
`;
fs.writeFileSync(path.join(root,'browser-session-v3.mjs'),s,{flag:'wx'});


import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),journal=path.join(root,'browser-v4-observations.ndjson');
fs.writeFileSync(journal,'',{flag:'wx'});
const safe=s=>String(s).replace(/([?&#](?:code|token|state|access_token|id_token|key|secret)=)[^&\s]+/gi,'$1[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[account]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]');
const emit=value=>{const s=JSON.stringify({at:new Date().toISOString(),...value});fs.appendFileSync(journal,s+'\n');console.log(s);};
const location=s=>{try{const u=new URL(s);return u.origin+u.pathname;}catch{return '[unavailable]';}};
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false});
const context=await browser.newContext({viewport:{width:1365,height:900}});
const health=[],network=[];
const errors=new Set(['invalid_request','invalid_client','unauthorized_client','unsupported_response_type','invalid_scope','access_denied','server_error','temporarily_unavailable','login_required','interaction_required','account_selection_required','consent_required','invalid_target','invalid_resource']);
context.on('response',r=>{
 const u=new URL(r.url()), auth=/\/api\/auth\/(?:cinaauth\/(?:login|callback)|oauth2\/authorize)$/.test(u.pathname), e=u.searchParams.get('error');
 network.push({method:r.request().method(),url:location(r.url()),status:r.status(),...(auth?{hasError:u.searchParams.has('error'),error:e?(errors.has(e)?e:'other'):null,hasCode:u.searchParams.has('code'),hasState:u.searchParams.has('state')}: {})});
});
context.on('requestfailed',r=>network.push({method:r.method(),url:location(r.url()),failed:safe(r.failure()?.errorText??'unknown')}));
context.on('page',p=>{
 p.on('console',m=>{if(['error','warning'].includes(m.type()))health.push({page:context.pages().indexOf(p),type:m.type(),message:safe(m.text()).slice(0,500)});});
 p.on('pageerror',e=>health.push({page:context.pages().indexOf(p),type:'pageerror',message:safe(e.message).slice(0,500)}));
 p.on('framenavigated',f=>{if(f===p.mainFrame())emit({event:'navigation',page:context.pages().indexOf(p),url:location(p.url())});});
 p.on('close',()=>emit({event:'page-closed',url:location(p.url())}));
});
const page=await context.newPage();
async function state(){
 const pages=[];
 for(const p of context.pages()){
  pages.push({index:context.pages().indexOf(p),url:location(p.url()),title:safe(await p.title().catch(()=>'')),headings:(await p.getByRole('heading').allTextContents().catch(()=>[])).map(safe),buttons:(await p.getByRole('button').allTextContents().catch(()=>[])).map(safe).filter(Boolean).slice(0,50),links:(await p.getByRole('link').allTextContents().catch(()=>[])).map(safe).filter(Boolean).slice(0,35),inputs:await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,name:x.name,placeholder:x.placeholder,autocomplete:x.autocomplete}))).catch(()=>[]),signInFailureVisible:await p.getByText('Sign-in could not be completed. Please try again.',{exact:true}).isVisible().catch(()=>false)});
 }
 emit({event:'state',pages,consoleHealth:health.slice(-20),network:network.slice(-50),credentialsRead:false,sessionExported:false});
}
await page.goto('https://cinatoken.com',{waitUntil:'domcontentloaded',timeout:45000});
emit({event:'ready',browser:'Chrome isolated new context',node:process.version,headless:false,playwright:'1.62.1',flow:'entry -> sign in -> existing dedicated test workspace (pending)'});
await state();
const requests=path.join(root,'browser-v4-requests.ndjson');fs.writeFileSync(requests,'',{flag:'wx'});let processed=0,n=1,running=true;
emit({event:'command-bridge-ready'});
while(running){
 const lines=fs.readFileSync(requests,'utf8').split(/\r?\n/).filter(Boolean);
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
    const file=path.join(root,'public-auth-v4-'+(n++)+'.png');await p.screenshot({path:file,fullPage:false});emit({event:'screenshot',file,url:location(p.url()),noCredentialsEnteredByAgent:true});continue;
   }
   if(c.op==='close'){await browser.close();emit({event:'closed'});running=false;break;}
   throw Error('Unsupported operation');
  }catch(e){emit({event:'operation-error',message:safe(e.message)});}
 }
 if(running)await new Promise(resolve=>setTimeout(resolve,100));
}
process.exit(0);

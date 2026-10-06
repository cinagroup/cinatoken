import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {chromium} from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false});
const context=await browser.newContext({viewport:{width:1365,height:900}});
const page=await context.newPage();
const consoleHealth=[];
const mask=s=>String(s).replace(/([?&#](?:code|token|state|access_token|id_token|key|secret)=)[^&\s]+/gi,'$1[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[account]');
page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleHealth.push({type:m.type(),message:mask(m.text()).slice(0,500)});});
page.on('pageerror',e=>consoleHealth.push({type:'pageerror',message:mask(e.message).slice(0,500)}));
const location=p=>{try{const u=new URL(p.url());return u.origin+u.pathname;}catch{return '[unavailable]';}};
let screenshotSequence=0;
async function state(){
 const pages=[];
 for(const p of context.pages()){
  const headings=await p.getByRole('heading').allTextContents().catch(()=>[]);
  const buttons=await p.getByRole('button').allTextContents().catch(()=>[]);
  const links=await p.getByRole('link').allTextContents().catch(()=>[]);
  const inputs=await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,name:x.name,placeholder:x.placeholder,autocomplete:x.autocomplete}))).catch(()=>[]);
  pages.push({index:context.pages().indexOf(p),url:location(p),title:mask(await p.title().catch(()=>'')),headings:headings.map(mask),buttons:buttons.map(mask).filter(Boolean).slice(0,50),links:links.map(mask).filter(Boolean).slice(0,35),inputs});
 }
 const result={at:new Date().toISOString(),pages,consoleHealth:consoleHealth.slice(-20),credentialsRead:false,persistedSession:false};
 console.log(JSON.stringify(result));
 return result;
}
await page.goto('https://cinatoken.com',{waitUntil:'domcontentloaded',timeout:45000});
console.log(JSON.stringify({ready:true,root,browser:'Chrome isolated new context',fallback:'Browser plugin not available; CUA failed to write kernel assets (os error 3)',flow:'cinatoken.com -> sign in -> existing dedicated test workspace -> key create/revoke (pending)',headed:true,credentialsRead:false}));
await state();
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
 try{
  const c=JSON.parse(line),p=context.pages()[c.page??0];
  if(c.op==='state'){await state();continue;}
  if(c.op==='click'){
   if(!p)throw Error('Unknown page');
   const l=p.getByRole(c.role??'button',{name:c.name,exact:c.exact??true});
   if(await l.count()!==1)throw Error('Expected unique observed locator');
   await l.click({timeout:15000});await state();continue;
  }
  if(c.op==='screenshot'){
   if(!p)throw Error('Unknown page');
   const file=path.join(root,'public-auth-'+(++screenshotSequence)+'.png');
   await p.screenshot({path:file,fullPage:false});
   console.log(JSON.stringify({screenshot:file,url:location(p),credentialsRead:false}));continue;
  }
  if(c.op==='close'){await browser.close();console.log(JSON.stringify({closed:true,at:new Date().toISOString()}));break;}
  throw Error('Unsupported operation');
 }catch(e){console.log(JSON.stringify({operationError:mask(e.message)}));}
}


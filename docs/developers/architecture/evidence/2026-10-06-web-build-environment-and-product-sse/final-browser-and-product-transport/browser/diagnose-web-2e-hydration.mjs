import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const cleanUrl=s=>{try{const u=new URL(s);return u.origin+u.pathname;}catch{return '[unavailable]';}};
const report={startedAt:new Date().toISOString(),browserPlugin:'absent',fallback:'Browser plugin not available',realAuthentication:false,businessWrites:false,requests:[],responses:[],failures:[],console:[],pageErrors:[],snapshots:[],events:[]};
let browser,context,page;
const snapshot=async(step)=>{const value=await page.evaluate(()=>{const root=document.getElementById('root');const selects=[...document.querySelectorAll('select')];return {readyState:document.readyState,classes:[...document.documentElement.classList],hydration:document.documentElement.dataset.cinatokenHydration??null,rootKeys:root?Object.keys(root).filter(k=>k.startsWith('__react')):[],selects:selects.map(el=>({value:el.value,label:el.closest('label')?.innerText,reactKeys:Object.keys(el).filter(k=>k.startsWith('__react')),hasOnChange:Object.keys(el).filter(k=>k.startsWith('__reactProps')).some(k=>typeof el[k]?.onChange==='function')})),scripts:[...document.scripts].map(el=>({src:el.src?new URL(el.src).pathname:null,type:el.type,id:el.id})),tsrPresent:!!window.$_TSR,tsrKeys:window.$_TSR?Object.keys(window.$_TSR):[],bodyLength:document.body.innerText.trim().length,themeCookie:document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('cinatoken-theme='))??null,events:window.__cinatokenReadonlyEvents??[]};});report.snapshots.push({step,at:new Date().toISOString(),...value});return value;};
try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});report.browserVersion=browser.version();
 context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});page=await context.newPage();
 await page.addInitScript(()=>{window.__cinatokenReadonlyEvents=[];for(const name of ['DOMContentLoaded','load','change','cinatoken:public-theme'])window.addEventListener(name,e=>window.__cinatokenReadonlyEvents.push({name,at:performance.now(),target:e.target?.tagName,value:e.target?.tagName==='SELECT'?e.target.value:undefined}),true);});
 page.on('request',r=>report.requests.push({url:cleanUrl(r.url()),method:r.method(),type:r.resourceType(),at:new Date().toISOString()}));
 page.on('response',r=>report.responses.push({url:cleanUrl(r.url()),status:r.status(),type:r.request().resourceType(),at:new Date().toISOString()}));
 page.on('requestfailed',r=>report.failures.push({url:cleanUrl(r.url()),failure:r.failure(),at:new Date().toISOString()}));
 page.on('console',m=>{if(['error','warning'].includes(m.type()))report.console.push({type:m.type(),message:m.text(),url:cleanUrl(m.location().url)});});
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 const response=await page.goto('https://cinatoken.com/en',{waitUntil:'domcontentloaded',timeout:45000});report.status=response.status();report.title=await page.title();
 await snapshot('domcontentloaded');
 for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,500));const state=await snapshot('observe-'+i);if(state.selects.every(x=>x.hasOnChange)&&state.classes.some(x=>x==='light'||x==='dark')){report.readyAt=i;break;}}
 const before=await snapshot('before-theme-action');
 await page.getByRole('combobox',{name:'Appearance',exact:true}).selectOption('dark',{timeout:10000});
 await snapshot('immediate-after-select');
 try{await page.waitForFunction(()=>document.documentElement.classList.contains('dark'),{timeout:8000});report.darkClassConfirmed=true;}catch(e){report.darkClassConfirmed=false;report.darkError=e.message;}
 await snapshot('settled-after-select');
 report.bodyPreview=(await page.locator('body').innerText()).slice(0,800);
 report.screenshot=path.join(directory,'web-2e-hydration-diagnostic.png');await page.screenshot({path:report.screenshot,fullPage:false});
 report.actualExit=report.darkClassConfirmed?0:1;
}catch(e){report.error={name:e.name,message:e.message};report.actualExit=1;}
finally{try{await context?.close();report.contextClosed=true;}catch(e){report.contextClosed=false;report.closeError=e.message;report.actualExit=1;}try{await browser?.close();report.browserClosed=true;}catch(e){report.browserClosed=false;report.browserCloseError=e.message;report.actualExit=1;}report.finishedAt=new Date().toISOString();const file=path.join(directory,'web-2e-hydration-diagnostic.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({report:file,actualExit:report.actualExit,readyAt:report.readyAt,snapshots:report.snapshots.map(x=>({step:x.step,classes:x.classes,hydration:x.hydration,rootKeys:x.rootKeys,selects:x.selects,themeCookie:x.themeCookie})),failures:report.failures,pageErrors:report.pageErrors,darkClassConfirmed:report.darkClassConfirmed,browserClosed:report.browserClosed,contextClosed:report.contextClosed}));}
process.exitCode=report.actualExit;

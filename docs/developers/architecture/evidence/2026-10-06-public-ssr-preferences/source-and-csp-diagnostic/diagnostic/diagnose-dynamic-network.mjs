import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {chromium} from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const dir=path.dirname(fileURLToPath(import.meta.url)),origin='http://127.0.0.1:57478',at=new Date().toISOString()
const save=(name,data)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'})
const report={at,origin,scope:'One owned local early dynamic-chunk locale navigation; record Playwright requests and Chromium Network/Page wire events; explicitly abort obsolete old-document held routes after the real target document commits.',requests:[],responses:[],finished:[],failed:[],networkEvents:[],pageEvents:[],gates:[],violations:[],pageErrors:[],console:[],errors:[]}
const initial=await fetch(origin+'/en',{redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000)})
assert.equal(initial.status,200)
const html=await initial.text(),entries=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match=>new URL(match[1],origin).pathname)
let browser,context,page,release
let opened=false,phase='initial'
const gate=new Promise(resolve=>release=resolve),jobs=new Set()
const capture=promise=>{const job=Promise.resolve(promise).catch(error=>report.errors.push({message:error.message,stack:error.stack}));jobs.add(job);void job.then(()=>jobs.delete(job))}
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
  context=await browser.newContext({viewport:{width:1280,height:900},bypassCSP:false,serviceWorkers:'block'})
  await context.addInitScript(()=>{window.__qaWireCSP=[];window.addEventListener('securitypolicyviolation',event=>window.__qaWireCSP.push({blockedURI:event.blockedURI,sourceFile:event.sourceFile,lineNumber:event.lineNumber,columnNumber:event.columnNumber}))})
  page=await context.newPage()
  const cdp=await context.newCDPSession(page)
  for(const name of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed','Network.loadingFinished'])cdp.on(name,event=>report.networkEvents.push({name,phase,at:new Date().toISOString(),event}))
  for(const name of ['Page.frameNavigated','Page.lifecycleEvent','Page.frameStartedLoading','Page.frameStoppedLoading'])cdp.on(name,event=>report.pageEvents.push({name,phase,at:new Date().toISOString(),event}))
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true})
  page.on('request',request=>report.requests.push({url:request.url(),type:request.resourceType(),phase,at:new Date().toISOString(),document:page.url()}))
  page.on('response',response=>report.responses.push({url:response.url(),status:response.status(),phase,at:new Date().toISOString()}))
  page.on('requestfinished',request=>report.finished.push({url:request.url(),phase,at:new Date().toISOString()}))
  page.on('requestfailed',request=>report.failed.push({url:request.url(),phase,at:new Date().toISOString(),failure:request.failure()}))
  page.on('pageerror',error=>report.pageErrors.push({message:error.message,stack:error.stack}))
  page.on('console',message=>report.console.push({type:message.type(),message:message.text(),location:message.location()}))
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==origin||request.method()!=='GET'||(!/^\/(?:en|zh|ja|ko)(?:\/models)?$/.test(url.pathname)&&!url.pathname.startsWith('/web-assets/')&&url.pathname!=='/api/user/me')){report.errors.push({blocked:url.href});await route.abort();return}
    if(opened||request.resourceType()!=='script'||entries.includes(url.pathname)){await route.continue();return}
    const row={url:url.href,phase,document:page.url(),at:new Date().toISOString(),pending:true}
    report.gates.push(row)
    let done
    const completion=new Promise(resolve=>done=resolve);jobs.add(completion)
    try{
      await gate
      row.releasedAt=new Date().toISOString()
      if(row.document.startsWith(origin+'/ja/')){
        row.action='explicit-abort-obsolete-held-script'
        await route.abort('aborted')
      }else{row.action='continue-target-document-script';await route.continue()}
      row.actionFulfilled=true
    }catch(error){row.routeError=error.message}
    finally{row.pending=false;done();jobs.delete(completion)}
  })
  await page.goto(origin+'/ja/models?q=HTTP+fixture#pricing',{waitUntil:'domcontentloaded',timeout:30000})
  await page.locator('header select[data-cinatoken-public-preference="locale"]').waitFor()
  let started=Date.now()
  while(report.gates.filter(row=>row.document.startsWith(origin+'/ja/')).length<1){assert.ok(Date.now()-started<10000);await new Promise(resolve=>setTimeout(resolve,30))}
  report.beforeNavigation={gateCount:report.gates.length,url:page.url(),csp:await page.evaluate(()=>window.__qaWireCSP)}
  phase='locale-navigation'
  await page.locator('header select[data-cinatoken-public-preference="locale"]').selectOption('ko')
  await page.waitForURL(origin+'/ko/models?q=HTTP+fixture#pricing',{waitUntil:'commit',timeout:30000})
  await page.locator('main h1').waitFor()
  report.afterTargetCommit={url:page.url(),gates:report.gates.length,failedCount:report.failed.length,loadingFailed:report.networkEvents.filter(row=>row.name==='Network.loadingFailed')}
  phase='release-after-target-commit'
  opened=true;release()
  await page.waitForFunction(()=>document.documentElement.dataset.cinatokenPublicHydration==='ready',null,{timeout:15000})
  await new Promise(resolve=>setTimeout(resolve,500))
  report.final={url:page.url(),dom:await page.evaluate(()=>({csp:window.__qaWireCSP,locale:document.documentElement.lang,hydration:document.documentElement.dataset.cinatokenPublicHydration,theme:document.documentElement.className,cookie:document.cookie}))}
  report.intendedExitCode=0
}catch(error){report.intendedExitCode=1;report.failure={message:error.message,stack:error.stack}}
finally{
  opened=true;release()
  await context?.close().then(()=>report.contextClosed=true).catch(error=>report.errors.push({closeContext:error.message}))
  while(jobs.size)await Promise.all([...jobs])
  await browser?.close().then(()=>report.browserClosed=true).catch(error=>report.errors.push({closeBrowser:error.message}))
  report.finishedAt=new Date().toISOString()
  if(report.errors.length||report.contextClosed!==true||report.browserClosed!==true)report.intendedExitCode=1
  save('dynamic-network-report.json',report)
  console.log(JSON.stringify({report:path.join(dir,'dynamic-network-report.json'),intendedExitCode:report.intendedExitCode,gates:report.gates,failed:report.failed,loadingFailed:report.networkEvents.filter(row=>row.name==='Network.loadingFailed'),final:report.final,errors:report.errors,contextClosed:report.contextClosed,browserClosed:report.browserClosed}))
  process.exitCode=report.intendedExitCode
}

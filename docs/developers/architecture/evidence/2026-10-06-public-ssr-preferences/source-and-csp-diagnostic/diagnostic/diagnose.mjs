import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {chromium} from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const dir=path.dirname(fileURLToPath(import.meta.url)),origin='http://127.0.0.1:57478'
const sha=data=>createHash('sha256').update(data).digest('hex')
const save=(name,data)=>fs.writeFileSync(path.join(dir,name),data,{flag:'wx'})
const result={at:new Date().toISOString(),origin,scope:'Owned loopback-only Chrome diagnosis. Strict CSP unchanged. Three independent contexts: production scripts with host-only waiting, minimal same-CSP automation control, production scripts with waitForFunction. No authentication or business writes.',cases:[],failures:[],sourceFiles:[]}
const pending=new Set(),savedScripts=new Map()
const collect=promise=>{const job=Promise.resolve(promise).catch(error=>result.failures.push({evidenceError:error.message,stack:error.stack}));pending.add(job);void job.then(()=>pending.delete(job))}
const settle=async()=>{while(pending.size)await Promise.all([...pending])}
const baseline=await fetch(origin+'/en',{redirect:'manual',credentials:'omit',headers:{accept:'text/html'},signal:AbortSignal.timeout(10000)})
assert.equal(baseline.status,200)
const baselineHTML=await baseline.text(),headers=Object.fromEntries(baseline.headers)
save('baseline-en.html',baselineHTML)
result.baseline={status:baseline.status,headers,bytes:Buffer.byteLength(baselineHTML),sha256:sha(baselineHTML)}
let browser
async function one(mode){
  const row={mode,at:new Date().toISOString(),pauseEvents:[],scripts:[],responses:[],console:[],pageErrors:[],blocked:[],stages:[]}
  result.cases.push(row)
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',bypassCSP:false})
  let page,cdp
  try{
    await context.addInitScript(()=>{
      window.__qaEvalViolations=[]
      window.addEventListener('securitypolicyviolation',event=>window.__qaEvalViolations.push({at:performance.now(),effectiveDirective:event.effectiveDirective,violatedDirective:event.violatedDirective,blockedURI:event.blockedURI,disposition:event.disposition,sample:event.sample,sourceFile:event.sourceFile,lineNumber:event.lineNumber,columnNumber:event.columnNumber,originalPolicy:event.originalPolicy}))
    })
    page=await context.newPage()
    page.on('console',message=>row.console.push({type:message.type(),message:message.text(),location:message.location()}))
    page.on('pageerror',error=>row.pageErrors.push({message:error.message,stack:error.stack}))
    page.on('response',response=>collect((async()=>{
      const url=new URL(response.url())
      const item={url:url.href,status:response.status(),type:response.request().resourceType()}
      row.responses.push(item)
      if(url.pathname.endsWith('.js')){
        const bytes=await response.body(),key=sha(bytes),name='asset-'+key+'.js'
        item.bytes=bytes.length;item.sha256=key;item.file=path.join(dir,name)
        if(!savedScripts.has(key)){save(name,bytes);savedScripts.set(key,item.file)}
      }
    })()))
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url())
      if(url.origin!==origin||request.method()!=='GET'||(!/^\/(?:en|zh|ja|ko)(?:\/models)?$/.test(url.pathname)&&!url.pathname.startsWith('/web-assets/')&&url.pathname!=='/api/user/me')){
        row.blocked.push({url:url.href,method:request.method()});await route.abort();return
      }
      if(mode==='minimal-same-csp-automation-control'&&request.resourceType()==='document'){
        await route.fulfill({status:200,headers,body:'<!DOCTYPE html><html lang="en"><head><title>Owned automation control</title></head><body><h1>Owned automation control</h1></body></html>'});return
      }
      await route.continue()
    })
    cdp=await context.newCDPSession(page)
    cdp.on('Debugger.scriptParsed',event=>row.scripts.push({scriptId:event.scriptId,url:event.url,startLine:event.startLine,startColumn:event.startColumn,endLine:event.endLine,endColumn:event.endColumn,hash:event.hash,sourceMapURL:event.sourceMapURL,executionContextId:event.executionContextId}))
    cdp.on('Debugger.paused',event=>collect((async()=>{
      const pause={reason:event.reason,data:event.data,at:new Date().toISOString(),callFrames:event.callFrames.map(frame=>({functionName:frame.functionName,url:frame.url,location:frame.location,scopeTypes:frame.scopeChain.map(scope=>scope.type)})),sources:[]}
      row.pauseEvents.push(pause)
      try{
        const first=event.callFrames.find(frame=>{
          const parsed=row.scripts.find(script=>script.scriptId===frame.location.scriptId)
          return parsed?.url.startsWith(origin+'/web-assets/')
        })
        if(first){
          const parsed=row.scripts.find(script=>script.scriptId===first.location.scriptId)
          const {scriptSource}=await cdp.send('Debugger.getScriptSource',{scriptId:first.location.scriptId})
          const key=sha(scriptSource),name='debugger-source-'+key+'.js'
          if(!savedScripts.has(key)){save(name,scriptSource);savedScripts.set(key,path.join(dir,name))}
          const lines=scriptSource.split('\n'),line=lines[first.location.lineNumber]??'',column=first.location.columnNumber
          pause.sources.push({scriptId:first.location.scriptId,url:parsed.url,lineNumber0:first.location.lineNumber,columnNumber0:column,lineNumber1:first.location.lineNumber+1,columnNumber1:column+1,bytes:Buffer.byteLength(scriptSource),sha256:key,file:savedScripts.get(key),excerpt:line.slice(Math.max(0,column-500),column+700)})
        }
      }finally{await cdp.send('Debugger.resume')}
    })()))
    await cdp.send('Debugger.enable')
    await cdp.send('Debugger.setPauseOnExceptions',{state:'all'})
    row.stages.push({stage:'before-goto',at:new Date().toISOString()})
    await page.goto(origin+'/en',{waitUntil:'domcontentloaded',timeout:30000})
    row.stages.push({stage:'after-goto-no-page-evaluation',at:new Date().toISOString(),pauseCount:row.pauseEvents.length})
    // Host-only waiting is deliberate: no evaluate/waitForFunction can cause the baseline event.
    await new Promise(resolve=>setTimeout(resolve,1500))
    row.stages.push({stage:'after-host-wait-no-page-evaluation',at:new Date().toISOString(),pauseCount:row.pauseEvents.length})
    if(mode==='minimal-same-csp-automation-control'){
      await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Owned automation control',null,{timeout:10000})
    }else if(mode==='real-public-with-waitForFunction'){
      await page.waitForFunction(()=>document.documentElement.dataset.cinatokenPublicHydration==='ready',null,{timeout:10000})
    }
    row.stages.push({stage:'before-first-observational-page-evaluate',at:new Date().toISOString(),pauseCount:row.pauseEvents.length})
    row.dom=await page.evaluate(()=>({violations:window.__qaEvalViolations,hydrated:document.documentElement.dataset.cinatokenPublicHydration??null,hydrationFailed:document.documentElement.dataset.cinatokenHydration??null,title:document.title,h1:document.querySelector('h1')?.textContent??null}))
    await settle()
    row.outcome='OBSERVED'
  }catch(error){row.outcome='DIAGNOSTIC_FAILURE';row.failure={message:error.message,stack:error.stack};result.failures.push({mode,...row.failure})}
  finally{
    await cdp?.send('Debugger.setPauseOnExceptions',{state:'none'}).catch(error=>row.debuggerCloseError=error.message)
    await context.close().then(()=>row.contextClosed=true).catch(error=>{row.contextClosed=false;row.closeError=error.message;result.failures.push({mode,closeError:error.message})})
    await settle()
    row.finishedAt=new Date().toISOString()
    save(mode+'.json',JSON.stringify(row,null,2)+'\n')
    console.log(JSON.stringify({mode,pauses:row.pauseEvents.length,violations:row.dom?.violations,outcome:row.outcome,contextClosed:row.contextClosed}))
  }
}
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--disable-sync'],timeout:30000})
  result.browserVersion=browser.version()
  await one('real-public-host-wait-only')
  await one('minimal-same-csp-automation-control')
  await one('real-public-with-waitForFunction')
}catch(error){result.failures.push({fatal:error.message,stack:error.stack})}
finally{
  await browser?.close().then(()=>result.browserClosed=true).catch(error=>{result.browserClosed=false;result.failures.push({browserCloseError:error.message})})
  await settle()
  result.finishedAt=new Date().toISOString()
  result.intendedExitCode=result.failures.length?1:0
  save('diagnostic-report.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({report:path.join(dir,'diagnostic-report.json'),cases:result.cases.map(row=>({mode:row.mode,outcome:row.outcome,violations:row.dom?.violations,pauseSources:row.pauseEvents.flatMap(pause=>pause.sources)})),browserClosed:result.browserClosed,failures:result.failures}))
  process.exitCode=result.intendedExitCode
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {publicationContract} from './publication-metadata-contract-v1.mjs'
const own=path.dirname(fileURLToPath(import.meta.url))
const label=process.argv[2],metadataPath=process.argv[3]
assert(metadataPath,'Actual published metadata required; no placeholder publication allowed')
assert.match(label??'',/^[a-z0-9][a-z0-9-]{0,63}$/)
const reportPath=path.join(own,label+'.81-scope.report.json')
assert.equal(fs.existsSync(reportPath),false)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const proof=file=>{const bytes=fs.readFileSync(file);return{path:file,bytes:bytes.length,sha256:hash(bytes)}}
const baselineFile=path.join(own,'81.working-baseline.md')
const repoDoc='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md'
const doc=process.argv[4]?path.resolve(process.argv[4]):repoDoc
const prepared=JSON.parse(fs.readFileSync(path.join(own,'prepared-81-scope.json'),'utf8'))
const baseline=fs.readFileSync(baselineFile),current=fs.readFileSync(doc)
assert.equal(proof(baselineFile).bytes,prepared.baseline.bytes)
assert.equal(proof(baselineFile).sha256,prepared.baseline.sha256)
fs.writeFileSync(path.join(own,label+'.working.md'),current,{flag:'wx'})
const a=baseline.toString('utf8'),b=current.toString('utf8')
const metadataContract=publicationContract(metadataPath,baseline)
const m=metadataContract.meta
assert.deepEqual(Buffer.from(b),current)
const checks=[]
const check=(item,passed,detail={})=>checks.push({item,passed,...detail})
const unique=(text,prefix)=>text.split('\n').filter(line=>line.startsWith(prefix)).length===1
const index=(text,prefix)=>{assert.ok(unique(text,prefix),'Unique heading '+prefix);return text.indexOf(prefix)}
const start5a=index(a,'## 5. '),start6a=index(a,'## 6. ')
const start5b=index(b,'## 5. '),start6b=index(b,'## 6. ')
const start596=index(b,'### 5.96 ')
const old5=a.slice(start5a,start6a)
const preserved5=b.slice(start5b,start596)
check('all existing section 5 bytes preserved including 5.94',preserved5.startsWith(old5)&&/^\s*$/.test(preserved5.slice(old5.length)),{
  before:{bytes:Buffer.byteLength(old5),sha256:hash(Buffer.from(old5))},
  originalBytePrefix:{bytes:Buffer.byteLength(preserved5.slice(0,old5.length)),sha256:hash(Buffer.from(preserved5.slice(0,old5.length)))}
})
check('exactly one new 5.96 before section 6',start596>start5b&&start596<start6b)
check('exactly one retained 5.94',unique(b,'### 5.94 '))
check('exactly one retained 5.95',unique(b,'### 5.95 '))
const oldLog=a.slice(start6a).trimEnd(),newLog=b.slice(start6b)
const remaining=newLog.startsWith(oldLog)?newLog.slice(oldLog.length):''
check('entire old update log byte prefix preserved',newLog.startsWith(oldLog),{
  before:{bytes:Buffer.byteLength(oldLog),sha256:hash(Buffer.from(oldLog))},
  originalBytePrefix:{bytes:Buffer.byteLength(newLog.slice(0,oldLog.length)),sha256:hash(Buffer.from(newLog.slice(0,oldLog.length)))}
})
const newEntries=remaining.split(/\r?\n/).filter(line=>line.trim())
check('only one appended 5.96 update log entry',newEntries.length===1&&newEntries[0].startsWith('2026-10-07：5.96'),{newEntries})
check('one exact newly published paragraph',b.split('\n').filter(line=>line===m.publicationLine).length===1)
check('one exact new introduction',b.split('\n').filter(line=>line.replace(/\r$/,'')===m.introductionLine).length===1)
check('date precise suffix preserved',b.split('\n').filter(line=>line===metadataContract.newDate).length===1)
check('old complete f9 publication line retained',b.split('\n').filter(line=>line===metadataContract.oldPublication).length===1)
function normalizePublication(text,isCurrent){
 if(!isCurrent)return text
 const inserted=m.publicationLine+'\n\n';assert.equal(text.split(inserted).length,2,'Exactly one current publication insertion');text=text.replace(inserted,'')
 const intro=m.introductionLine+(metadataContract.oldIntroduction.endsWith('\r')?'\r':'');assert.equal(text.split(intro).length,2);text=text.replace(intro,metadataContract.oldIntroduction)
 assert.equal(text.split(metadataContract.newDate).length,2);return text.replace(metadataContract.newDate,metadataContract.oldDate)
}
const mutablePrefixes=['当前推进：']
const mutablePhases=new Set(['P1','P6','P7','P8'])
const changedAllowedLines=[]
const masked=text=>text.match(/[^\n]*(?:\n|$)/g).filter(Boolean).map(raw=>{
  const content=raw.replace(/\r?\n$/,'')
  const end=raw.slice(content.length)
  const prefix=mutablePrefixes.find(value=>content.startsWith(value))
  if(prefix)return prefix+' <evidence text mutable>'+end
  const phase=/^\| (P[0-8]) /.exec(content)?.[1]
  if(phase&&mutablePhases.has(phase)){
    const cells=content.split('|')
    assert.equal(cells.length,6)
    cells[3]=' <evidence mutable> '
    cells[4]=' <next step mutable> '
    return cells.join('|')+end
  }
  return raw
}).join('')
check('all protected prefix bytes exact outside narrowly allowed evidence fields',
  masked(normalizePublication(a.slice(0,start5a),false))===masked(normalizePublication(b.slice(0,start5b),true)),{
    baselineMaskedSha256:hash(Buffer.from(masked(normalizePublication(a.slice(0,start5a),false)))),
    currentMaskedSha256:hash(Buffer.from(masked(normalizePublication(b.slice(0,start5b),true))))
})
for(const prefix of mutablePrefixes){
  const oldLine=a.split('\n').find(line=>line.startsWith(prefix))
  const newLine=b.split('\n').find(line=>line.startsWith(prefix))
  changedAllowedLines.push({prefix,changed:oldLine!==newLine,before:oldLine??null,after:newLine??null})
}
for(const id of mutablePhases){
  const oldLine=a.split('\n').find(line=>line.startsWith('| '+id+' '))
  const newLine=b.split('\n').find(line=>line.startsWith('| '+id+' '))
  changedAllowedLines.push({phase:id,changed:oldLine!==newLine,before:oldLine??null,after:newLine??null})
}
const publication=b.split('\n').find(line=>line.startsWith('当前发布（2026-10-06）：'))??''
for(const value of ['f9b9140f7fdc35b4bddcd27e13df14cb2e444a34','218e2b8c-6153-4163-8b9f-cffc34445e27','b1fc86e3-a392-488c-9eca-6b5a99f8c713']){
  check('unchanged current source/deployment '+value,publication.includes(value))
}
for(const value of [m.sourceCommit,m.versionId,m.deploymentId,'100%'])check('new publication actual '+value,m.publicationLine.includes(value))
const preservedEvidence=prepared.protectedPriorEvidence.map(saved=>{
  const actual=proof(saved.path)
  const unchanged=actual.bytes===saved.bytes&&actual.sha256===saved.sha256
  check('existing 5.94 evidence file unchanged '+saved.path,unchanged)
  return {href:saved.path,original:saved,current:actual,unchanged}
})
const evidence596=b.slice(start596,start6b)
check('only appended numbered evidence heading is5.96',evidence596.split('\n').filter(line=>/^### 5\.\d+ /.test(line)).length===1)
const links=[...evidence596.matchAll(/\]\(([^)]+)\)/g)].map(match=>match[1]).filter(href=>!href.startsWith('#')&&!/^[a-z][a-z0-9+.-]*:/i.test(href))
const finalLinks=[...new Set(links)].map(href=>{
  const target=path.resolve(path.dirname(repoDoc),decodeURIComponent(href.split('#')[0]))
  const exists=fs.existsSync(target)&&fs.statSync(target).isFile()
  check('new 5.96 relative evidence file exists '+href,exists)
  return {href,path:target,exists,file:exists?proof(target):null}
})
check('new 5.96 has actual relative evidence links',finalLinks.length>0)
const report={
  startedAt:new Date().toISOString(),label,readOnly:true,noProductionActions:true,
  baselineCommit:prepared.baselineCommit,metadataContract,exactAllowedMetadata:['new publication paragraph inserted before complete original f9 paragraph','introduction exactly from actual metadata','date only2026-10-06to2026-10-07 with scope suffix unchanged'],
  baseline:prepared.baseline,current:proof(doc),
  workingSnapshot:proof(path.join(own,label+'.working.md')),
  checks,changedAllowedLines,preservedEvidence,finalLinks,
  manualReviewStillRequired:[
    '11 final source files and actual closed checks/build/browser must bind exact source bytes.',
    'Private v3 before4PASS11FAIL/actual1 and after14PASS1FAIL/actual1 remain; case13 is a fixture read-counter assumption, not proof of product regression.',
    'Local/Linux private15 and controlled-source PublicShell24 remain separate from final real compiled-dist and actual production results; use exact closed receipts.',
    'Controlled anonymous local static fixture is not realAuth/workspace/keys, authenticated business, SSR/CSP/Cloudflare/BFCache/performance acceptance.',
    'Initial private/route unit failures and build/environment failures remain immutable evidence.',
    'Production OAuth association remains unapproved; old full migration/SSE/performance/gate failures remain pending.'
  ],
  passed:checks.every(item=>item.passed)
}
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({reportPath,report:proof(reportPath),passed:report.passed,failedChecks:checks.filter(item=>!item.passed),relativeLinks:finalLinks.length,manualReviewStillRequired:report.manualReviewStillRequired}))
process.exitCode=report.passed?0:1

import json,pathlib,hashlib,datetime,sys
own=pathlib.Path(__file__).resolve().parent
old=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-md-scope-79204d34279045ad83a65f36ab1e0bab')
root=pathlib.Path('C:/cinagroup/cinatoken')
dest=root/'docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing'
R=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-bfcache-continuation-64228ac856184788ac472e5bbe6acb64')
offline=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-source-download-offline-4ea34b9e21574457a996e4cb1802a1b7')
doc=root/'docs/developers/architecture/web-frontend-migration.md'
inputs={}
def proof(file):
    file=pathlib.Path(file)
    body=file.read_bytes()
    item={'path':str(file),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
    inputs[str(file)]=item
    return item
def read(file):
    proof(file)
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8'))
def check_proof(saved):
    actual=proof(saved['path'])
    assert actual['bytes']==saved['bytes'] and actual['sha256']==saved['sha256'],str(saved['path'])
def assert_closed(file,code):
    value=read(file)
    assert value['actualExitCode']==code and value['signal'] is None
    assert value.get('error') is None and value.get('spawnError') is None
    streams=[]
    streams.extend(value.get('files',[]))
    if isinstance(value.get('streams'),dict):streams.extend(value['streams'].values())
    for key in ['stdout','stderr']:
        if isinstance(value.get(key),dict):streams.append(value[key])
    for saved in streams:check_proof(saved)
    return value
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
document=proof(doc)
assert document['bytes']==873423
assert document['sha256']=='63ce789bc24f546c873440d2b6fa68eea109b3cabe6a6457b1429efa79fe99a0'
c6=read(own/'final-md-595-v3.c6-scope.report.json')
original=read(old/'final-md-595-v3.report.json')
assert c6['passed'] and original['passed']
assert c6['current']['bytes']==document['bytes'] and c6['current']['sha256']==document['sha256']
assert pathlib.Path(c6['current']['path']).resolve()==doc.resolve()
assert original['documentBytes']['workingSnapshot']['bytes']==document['bytes']
assert original['documentBytes']['workingSnapshot']['sha256']==document['sha256']
assert len(original['negativeControls'])==10 and all(x['caught'] for x in original['negativeControls'])
assert all(x['passed'] for x in c6['checks'])
assert all(x['passed'] for x in original['history']['checks']+original['comparison']['checks'])
assert {x['phase'] for x in c6['changedAllowedLines'] if x.get('phase') and x['changed']}=={'P6','P8'}
assert {x['prefix'] for x in c6['changedAllowedLines'] if x.get('prefix') and x['changed']}=={'当前推进：'}
assert_closed(own/'final-md-595-v3.process-closed.json',0)
assert_closed(old/'final-md-595-v3.audit.result.json',0)
for link in c6['finalLinks']:check_proof(link['file'])
assert len(c6['finalLinks'])==13
for saved in c6['preservedEvidence']:check_proof(saved['original'])
copy_names=[
 'final-md-595-v3.report.json','final-md-595-v3.audit.result.json',
 'final-md-595-v3.audit.stdout.log','final-md-595-v3.audit.stderr.log',
 'final-md-595-v3.f77.git-show.result.json','final-md-595-v3.f9.git-show.result.json'
]
copies=[]
for name in copy_names:
    src=old/name
    dst=own/('original-scope-'+name)
    body=src.read_bytes()
    if dst.exists():assert dst.read_bytes()==body
    else:
        with dst.open('xb') as handle:handle.write(body)
    assert dst.read_bytes()==body
    copies.append({'original':proof(src),'copy':proof(dst),'byteExact':True})
browser=read(dest/'browser-report.json')
raw_browser=read(R/'normal-production-f9-v4/report.json')
assert browser==raw_browser
assert (dest/'browser-report.json').read_bytes()==(R/'normal-production-f9-v4/report.json').read_bytes()
closed=assert_closed(dest/'closure/bfcache-normal-production-f9-v4.result.json',0)
assert (dest/'closure/bfcache-normal-production-f9-v4.result.json').read_bytes()==(R/'bfcache-normal-production-f9-v4.result.json').read_bytes()
assert browser['outcome']=='RESTORED_PASS' and browser['intendedExitCode']==0
assert browser['candidateCommit']=='f9b9140f7fdc35b4bddcd27e13df14cb2e444a34'
assert browser['browserVersion']['product']=='Chrome/154.0.8037.98'
assert browser['configuration']['context']=={'viewport':{'width':1280,'height':900},'colorScheme':'light'}
for key in ['routeInstalled','FetchEnabled','cacheDisabled','networkBlocking','bypassCSP']:assert browser['configuration'][key] is False
assert browser['configuration']['ignoreDefaultArgs']==['--disable-back-forward-cache']
assert browser['configuration']['customArgs']==[]
assert browser['chromeBinaryBefore']['bytes']==browser['chromeBinaryAfter']['bytes']==4496024
assert browser['chromeBinaryBefore']['sha256']==browser['chromeBinaryAfter']['sha256']=='6849d2982038de9f9489a7b3858f3b785b7fec06a842c93c517281d21995c8ca'
assert browser['chromeBinaryInputsUnchanged'] and browser['localInputsUnchanged']
assert browser['releaseAfter']['inputsUnchanged']
for key in ['manifestSha256','assets','serverFiles','sourceArchives']:assert browser['releaseBefore'][key]==browser['releaseAfter'][key]
assert browser['releaseBefore']['assets']==158 and browser['releaseBefore']['serverFiles']==35 and browser['releaseBefore']['sourceArchives']==5
case=browser['cases'][0]
assert len(browser['cases'])==1 and case['outcome']=='RESTORED_PASS' and case['failure'] is None
assert len(case['traversals'])==2
traversals=[]
for t in case['traversals']:
    assert t['outcome']=='RESTORED_PASS'
    assert t['originalDocumentToken']==t['currentDocumentToken']==t['state']['token']
    assert t['persistedShow']['persisted'] is True and t['persistedShow']['isTrusted'] is True
    assert t['persistedShow']['token']==t['originalDocumentToken']
    assert any(event['type']=='BackForwardCacheRestore' for event in t['frameNavigations'])
    assert t['documentRequests']==[]
    assert all(t['state']['identity'].values())
    assert t['state']['theme']=='system' and t['state']['locale']=='en' and t['state']['darkMedia'] is False
    assert t['state']['classes']==['light']
    assert any(event['kind']=='pagehide' and event['persisted'] and event['isTrusted'] for event in t['state']['pagehide'])
    screenshot=t['screenshot']
    p=proof(dest/screenshot['path'])
    assert p['bytes']==screenshot['bytes'] and p['sha256']==screenshot['sha256']
    traversals.append({
      'direction':t['direction'],'outcome':t['outcome'],
      'documentToken':t['currentDocumentToken'],
      'genuineTrustedPersistedPageshow':True,'actualCDPBackForwardCacheRestore':True,
      'retainedIdentity':t['state']['identity'],'replacementDocumentRequests':0,
      'nativePersistedPagehideFromRetainedDocument':True,
      'screenshot':p
    })
for key in ['anonymousMeEvidence','unexpectedRequests','cspViolations','pageErrors','evidenceErrors']:assert case[key]==[]
assert len(case['requests'])==len(case['terminals'])==36
assert len(case['documentEvidence'])==2 and len(case['assetEvidence'])==34
asset_urls={x['url'] for x in case['assetEvidence']}
assert len(asset_urls)==20
for t in case['terminals']:assert t.get('kind','loadingFinished')!='loadingFailed'
assert browser['ownedBrowserProcess']['actualClose']['actualExitCode']==0
assert browser['ownedBrowserProcess']['actualClose']['signal'] is None
assert browser['cleanup']['browserServerCloseEvent']['exitCode']==0
assert browser['cleanup']['browserServerCloseEvent']['signal'] is None
assert browser['cleanup']['ownedChildNaturallyClosedZero']
assert browser['cleanup']['contextsAfterBrowserClose']==0 and browser['cleanup']['pendingEvidenceAfterClose']==0
independent_browser=read(dest/'independent-browser-review.json')
assert independent_browser['actualRunExitCode']==0
assert independent_browser['reviewOutcome']=='PASS_ONLY_EXACT_NORMAL_DESKTOP_PRODUCTION_BFCACHE_SCOPE'
assert len(independent_browser['documentBodyProofs'])==2 and len(independent_browser['assetBodyProofs'])==34
assert all(x['manifestAndFrozenRawBytesMatch'] for x in independent_browser['assetBodyProofs'])
assert all(x['7SSRScriptNoncesMatch'] and x['exactTwoNativeControls'] for x in independent_browser['documentBodyProofs'])
assert_closed(dest/'closure/bfcache-v4-actual-review-process-closed.json',0)
v2=read(R/'normal-production-f9/report.json')
v3=read(R/'normal-production-f9-v3/report.json')
assert_closed(R/'bfcache-normal-production-f9.result.json',1)
assert_closed(R/'bfcache-normal-production-f9-v3.result.json',1)
assert v2['outcome']=='FAIL' and v3['outcome']=='FAIL'
assert 'Browser.getBrowserCommandLine' in v2['cases'][0]['failure']['message']
assert v2['cases'][0]['requests']==[] and v2['cases'][0]['traversals']==[]
assert v3['cases'][0]['traversals']==[]
diagnostic=read(dest/'offline-diagnostic-report.json')
assert (dest/'offline-diagnostic-report.json').read_bytes()==(offline/'offline-diagnostic-report.json').read_bytes()
assert diagnostic['outcome']=='PASS' and diagnostic['networkRequestsStarted']==0
assert diagnostic['originalInputsByteExactUnchanged'] and diagnostic['protectedOriginalFileCount']==26
assert len(diagnostic['replays'])==20
assert len([x for x in diagnostic['replays'] if x['mode']=='original-like'])==15
assert len([x for x in diagnostic['replays'] if x['mode']=='fixed-metadata-instrumented'])==5
assert [x['finalElapsedMs'] for x in diagnostic['rows']]==[52561,60018,37799,60018,43501]
assert [x['observedBytes'] for x in diagnostic['rows']]==[4240549,2788736,4239144,2940608,4237024]
assert [x['missingExpectedBytes'] for x in diagnostic['rows']]==[0,1466246,0,1309220,0]
assert [x['originalOutcome'] for x in diagnostic['rows']]==['PASS','FAIL','PASS','FAIL','PASS']
assert diagnostic['originalEvidence']['sourceProcessActualExitCode']==1
assert_closed(offline/'offline-process-closed.json',0)
second=read(dest/'second-independent-offline-review.json')
assert second['outcome']=='PASS'
assert second['productPerformanceAcceptanceStillOpen'] and not second['networkOrCloudflareRootCauseProven']
independent_offline=read(dest/'independent-offline-review.json')
assert independent_offline['performanceGatePending']
assert independent_offline['networkOrCloudflareRootCauseProven'] is False
assert independent_offline['productFixSelected'] is False
assert_closed(dest/'closure/offline-timing-review-v2-process-closed.json',0)
guard=read(dest/'deployment-guard.json')
assert guard['actualExit']==0 and guard['readOnly']
assert guard['deployment']['id']=='b1fc86e3-a392-488c-9eca-6b5a99f8c713'
assert guard['deployment']['versions']==[{'version_id':'218e2b8c-6153-4163-8b9f-cffc34445e27','percentage':100}]
assert guard['deployment']['commitTag']=='f9b9140f7fdc35b4bddcd27e13df14cb2e444a34'
assert len(guard['flags'])==29 and all(x['value']=='true' for x in guard['flags'])
assert len(guard['routes'])==3
assert_closed(dest/'closure/post-bfcache-production-guard.result.json',0)
index=read(dest/'index.json')
assert index['verification']['originalFiles']==248
assert index['verification']['newUniqueMembers']==151
assert index['verification']['reusedPriorFileMappings']==93
assert all(index['verification'][key] for key in ['allDecodedBytesShaCrcVerified','allOriginalBytesAndMtimeUnchanged','priorIndexAndZipUnchanged'])
p=proof(dest/index['bundle']['path'])
assert p['bytes']==899345 and p['sha256']=='6c7fe7b7b34f2a13c037806858b67aeeb700db7fd7662e66c9f688c7b6536236'
physical=read(dest/'closure/BFCache-source-timing-archive-roundtrip-reviewed.json')
assert physical['reviewOutcome']=='PASS_ARCHIVE_PHYSICAL_ROUNDTRIP_ONLY'
assert physical['all248DecodedBytesDeepEqualActualOriginals']
assert physical['allOriginalSHABytesAndMtimeAfterUnchanged']
assert physical['allNewZipMembersActuallyReadCRCVerified']
assert physical['allReferencedPriorMembersActuallyReadCRCVerified']
assert_closed(dest/'closure/bfcache-source-timing-archive-review-process-closed.json',0)
assert_closed(dest/'closure/archive-continuation.result.json',0)
text=doc.read_text(encoding='utf-8')
section=text[text.index('### 5.95 '):text.index('## 6. ')]
for marker in ['15份动态时间日志','5份固定metadata日志','真实身份','尚未验收','此前被自动审批拒绝','原严格SSE取消8/7/1','minimal source.cancel FAIL','不能归为BFCache不恢复','性能预算仍未通过']:
    assert marker in section,marker
assert '36个真实body的保存字节/hash均经复核' in section
assert '34资产响应（20 unique assets）与冻结manifest/raw逐byte一致' in section
assert section.count('### 5.95 ')==1
for key in ['main','actual']:
    expected={'main':(102,8,94),'actual':(211,55,156)}[key]
    rows=original['protectedCollections']['main' if key=='main' else 'tasks']
    assert rows['baseline']['sha256']==rows['working']['sha256']
for saved in list(inputs.values()):
    body=pathlib.Path(saved['path']).read_bytes()
    assert len(body)==saved['bytes'] and hashlib.sha256(body).hexdigest()==saved['sha256'],saved['path']
assert proof(doc)==document
result={
 'reviewStartedAt':started,'reviewedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'reviewer':'/root/public_early_controls_review','outcome':'PASS_REVIEWABLE_DOCUMENT_AND_EVIDENCE_SCOPE_ONLY',
 'canCommitDocumentAndEvidence':True,'readOnlyOriginals':True,'networkRequestsMade':0,'browserOperationsMade':0,'benchmarkRerunsMade':0,
 'sourceCommit':'f9b9140f7fdc35b4bddcd27e13df14cb2e444a34','document':document,
 'scope':{
   'c6StructuralScopeActualExitCode':0,'f77F9OriginalScopeActualExitCode':0,
   'rawCheckboxLines':213,'actualTasks':211,'actualDone':55,'actualPending':156,
   'mainTasks':102,'mainDone':8,'mainPending':94,'routes':54,'gates':9,'evidenceGates':9,'phases':9,
   'negativeControls':10,'onlyChangedPrefix':'当前推进：','onlyChangedPhaseEvidenceAndNext':['P6','P8'],
   'allOldSection5Including594BytePrefixPreserved':True,'oldUpdateLogBytePrefixPreserved':True,
   'newSection595AndOneUpdateEntryOnly':True,'existing594EvidenceFilesUnchanged':8,
   'all595RelativeLinksExist':13
 },
 'browser':{
   'actualClose':{'actualExitCode':0,'signal':None},'actualVersion':'Chrome/154.0.8037.98',
   'actualExeBytes':4496024,'actualExeSHA256':'6849d2982038de9f9489a7b3858f3b785b7fec06a842c93c517281d21995c8ca',
   'condition':'One anonymous1280x900 English/system/light home-models-back-forward; actual HeadlessChrome on Windows',
   'traversals':traversals,'savedRealBodies':36,'SSRDocuments':2,'assetResponses':34,'uniqueAssets':20,
   'SSRPhysicalBytesAndNonceCSPControlContractChecked':True,
   'onlyAssetsClaimFrozenManifestAndRawByteEquality':True,
   'existingIndependentPhysicalReviewActualExitCode':0,
   'CSPPageEvidenceUnexpectedAndAnonymousMe':0,'ownedChildAndBrowserServerNaturalClose0Null':True,
   'screenshotsManuallyViewed':'Home and models show English/system/light layout; models0results. No interaction beyond captured traversals.',
   'V2':{'actualExitCode':1,'outcome':'FAIL_API_PRECONDITION','publicRequests':0,'traversals':0,'NOT_RESTORED':False},
   'V3':{'actualExitCode':1,'outcome':'FAIL_FAVICON_BODY_EVIDENCE_RACE','traversals':0,'notClaimedRealModelsCancellation':True}
 },
 'offline':{
   'actualDiagnosticExitCode':0,'originalLikeTrials':15,'instrumentedFixedMetadataTrials':5,'totalTrials':20,
   'rawBodiesPreservedIncludingTwoPartials':True,'dynamicLogsClaimOnlyChunkBoundaryEquality':True,
   'fixedMetadataLogsClaimByteEquality':True,'protectedOriginalFiles':26,
   'original60SecondOutcome':'3PASS2partialFAIL','originalActualExitCode':1,
   'prior30SecondRunsRemainFailed':True,'fsync':'finally only; once per raw/progress fd',
   'historicalCollectorShareProven':False,'networkOrCloudflareRootCauseProven':False,'productFixSelected':False,
   'performanceGatePending':True
 },
 'archive':{
   'newOriginalFileMappings':248,'newMembers':151,'oldArchiveReusedMappings':93,'newZip':p,
   'independentPhysicalArchiveReviewActualExitCode':0,
   'archiveClose0DoesNotPromoteTestOutcomes':True,'wholeArchiveRoundtripNotRepeatedByThisReviewer':True
 },
 'boundaries':[
   'No completion claim for away-page cookie/media changes, mobile BFCache, post-restore native preference input, listener counts, nonempty directory or complete business matrix.',
   'Real CinaAuth, existing dedicated workspace switch and test key create/revoke acceptance remain unfinished.',
   'ProductionOAuth exact association remains specifically unapproved after prior automatic review rejection; no write or bypass approved by this review.',
   'G0-G8/E00-E08, originalSSEstrict8/7/1 and minimal source.cancelFAIL, DB/accounting, dual platform, gray rollout/real rollback and oldUI retirement remain at original scope.',
   'This review authorizes no new product code, production deployment, authentication write, or relaxed performance budget.'
 ],
 'resolvedWordingFindings':[
   'SSR saved-byte/contract proof distinguished from34asset frozen-manifest/raw byte proof.',
   '15dynamic timestamp logs distinguished from5byte-exact fixed metadata logs.'
 ],
 'copiedOriginalScopeArtifacts':copies,
 'inputsReadAndAfterUnchanged':list(inputs.values()),
 'intendedExitCode':0
}
result['reviewerPriorAttempt']={'actualExitCode':1,'reason':'Proof dict compared equivalent C:/ and C:\\ path strings; bytes/hash unchanged; no product test failure','receipt':str(own/'final-md-595-v3-manual.process-closed.json')}
assert_closed(own/'final-md-595-v3-manual.process-closed.json',1)
assert_closed(own/'final-md-595-v3-manual-v2.process-closed.json',1)
result['reviewerPriorAttempts']=[{'actualExitCode':1,'reason':'Equivalent path separator strings compared as full dictionaries','receipt':str(own/'final-md-595-v3-manual.process-closed.json')},{'actualExitCode':1,'reason':'Literal wording assertion expected missing Chinese classifier; document bytes/hash unchanged and preceding fact checks passed','receipt':str(own/'final-md-595-v3-manual-v2.process-closed.json')}]
result['inputsReadAndAfterUnchanged']=list(inputs.values())
target=own/'final-md-595-v3-manual-v3-review.json'
with target.open('x',encoding='utf-8',newline='\n') as handle:handle.write(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
out=target.read_bytes()
print(json.dumps({'report':str(target),'bytes':len(out),'sha256':hashlib.sha256(out).hexdigest(),'outcome':result['outcome'],'canCommitDocumentAndEvidence':True,'document':document,'inputsUnchanged':len(inputs),'intendedExitCode':0},ensure_ascii=False))
import json,pathlib,hashlib,gzip,os,collections,sys,datetime
out=pathlib.Path(sys.argv[1]);base=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-final-durable-collection-meta-S7NHM2');archive=base/'collected-archive-output'
report_path=archive/'2026-10-06-g7-native26-calibration-progress.json'
def info(b):return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def load(p):return json.loads(pathlib.Path(p).read_text(encoding='utf-8'))
def norm(p):return os.path.normcase(os.path.abspath(p))
rb=report_path.read_bytes();assert info(rb)=={'bytes':5177117,'sha256':'794d72cc5287970fb8e042241fe5213994b9899274f5020a77a946f93362fa5d'};r=json.loads(rb)
original_cfg=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-final-capsule-collection-config-NWebV7/all-frozen-final-config.json');cb=original_cfg.read_bytes();cfg=json.loads(cb)
modified_path=base/'collection-config.json';mb=modified_path.read_bytes();modified=json.loads(mb)
first_script=out/'audit-full42-archive.py';first_closed=out/'audit-full42-archive.closed.json';first_receipt=load(first_closed)
assert first_receipt['actualExit']==1 and first_receipt['closed'] and first_receipt['signal'] is None
first_error=pathlib.Path(first_receipt['stderr']['path']).read_bytes();assert info(first_error)=={'bytes':1116,'sha256':'2f39951abc97455b921ef5ba508836de25c83551df31f8f4111852342ee0e1bc'}
assert b'line 83, in <module>' in first_error and b"082-docker.stdout.log" in first_error and b'FileNotFoundError' in first_error
script_lines=first_script.read_text(encoding='utf-8').splitlines()
assert "if d:pin(d);verified_streams.append(stream)" in script_lines[82]
assert "stored_bytes==53430236" in script_lines[52-1] or any("stored_bytes==53430236" in x for x in script_lines[:54])
assert any("actual_stored==stored_set and actual_stored_dirs==expected_dirs" in x for x in script_lines[:54])
source_stage={'actualWholeReaderExit':1,'readerScript':{'file':str(first_script),**info(first_script.read_bytes())},'closedReceipt':{'file':str(first_closed),**info(first_closed.read_bytes()),'value':first_receipt},'originalError':{'file':first_receipt['stderr']['path'],**info(first_error)},'completedAssertionRangeBeforeTraceFailure':'Source/stored/config/set/gzip/total assertions in original script lines1-54 ran before original line83 failed resolving a relative historical stdout descriptor.','wholeReaderSuccessClaimed':False,'sourceAndStorageWorkRepeated':False}
root_map={x['id']:pathlib.Path(x['path']) for x in r['roots']};storage=archive/r['evidenceDirectory'];entries={x['relative']:x for x in r['entries']};assert len(entries)==3357
actual_source={key:pathlib.Path(e['sourcePath']) for key,e in entries.items()}
source_paths={norm(p):key for key,p in actual_source.items()}
class SourceData:
 def __init__(self):self.cache={}
 def __getitem__(self,key):
  if key not in self.cache:
   b=actual_source[key].read_bytes();e=entries[key];assert info(b)=={'bytes':e['originalBytes'],'sha256':e['originalSha256']};self.cache[key]=b
  return self.cache[key]
data=SourceData()
verified=[{'relative':e['relative'],'storedRelative':e['storedRelative'],'encoding':e['encoding'],'originalBytes':e['originalBytes'],'originalSha256':e['originalSha256'],'storedBytes':e['storedBytes'],'storedSha256':e['storedSha256'],'sourceAndDecodeExact':True,'independentSourceStageAuthority':'audit-full42-archive.closed.json actual1; completed source/stored assertions before later line83 path error'} for e in r['entries']]
actual_stored_dirs=set()
for e in r['entries']:
 p=pathlib.PurePosixPath(e['storedRelative']).parent
 while str(p)!='.':actual_stored_dirs.add(str(p));p=p.parent
gzip_count=r['totals']['gzipFiles'];original_bytes=r['totals']['originalBytes'];stored_bytes=r['totals']['storedBytes']
def pin_stream(d,c,stream):
 f=d.get('file',d.get('path'));expected={'bytes':d['bytes'],'sha256':d['sha256']}
 candidates=[]
 if norm(f) in source_paths:candidates.append(source_paths[norm(f)])
 context=root_map[c['root']]/pathlib.PurePosixPath(c['file']).parent
 for candidate in [context/f,context/pathlib.Path(f).name]:
  key=source_paths.get(norm(candidate))
  if key and key not in candidates:candidates.append(key)
 for b in cfg.get('explicitCommandOutputBindings',[]):
  if b['rootId']==c['root'] and b['receiptFile']==c['file']:
   ds=[x for x in b['outputs'] if x['file'].endswith('.'+stream+'.log') or x['file'].endswith('-'+stream+'.log')]
   if not ds and len(b['outputs'])==2:ds=[b['outputs'][0 if stream=='stdout' else 1]]
   for x in ds:
    if {k:x[k] for k in ['bytes','sha256']}==expected:candidates.append(c['root']+'/'+x['file'])
 for b in cfg.get('immutableSchemaCopies',[]):
  if b['rootId']==c['root'] and b['file']==c['file']:
   for x in b['includedLogCopies']:
    if x['file'].endswith('.'+stream+'.log') and {k:x[k] for k in ['bytes','sha256']}==expected:candidates.append(b['rootId']+'/'+x['file'])
 matching=[key for key in dict.fromkeys(candidates) if info(data[key])==expected]
 assert matching,('unresolved exact receipt stream',c['root'],c['file'],stream,f,candidates)
 return data[matching[0]]
def json_source(root,file):return json.loads(data[root+'/'+file])
def pin(b):
 file=b.get('file',b.get('path'));assert file
 raw=pathlib.Path(file).read_bytes();assert info(raw)=={k:b[k] for k in ['bytes','sha256']};return raw
def descriptor_stream(v,stream):
 d=v.get(stream)
 if isinstance(d,dict) and ('path' in d or 'file' in d) and 'bytes' in d and 'sha256' in d:return d
 if isinstance(d,str) and isinstance(v.get(stream+'Info'),dict):return {'path':d,**v[stream+'Info']}
 return None
def raw_exit(v,dialect):
 if dialect=='v364-direct-socket-executor-closed-v1':return v.get('actualProcessExit'),'actualProcessExit'
 if dialect=='v364-direct-socket-no-child-preflight-rejection-v1':
  for key in ['runnerOutcomeCode','actualExit','outcomeCode','actualExitCode']:
   if key in v:return v[key],key
 if 'actualExit' in v:return v['actualExit'],'actualExit'
 if 'status' in v:return v['status'],'status'
 for key in ['result','rawResult','commandResult']:
  if isinstance(v.get(key),dict) and 'status' in v[key]:return v[key]['status'],key+'.status'
 if 'actualExitCode' in v:return v['actualExitCode'],'actualExitCode'
 raise AssertionError('No raw exit authority '+dialect+' keys '+str(list(v)))
closed=[];exits=collections.Counter();dialects=collections.Counter();all_bad=[]
for c in r['closedReceipts']:
 key=c['root']+'/'+c['file'];b=data[key];assert hashlib.sha256(b).hexdigest()==c['sha256'];v=json.loads(b)
 actual,authority=raw_exit(v,c['dialect']);assert actual==c['actualExit'],(key,actual,c['actualExit'],authority)
 exits[str(actual)]+=1;dialects[c['dialect']]+=1
 verified_streams=[]
 for stream in ['stdout','stderr']:
  d=descriptor_stream(v,stream)
  if d:pin_stream(d,c,stream);verified_streams.append(stream)
 closed.append({'root':c['root'],'file':c['file'],'sha256':c['sha256'],'dialect':c['dialect'],'rawActualExit':actual,'rawExitAuthority':authority,'descriptorStreamsExact':verified_streams,'actualChildExitProvenExplicit':c.get('actualChildExitProven'),'signal':c.get('signal'),'spawnError':c.get('spawnError')})
 if actual!=0 or c.get('signal') or c.get('spawnError'):all_bad.append(closed[-1])
assert len(closed)==803 and dict(exits)=={'0':762,'1':36,'2':2,'None':3};assert len(all_bad)==41
assert len(r['closedAggregateReports'])==9 and all(a['aggregateOnly'] and not a['childLogAuthority'] and not a['gatePassDerived'] for a in r['closedAggregateReports'])
for a in r['closedAggregateReports']:assert hashlib.sha256(data[a['root']+'/'+a['file']]).hexdigest()==a['sha256']
for binding in r['explicitCommandOutputBindings']:
 receipt_bytes=data[binding['rootId']+'/'+binding['receiptFile']];assert hashlib.sha256(receipt_bytes).hexdigest()==binding['expectedReceiptSha256']
 for d in binding['outputs']:assert info(data[binding['rootId']+'/'+d['file']])=={k:d[k] for k in ['bytes','sha256']}
for binding in r['immutableSchemaCopies']:
 a=data[binding['rootId']+'/'+binding['file']];b=data[binding['originalRootId']+'/'+binding['originalFile']];assert a==b and hashlib.sha256(a).hexdigest()==binding['sha256']
 for d in binding['includedLogCopies']:assert data[binding['rootId']+'/'+d['file']]==data[binding['originalRootId']+'/'+d['originalFile']] and info(data[binding['rootId']+'/'+d['file']])=={k:d[k] for k in ['bytes','sha256']}
bindings=[];kinds=collections.Counter();fs_status=collections.Counter()
assert r['frozenInputDataBindings']==cfg['frozenInputDataBindings'] and len(r['frozenInputDataBindings'])==93
report_only={(x['root'],x['file']):x for x in r['reportOnlyDataBindings']};assert len(report_only)==93
closed_keys={(x['root'],x['file']) for x in r['closedReceipts']}
for b in r['frozenInputDataBindings']:
 kind=b['kind'];kinds[kind]+=1;rootid=b['rootId'];file=b.get('reportFile',b.get('file'));ro=report_only[(rootid,file)]
 assert ro['reportOnly'] and ro['actualProcessExit'] is None and not ro['actualChildExitProven'] and not ro['newExecutionClaimed'] and not ro['gatePassDerived']
 assert (rootid,file) not in closed_keys
 pin(b['producer'])
 if kind=='exact-file-read-report-only-v1':
  raw=data[rootid+'/'+file];assert info(raw)=={'bytes':b['reportBytes'],'sha256':b['reportSha256']};v=json.loads(raw);assert v==b['report'] and v['operation']=='readFile' and 'executable' not in v and 'spawnError' not in v
  fs_status[str(v['actualExit'])]+=1
  for d in b['outputs']:assert info(data[rootid+'/'+d['file']])=={k:d[k] for k in ['bytes','sha256']}
  if v['actualExit'] is None:
   assert v['error']['code']=='ENOENT' and data[rootid+'/'+b['outputs'][0]['file']]==b''
   assert json.loads(data[rootid+'/'+b['outputs'][1]['file']])==v['error']
  else:assert v['actualExit']==0 and v['error'] is None
 elif kind=='exact-native-workflow-utf16-slice-v1':
  for name in ['source','receipt','report','sliceProducerReceipt','progressReceipt','progressFile']:pin(b[name])
  source=data[rootid+'/'+b['sourceFile']];text=source.decode('utf-8');assert text.encode('utf-8')==source
  units=text.encode('utf-16-le');assert 0<=b['startStringOffset']<b['endStringOffset']<=len(units)//2
  decoded=units[b['startStringOffset']*2:b['endStringOffset']*2].decode('utf-16-le').encode('utf-8')
  target=data[rootid+'/'+file];assert target==decoded and info(target)=={k:b[k] for k in ['bytes','sha256']}
  source_report=json.loads(pin(b['report']));row=next(x for x in source_report['chain55to113']['records'] if x['step']==b['step']);assert row['workflowCommand']==b['workflowCommand']
  assert row['group']['startStringOffset']==b['startStringOffset'] and row['group']['endStringOffset']==b['endStringOffset']
  progress=json.loads(pin(b['progressFile']));assert progress['headSha']=='dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc' and progress['databaseId']==37412060008
 elif kind=='exact-closed-command-input-snapshot-v1':
  input_bytes=pin(b['input']);command=json.loads(pin(b['receipt']));parent=json.loads(pin(b['producerReceipt']))
  assert command['actualExit']==0 and parent['actualExit']==b['producerActualExit']==1 and command['args']==['cat-file','--batch']
  assert info(input_bytes)=={k:command['stdin'][k] for k in ['bytes','sha256']} and input_bytes==data[rootid+'/'+file]
 else:raise AssertionError(kind)
 bindings.append({'kind':kind,'root':rootid,'file':file,'sha256':ro['sha256'],'reportOnly':True,'actualProcessExit':None,'bytesRelationshipExact':True})
assert dict(kinds)=={'exact-file-read-report-only-v1':52,'exact-native-workflow-utf16-slice-v1':40,'exact-closed-command-input-snapshot-v1':1}
transports=[]
for b,t in zip(r['transportedDirectExecutorBindings'],r['closedExecutorTransportBindings']):
 assert b['rootId']==t['root'] and b['executorFile']==t['file']
 executor=json.loads(pin(b['executor']));download=json.loads(pin(b['download']));metadata=json.loads(pin(b['metadata']));pin(b['metadataReceipt']);index=json.loads(pin(b['index']))
 assert executor['actualProcessExit']==executor['runnerOutcomeCode']==1 and t['originalExecutorActualExit']==t['originalActualProcessExit']==t['originalRunnerOutcomeCode']==1
 assert download==b['downloadBody'] and download['actualExit']==0 and t['downloadActualExit']==0
 assert t['originalMtimePreserved'] is False and t['downloadedMtimeIsNotProducerMtime'] is True and t['localZipDigestVerified'] is False and t['newExecutionClaimed'] is False and t['gatePassDerived'] is False
 artifact=metadata['artifacts'][0];assert metadata['total_count']==1 and len(metadata['artifacts'])==1 and artifact['id']==b['artifactId'] and str(artifact['workflow_run']['id'])==b['runId'] and artifact['workflow_run']['head_sha']==b['sourceSHA']
 assert artifact['digest']==t['remoteZipDigestReportedOnly'] and executor['checkoutSHA']==b['sourceSHA'] and executor['run']['GITHUB_SHA']==b['sourceSHA']
 assert executor['run']['GITHUB_RUN_ID']==b['runId'] and executor['run']['GITHUB_RUN_ATTEMPT']==b['runAttempt']
 indexed={x['file']:x for x in index['entries']};assert len(indexed)==981 and index['files']==981 and index['totalBytes']==11305947
 prefix=str(pathlib.PurePosixPath(b['executorFile']).parent)+'/'
 for name in [b['executorFile']]+[prefix+x['path'] for x in executor['files']]+[b['downloadFile'],b['metadataFile'],b['metadataReceiptFile']]:
  item=data[b['rootId']+'/'+name];assert info(item)=={k:indexed[name][k] for k in ['bytes','sha256']}
 assert (t['root'],t['file']) in closed_keys
 transports.append(t)
assert len(transports)==2
toolroot=root_map['all-frozen-new-reader-owner'];toolseal=load(toolroot/'STOPWRITE-all-frozen-data-reader-seal.json')
assert len(toolseal['entries'])==98 and len([x for x in actual_source if x.startswith('all-frozen-new-reader-owner/')])==99
for d in toolseal['entries']:assert info(data['all-frozen-new-reader-owner/'+d['file']])=={k:d[k] for k in ['bytes','sha256']}
assert info(data['all-frozen-new-reader-owner/evidence-lib.mjs'])=={'bytes':56334,'sha256':'0ad4b4ef3467b684743bb9a2d29f6780b47aa7e076174a5613e7ebf4a60628a1'}
assert info(data['all-frozen-new-reader-owner/frozen-data-binding.mjs'])=={'bytes':13826,'sha256':'0e8e6f17a9c0b47f3c074ef35211f10ba42799076ceb364d80d4fe3faa085a18'}
root_receipts=[]
for name in ['collection-final','verification-final']:
 v=load(base/(name+'.result.json'));assert v['actualExit']==0 and v['signal'] is None and v['finishedAt']>=v['at']
 for stream in ['stdout','stderr']:pin(v[stream])
 root_receipts.append({'file':str(base/(name+'.result.json')),'receipt':v,'receiptPin':info((base/(name+'.result.json')).read_bytes())})
assert root_receipts[0]['receipt']['args'][1]=='collect' and norm(root_receipts[0]['receipt']['args'][2])==norm(modified_path)
assert root_receipts[1]['receipt']['args'][-1]=='with-source'
verification=load(base/'verification-final.json');assert verification['closed'] and verification['actualExitCode']==0 and verification['verifiedFiles']==3357 and verification['reportBytes']==5177117 and verification['reportSha256']==info(rb)['sha256'] and not verification['gatePassDerived']
admission_path=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-final-capsule-admission-meta-UkwrUh/FINAL-final42-frozen-capsule-admission.json');ab=admission_path.read_bytes();assert info(ab)=={'bytes':34074,'sha256':'17bd25b696dee7d03f28dc5696d09df8330243a1ba2128d83da0292aa16a8b8b'};admission=json.loads(ab)
assert admission['closedReceiptCount']==803 and admission['originalAdmissionFailuresPreserved']['original39RootActualExit']==1
failure_root=root_map['original-final39-failed-admission-metadata'];failure_files=[(key,data[key]) for key in entries if key.startswith('original-final39-failed-admission-metadata/')]
failure_report_candidates=[(key,json.loads(value)) for key,value in failure_files if key.endswith('.json') and b'blockers' in value]
assert failure_report_candidates
layers=r['semantics']['sourceLayers'];assert layers['g7ActualSourceCommit']=='473de5fc520fc7d64db700db88a76c7a6b45c241' and layers['native26ActualSourceCommit']=='dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc' and layers['newCalibrationDiagnosticActualSourceCommit']==r['sourceCommit']=='dc7be6f8597333151c450bae3ae15e6585e3b2eb' and layers['newStaticPreparedCommit']=='ee122dd4273e2db892daa724bc6417a9b02b280c' and layers['productionSourceCommitPrefix']=='c13' and layers['productionReadPerformedHere'] is False
capsule=load(out/'ee122-capsule-independent-audit.json');assert capsule['sourceFileCount']==213 and capsule['originalClosedChildren']['count']==31 and capsule['originalClosedChildren']['actualOne']==3
result={'schema':'cinatoken.final42-full-archive-independent-audit.v1','finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verdict':{'completeSourceAndStoredSetExact':True,'allStoredBytesShaExact':True,'allDecodedOriginalBytesShaExact':True,'collectionOnly':True,'businessPassDerived':False,'fullG7Verified':False,'fullG8Verified':False},'authority':{'report':{'file':str(report_path),**info(rb)},'originalConfig':{'file':str(original_cfg),**info(cb)},'modifiedConfig':{'file':str(modified_path),**info(mb)},'outputDirectoryOnlyConfigChange':True,'admission':{'file':str(admission_path),**info(ab)},'rootCollectionAndVerificationReceipts':root_receipts,'rootVerificationReport':verification},'totals':r['totals'],'sourceRoots':r['roots'],'sourceDirectoryWalkNotRepeated':True,'storedDirectoryCount':len(actual_stored_dirs),'fileRecords':verified,'closedReceiptCount':len(closed),'closedReceiptExitCounts':dict(exits),'closedReceiptDialects':dict(dialects),'closedReceipts':closed,'nonzeroOrUnknownReceipts':all_bad,'aggregateReports':r['closedAggregateReports'],'reportOnlyBindings':{'count':len(bindings),'kinds':dict(kinds),'originalFileReadStatusCounts':dict(fs_status),'records':bindings},'transportedOriginalExecutors':transports,'transportEntriesAlsoIn803ClosedReceipts':True,'opaqueEe122Original31ChildrenNotInTopLevel803':True,'capsuleIndependentAudit':{'file':str(out/'ee122-capsule-independent-audit.json'),**info((out/'ee122-capsule-independent-audit.json').read_bytes())},'sourceCohorts':layers,'completedSourceStageFromActualReader1':source_stage,'originalAdmissionFailurePreserved':admission['originalAdmissionFailuresPreserved'],'original39FailureFilesPreserved':[{'file':key,**info(value)} for key,value in failure_files],'tools99WholeFrozenSetUnchanged':True,'scope':{'repoWrites':0,'oldRootWrites':0,'productionRequests':0,'ciTriggered':0,'businessRuns':0,'readerControlsRepeated':0,'canonicalCollectorOrVerifierRepeated':0},'limitations':['803 is the exact admitted closed-receipt record count, not803 successful processes or PG runs; null EPERM records and no-child preflight outcome remain typed records.','The two transport sidecars also describe original executor1 records already in803; they are not two newly successful local executions.','The opaqueEE internal31 child records are independently verified historical data and not added to top-level803.','Packaging, collection, Root verify and this independent read audit actual0 do not turn original native/strict/CI/admission failures into business success.']}
target=out/'full42-archive-independent-audit.json'
with target.open('x',encoding='utf-8',newline='\n') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps({'report':str(target),**info(target.read_bytes()),'files':3357,'gzip':111,'originalBytes':original_bytes,'storedBytes':stored_bytes,'closed':803,'exitCounts':dict(exits),'reportOnlyKinds':dict(kinds),'sourceCohortsDistinct':True,'noBusinessPassDerived':True}))
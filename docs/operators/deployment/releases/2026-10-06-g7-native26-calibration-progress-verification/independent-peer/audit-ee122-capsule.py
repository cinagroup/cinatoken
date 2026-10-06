import json,os,pathlib,hashlib,zlib,zipfile,sys,datetime
out=pathlib.Path(sys.argv[1])
root=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7')
def info(b):return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def load(p):return json.loads(pathlib.Path(p).read_text(encoding='utf-8'))
def verify_pin(pin):
 b=pathlib.Path(pin['path']).read_bytes()
 assert info(b)=={k:pin[k] for k in ['bytes','sha256']},pin['path']
 return b
final_bytes=(root/'FINAL-ee122-opaque-capsule.json').read_bytes()
assert info(final_bytes)=={'bytes':6188,'sha256':'5d471ca014ff1a301a5c55c538cf260a52e4f485a7d4817bf7408e8f4f4586eb'}
final=json.loads(final_bytes)
seal_bytes=(root/'CAPSULE-SEAL.json').read_bytes()
assert info(seal_bytes)=={'bytes':4550,'sha256':'54dea9189d5230559c465232491ff73ff0a8081f181bf5777f9c7507e88eae2c'}
seal=json.loads(seal_bytes)
actual_capsule_set={p.name for p in root.iterdir()}
assert actual_capsule_set=={e['relative'] for e in seal['entries']}|{seal['selfExcluded']}
assert len(seal['entries'])==14
for e in seal['entries']:verify_pin(e)
for key in ['ZIP','sourceIndexBefore','sourceIndexAfter','zipMemberProof','packagingTrueClosedReceipt']:
 verify_pin(final[key])
for pin in final['packagingTools']:verify_pin(pin)
before=load(final['sourceIndexBefore']['path']);after=load(final['sourceIndexAfter']['path']);proof=load(final['zipMemberProof']['path'])
assert {k:v for k,v in before.items() if k!='at'}=={k:v for k,v in after.items() if k!='at'}
src=pathlib.Path(final['sourceRoot'])
def identity(p):
 s=os.stat(p,follow_symlinks=False)
 return {'device':s.st_dev,'inode':s.st_ino,'mode':s.st_mode,'bytes':s.st_size,'mtimeNs':s.st_mtime_ns,'attributes':getattr(s,'st_file_attributes',0)}
assert identity(src)==before['sourceRootIdentity']
actual_files={};actual_dirs={}
for parent,dirs,files in os.walk(src,followlinks=False):
 for name in dirs:
  p=pathlib.Path(parent)/name
  assert not p.is_symlink()
  actual_dirs[p.relative_to(src).as_posix()]=identity(p)
 for name in files:
  p=pathlib.Path(parent)/name
  assert p.is_file() and not p.is_symlink()
  rel=p.relative_to(src).as_posix();b=p.read_bytes()
  actual_files[rel]={'identity':identity(p),**info(b),'crc32':format(zlib.crc32(b)&0xffffffff,'08x')}
assert actual_files==before['files']
assert actual_dirs==before['directories']
assert len(actual_files)==213 and len(actual_dirs)==0
assert sum(x['bytes'] for x in actual_files.values())==12098565
zip_path=pathlib.Path(final['ZIP']['path'])
assert info(zip_path.read_bytes())=={'bytes':1754533,'sha256':'ad81f711b44102fde593087f8592dd4081c53058309df910586ee2a7af86f03a'}
members=[]
with zipfile.ZipFile(zip_path,'r') as z:
 zi=z.infolist();names=[x.filename for x in zi]
 assert len(zi)==213 and len(set(names))==213
 assert set(names)==set(actual_files)
 declared={x['name']:x for x in proof['members']}
 assert set(declared)==set(names)
 for item in zi:
  assert not item.is_dir()
  decoded=z.read(item);original=(src/item.filename).read_bytes()
  assert decoded==original,item.filename
  sha=info(decoded);crc=format(zlib.crc32(decoded)&0xffffffff,'08x')
  assert sha=={k:actual_files[item.filename][k] for k in ['bytes','sha256']}
  assert crc==actual_files[item.filename]['crc32']==format(item.CRC,'08x')
  assert item.file_size==len(decoded)
  claim=declared[item.filename]
  assert sha=={k:claim[k] for k in ['bytes','sha256']}
  assert crc==claim['crc32'] and item.compress_size==claim['compressedBytes'] and claim['sourceMtimeNs']==actual_files[item.filename]['identity']['mtimeNs'] and claim['exact']
  members.append({'name':item.filename,**sha,'crc32':crc,'compressedBytes':item.compress_size,'zipLocalHeaderOffset':item.header_offset,'sourceIdentity':actual_files[item.filename]['identity'],'decodedBytesExact':True})
 assert z.testzip() is None
for pin in final['originalFinalAndSealPins']:
 assert info((src/pin['relative']).read_bytes())=={k:pin[k] for k in ['bytes','sha256']}
original_receipts=[]
for rel in sorted(actual_files):
 if not rel.endswith('.closed.json'):continue
 r=load(src/rel)
 assert r['closed'] and r['closedAt']>=r['startedAt'] and r['signal'] is None and r['spawnError'] is None and r['actualExit'] in [0,1]
 for key in ['stdout','stderr']:
  pin=r[key];expected=pathlib.Path(pin['path'])
  assert expected.parent==src
  verify_pin(pin)
 if r.get('stdin'):verify_pin(r['stdin'])
 original_receipts.append({'relative':rel,'actualExit':r['actualExit'],'executable':r['executable'],'startedAt':r['startedAt'],'closedAt':r['closedAt'],'receiptBytesSha':info((src/rel).read_bytes()),'rawExact':True})
assert len(original_receipts)==31
assert sum(x['actualExit']==0 for x in original_receipts)==28
assert sum(x['actualExit']==1 for x in original_receipts)==3
packaging=[]
for name in ['package.result.json','finalize.result.json']:
 r=load(root/name);assert r['closed'] and r['actualExit']==0 and r['signal'] is None and r['spawnError'] is None and not r['timedOut']
 for key in ['stdout','stderr']:verify_pin(r[key])
 packaging.append({'file':str(root/name),'receipt':r,'receiptBytesSha':info((root/name).read_bytes())})
original_final=load(src/'FINAL-ee122-native-tail-terminal-independent-peer.json')
assert original_final['sourceHead']=='ee122dd4273e2db892daa724bc6417a9b02b280c'
assert original_final['verdict']['fullProxyPass'] is False
assert original_final['firstFailureFact']['rawExitCodes']==[1] and original_final['firstFailureFact']['step']==24
assert original_final['chain55to113']['counts']['skipped']==59 and original_final['preparedTargets26']['counts']['skipped']==26
assert original_final['dispatch']['tap']=={'tests':8,'pass':7,'fail':1,'cancelled':0,'skipped':0,'todo':0}
assert final['collectionOnly'] and not final['fullG7G8Pass'] and not final['gatePassDerived'] and not final['nativeExitZeroDerived']
assert final['originalFactsFromRoot']['originalTrueChildren']==31
report={'schema':'cinatoken.final42-peer.ee122-opaque-capsule-audit.v1','finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'capsuleRoot':str(root),'capsuleFinal':info(final_bytes),'capsuleSeal':info(seal_bytes),'zip':{'file':str(zip_path),**info(zip_path.read_bytes())},'capsuleCompleteFileSetCount':len(actual_capsule_set),'sourceFileCount':len(actual_files),'sourceDirectoryCount':len(actual_dirs),'sourceOriginalTotalBytes':sum(x['bytes'] for x in actual_files.values()),'sourceBeforeAfterAndCurrentBytesShaMtimeIdentityExact':True,'sourceRootIdentity':before['sourceRootIdentity'],'unsafeIntegerIdentityDecimalStrings':{k:str(v) for k,v in before['sourceRootIdentity'].items() if isinstance(v,int) and abs(v)>9007199254740991},'zipMemberSetBytesShaCrcCompleteExact':True,'members':members,'originalClosedChildren':{'count':len(original_receipts),'actualZero':sum(x['actualExit']==0 for x in original_receipts),'actualOne':sum(x['actualExit']==1 for x in original_receipts),'records':original_receipts},'packagingReceipts':packaging,'originalBusinessFacts':{'sourceHead':original_final['sourceHead'],'proxyConclusion':original_final['workflows'][0]['run']['conclusion'],'nativeStep24OriginalExit':1,'native55to113Skipped':59,'prepared26Skipped':26,'strictTap':original_final['dispatch']['tap'],'collectionOnly':True,'fullG7G8Pass':False},'setupToolFailureAvailableOnlyAsProducerStatement':final['setupToolReaderFailure'],'scope':{'sourceWrites':0,'repoWrites':0,'ciRuns':0,'appRuns':0,'dbRuns':0,'originalReaderControlsRepeated':0},'interpretation':'Packaging actual0 preserves original31 child28zero/3one as independently audited raw facts; it does not derive their results or native/strict/fullG7G8 pass.'}
report_path=out/'ee122-capsule-independent-audit.json'
with report_path.open('x',encoding='utf-8',newline='\n') as f:json.dump(report,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps({'report':str(report_path),**info(report_path.read_bytes()),'sourceFiles':213,'members':213,'totalBytes':12098565,'originalChildren':31,'zero':28,'one':3,'capsuleSet':len(actual_capsule_set),'businessProxyPass':False},ensure_ascii=False))
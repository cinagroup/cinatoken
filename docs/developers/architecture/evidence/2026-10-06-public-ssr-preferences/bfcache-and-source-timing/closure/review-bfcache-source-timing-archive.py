import pathlib,json,hashlib,zipfile,binascii,datetime,re
F=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-fixture-c60a7fdf3ecc40f49e04ef65e7956771')
D=pathlib.Path('C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing')
inputs={}; originals={}
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):
 p=pathlib.Path(p);b=p.read_bytes();inputs[str(p)]={'path':str(p),'bytes':len(b),'sha256':sha(b),'mtimeNs':p.stat().st_mtime_ns};return b
def same(p,n,h):
 b=read(p);assert len(b)==n and sha(b)==h,(str(p),len(b),sha(b));return b
def js(p):return json.loads(read(p))
index_raw=same(D/'index.json',135789,'c42b64f6505968cc09832b691928327110b1020b86c1710edf1042dffe7e2219')
index=json.loads(index_raw);assert index['sourceCommit']=='f9b9140f7fdc35b4bddcd27e13df14cb2e444a34'
new_raw=same(D/'raw-evidence.zip',899345,'6c7fe7b7b34f2a13c037806858b67aeeb700db7fd7662e66c9f688c7b6536236')
old_index_raw=same(D/'../production-f9/index.json',805993,'b8649463f6bb12e1083d3cb80ac8bac83a5bc2de2208bae04a5145d25f920988')
old_raw=same(D/'../production-f9/raw-evidence.zip',35638466,'9262b469b0f1160a27d00f3e352f2a023b5804e0a29a39aba0d60cdf06b16e6f')
old_index=json.loads(old_index_raw)
assert len(index['files'])==248 and len({x['path'] for x in index['files']})==248
assert index['priorArchive']['sha256']==sha(old_raw) and index['priorArchive']['indexSha256']==sha(old_index_raw)
assert index['bundle']['bytes']==len(new_raw) and index['bundle']['sha256']==sha(new_raw)
new_mappings=[x for x in index['files']if x['archive']=='raw-evidence.zip']
old_mappings=[x for x in index['files']if x['archive']=='../production-f9/raw-evidence.zip']
assert len(new_mappings)==155 and len(old_mappings)==93
assert len({x['member']for x in new_mappings})==151 and len({x['member']for x in old_mappings})==33
old_known={x['sha256']:x['member']for x in old_index['files']}
for x in index['files']:
 assert x['member']=='sha256/'+x['sha256'] and re.fullmatch('[0-9a-f]{64}',x['sha256'])
 assert x['archive'] in ['raw-evidence.zip','../production-f9/raw-evidence.zip']
 assert x['path'] and not x['path'].startswith('/') and '..' not in pathlib.PurePosixPath(x['path']).parts
 if x in old_mappings:assert old_known[x['sha256']]==x['member']
 else:assert x['sha256'] not in old_known

new_member_proofs=[];old_member_proofs=[];mapping_proofs=[];decoded={}
def member(z,archive,name):
 key=(archive,name)
 if key not in decoded:
  info=z.getinfo(name);raw=z.read(name)
  assert info.file_size==len(raw) and sha(raw)==name.split('/')[1]
  assert (binascii.crc32(raw)&0xffffffff)==info.CRC
  decoded[key]=raw
  proof={'archive':archive,'member':name,'bytes':len(raw),'sha256':sha(raw),'CRC32':f'{info.CRC:08x}','actualReadCRCVerified':True}
  (new_member_proofs if archive=='raw-evidence.zip' else old_member_proofs).append(proof)
 return decoded[key]
with zipfile.ZipFile(D/'raw-evidence.zip') as new,zipfile.ZipFile(D/'../production-f9/raw-evidence.zip') as old:
 assert len(new.infolist())==151 and len(new.namelist())==len(set(new.namelist()))
 assert set(new.namelist())=={x['member']for x in new_mappings}
 for name in new.namelist():member(new,'raw-evidence.zip',name)
 for x in index['files']:
  z=new if x['archive']=='raw-evidence.zip' else old
  actual=member(z,x['archive'],x['member']);original=read(x['original'])
  assert actual==original and len(actual)==x['bytes'] and sha(actual)==x['sha256']
  p=pathlib.Path(x['original']);assert p.stat().st_mtime_ns==x['mtimeNs']
  originals[str(p)]=original
  mapping_proofs.append(x|{'decodedBytesEqualActualOriginal':True,'recordedShaLengthMatch':True,'recordedMtimeUnchanged':True})

 closure=js(D/'closure/archive-continuation.result.json')
 assert closure['actualExitCode']==0 and closure['signal'] is None and closure['spawnError'] is None
 for stream in ['stdout','stderr']:same(closure[stream]['path'],closure[stream]['bytes'],closure[stream]['sha256'])
 source_args=closure['args'][1:];expected_mapping=[]
 cutoff_ns=int(datetime.datetime.fromisoformat(index['at']).timestamp()*1000000000)
 for arg in source_args:
  alias,value=arg.split('=',1);p=pathlib.Path(value).resolve()
  assert str(p).lower().startswith('c:\\users\\cina\\appdata\\local\\temp\\')
  files=sorted(f for f in p.rglob('*')if f.is_file() and f.stat().st_mtime_ns<=cutoff_ns)if p.is_dir()else[p]
  for f in files:expected_mapping.append((alias+'/'+(f.relative_to(p).as_posix()if p.is_dir()else f.name),str(f)))
 assert set(expected_mapping)=={(x['path'],x['original'])for x in index['files']}
 assert len(expected_mapping)==248
 plain=js(D/'closure/plain-copy-receipt.json');assert len(plain)==18
 assert len({x['path']for x in plain})==18
 plain_proofs=[]
 for x in plain:
  destination=D/x['path'];copied=same(destination,x['bytes'],x['sha256']);original=same(x['source'],x['bytes'],x['sha256'])
  assert copied==original
  plain_proofs.append(x|{'actualPlainCopiedBytesEqualOriginal':True})
 # Deserialize the same archived negative bytes, never substitute a derived success code.
 bypath={x['path']:x for x in index['files']}
 def archived(logical):
  x=bypath[logical];z=new if x['archive']=='raw-evidence.zip' else old
  return json.loads(member(z,x['archive'],x['member']))
 negatives=[]
 for directory,receipt_name in [('browser-v2','bfcache-normal-production-f9.result.json'),('browser-v3','bfcache-normal-production-f9-v3.result.json')]:
  report=archived(directory+'/report.json');receipt=archived('root-closed/'+receipt_name)
  assert report['outcome']=='FAIL' and receipt['actualExitCode']==1 and receipt['signal']is None and receipt['spawnError']is None
  assert report['cases'][0]['traversals']==[]
  negatives.append({'scope':directory,'actualExitCode':1,'outcome':'FAIL','historyTraversals':0,'originalReportHash':bypath[directory+'/report.json']['sha256'],'actualCloseHash':bypath['root-closed/'+receipt_name]['sha256']})
 v3=archived('browser-v3/report.json')
 assert v3['cleanup']['requestsWithoutObservedTerminal'] and v3['cleanup']['requestsWithoutObservedTerminal'][0]['sequence']==16
 assert len(v3['cases'][0]['evidenceErrors'])==1
 v4=js(D/'browser-report.json');assert v4['outcome']=='RESTORED_PASS' and v4['intendedExitCode']==0
 assert [x['outcome']for x in v4['cases'][0]['traversals']]==['RESTORED_PASS','RESTORED_PASS']
 v4_close=js(D/'closure/bfcache-normal-production-f9-v4.result.json');assert v4_close['actualExitCode']==0 and v4_close['signal']is None
 review=js(D/'independent-browser-review.json')
 assert review['reviewOutcome']=='PASS_ONLY_EXACT_NORMAL_DESKTOP_PRODUCTION_BFCACHE_SCOPE' and review['performanceGatePending']is True
 offline=js(D/'independent-offline-review.json')
 assert sha(read(D/'independent-offline-review.json'))=='f1766883c136cc481cf2dab0fd260b995a9d3adcc5aee5c2f80852bec26eb945'
 trials=[x for x in index['files']if x['path'].startswith('offline/')and x['path'].endswith('.raw-body.bin')]
 assert len(trials)==20 and all(x['archive']=='../production-f9/raw-evidence.zip'for x in trials)
 assert len({x['member']for x in trials})==5
 counts={h:sum(x['sha256']==h for x in trials)for h in {x['sha256']for x in trials}};assert set(counts.values())=={4}
 # Prior performance negatives are separately retained in the pinned prior archive.
 original_performance=[]
 prior_paths={x['path']:x for x in old_index['files']}
 for logical in ['root/live-http-production-f9-network/http/report.json','root/live-http-production-f9-v2/http/report.json','root/source-download-production-f9/report.json','root/source-download-production-f9/process-closed.json']:
  x=prior_paths[logical];raw=old.read(x['member']);assert sha(raw)==x['sha256'] and len(raw)==x['bytes']
  value=json.loads(raw)
  original_performance.append({'path':logical,'bytes':len(raw),'sha256':sha(raw),'actualExitCode':value.get('actualExitCode'),'outcome':value.get('outcome'),'summary':value.get('summary')})
 assert original_performance[-1]['actualExitCode']==1
 # These extra prior negative reads do not expand the reused-member count.

derived=js(D/'closure/archive-verification.json')
assert derived['intendedExitCode']==0 and derived['indexSha256']==sha(index_raw)
assert derived['originalFiles']==248 and derived['newUniqueMembers']==151 and derived['reusedPriorFileMappings']==93
readme=read(D/'README.md').decode('utf-8')
for fragment in ['30 秒 HTTP 167/177','175/177 actual1','60 秒源码 3/5 actual1','监听器数量','真实登录/已有专用工作区/密钥','离页 cookie/系统媒体变化','移动 BFCache']:
 assert fragment in readme,fragment
for p,original in originals.items():
 current=pathlib.Path(p).read_bytes();assert current==original and pathlib.Path(p).stat().st_mtime_ns==inputs[p]['mtimeNs'],p
all_inputs=list(inputs.values())
for item in all_inputs:
 p=pathlib.Path(item['path']);raw=p.read_bytes();assert len(raw)==item['bytes'] and sha(raw)==item['sha256'] and p.stat().st_mtime_ns==item['mtimeNs'],str(p)
result={
 'schemaVersion':1,'reviewedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reviewOutcome':'PASS_ARCHIVE_PHYSICAL_ROUNDTRIP_ONLY','networkRequestsMade':0,'browserOperationsMade':0,'benchmarkRerunsMade':0,
 'sourceCommit':index['sourceCommit'],'archiveCollectionAsAt':index['at'],'newIndex':inputs[str(D/'index.json')],'newZip':inputs[str(D/'raw-evidence.zip')],'priorIndex':inputs[str(D/'../production-f9/index.json')],'priorZip':inputs[str(D/'../production-f9/raw-evidence.zip')],
 'counts':{'originalFileMappings':248,'newArchiveFileMappings':155,'newUniqueMembers':151,'reusedPriorFileMappings':93,'reusedPriorUniqueMembers':33,'plainCopies':18,'offlineTrialBodiesReused':20,'offlineUniqueOriginalFullOrPartialBodies':5},
 'completeRequestedSourceInventoryAsAtVerified':True,'all248DecodedBytesDeepEqualActualOriginals':True,'allOriginalSHABytesAndMtimeAfterUnchanged':True,'allNewZipMembersActuallyReadCRCVerified':True,'allReferencedPriorMembersActuallyReadCRCVerified':True,
 'newMemberProofs':new_member_proofs,'priorReusedMemberProofs':old_member_proofs,'mappingProofs':mapping_proofs,'plainCopyProofs':plain_proofs,
 'actualArchiveClose':closure,'derivedIntendedArchiveExitCode':derived['intendedExitCode'],'actualAndIntendedCodesKeptSeparate':True,'inflightArchiveLogsExcludedFromMainIndexAndClosedLater':True,
 'negativeBrowserRunsPreserved':negatives,'v3MissingModelsTerminalPreserved':'Unobserved terminal, not fabricated cancellation; original evidence failure and actual1 retain exact archived bytes.','v4ActualExitCode':0,'originalPerformanceNegativesPinnedInPriorZip':original_performance,'performanceGatePending':True,
 'offlineBodyReuseSHAOccurrences':counts,'offlineTimingScope':'Current local copy/write/hash/progress/fsync/close operations only; no conclusion about historical network or Cloudflare causes. Full/partial old bodies remain full/partial, and 30s/60s actual failures stay unchanged.',
 'scopeLimits':['Archive verification success concerns stored byte preservation; it is not new browser, network, timing benchmark or product acceptance.','Normal desktop English system/light BFCache case only; away cookie/media/mobile/native post-restore/listener count/auth/workspace/key/full G/E gates remain pending.','The old whole ZIP SHA is pinned; this turn reads all 151 new members and all 33 reused prior members, not a repeat full 1195-member prior audit.','Extra final scope-review closure files added after this index are outside the original 248 map and will be separately indexed by root.','README and 18 plain copies are verified at this read-only review time; no original file or archive was edited.'],
 'inputsReadAndAfterUnchanged':all_inputs
}
output=F/'BFCache-source-timing-archive-roundtrip-reviewed.json'
with output.open('x',encoding='utf-8',newline='\n')as h:json.dump(result,h,indent=2,ensure_ascii=False);h.write('\n')
raw=output.read_bytes();print(json.dumps({'outcome':'PASS_ARCHIVE_PHYSICAL_ROUNDTRIP','networkRequestsMade':0,'report':{'path':str(output),'bytes':len(raw),'sha256':sha(raw)}}))

import pathlib, json, hashlib, sys, re, zipfile, difflib, struct
from datetime import datetime, timezone
OWN=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path('C:/cinagroup/cinatoken')
R=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-38ed4ea0f0a742aca3705cba2813a099')
S=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-md-596-scope-205e5c1e2d444a7c8a8fa1de33de32bd')
E=ROOT/'docs/developers/architecture/evidence/2026-10-07-private-preferences-and-route-recovery'
M=ROOT/'docs/developers/architecture/web-frontend-migration.md'
label=sys.argv[1]
assert re.fullmatch('[a-z0-9-]+',label)
tracked={}
def digest(b):return hashlib.sha256(b).hexdigest()
def physical(p,expected=None):
 p=pathlib.Path(p).resolve(); b=p.read_bytes(); s=p.stat()
 q={'path':str(p),'bytes':len(b),'sha256':digest(b),'mtimeNs':s.st_mtime_ns}
 if expected:
  assert q['bytes']==expected['bytes'] and q['sha256']==expected['sha256'],str(p)
 tracked[str(p)]=q
 return q,b
def load(p,expected=None):q,b=physical(p,expected);return json.loads(b)
def actual(p):
 d=load(p);assert d['actualExitCode']==0 and d.get('signal') is None and d.get('spawnError',d.get('error')) is None and d.get('closedAt',d.get('endedAt')),str(p)
 streams=d.get('streams',d)
 for k in ['stdout','stderr']:
  if k in streams:physical(streams[k]['path'],streams[k])
 return d
current,mb=physical(M);mt=mb.decode('utf-8')
assert current['bytes']==880195 and current['sha256']=='20cdbe51e5996505e4333b585f5138549e7444525573d6d5a32fa121b3cc2c0c'
metadata=load(E/'actual-publication-metadata.json')
assert metadata['sourceCommit']=='3494dca3fd14f8433ede2679fcb54916256a9113' and metadata['versionId']=='c5314d77-ba0d-4f7e-9b38-f8241e2d4424' and metadata['deploymentId']=='c7c90b4c-aa1e-4fbc-a0f5-0a988423a1a4' and metadata['trafficPercent']==100
assert mt.count(metadata['introductionLine'])==1 and mt.count(metadata['publicationLine'])==1
for row in metadata['actualEvidence']:
 physical(row['path'],row)
 if 'expectedActualExitCode' in row:assert load(row['path'])['actualExitCode']==row['expectedActualExitCode']
old_scope=load(S/'root-final-scope-596.report.json');old_publication=load(S/'root-final-publication-596.81-scope.report.json')
root_scope=actual(R/'final-main-scope-596.result.json');root_publication=actual(R/'final-main-publication-596.result.json');nested_scope=actual(S/'root-final-scope-596.audit.result.json')
assert old_scope['passed'] and old_scope['comparison']['passed'] and all(x['passed'] for x in old_scope['comparison']['checks'])
assert old_publication['passed'] and all(x['passed'] for x in old_publication['checks'])
for q in [old_scope['documentBytes']['workingSnapshot'],old_publication['workingSnapshot']]:physical(q['path'],q)
old=pathlib.Path(old_publication['workingSnapshot']['path']).read_bytes();before=old.decode('utf-8')
assert len(old)==880135 and digest(old)=='063f2c6138ba3097d1f90b406773e15d2cd7143fcb3532cacdaed81915f90f7e'
replaced=before.replace('\u5f53\u524df9 Web\u516c\u5f00\u56db\u8bed\u9996\u9875/models SSR','\u5386\u53f25.94\u7684f9 Web\u516c\u5f00\u56db\u8bed\u9996\u9875/models SSR',1)
replaced=replaced.replace('\u5f53\u524d\u751f\u4ea7\u516c\u5f00\u9875\u9762\u75315.94\u7684f9\u72ec\u7acbWeb SSR\u627f\u8f7d','\u5f53\u524d\u751f\u4ea7\u516c\u5f00\u9875\u9762\u75315.96\u76843494\u72ec\u7acbWeb SSR\u627f\u8f7d',1)
# Bind the finite current delta exactly instead of attributing old receipts to newer bytes.
changes=[]
for tag,a,b,c,d in difflib.SequenceMatcher(a=before.splitlines(keepends=True),b=mt.splitlines(keepends=True),autojunk=False).get_opcodes():
 if tag!='equal':changes.append({'operation':tag,'oldLines':[a+1,b],'newLines':[c+1,d],'before':before.splitlines(keepends=True)[a:b],'after':mt.splitlines(keepends=True)[c:d]})
assert len(changes)==2 and all(x['operation']=='replace' and len(x['before'])==len(x['after'])==1 for x in changes)
assert changes[0]['oldLines']==[71,71] and changes[1]['oldLines']==[75,75]
assert '\u5386\u53f25.94\u7684f9 Web' in changes[0]['after'][0] and '\u5f53\u524d\u751f\u4ea7\u516c\u5f00\u9875\u9762\u75315.96\u76843494' in changes[1]['after'][0] and '5.94\u7684f9\u53d1\u5e03\u8bb0\u5f55\u6309\u539f\u5b57\u8282\u4fdd\u7559\u4e3a\u5386\u53f2' in changes[1]['after'][0]
checkbox=lambda s:[l for l in s.splitlines(keepends=True) if re.search(r'^\s*- \[[ xX]\]',l)]
assert checkbox(before)==checkbox(mt)
counts=next(x['actual'] for x in old_scope['comparison']['checks'] if x['item']=='after exact counts')
assert counts=={'rawCheckboxLines':213,'actual':{'total':211,'done':55,'pending':156},'main':{'total':102,'done':8,'pending':94},'matrix':54,'gates':9,'evidence':9,'phases':9}
index=load(E/'index.json');verification=load(E/'archive-verification.json');archive_close=actual(E/'archive-process-closed.json')
archive_script,ab=physical(archive_close['args'][0]);acode=ab.decode('utf-8')
assert 'assert archive.testzip() is None' in acode and 'Archive input changed while packaging' in acode and 'intendedExitCode' in acode
assert index['verification']=={'allOriginalBytesEqualDecodedZip':True,'allOriginalMtimeUnchanged':True,'allPriorProofBytesMtimeUnchanged':True,'crcErrors':0}
assert index['physicalOriginals']==verification['physicalFiles']==2238 and index['uniqueMembers']==verification['uniqueMembers']==1156 and verification['priorProtectedFiles']==len(index['priorProtectedInputs'])==292
for f,k in [('index.json','index'),('archive-input-plan.json','recipe'),('selected-inputs-physical.json','physicalInputManifest'),('raw-evidence.zip','bundle')]:physical(E/f,verification[k])
for k,p in [('stdout','archive.stdout.log'),('stderr','archive.stderr.log')]:physical(E/p,archive_close['streams'][k])
source_review=load(OWN/'eleven-source-review.json');assert source_review['outcome']=='NO_BLOCKING_FINDINGS' and source_review['noChecksRerun']
source_by_path={x['relativePath']:x for x in source_review['sourceFiles']}
assert len(index['finalSources'])==len(source_by_path)==11
by_original={str(pathlib.Path(x['original']).resolve()):x for x in index['files']}
source_bindings=[]
with zipfile.ZipFile(E/'raw-evidence.zip') as z:
 central=z.infolist();names=[x.filename for x in central]
 assert len(names)==len(set(names))==1156 and set(names)=={x['member'] for x in index['files']}
 for x in index['finalSources']:
  assert x['relative'] in source_by_path and x['bytes']==source_by_path[x['relative']]['bytes'] and x['sha256']==source_by_path[x['relative']]['sha256']
  op,ob=physical(x['originalPath'],x);sp,sb=physical(x['snapshotPath'],x);assert ob==sb
  row=by_original[str(pathlib.Path(x['snapshotPath']).resolve())]
  assert row['bytes']==x['bytes'] and row['sha256']==x['sha256']
  decoded=z.read(row['member']);assert decoded==ob
  info=z.getinfo(row['member']);source_bindings.append({'relative':x['relative'],'bytes':x['bytes'],'sha256':x['sha256'],'member':row['member'],'crc32':info.CRC,'selectedMemberDecodedCrcAndShaVerified':True,'priorSourceReview':str(OWN/'eleven-source-review.json')})
 gallery=load(E/'gallery/gallery-proof.json');image_bindings=[]
 for x in gallery['images']:
  p,b=physical(E/x['alias'],x['source']);physical(x['source']['path'],x['source']);assert b[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',b[16:24])==(x['width'],x['height'])
  member='sha256/'+x['source']['sha256'];assert z.read(member)==b
  image_bindings.append({'file':p,'dimensions':[x['width'],x['height']],'archivedMember':member,'physicalOnlyNoNewVisualReview':True})
links=[]
for x in old_publication['finalLinks']:
 assert mt.count(']('+x['href']+')')==1
 q,b=physical(M.parent/x['href'],x['file']);assert pathlib.Path(q['path']).is_relative_to(E)
 links.append({'href':x['href'],'file':q})
assert len(links)==4
# Failed original production requests and pending authentication are bound to prior independent audit; they are not rerun here.
prod=load(OWN/'production-596-deployment-and-offline-smoke-review.json')
limits=['Read-only finite documentation/archive physical review; no repository mutation, browser, service, network or completed product checks rerun.','Old final-main receipts actual 0 bind the 880135-byte snapshot only. This review separately verifies exactly two current tense clarifications and unchanged checkbox bytes in the 880195-byte current file.','Existing executed archive receipt and producer source bind full CRC 0 and byte round-trip; only final source11 and two gallery members are decoded here, without rerunning all historical audits.','Original production HTTP 13/19 actual 1 and current source archive 30-second partial download failure remain unchanged; primary offline 18/19 is a separate interpretation record.','Real CinaAuth session, existing dedicated workspace, key creation/revocation, full business/database/dual-platform/BFCache/performance, 14-day retention and full gates are not accepted by this review.','No future Git commit/push proof is claimed.']
assert '13/19actual1' in mt and '18/19' in mt and 'current' in mt and '30s' in mt and '\u771f\u5b9e\u767b\u5f55\u65e0session' in mt and '102/211/54' in mt
for q in list(tracked.values()):
 p=pathlib.Path(q['path']);b=p.read_bytes();assert len(b)==q['bytes'] and digest(b)==q['sha256'] and p.stat().st_mtime_ns==q['mtimeNs'],str(p)
record={'kind':'Finite independent final checklist publication and installed archive review','recordedAt':datetime.now(timezone.utc).isoformat(),'outcome':'NO_BLOCKING_FINDINGS_IN_REVIEWED_SCOPE','currentDocument':current,'publicationMetadata':metadata,'earlierActualScope':{'receipt':root_scope,'nestedReceipt':nested_scope,'requireFinalFlag':old_scope['requireFinal'],'finalChecksCount':len(old_scope['finalChecks']),'counts':counts,'report':str(S/'root-final-scope-596.report.json')},'earlierActualPublication':{'receipt':root_publication,'report':str(S/'root-final-publication-596.81-scope.report.json'),'snapshot':old_publication['workingSnapshot']},'twoCurrentTenseClarifications':changes,'checkboxBytesUnchanged':True,'fourRelativeLinks':links,'executedArchive':{'actualCloseReceipt':archive_close,'producer':archive_script,'verification':index['verification'],'uniqueMembers':1156,'physicalOriginals':2238,'priorProtectedInputs':292,'index':str(E/'index.json'),'bundle':index['bundle'],'allCentralDirectoryNamesMatchIndex':True,'fullCrcAuthority':'Previously executed archive.testzip() before receipt actual 0; all archive and producer physical bytes bound here.'},'finalSourceBindings':source_bindings,'galleryBindings':image_bindings,'priorProductionIndependentReview':str(OWN/'production-596-deployment-and-offline-smoke-review.json'),'allReadInputsUnchanged':True,'physicalInputs':list(tracked.values()),'limits':limits}
out=OWN/(label+'.json');md=OWN/(label+'.md')
with out.open('x',encoding='utf-8',newline='\n') as f:json.dump(record,f,ensure_ascii=False,indent=2);f.write('\n')
text='有限只读终审无阻塞发现。当前 checklist 为 880195 B / 20cdbe51e5996505e4333b585f5138549e7444525573d6d5a32fa121b3cc2c0c。当前 metadata 准确绑定 3494 源码、c5314d77 version、c7c90b4c deployment 和 100% 流量；四个相对链接均指向真实已安装原字节。\n\n旧 final-main-scope/publication 实际 0 只证明 880135 B 快照。本审阅另核实当前恰好两行时态澄清、全部 checkbox 字节不变，102 主任务、211 实际任务、54 矩阵及 G/E/P 范围不升级。f9 原历史发布段保留。\n\n实际 archive Python 关闭 0 及其生产者源码证明先完成全 ZIP CRC 0 与原字节 round-trip；安装的 1156 ZIP members/2238 physical originals/292 protected inputs 元数据与实体一致。本次仅另解码 final source11 和两幅 gallery，均与原审阅/原截图 SHA 一致，没有重跑全部历史验证。\n\n首轮生产 HTTP 13/19 actual1、独立 primary offline 18/19、current 源码包 30 秒部分下载失败保持。真实 CinaAuth 无 session、工作区和密钥尚未验收。本次未运行网络、浏览器、服务或产品检查，也不宣称未来 Git 提交/推送完成。\n'
with md.open('x',encoding='utf-8',newline='\n') as f:f.write(text)
print(json.dumps({'record':{'path':str(out),'bytes':out.stat().st_size,'sha256':digest(out.read_bytes())},'summary':{'path':str(md),'bytes':md.stat().st_size,'sha256':digest(md.read_bytes())},'outcome':record['outcome'],'physicalInputs':len(tracked),'noNetwork':True,'noBrowser':True,'noRepoWrites':True},ensure_ascii=True))
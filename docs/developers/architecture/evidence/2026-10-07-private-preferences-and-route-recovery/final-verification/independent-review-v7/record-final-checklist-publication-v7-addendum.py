import pathlib,json,hashlib,difflib,re,sys
from datetime import datetime,timezone
OWN=pathlib.Path(__file__).resolve().parent
S=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-md-596-scope-205e5c1e2d444a7c8a8fa1de33de32bd')
R=pathlib.Path('C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-38ed4ea0f0a742aca3705cba2813a099')
M=pathlib.Path('C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md')
label=sys.argv[1];assert re.fullmatch('[a-z0-9-]+',label)
tracked={}
def digest(b):return hashlib.sha256(b).hexdigest()
def physical(p,expected=None):
 p=pathlib.Path(p).resolve();b=p.read_bytes();q={'path':str(p),'bytes':len(b),'sha256':digest(b),'mtimeNs':p.stat().st_mtime_ns}
 if expected:assert q['bytes']==expected['bytes'] and q['sha256']==expected['sha256'],str(p)
 tracked[str(p)]=q;return q,b
def load(p,expected=None):return json.loads(physical(p,expected)[1])
def actual(p):
 d=load(p);assert d['actualExitCode']==0 and d.get('signal') is None and d.get('spawnError',d.get('error')) is None and d.get('closedAt',d.get('endedAt')),str(p)
 streams=d.get('streams',d)
 for k in ['stdout','stderr']:
  if k in streams and 'path' in streams[k]:physical(streams[k]['path'],streams[k])
 return d
current,mb=physical(M,{'bytes':880195,'sha256':'20cdbe51e5996505e4333b585f5138549e7444525573d6d5a32fa121b3cc2c0c'})
base_review=load(OWN/'final-checklist-publication-review-596.json');assert base_review['currentDocument']['sha256']==current['sha256']
v1,b1=physical(S/'compare-81-publication-v1.mjs',{'bytes':9222,'sha256':'99df79b9c9d08a3e9f5d8a9bc9c6885a24cb205db3bdaf2c9b852baa36557e0d'})
v2,b2=physical(S/'compare-81-publication-v2.mjs',{'bytes':10799,'sha256':'c13eaa0f3adc7037fefd4e4571d5c2016d01fd334e673fc181cc9f52f4d5bacd'})
a=b1.decode('utf-8').splitlines(keepends=True);b=b2.decode('utf-8').splitlines(keepends=True)
changes=[]
for tag,i,j,k,l in difflib.SequenceMatcher(a=a,b=b,autojunk=False).get_opcodes():
 if tag!='equal':changes.append({'operation':tag,'oldLines':[i+1,j],'newLines':[k+1,l],'before':a[i:j],'after':b[k:l]})
assert len(changes)==3 and [x['operation'] for x in changes]==['insert','insert','replace']
assert len(changes[0]['after'])==3 and 'currentStatusPatch' in ''.join(changes[0]['after']) and 'assert.equal(hash(current),currentStatusPatch.documentAfter.sha256)' in ''.join(changes[0]['after'])
assert len(changes[1]['after'])==1 and 'Exactly one current status correction' in changes[1]['after'][0] and 'Exactly one original status line' in changes[1]['after'][0]
assert len(changes[2]['before'])==len(changes[2]['after'])==1 and 'exactAllowedMetadata' in changes[2]['before'][0] and 'currentStatusPatch: {proof:proof(statusPatchPath)' in changes[2]['after'][0]
correction=load(R/'corrected-current-metadata-596.json',{'bytes':3463,'sha256':'9a081e9e436f71a18f66cbce54ebab74d7e4b68e061399707efe58a067e26faf'})
assert correction['kind']=='EXACT_CURRENT_METADATA_CORRECTION_596' and correction['documentAfter']['bytes']==current['bytes'] and correction['documentAfter']['sha256']==current['sha256']
mt=mb.decode('utf-8');assert mt.count(correction['statusAfter'])==1 and mt.count(correction['phaseAfter'])==1 and correction['statusBefore'] not in mt and correction['phaseBefore'] not in mt
receipts={'scope':actual(R/'final-main-scope-596-v7.result.json'),'publication':actual(R/'final-main-publication-596-v7.result.json'),'diffWhitespace':actual(R/'final-md-diff-check-596-v7.result.json'),'scopeNested':actual(S/'root-final-scope-596-v7.audit.result.json')}
scope=load(S/'root-final-scope-596-v7.report.json',{'bytes':258064,'sha256':'163ed66dd22bd04a3ab96f48be90e353642ab0affed8b875f9c992e262ea746a'})
pub=load(S/'root-final-publication-596-v7.81-scope.report.json',{'bytes':366567,'sha256':'7b41eeb70a95f270390419988017a594cc4828cb7709cfe3fd9eb31bcb9bd2f2'})
assert scope['passed'] and scope['comparison']['passed'] and all(x['passed'] for x in scope['comparison']['checks']) and pub['passed'] and all(x['passed'] for x in pub['checks'])
for q in [scope['documentBytes']['workingSnapshot'],pub['workingSnapshot'],pub['current']]:
 assert q['bytes']==current['bytes'] and q['sha256']==current['sha256'];physical(q['path'],q)
assert pub['currentStatusPatch']['before']==correction['statusBefore'] and pub['currentStatusPatch']['after']==correction['statusAfter'];physical(pub['currentStatusPatch']['proof']['path'],pub['currentStatusPatch']['proof'])
assert pathlib.Path(receipts['publication']['args'][0]).resolve()==pathlib.Path(v2['path']).resolve() and pathlib.Path(receipts['publication']['args'][-1]).resolve()==(R/'corrected-current-metadata-596.json').resolve()
counts=next(x['actual'] for x in scope['comparison']['checks'] if x['item']=='after exact counts')
assert counts==base_review['earlierActualScope']['counts'] and len(pub['finalLinks'])==4
assert {x['href']:x['file']['sha256'] for x in pub['finalLinks']}=={x['href']:x['file']['sha256'] for x in base_review['fourRelativeLinks']}
for q in list(tracked.values()):
 p=pathlib.Path(q['path']);b=p.read_bytes();assert len(b)==q['bytes'] and digest(b)==q['sha256'] and p.stat().st_mtime_ns==q['mtimeNs'],str(p)
record={'kind':'Finite final v7 publication and scope addendum','recordedAt':datetime.now(timezone.utc).isoformat(),'outcome':'NO_BLOCKING_FINDINGS_IN_REVIEWED_SCOPE','currentDocument':current,'v2StaticReview':{'v1':v1,'v2':v2,'exactThreeDiffHunks':changes,'conclusion':'Only exact kind/source/version/full current hash status correction binding, one unique whole status paragraph normalization, and correction-proof report field were added. All previous v1 checks remain byte-identical outside these three additions. P6 change stays inside the previously allowed phase evidence column; protected status/checkbox/history constraints remain.'},'currentCorrectionProof':correction,'actualV7Receipts':receipts,'reports':{'scope':str(S/'root-final-scope-596-v7.report.json'),'publication':str(S/'root-final-publication-596-v7.81-scope.report.json')},'counts':counts,'scopeRequireFinalFlag':scope['requireFinal'],'scopeFinalChecksCount':len(scope['finalChecks']),'allScopeComparisonAndPublicationChecksTrue':True,'fourRelativeLinkProofsSameAsPriorIndependentReview':True,'earlierIndependentReview':str(OWN/'final-checklist-publication-review-596.json'),'allInputsUnchanged':True,'physicalInputs':list(tracked.values()),'limits':['This addendum binds new actual v7 receipts to current 880195-byte document, replacing no earlier immutable receipt.','No product, production HTTP, source, ZIP or historical acceptance checks were rerun; no network, browser, service or repository writes.','Original HTTP failures, partial current source archive download, absent real CinaAuth session/workspace/key acceptance and unchanged 102/211/54/full gates remain.','No later Git commit/push completion is inferred.']}
out=OWN/(label+'.json');md=OWN/(label+'.md')
with out.open('x',encoding='utf-8',newline='\n') as f:json.dump(record,f,ensure_ascii=False,indent=2);f.write('\n')
text='v2 静态审阅与新 v7 实际关闭记录有限补充：无阻塞发现。v2 相对 v1 仅三处精确新增：status correction 完整固定段与 source/version/current hash 绑定、唯一整段归一化、报告中 correction proof；其余检查全部保留。\n\n新 scope/publication/diffWhitespace 及 nested scope 均 actual 0/null，scope/publication 实体报告绑定当前 880195 B / 20cdbe51e5996505e4333b585f5138549e7444525573d6d5a32fa121b3cc2c0c，全部声明检查为真。102/211/54 范围、四 relative link hash 与旧独立终审一致。此前 880135 快照收据保持原件，不归因于新字节。\n\n本次只读取有限静态文件与实际收据，没有重复产品/生产/ZIP检查或网络/浏览器/服务操作。原 HTTP/current 源码包下载失败与真实 Auth/工作区/密钥未验收保持，也不推断后续 Git 提交或推送。\n'
with md.open('x',encoding='utf-8',newline='\n') as f:f.write(text)
print(json.dumps({'record':{'path':str(out),'bytes':out.stat().st_size,'sha256':digest(out.read_bytes())},'summary':{'path':str(md),'bytes':md.stat().st_size,'sha256':digest(md.read_bytes())},'outcome':record['outcome'],'physicalInputs':len(tracked)},ensure_ascii=True))
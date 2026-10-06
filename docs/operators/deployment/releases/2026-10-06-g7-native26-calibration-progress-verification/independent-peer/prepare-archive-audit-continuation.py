import pathlib
out=pathlib.Path(r'C:\Users\cina\AppData\Local\Temp\cinatoken-final42-archive-independent-peer-da67e04e43144446a163867b927351c4')
old=(out/'audit-full42-archive.py').read_text(encoding='utf-8')
tail=old[old.index('def json_source'):]
tail=tail.replace("if d:pin(d);verified_streams.append(stream)","if d:pin_stream(d,c,stream);verified_streams.append(stream)")
tail=tail.replace("failure_files=[(key,value) for key,value in data.items() if key.startswith('original-final39-failed-admission-metadata/')]","failure_files=[(key,data[key]) for key in entries if key.startswith('original-final39-failed-admission-metadata/')]")
tail=tail.replace("'sourceDirectories':len(source_directories)","'sourceDirectoryWalkNotRepeated':True")
tail=tail.replace("'sourceCohorts':layers,","'sourceCohorts':layers,'completedSourceStageFromActualReader1':source_stage,")
tail=tail.replace("target=out/'full42-archive-independent-audit.json'","target=out/'full42-archive-independent-audit.json'")
prefix=r"""import json,pathlib,hashlib,gzip,os,collections,sys,datetime
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
"""
target=out/'audit-full42-archive-v2.py'
with target.open('x',encoding='utf-8',newline='\n') as f:f.write(prefix+tail)
print(str(target))
import hashlib, json, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path
OWN=Path(__file__).resolve().parent
REPO=Path('C:/cinagroup/cinatoken')
OLD=REPO/'docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/production-f9'
DEST=OLD.parent/'bfcache-and-source-timing'
sha=lambda b:hashlib.sha256(b).hexdigest()
old_i=(OLD/'index.json').read_bytes();old_z=(OLD/'raw-evidence.zip').read_bytes()
assert sha(old_i)=='b8649463f6bb12e1083d3cb80ac8bac83a5bc2de2208bae04a5145d25f920988'
assert sha(old_z)=='9262b469b0f1160a27d00f3e352f2a023b5804e0a29a39aba0d60cdf06b16e6f'
known={x['sha256']:x['member'] for x in json.loads(old_i)['files']}
sources=[]
for arg in sys.argv[1:]:
    alias,value=arg.split('=',1)
    assert alias and all(c.isalnum() or c in '-_' for c in alias)
    p=Path(value).resolve()
    assert p.exists() and str(p).lower().startswith('c:\\users\\cina\\appdata\\local\\temp\\')
    assert p!=OWN,'Exclude active archiver logs'
    paths=sorted(f for f in p.rglob('*') if f.is_file()) if p.is_dir() else [p]
    for f in paths:
        assert not f.is_symlink()
        sources.append((alias+'/'+(f.relative_to(p).as_posix() if p.is_dir() else f.name),f))
assert sources and len({x[0] for x in sources})==len(sources)
DEST.mkdir()
files=[];new_members={};originals={}
for name,p in sources:
    b=p.read_bytes();h=sha(b);mtime=p.stat().st_mtime_ns
    originals[str(p)]=(b,mtime)
    archive='../production-f9/raw-evidence.zip' if h in known else 'raw-evidence.zip'
    member=known[h] if h in known else 'sha256/'+h
    if h not in known:
        assert member not in new_members or new_members[member]==b
        new_members[member]=b
    files.append(dict(path=name,original=str(p),bytes=len(b),sha256=h,member=member,archive=archive,mtimeNs=mtime))
new_path=DEST/'raw-evidence.zip'
with zipfile.ZipFile(new_path,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for member,b in sorted(new_members.items()):z.writestr(member,b)
with zipfile.ZipFile(new_path) as new,zipfile.ZipFile(OLD/'raw-evidence.zip') as prior:
    assert new.testzip() is None and len(new.namelist())==len(new_members)
    for f in files:
        z=new if f['archive']=='raw-evidence.zip' else prior
        decoded=z.read(f['member']);expected,mtime=originals[f['original']]
        assert decoded==expected and len(decoded)==f['bytes'] and sha(decoded)==f['sha256']
        p=Path(f['original']);assert p.read_bytes()==expected and p.stat().st_mtime_ns==mtime
assert (OLD/'index.json').read_bytes()==old_i and (OLD/'raw-evidence.zip').read_bytes()==old_z
bundle=dict(path='raw-evidence.zip',bytes=new_path.stat().st_size,sha256=sha(new_path.read_bytes()))
verification=dict(originalFiles=len(files),newUniqueMembers=len(new_members),reusedPriorFileMappings=sum(f['archive']!='raw-evidence.zip' for f in files),allDecodedBytesShaCrcVerified=True,allOriginalBytesAndMtimeUnchanged=True,priorIndexAndZipUnchanged=True)
index=dict(schemaVersion=1,at=datetime.now(timezone.utc).isoformat(),sourceCommit='f9b9140f7fdc35b4bddcd27e13df14cb2e444a34',purpose='Real BFCache observations and offline diagnostics only; prior failures and full migration gates preserved',bundle=bundle,priorArchive=dict(path='../production-f9/raw-evidence.zip',bytes=len(old_z),sha256=sha(old_z),indexPath='../production-f9/index.json',indexSha256=sha(old_i)),files=files,verification=verification,excluded=['Active archiver logs are closed and copied separately after actual child close'])
with (DEST/'index.json').open('x',encoding='utf8',newline='\n') as f:json.dump(index,f,ensure_ascii=False,indent=2);f.write('\n')
receipt=dict(**verification,bundle=bundle,indexBytes=(DEST/'index.json').stat().st_size,indexSha256=sha((DEST/'index.json').read_bytes()),intendedExitCode=0)
with (OWN/'archive-verification.json').open('x',encoding='utf8',newline='\n') as f:json.dump(receipt,f,indent=2);f.write('\n')
print(json.dumps(receipt))

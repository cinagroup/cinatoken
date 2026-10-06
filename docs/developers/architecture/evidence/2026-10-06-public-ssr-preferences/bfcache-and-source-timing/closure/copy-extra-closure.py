import hashlib,json
from pathlib import Path
R=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-bfcache-continuation-64228ac856184788ac472e5bbe6acb64")
DEST=Path("C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing/closure")
names=["copy-archive-plain.py","copy-archive-plain.result.json","copy-archive-plain.stdout.log","copy-archive-plain.stderr.log","section-595.md","update-md-595.py","update-md-595.result.json","update-md-595.stdout.log","update-md-595.stderr.log","update-md-595-v2.py","update-md-595-v2.result.json","update-md-595-v2.stdout.log","update-md-595-v2.stderr.log","md-update.json"]
copied=[]
for n in names:
    b=(R/n).read_bytes()
    with (DEST/n).open("xb") as f:f.write(b)
    assert (DEST/n).read_bytes()==b
    copied.append(dict(path=n,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
with (R/"extra-closure-copy.json").open("x",encoding="utf8") as f:json.dump(copied,f,indent=2);f.write("\n")
print(json.dumps(dict(copied=len(copied))))


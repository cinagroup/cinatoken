import json
from pathlib import Path
R=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-bfcache-continuation-64228ac856184788ac472e5bbe6acb64")
S=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-md-595-scope-01385f0503ef418ba5e5bfe8771c5f6a")
OLD=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-md-scope-79204d34279045ad83a65f36ab1e0bab")
DEST=Path("C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing/closure")
assert json.loads((S/"final-md-595-v3.process-closed.json").read_bytes())["actualExitCode"]==0
assert json.loads((S/"final-md-595-v3.c6-scope.report.json").read_bytes())["passed"] is True
sources=[p for root in [S,OLD] for p in root.glob("final-md-595*") if p.is_file() and p.suffix!=".md"]
sources += [S/"compare-c6.mjs",S/"run-c6-scope.mjs",OLD/"audit-migration-scope.mjs",OLD/"run-owned-audit.mjs"]
sources += [R/n for n in ["update-md-595-v3.py","update-md-595-v3.result.json","update-md-595-v3.stdout.log","update-md-595-v3.stderr.log","md-update-v3.json","copy-extra-closure.py","copy-extra-closure.result.json","extra-closure-copy.json","copy-archive-review.py","copy-archive-review.result.json"]]
assert len({p.name for p in sources})==len(sources)
for p in sources:
    b=p.read_bytes()
    with (DEST/p.name).open("xb") as f:f.write(b)
    assert (DEST/p.name).read_bytes()==b
print(json.dumps(dict(copied=len(sources))))


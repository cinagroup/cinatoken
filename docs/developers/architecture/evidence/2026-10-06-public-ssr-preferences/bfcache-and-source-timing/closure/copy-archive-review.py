import hashlib,json
from pathlib import Path
F=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-fixture-c60a7fdf3ecc40f49e04ef65e7956771")
DEST=Path("C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing/closure")
receipt=json.loads((F/"bfcache-source-timing-archive-review-process-closed.json").read_bytes())
assert receipt["actualExitCode"]==0 and receipt["signal"] is None
names=["BFCache-source-timing-archive-roundtrip-reviewed.json","bfcache-source-timing-archive-review-process-closed.json","bfcache-source-timing-archive-review.stdout.log","bfcache-source-timing-archive-review.stderr.log","review-bfcache-source-timing-archive.py","run-bfcache-source-timing-archive-review-closed.mjs"]
for n in names:
    b=(F/n).read_bytes()
    with (DEST/n).open("xb") as f:f.write(b)
    assert (DEST/n).read_bytes()==b
print(json.dumps(dict(copied=len(names))))


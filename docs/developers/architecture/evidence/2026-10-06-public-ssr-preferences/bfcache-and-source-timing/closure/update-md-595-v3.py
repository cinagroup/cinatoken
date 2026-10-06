import hashlib,json
from pathlib import Path
R=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-bfcache-continuation-64228ac856184788ac472e5bbe6acb64")
DOC=Path("C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md")
old=DOC.read_bytes()
assert hashlib.sha256(old).hexdigest()=="6d61666ce193d825396488e291c23899baff695bc8982bf67c8bb5a24058e6af"
a="起始两份SSR、34资产响应共36个真实body（20 unique assets）全部与冻结原字节匹配；"
b="起始两份SSR、34资产响应共36个真实body的保存字节/hash均经复核；其中34资产响应（20 unique assets）与冻结manifest/raw逐byte一致，两份SSR的nonce/CSP/控件契约通过；"
c="1486原chunk/18446061实际观察bytes、5个完整或部分body以及逐行进度均匹配，26保护输入前后原字节未变。"
d="1486原chunk/18446061实际观察bytes及5个完整或部分body均匹配；15份动态时间日志的chunk边界一致，5份固定metadata日志逐byte一致，26保护输入前后原字节未变。"
text=old.decode("utf8")
assert text.count(a)==1 and text.count(c)==1
raw=text.replace(a,b).replace(c,d).encode("utf8")
DOC.write_bytes(raw)
receipt=dict(beforeBytes=len(old),beforeSha256=hashlib.sha256(old).hexdigest(),afterBytes=len(raw),afterSha256=hashlib.sha256(raw).hexdigest(),changes=["SSR and asset byte proof distinction","dynamic versus fixed progress metadata distinction"])
with (R/"md-update-v3.json").open("x",encoding="utf8") as f:json.dump(receipt,f,indent=2);f.write("\n")
print(json.dumps(receipt))


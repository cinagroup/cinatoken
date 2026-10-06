import hashlib,json,re
from pathlib import Path
R=Path("C:/Users/cina/AppData/Local/Temp/cinatoken-bfcache-continuation-64228ac856184788ac472e5bbe6acb64")
DOC=Path("C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md")
DEST=DOC.parent/"evidence/2026-10-06-public-ssr-preferences/bfcache-and-source-timing"
old=DOC.read_bytes()
assert hashlib.sha256(old).hexdigest()=="683380e63867768b313758c5667b38d864c540b0dcb8cb35fc4cd7013be13b08"
assert json.loads((DEST/"browser-report.json").read_bytes())["outcome"]=="RESTORED_PASS"
assert json.loads((DEST/"closure/bfcache-normal-production-f9-v4.result.json").read_bytes())["actualExitCode"]==0
assert json.loads((DEST/"offline-diagnostic-report.json").read_bytes())["outcome"]=="PASS"
assert json.loads((DEST/"deployment-guard.json").read_bytes())["actualExit"]==0
text=old.decode("utf8")
lines=text.splitlines(keepends=True)
for i,line in enumerate(lines):
    end="\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
    content=line[:-len(end)] if end else line
    if content.startswith("当前推进："):
        lines[i]="当前推进：f9公开SSR早期偏好修复和严格CSP已发布（5.93–5.94）；生产桌面Chrome .98真实后退/前进BFCache恢复通过（5.95），原Document/DOM/controller/nonce保留。20次下载采集离线重放及独立复核完成，仅反映当前本地操作；旧30s HTTP与60s源码下载实际失败、性能根因未证保持。离页cookie/媒体变化、移动及恢复后原生输入/监听器等完整BFCache验收继续。原102主任务8完成/94待、211任务55完成/156待及54矩阵/G0–G8/E00–E08未变；生产OAuth固定关联写入仍待具体批准，真实身份/已有专用测试工作区/密钥未验收。产品SSE transport PASS/minimal source.cancel FAIL及原strict8/7/1保持。"+end
    elif content.startswith("| P6 ") or content.startswith("| P8 "):
        cells=content.split("|"); assert len(cells)==6
        cells[3]=cells[3].rstrip()+"；5.95实际Chrome .98桌面双向BFCache恢复与36 body/20 unique assets独立复核通过，离线20次采集诊断不改变性能失败 "
        if content.startswith("| P6 "):
            cells[4]=cells[4].replace("BFCache恢复未执行；","离页cookie/媒体变化、移动及恢复后输入/监听器等完整BFCache仍待；")
        else:
            cells[4]=cells[4].replace("BFCache与性能预算","完整BFCache与性能预算")
        lines[i]="|".join(cells)+end
updated="".join(lines)
section=(R/"section-595.md").read_text(encoding="utf8")
assert "### 5.95 " not in text
updated=updated.replace("## 6. 更新记录",section+"\n## 6. 更新记录",1)
record="2026-10-06：5.95记录真实Chrome .98桌面匿名双向BFCache恢复actual0与独立物理复核、20次固定数据离线采集诊断actual0；前置浏览器/reviewer actual1和旧30s/60s失败原样归档，不归因网络或Cloudflare，不改变预算。生产f9/100%保持；完整任务/54矩阵/G/E、真实Auth/已有专用工作区/密钥和OAuth具体批准继续。"
updated=updated.rstrip()+"\n\n"+record+"\n"
raw=updated.encode("utf8")
checkbox=lambda b:[x for x in b.splitlines(keepends=True) if re.match(rb"\s*-\s+\[[ xX]\]",x)]
assert len(checkbox(old))==213 and checkbox(raw)==checkbox(old)
DOC.write_bytes(raw)
receipt=dict(beforeBytes=len(old),beforeSha256=hashlib.sha256(old).hexdigest(),afterBytes=len(raw),afterSha256=hashlib.sha256(raw).hexdigest(),checkboxLinesExact=True,checkboxLineCount=213)
with (R/"md-update.json").open("x",encoding="utf8") as f:json.dump(receipt,f,indent=2);f.write("\n")
print(json.dumps(receipt))


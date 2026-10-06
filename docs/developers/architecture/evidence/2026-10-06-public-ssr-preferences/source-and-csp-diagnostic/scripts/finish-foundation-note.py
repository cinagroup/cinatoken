from pathlib import Path
import re,json,hashlib
p=Path('C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md')
b=p.read_bytes();s=b.decode('utf-8');tasks=re.findall(r'^.*\[(?: |x)\].*$',s,re.M)
s=s.replace('新增10项回归通过，完整Web检查及真实延迟资产Chrome验收推进中；新源码尚未发布。','新增10项回归和完整Web1610/1610、types/lint/format及三target build actual0；首轮Chrome4/13通过、9JS未通过，eval CSP来源与旧文档held chunk终态观察正在核查，新源码尚未发布。',1)
old='真实Chrome延迟主包/动态chunk、释放后hydration无回退/重复nav、四语/mobile/真正NoJS及完整Web/Linux/新冻结发布仍在执行；本节此时不声称新版本已上线。'
new='完整Web1610/1610、skip0，最终types/lint/format及三target生产build actual0。首轮Chrome13context中真正NoJS四语4/4通过、9JS未通过：8项因一次eval CSP事件严格失败，dynamic语言还因旧文档held请求无terminal观察而失败；已完成的early输入/主题保持不覆盖整体失败。来源诊断、浏览器完整验收、同SHA Linux CI/冻结与新发布继续，本节不声称新版本已上线。'
assert s.count(old)==1;s=s.replace(old,new)
link='直接证据：[本批源码、完整Web检查、独立审查与首轮负面浏览器索引](./evidence/2026-10-06-public-ssr-preferences/foundation/index.json)。原始失败与actual exit保持；后续不通过删去CSP观察或等待ready逃过early动作。\r\n\r\n'
s=s.replace('## 6. 更新记录',link+'## 6. 更新记录',1)
assert re.findall(r'^.*\[(?: |x)\].*$',s,re.M)==tasks
p.write_bytes(s.encode('utf-8'))
print(json.dumps({'checkboxLinesUnchanged':True,'count':len(tasks),'sha256':hashlib.sha256(s.encode()).hexdigest()}))

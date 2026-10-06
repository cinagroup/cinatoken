from pathlib import Path
import hashlib, json, re

root = Path('C:/cinagroup/cinatoken')
temp = Path(__file__).parent
path = root / 'docs/developers/architecture/web-frontend-migration.md'
before_bytes = path.read_bytes()
before = before_bytes.decode('utf-8')
newline = '\r\n' if '\r\n' in before else '\n'
assert '### 5.93 ' not in before
task_lines = re.findall(r'^.*\[(?: |x)\].*$', before, re.M)
progress = re.search(r'^当前推进：[^\r\n]+', before, re.M)
assert progress
updated = '当前推进：独立Web exact2e生产仍为a898/7223/tag2e/100%；本轮已修复公开SSR初始化前主题/语言输入丢失，nonce head固定脚本统一拥有公开偏好，React使用原生uncontrolled选择并在实际shell commit后同步（5.93）。新增10项回归通过，完整Web检查及真实延迟资产Chrome验收推进中；新源码尚未发布。产品SSE transport PASS/minimal source.cancel FAIL和原strict8/7/1保持；P1-07、G1及完整G0–G8待验。生产OAuth具体关联批准待，真实身份/已有专用测试工作区/密钥未验收。'
after = before[:progress.start()] + updated + before[progress.end():]
section = '''### 5.93 公开 SSR 早期主题与语言输入修复（2026-10-06）

5.92 的真实缺陷已进入源码修复：主bundle或动态SSR模块尚未下载时，公开header的两个native select也能立即处理用户选择。新增固定JavaScript literal通过现有每响应nonce在head安装一个document捕获change监听，根正文后、defer入口前同步偏好；不使用function.toString或动态eval，不插入请求数据、凭据或HTML，不放宽CSP。React两个select使用与SSR相同的defaultValue，移除第二份cookie/class写入及语言assign；实际PublicShell effect只同步现有控制器并标记真实commit。

控制器只接受当前root内、精确theme/locale标记的HTMLSelectElement；公开语言路径保留query/hash，URL locale为权威，私有或未知路径不导航，相同locale不再次导航。主题立即写公开偏好cookie并更新html class；Cookie读写被拒时保留页面内选择，system跟随OS。幂等安装只有一组change/media/pageshow监听，旧disposer不能删除重装实例；页面恢复可采用可读的外部偏好变化。

新增10项VM执行真实fixed script的回归actual0/skip0，含128个四语公开href组合、earlyroot、Cookie拒绝、非法目标、私有路径、systemmedia、pageshow与清理反例；现有32四语×八页面文档契约增加两个inline script的nonce/顺序及native marker断言，原SSR useId树不变。真实Chrome延迟主包/动态chunk、释放后hydration无回退/重复nav、四语/mobile/真正NoJS及完整Web/Linux/新冻结发布仍在执行；本节此时不声称新版本已上线。

原102主任务（8完成/94待）、54矩阵、211实际task（55完成/156待）、G0–G8/E00–E08范围和状态保持；P1-07还包括公开/账户/管理布局和各状态整体验收，本轮局部偏好修复不勾整项。生产OAuth固定关联写入的具体批准仍待，未重试被拒动作或绕过认证；真实登录、已有专用测试工作区与密钥操作尚未验收。

'''.replace('\n', newline)
assert after.count('## 6. 更新记录') == 1
after = after.replace('## 6. 更新记录', section + '## 6. 更新记录', 1)
after += newline + '2026-10-06：5.93启动公开SSR真实早期输入修复，统一nonce native偏好控制器与uncontrolled React控件；10项新回归通过，完整Web/真实延迟资产Chrome/LinuxCI和新发布推进中。生产仍exact2e，原102/54/G/E/211状态不变，OAuth具体批准及真实工作区/密钥待。' + newline
assert re.findall(r'^.*\[(?: |x)\].*$', after, re.M) == task_lines
path.write_bytes(after.encode('utf-8'))
receipt = {'beforeBytes': len(before_bytes), 'beforeSha256': hashlib.sha256(before_bytes).hexdigest(), 'afterBytes': len(after.encode('utf-8')), 'afterSha256': hashlib.sha256(after.encode('utf-8')).hexdigest(), 'allCheckboxLinesUnchanged': True, 'checkboxLineCount': len(task_lines), 'newSourceDeployedClaim': False}
(temp / 'checklist-first-update.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))

# 2026-10-06：生产桌面 BFCache 与源码下载离线诊断

当前生产 Web 源码为 f9b9140f7fdc35b4bddcd27e13df14cb2e444a34。验收后只读 guard 仍是 version 218e2b8c-6153-4163-8b9f-cffc34445e27、deployment b1fc86e3-a392-488c-9eca-6b5a99f8c713、100% 流量。本批没有修改产品代码或重新部署。

- [浏览器原始报告](browser-report.json)：真实 Chrome 154.0.8037.98、1280×900、新匿名上下文；/en → /en/models → 后退 → 前进，两方向 RESTORED_PASS。trusted pageshow.persisted=true、原 Document/DOM/controller/nonce 身份保留且没有新 HTML 请求。36 保存响应体含 2 SSR、34 assets（20 unique）；CSP/page/evidence/private/unexpected 均为零，原始浏览器 child 与 BrowserServer 自然关闭。
- [独立浏览器审查](independent-browser-review.json)与[实际进程退出收据](closure/bfcache-normal-production-f9-v4.result.json)分别保留。恢复后的[首页](back.png)及[模型页](forward.png)截图已由 root 实际查看。只覆盖匿名英语 system/light 桌面场景。
- [离线诊断](offline-diagnostic-report.json)复读旧 60 秒下载 5 个完整或部分 body，完成 20 次固定数据重放；15 次近似原采集操作为 14.3443–25.0012ms，5 次逐操作计时为 18.8576–28.8973ms。仅反映当前本地操作，不证明历史网络/Cloudflare根因，也不把旧实际退出1改成通过。
- [离线独立复核](independent-offline-review.json)与[第二份复核](second-independent-offline-review.json)保留原报告、精度修正前的 reviewer 失败和实际退出收据。
- [参考说明](reference-notes.md)解释浏览器 API、真实 BFCache 观察方法及范围；[生产 guard](deployment-guard.json)确认切流不变。

新 index 精确映射 248 个原文件：151 个新唯一成员，93 个文件映射复用不可变的 ../production-f9/raw-evidence.zip。新 ZIP 为 899345 B，SHA256 6c7fe7b7b34f2a13c037806858b67aeeb700db7fd7662e66c9f688c7b6536236。所有成员经解压、原字节/SHA/CRC核验；原文件 bytes/mtime 和旧 index/ZIP 均未改变。归档 actual close0 见 closure/archive-continuation.result.json，intendedExitCode 与实际退出码分别存放。

V2 preflight actual1（没有创建页面/目标请求/历史遍历）与 V3 favicon body 取证竞态 actual1（历史遍历0、未观察到模型文档终态）均保留在 index 中，不能归为产品 BFCache 不恢复。最终 V4 收齐自然请求的 SSR 声明 favicon 及所有已启动响应后才释放原生点击，没有人工请求、拦截、跳过或缓存政策放宽。

原 30 秒 HTTP 167/177、175/177 actual1 和 60 秒源码 3/5 actual1 保持。离页 cookie/系统媒体变化、移动 BFCache、恢复后原生输入、监听器数量、真实登录/已有专用工作区/密钥、非空模型目录、完整54矩阵及G0–G8/E00–E08继续待验。生产 OAuth 固定关联写入仍待具体授权。原严格 SSE 失败及全部迁移待办没有提前勾选。

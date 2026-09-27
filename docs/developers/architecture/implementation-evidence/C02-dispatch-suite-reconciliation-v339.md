# C02 v339：dispatch 合并回归与旧夹具校准

2026-09-24；[机器摘要](./C02-dispatch-suite-reconciliation-v339-results.json)固定本地源码与回归结果。未修改生产重试或资金代码，未运行 Linux CI、供应商请求或远端 SQL。

在报价引用桥接合并后，首次本机 `test:dispatch-safety` 为 **4215/4273**。58 个失败集中于旧夹具把已发送后的 HTTP 503 当作明确、可安全重试的拒绝：Realtime 26、ASR/上传 25、Vertex 5、全局模型 fallback 2。当前运行合同将此类 503 视为可能已被上游接受，停止隐藏重发。针对需要多候选验证的夹具改用明确 429；同时保留并扩展 503 的一次发送、结果不明、禁止 fallback、资源收尾及预算断言。全局 fallback 仍验证三次真实派发的顺序与请求级上限。另把 HTTP header 联合类型和可选 dispatch budget 的五处测试类型断言写清。

修正后，Realtime／ASR／Vertex 五文件定向 **362/362**，全局 fallback **6/6**，公开入口文件 **701/701**，Images 生命周期 **96/96**。本机完整 `npm run test:dispatch-safety -w @octafuse/proxy` **4291/4291**，`typecheck:dispatch-safety` 和 Proxy 类型检查通过。新增断言使总测试数增加 18；首次失败不是对生产 503 规则的回退理由。

这是本机 Node 与合成供应商夹具的回归证据。真实 Workers、中间代理与供应商内部重试、并发共享预算、上游实际接受/计费及持久财务仍待验收；C02.5／6／G 保持开放。

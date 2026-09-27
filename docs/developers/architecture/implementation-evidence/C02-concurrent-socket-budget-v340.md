# C02 v340：并发模型与 Key 链共享物理发送预算

2026-09-25；**本机 Node HTTP 回环子集通过，C02.5／C02.6／C02.G 继续开放。** [机器摘要](./C02-concurrent-socket-budget-v340-results.json)固定测试源码与边界。没有供应商请求、远端 SQL 或部署。

在 `request-dispatch-budget.test.ts` 增加同一请求预算的并发夹具：8 条模型／Key 候选链同时进入发送前回调，每条链有 2 个候选，共 16 条合成路由。使用真实 Node `fetch` 向本机 HTTP 服务发送完整 POST，服务端先返回两次明确 429，并在收到第三次完整正文后断开连接。每条路由有独立模型名和合成凭据。

服务端共收到 **3 次完整 POST**、3 个不同模型名和 3 个不同 Bearer 凭据；共享预算只消费 3 个许可。第三次发送的结果保留为 `upstreamOutcomeUnknown`，其链禁止 failover；其余 7 条链返回 `gateway.dispatch_limit_exceeded`，没有第九次发送前准入。该用例直接观察 socket 正文数量，不仅统计 mock fetch 调用。

新用例 **1/1 PASS**；`request-dispatch-budget.test.ts` 全文件 **12/12 PASS**，Proxy `test:dispatch-safety` 合并回归 **4292/4292 PASS**，专项类型检查和定向 `git diff --check` 通过。测试文件已由该脚本收集，Linux CI 尚未运行。

这里仅证明单进程内、共享同一个预算对象的并发 Node 路径；并未证明多 Worker 实例、真实 Cloudflare／中间代理、供应商内部重试、上游是否接受或计费、持久财务写入。C02.5／6／G 不据此勾选。

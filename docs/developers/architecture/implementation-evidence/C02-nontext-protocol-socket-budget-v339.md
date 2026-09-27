# C02 v339：Images 与向量公开入口的真实发送上限

2026-09-24；**本机 Node HTTP 回环子集通过，C02.5／C02.6／C02.G 继续开放。** [机器摘要](./C02-nontext-protocol-socket-budget-v339-results.json)固定测试源码与边界。没有供应商请求、远端 SQL 或部署。

承接 [v338 四类文本入口](./C02-text-protocol-socket-budget-v338.md)，新增公开 `/v1/images/generations`、`/v1/embeddings`、`/v1/rerank` 的物理 socket 用例。每个入口配置同一模型的 40 条候选路由及不同的合成上游凭据，使用真实 Node `fetch` 向本机 HTTP 服务发出 POST。服务端完整读取正文后，分别持续返回明确的 429，或在第二次 POST 后断开 socket。

三类入口的六组回环均符合请求级发送上限：全 429 各收到 **3 次**完整 POST；第二次 POST 后断线各收到 **2 次**，未发送第三次。429 只在有限预算内切换候选，公开错误为 `gateway.dispatch_limit_exceeded`；断线后不再切换，公开错误为 `upstream.server_error`。每次公开请求只有一笔终端 usage 写入。此次扩展只修改测试夹具，未发现需要修复的内层重试放大，也未修改生产 dispatch／egress 代码。

新用例 **6/6 PASS**；`request-dispatch-limit.test.ts` 全文件 **701/701 PASS**，Proxy 类型检查与定向 `git diff --check` 通过。该测试文件已由 Proxy `test:dispatch-safety` 脚本收集，工作流调用该脚本；Linux CI 尚未运行。

这里只证明这三类公开入口在本机 Node 传输与 40 条候选路由配置中的物理 POST 上限。其他音频协议、并发共享预算、真实 Workers／Cloudflare／中间代理及供应商内部重试、上游实际接受/计费和持久财务写入仍未验收，不能据此勾选 C02.5／6／G。v338 的测试源码 SHA 是当轮历史快照，本轮扩展后的源码 SHA 以本页机器摘要为准。

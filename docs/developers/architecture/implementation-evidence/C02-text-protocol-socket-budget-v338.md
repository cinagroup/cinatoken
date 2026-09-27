# C02 v338：四类公开文本协议共享真实发送上限

2026-09-24；**本机 Node HTTP 回环子集通过，C02.5／C02.6／C02.G 继续开放。** [机器摘要](./C02-text-protocol-socket-budget-v338-results.json)固定本轮测试源码和边界。没有供应商请求、远端 SQL 或部署。

承接 [v337 Chat 回环](./C02-outer-inner-socket-budget-v337.md)，同一真实 socket 夹具现在覆盖 `/v1/chat/completions`、`/v1/completions`、`/v1/responses` 和 `/v1/messages`。每个入口配置 5 个外层模型、合计 162 条路由和独立的合成上游凭据。服务器完整读取每次 POST 正文后，分别返回 429 或在第二次 POST 后断开 socket。夹具使用原生 Node `fetch`，按服务端实际收到的正文计数；Messages 的凭据位于 `x-api-key`，其余三类使用 `Authorization`。

四个入口的八组回环均符合相同边界：全 429 仅有 **3 次**完整 POST；第二次 POST 后 socket reset 仅有 **2 次**，没有第三次。模型顺序与凭据均对应实际候选路由；公开错误分别为 `gateway.dispatch_limit_exceeded` 与 `upstream.server_error`，每次公开请求只有一笔终端 usage 写入。扩展只修改测试夹具，没有改变 dispatcher 或 egress 生产代码。

`request-dispatch-limit.test.ts` 全文件 **695/695 PASS**，Proxy 类型检查与定向空白检查通过。该测试文件已由 Proxy `test:dispatch-safety` 脚本收集，工作流调用该脚本；Linux CI 尚未运行。这里只证明这四类公开文本入口在本机 Node 传输中的物理 POST 上限。其他协议、并发共享预算、真实 Workers／Cloudflare／中间代理和供应商内部重试、上游实际接受/计费及持久财务写入仍未验收，不能据此勾选 C02.5／6／G。

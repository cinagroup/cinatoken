# C02.6：文本驱动的隐式重定向请求放大

版本：Checklist v1.132；日期：2026-09-09。本地修复与回环验证；没有部署。C02.G、容量门禁及完整实施目标保持未完成。

## 1. 发现与最小修复

检查当前四个文本驱动发现：真实 fetch 未指定 redirect 策略。回环服务先返回重定向，目的端点记录收到的请求；不通过 mock fetch 返回值模拟重定向。80 个直接驱动用例逐个复现“消费 1 个许可，但发出原请求与重定向请求共 2 次”，另 16 个完整 dispatcher 用例也失败。16 个原有显式 429/503 上限场景通过。缺口直接对应 C02.6，而非容量池的间接证据。

修复只在 OpenAI Chat、Responses、Anthropic、Gemini 的初次文本 POST fetch 增加 `redirect: 'error'` 与说明注释。四份修复前源文件已按字节归档，校验器验证移除此两行后与原版完全相同。未修改预算算法、成功计量、SSE 解析或 Images 结算点。

重定向 fetch 异常继续走既有 unknown / 禁止 failover 处理，不退还许可。没有手工跟随 Location，也不把未知结果当成“供应商未接受”。公开规则见 [文本上游重定向策略](../../reference/upstream-redirect-policy.md)。

## 2. 可复现测试

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 packages/proxy/src/services/egress/text-redirect-wire.test.mjs
```

112 项同一测试源码的修复前后对照：修复前 16 PASS / 96 FAIL；修复后 112 PASS / 0 FAIL。覆盖如下：

- 80 项：四种文本协议 × 301/302/303/307/308 × stream 开关 × 同源/跨端口重定向；目的端点必须零请求，原 POST 只一次，permit=1，错误标记 unknown。
- 16 项：四种协议 × 307/308 × 候选 4/40；真实 dispatcher 不跟随重定向、不换下一个候选，permit=1、failoverForbidden。
- 16 项：四种协议 × 429/503 × 候选 4/40；实际服务器收到的 POST 始终只有 3 次，返回 dispatch_limit_exceeded。

所有端点仅绑定动态 `127.0.0.1` 端口，重定向目标也只由夹具指向这两个回环服务。凭据/正文均为合成数据，测试结束关闭自有 socket 与 server。没有真实 OAuth/KMS、数据库或供应商调用。测试不是 Workers 原生运行、真实账务或容量验证。

首次采集器未显式指定 TAP，Node 输出采用 spec 格式，计数解析错误地记录为 0；原日志仍保留 112 项实际结果。修正采集器指定 TAP 后再次运行修复前测试，得到可解析的 16/96 结果；未改变测试内容或源文件。首次错误报告不得作为“没执行测试”的依据。

新增独立 CI workflow 收集本套测试，不修改旧冻结 package.json / workflow。远程 CI 本轮未运行；仅有配置不计为 CI PASS。

更大范围 dispatch 回归 **2,799/2,799 PASS**（包含新增 112 项），dispatch-safety 与 staging 两项类型检查 PASS。实际命令、输出和摘要写入[机器证据](./C02-text-redirect-v233-results.json)，不沿用上轮 2,439 项作为本轮重跑数量。1,975 条历史记录经四条显式源归档映射核验；加本轮源码、测试、原始输出和说明，共 1,997 条摘要记录。

## 3. 同实例观察评估与有限顺序

v232 已证实独立 Upgrade 的八次原始响应均为外部逻辑实例。当前容量池只保留数字，`retainCapacityUntilSettled` 在原 Promise 的 finally 归还；`scheduleBackgroundWork` 把原拥有者传入 waitUntil。固定 host-expiry 探针暂停于真实持久化 marker 之后，现有 Node 测试通过人为终结 ACK 来归还；这不是平台取消必定执行 finally 的证据。

| 方案 | 当前证据及结论 |
| --- | --- |
| 增加 HTTP/Upgrade 发现次数 | 平台无同实例路由保证，停止继续碰撞式试验 |
| `ctx.exports` loopback | 文档规定其为自动服务绑定；没有在所查文档找到“固定原请求实例”的保证，不能据名称认定具有实例亲和性 |
| 从原请求返回 RpcTarget 观察句柄 | RPC stubs 受执行上下文生命周期约束，原客户端终止可能取消 server context；延长原上下文又会改变待测取消边界，不作为直接等价替换 |
| 新增 Durable Object 或替换运行时 | 需要新资源/执行边界决策；即使可固定对象身份，也不自动证明原 stateless Worker 的内存池已释放；本轮未新增或切换 |

依据：[Workers 分布式执行](https://developers.cloudflare.com/workers/reference/how-workers-works/)、[ctx.exports](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)、[RPC 生命周期](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)。这里只排除无证据的直接替换，不宣称证明了所有确定性观测办法不可能。

因此继续保持容量池生产禁用；在同一 C02 工作包内先完成可独立验证的“真实出站次数 / 内层重试”缺口，不跳过 C01 决策、不提前开展后续生产启用。下一项核对其他驱动的内层发送及 Gemini 头前取消/断连 drain 的现有合同；不能仅据本轮重定向通过将 C02.2/5/6/G 全部勾选。

Workers 最佳实践技能促使本轮先查当前文档/类型，并拒绝把未证实的 loopback/RPC 生命周期当作原生容量证据。官方 npm 只读确认当前类型版本 5.20260908.1；未升级依赖。默认 npm 镜像的受限网络查询失败后改查官方注册表，未产生 staging API 调用。

## 4. 证据版本与云端边界

历史 v232 清单/结果/日志/产物不修改。四个源路径现在是修复后的工作树；新清单显式把历史四条摘要映射到修复前归档，并登记当前四份源码摘要。不能再直接拿旧 CLI 的当前路径摘要校验发布新源码：它应拒绝源漂移；新部署必须重新冻结、构建和验证。旧云端 bundle 本身没有变化，也不是已包含本修复。

本轮新增 staging 管理调用、公开 HTTP、模型、KMS、生产写入和部署均为 0。首轮累计公开 HTTP 仍 422、模型/KMS 0/0、US$2 不重置。最后关闭读回仍为 v232 的 2026-09-09T06:45:06.937Z，本轮未重新核验远端隔离或最终增量账单。原 v232 FAILED 容量结论保留。

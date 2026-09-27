# C02 v337：公开请求跨模型／多 Key 的真实 POST 上限

2026-09-24；**Node 本地子集通过，C02.5／C02.6／C02.G 继续开放**。[机器摘要](./C02-outer-inner-socket-budget-v337-results.json)固定源码、测试和边界。

## 风险与夹具

公开 `/v1/chat/completions` 的 `models` 候选经外层模型 fallback，再进入每个模型的路由／Key fallback。新增真实 Node HTTP 回环，配置 5 个模型共 **162 条**路由（每模型 2／40／40／40／40），每条路由使用不同的合成凭据。服务端读完每次 POST 正文后才返回 429 或断开 socket；夹具使用原生 `fetch`，只允许精确 loopback origin，按到达服务端的请求而非 `fetch` 调用数计数。DB 仓储为合成读取与日志 sink，不证明财务持久化。

- 全 429：服务端收到 **3 个**完整 POST，顺序为模型 0 的两条不同 Key 路由、模型 1 的第一条路由；第 4 条及其余 159 条均未发送。公开响应 `gateway.dispatch_limit_exceeded`，一笔终端 usage 写入。
- 第一次 429、第二次读完 POST 后 reset socket：服务端收到 **2 个**完整 POST，第三次不发送；公开响应 `upstream.server_error`，一笔终端 usage 写入。此场景验证已发送后的传输结果不明不会作为可重试的明确拒绝。

完整文件回归最初揭示一批旧夹具仍将已发送的 503 当成“明确拒绝”，期待后续授权或候选派发；这与 v333–v336 收紧的结果不明分类冲突。将 `known-then-*` 的合成响应改为明确 429，并将文本外层预算用例改名 `clear-429`。这些修改仅在测试夹具，保留其原有“明确拒绝后受限继续”的语义。

## 验证与边界

- `node --import tsx --test --test-reporter=tap src/routes/v1/request-dispatch-limit.test.ts`：**689/689 PASS**，包含新增 2/2 回环和原有协议、取消、结算用例。
- `npm run typecheck -w @octafuse/proxy`：PASS。测试文件已在 Proxy `test:dispatch-safety` 与 `test:unit` 脚本内；GitHub `proxy-dispatch-safety.yml` 调用前者，**Linux CI 未运行**。
- 当前 `failover-dispatch.ts` 与 `request-dispatch-budget.ts` 未修改。只证明该公开文本 Node 路径的 HTTP 请求数；其他协议、并发共享预算、真实 Workers／Cloudflare／中间代理、供应商内部接收与计费、SDK 辅助调用的全部层次仍需逐项验收。C02.5／6／G 保持开放，不据此放行大池。

本轮没有供应商、远端 SQL、部署或云调用。

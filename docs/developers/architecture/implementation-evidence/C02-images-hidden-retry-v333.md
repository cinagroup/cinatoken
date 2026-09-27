# C02 v333：Images 隐藏重发与 3xx 结果边界

2026-09-24；**本地子集通过，C02.5／C02.6／C02.G 仍未完成**。[机器摘要](./C02-images-hidden-retry-v333-results.json)固定测试与源码摘要。

Images generations／edits 的一次 POST 在收到 3xx、408、499 或 5xx 后，不能仅凭 HTTP 状态确认供应商没有接收工作。驱动现在把这些状态标记为 `upstreamOutcomeUnknown` 和 `failoverForbidden`；响应正文读取失败也保留同一判断。明确的 400／401／429 仍作为拒绝处理，合法候选切换继续受请求级 dispatch 预算限制。出站 `fetch` 与 GCP OAuth 获取继续使用 `redirect: 'manual'`，Images 路径没有另套 SDK 调用。

**修复前反例：**实际 Node 回环服务在接收完整 Images POST 后返回 307。手动重定向确实没有访问 `Location`，但把两个 route 置于不同 `gatewayCandidateIndex`、开启 `crossModelCandidateFailover` 时，dispatcher 对 generations／edits 各向原入口发送 **2 次 POST**。当时定向测试 **0/2**，两项均因观测数 `2 !== 1` 失败；该失败输出来自修改前的本地命令，未另存原始日志。

**修复后：**相同真实回环配置在两个操作中均只发送 **1 次 POST**，重定向目标访问 **0 次**，消耗 **1 个** dispatch permit，结果标为 unknown。另一个回环用例在服务端接收完整请求后直接断开 socket，两个操作的内层 Node `fetch` 与外层 dispatcher 均未再次发送。Hono 公开路由对上游 307 返回不含 `Location`／目标密文的 **502**，带 `outcome_unknown:true`、`retry_safe:false`。合成两候选测试覆盖 300／301／302／303／307／308／408／499／500／503／524 的停止行为，同时证明明确 429 可在预算内使用下一候选；驱动正文超限夹具覆盖 307／503 的 unknown 标记。

运行 `npx tsx --test --test-reporter=tap src/services/egress/image-request-lifecycle.test.ts src/services/egress/openai-images-driver.test.ts src/routes/v1/image-request-lifecycle.test.ts`：**561/561 PASS，9 suites，0 fail**。`npm run typecheck -w @octafuse/proxy` 与 `git diff --check` 通过。三份测试已列入 Proxy 的 `test:dispatch-safety` 脚本，Linux [CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)调用该脚本；本轮尚无 Linux CI 运行结果。

这些回环和合成测试不证明真实 Workers／Cloudflare 底层、任何中间代理或供应商内部没有重试，也不证明供应商实际接收／计费结果。全出口 SDK/HTTP 重试盘点、生产环境观察及 C02.G 全失败／取消／断流与容量验收仍需继续。没有远端供应商调用、部署或云资源写入；生产 PostgreSQL recovery 仍禁用。

# C02 v336：文本 POST 与 Realtime 握手的隐藏候选重发

2026-09-24；**本地子集通过，C02.5／C02.6／C02.G 继续开放**。[机器摘要](./C02-text-realtime-hidden-retry-v336-results.json)固定测试、源码摘要和边界。

## 发现与修复

四个文本出口（OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini generateContent／streamGenerateContent）都使用原生 `fetch`，以 `redirect: 'error'` 阻止内层 3xx 跳转，并把 fetch 拒绝标记为结果不明。但收到完整 **503** 响应时，它们原样返回无 `meta` 的错误，外层 `failoverDispatch` 将其当成可重试的明确拒绝。新真实 Node 回环测试中，服务端完整收到第一个 POST 后返回 503；两个候选各发一次，四个协议均为 **2 次 POST**。408／499 路径因现有分类只发送一次，但同样缺少 `upstreamOutcomeUnknown` 标记，不能作为已确认拒绝记账。

DashScope Realtime 的 Node `ws` 和 Worker Upgrade 出口均先建立一次有上游副作用可能的连接；握手拒绝共用 `realtimeRejectedResponse()`。原有四种操作 × 两种 runtime 的合成夹具明确把 503 验收为 **3 次连接**（12 个候选、3 次硬预算），即同样在未知结果后候选重连。

新增共享状态分类：**3xx、408、499、5xx** 在已派发的文本 POST 或 Upgrade 握手后带 `upstreamOutcomeUnknown=true` 与 `failoverForbidden=true`。文本 503 的四个真实回环各降至 **1 次 POST**；Realtime 503 的八个 Node／Worker 场景各降至 **1 次连接**。文本 408／499 的结果标记补齐；Node 原生 302／503 未完成握手的回环仍只建立一次并释放 socket。400／401／429 保持明确拒绝，其中文本 429 在两个候选且预算允许时仍是两次受控 POST。Node `ws` 继续设置 `followRedirects: false`，Worker Upgrade `fetch` 继续设置 `redirect: 'manual'`。

## 验证

- 新文本真实回环 20/20；原有文本重定向／大量候选回环 112/112，更新 503 的预期为一次。两套覆盖原生 Node HTTP socket 与真实 `fetch`，不调用供应商。
- Realtime 两 runtime 四操作的握手／中止／资源专项及原生 Node `ws` 回环合计 194/194；新增 14 个状态矩阵断言。原有共享绝对期限测试改用明确 429 拒绝继续验证候选间不续期。
- 文本驱动、JSON 与准入边界 24/24；上述八份文件合并 **350/350 PASS**。登记后的 `test:text-stream` 脚本 **188/188**（与前述文件有重叠）。Proxy TypeScript 检查与定点 `git diff --check` PASS。
- 新文本测试与既有重定向测试已登记到 Proxy `test:dispatch-safety`、`test:text-stream`、`test:unit`；Realtime 原有专项仍在 dispatch-safety。并行 C04 新测试也依主任务要求登记到 dispatch-safety/unit。**本轮未运行 Linux CI**。

## 出口审计边界

`proxy.ts` 的模型出口包含四个文本 driver、embeddings/rerank、Images generations/edits、OpenAI transcription、DashScope 同步／异步 ASR 与 multimodal、四个 TTS adapter、DashScope Realtime Node／Worker。近轮证据覆盖了各族已发现的候选隐藏重发；本轮重点闭合文本和 Realtime 握手状态分类。DashScope 异步作业后的查询为 GET；其提交 POST 已在音频专项内处理。Proxy 的告警 Webhook 另有直接 `fetch` POST，其重定向问题在[同轮独立证据](./C02-webhook-redirect-v336.md)中修复。`@octafuse/core` 辅助调用、工具引擎、真实 Workers／Cloudflare 传输、中间代理与供应商内部重试仍未获得全层发送计数验收。不能由本地一次请求推断供应商只接收或计费一次。

C02.5／C02.6／C02.G 及生产放行保持开放。本轮无远端供应商调用、云资源写入或部署。

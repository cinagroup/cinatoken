# C02 v335：TTS 出口的隐藏候选重发边界

2026-09-24；**本地子集通过，C02.5／C02.6／C02.G 仍未完成**。[机器摘要](./C02-speech-hidden-retry-v335-results.json)固定本轮场景、测试和源码 SHA256。

OpenAI speech、DashScope SpeechSynthesizer、Qwen TTS 和 MiniMax TTS 经同一 `audio-request-lifecycle` 调用原生 `fetch`；该层已强制 `redirect: 'manual'`，没有另套供应商 SDK。实际缺口在外层候选调度：供应商完整收到 POST 后返回 **3xx、408、499、5xx**，TTS 驱动仍把状态当作明确拒绝，允许再次发送到下一候选；这些状态的响应正文读取异常也可能丢失结果不明事实。现在四个 adapter 在这些状态下设置 `upstreamOutcomeUnknown` 和 `failoverForbidden`，包括读体失败路径。**400、401、429** 仍为明确拒绝，429 可在请求级有限预算内切换候选。

修复前用真实 Node 回环服务完整接收 POST，分别返回 307 或 503；两个候选具有不同 `gatewayCandidateIndex`，开启 `crossModelCandidateFailover`。四个 adapter × 两个状态共 **8 个场景**，每个都观察到 **2 次 POST**。307 的 `Location` 目标访问均为 **0**，证明并非内层 fetch 自动跟随，而是外层重发。新增测试修复前为 **4/16 通过、12/16 失败**：8 个回环断言及四个状态矩阵断言失败；失败输出仅在本地观察，未另存原始日志。

修复后相同 8 个回环场景各仅 **1 次 POST**，307 目标仍为 **0 次**。状态矩阵覆盖 300／301／302／303／304／307／308／408／499／500／503／524，并检查 400／401／429 的明确拒绝；307／503／400／429 的读体异常分别核验结果边界。真实回环的 429 再切换 1 个候选，合计 2 次受控 POST。公开错误规范化把 307 变为安全 502、保留 503 状态，均不透传 `Location` 或供应商错误细节。

运行六份 TTS 驱动／生命周期／上传资源／公开音频路由定向文件，合计 **390/390 PASS**；新回归单独 **16/16 PASS**。`npm run typecheck -w @octafuse/proxy` 和 `git diff --check` 通过。新回归已登记到 Proxy 的 `test:dispatch-safety` 与 `test:unit` 脚本；本轮未修改 CI 工作流，也没有这些修改的 Linux CI 运行结果。

本地回环无法证明真实 Workers／Cloudflare 传输层、中间代理或供应商内部不会重试，也不能判定供应商实际接收或计费结果。其余出口与全失败／取消／断流、请求总预算、生产观测仍需验收；C02.5／C02.6／C02.G 保持开放。无远端供应商调用、部署或云资源写入。

# C02 v334：音频与向量出口的隐藏重发边界

2026-09-24；**本地子集通过，C02.5／C02.6／C02.G 仍未完成**。[机器摘要](./C02-audio-vector-hidden-retry-v334-results.json)固定测试、源码和 CI 摘要。

四个真实 Node 回环反例均先完整接收一次 POST，再返回 HTTP 状态：OpenAI transcription 的 307 从 **2 次 POST 降至 1 次**；DashScope 同步 ASR 和异步任务提交的 307 各从 **2 次降至 1 次**；embeddings 与 rerank 的 503 各从 **2 次降至 1 次**。307 用例的 `Location` 访问均为 0，说明内层 `fetch` 使用手动重定向，但外层候选调度曾重新发送。修改前的断言失败输出仅在本地观察，未另存原始日志；本轮未调用真实供应商。

OpenAI audio、DashScope 同步／异步 ASR 与 native multimodal、embeddings、rerank 在已发送 POST 后收到 **3xx、408、499、5xx** 时，现标记 `upstreamOutcomeUnknown` 与 `failoverForbidden`；正文超限／读取异常也保留相同边界。**400、401、429** 继续作为明确拒绝处理，429 的有限候选切换有回归测试。DashScope 异步任务已被接受后的轮询／结果下载继续禁止第二次付费提交。音频请求使用 `redirect: 'manual'`；向量请求也使用手动重定向。上述路径直接调用本地 `fetch`，没有另一套供应商 SDK 重试层。

五份驱动／生命周期定向测试合跑 **202/202 PASS，13 suites，0 fail**（OpenAI audio 35、DashScope 33、ASR 生命周期 109、embeddings 13、rerank 12）。音频公开路由另测 **23/23**；`npm run test:embeddings` **33/33**、`npm run test:rerank` **16/16**、向量资源／上传定向测试 **75/75**。`npm run typecheck -w @octafuse/proxy` 和 `git diff --check` 通过。

当前工作树中的 [Proxy dispatch safety CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)通过 `test:dispatch-safety` 运行三份音频测试，并直接运行两份向量驱动测试；直接向量命令本地 **25/25** 通过。工作流还登记了同轮 C04 收益修复的定向测试；其 SHA256 为 `5194365065acd4279634a35b313419a8f4662d03abaf46e529e6cac97e8b9127`。该工作流文件目前未被 Git 跟踪，**尚无针对这些修改的 Linux CI 结果**。

本地回环无法证明 Workers／Cloudflare 传输层、中间代理和供应商内部不会重试，也不能证明真实接收或计费结果。其余出口、生产观测及 C02.G 全失败／取消／断流与容量验收仍需继续；无部署或云资源写入。

# C02.B2.2 — 请求级辅助认证次数预算

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；C02.B2.2 / C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续 [OAuth 生命周期证据](./C02-oauth-lifecycle.md)，不覆盖历史快照。此次修复现有上游 service-account OAuth 的跨候选请求放大，不是 Google Cloud KMS adapter 实现。并行处理的用户输入及 GCP 只读就绪结果另见 [C01 选型记录第 5 节](./C01-google-cloud-kms-selection.md)。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。开始时 100 个修改/未跟踪文件已取摘要；结束核验中 79 个不变、21 个仅有本轮预期变更、0 个意外改变。另新增两份 Core 源码/测试及本报告/快照。20 个本轮源码/配置文件与 9 个相关未改动文件的 SHA-256 见[受测快照](./C02-auxiliary-auth-budget-snapshot.json)，不是仅用 HEAD 代表脏工作树。

## 1. 已实现合同

| 边界 | 实际行为 / 证据 |
| --- | --- |
| 两类独立预算 | 原每请求最多 3 次推理发送许可不变；新增最多 3 次辅助认证 exchange。本地安全默认，可由内部调用收紧、不能提高，不等于生产 SLO 或财务批准 |
| 请求所有权 | `createRequestDispatchBudget` 持有独立 `auxiliaryAuth` 对象；已有文本入口只创建一次，同一个对象穿过普通模型循环、partition=none 全局调度和共享/BYOK 凭据展开。没有全局请求计数或以 signal 为键的共享状态 |
| 精确计数位置 | 冷缓存才检查预算，私钥签名前可早停；在 OAuth 生命周期检查之后、实际 fetch 紧邻处同步 claim，异步签名后再检查防并发超支。认证超时、取消、HTTP/transport 失败不退还已经 claim 的许可；签名前失败/预取消不 claim |
| 缓存与普通 Key | 普通 API Key、仍有效的完成 token 缓存命中无需新认证许可；即使认证预算用完仍可处理该类候选。缓存过期或换身份不能重置请求预算 |
| 失败性质 | Core 保留固定的 `RequestAuxiliaryAuthLimitError`，不被 OAuth 通用脱敏错误吞掉。dispatcher 返回 502 / `gateway.auxiliary_auth_limit_exceeded`，设置本地生成、当前 attempt 未发送、禁止继续回退；不因认证上限将推理标为 unknown、触发准入、禁用共享 Key 或打开供应商熔断 |
| 公开协议 / 可观测性 | Chat、Responses、Anthropic 对应错误外形与关联 ID 保留；快照包含推理与认证两个计数。停止日志只有稳定原因与计数，无 credential、账号、JWT、私钥、原始 OAuth 正文 |
| 已发生推理 | 成功认证后如模型实际 fetch 失败且结果未知，仍立即停止；不把认证失败与已发送推理混为一谈，也不退还推理许可或抹掉既有 unknown |

核心文件：[认证预算](../../../../packages/core/src/request-auxiliary-auth-budget.ts)、[token 交换](../../../../packages/core/src/gcp-service-account-token.ts)、[请求预算](../../../../packages/proxy/src/services/request-dispatch-budget.ts)、[dispatcher](../../../../packages/proxy/src/services/failover-dispatch.ts)、[协议转发](../../../../packages/proxy/src/services/proxy.ts)。

采用 Workers 最佳实践技能后，将计数显式放在请求所有者并通过参数传递，不引入跨请求可变计数/I/O；同步检查与 claim 中间没有 await。已刷新 [Cloudflare 官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，最新版 npm 类型查询仍被 EACCES 拒绝，按技能回退已安装 Workers types **5.20260829.1**。检查了相关 AbortSignal 类型和本机 Wrangler schema/config；未修改兼容日期、flags、bindings、依赖或部署配置。

## 2. 调用链覆盖与未覆盖范围

| 调用方 | 本轮状态 |
| --- | --- |
| Chat / Legacy Completions / Responses / Messages | 请求级预算已接入；`/v1` 与 `/api/v1`，普通模型循环及全局 partition=none 均跑真实 Hono/planner/dispatcher/driver 链，外部 HTTP 与仓储行为为合成 fixture |
| Gemini proxy / driver | 已传认证预算，单次 proxy 内的凭据回退受限；未由此证明 Gemini 总请求 deadline、已接受 SSE drain 或入口取消均完成 |
| 共享池 + 私有 BYOK | 实际运行展开逻辑，验证 primary → shared → platform → fallback 共用一次预算，不因换 Key 换计数器 |
| Embeddings / Rerank | 现有两个 OAuth 调用尚未传请求预算/signal；下一步首先接入并按各自准入/响应合同验证 |
| Images generations/edits；Audio speech/transcriptions；DashScope ASR/Realtime | 尚未逐调用接入；不以推理默认 3 次推断认证预算已全面覆盖 |
| Node realtime；管理 Playground | 独立请求所有权合同仍待接入/验证；本轮未修改 Admin 工作树 |
| 其他辅助 I/O / 未来 KMS | 不由当前 OAuth 计数替代 KMS、数据库、探测或 SDK 内部重试的独立预算；未来实现仍需显式接入与验收 |

源码检索现有 17 个非测试应用 OAuth 调用点，其中上述 4 个文本 driver 已传预算，另 13 个调用点尚未传入（不包括 Core 定义和 workerd 测试 fixture）。表中未接入路径的认证快照为默认值，不可据此推断其真实网络调用为零。此前全池读取/解密和本地签名失败的准备放大尚未消除；本轮上限针对认证网络发送，不是 Top-K 调度验收。

## 3. 验证结果

环境：Windows / Node **24.14.1**。新增 **39 项**测试：Core **6**、Vertex egress **17**、文本 API 入口 **16**。未删除或跳过既有测试；仅更新旧推理预算快照断言以包含新的独立认证计数。

- Core：非法上限、不可变快照、20 个并发冷交换仅发 3 次、不退款、有效/过期缓存、普通 Key、预取消/签名失败不计数、跨请求隔离。
- Proxy：32 个候选、多次模型调用、认证成功缓存后的推理上限、unknown 不重放、Gemini 零准入、真实共享/BYOK 展开与耗尽后免认证候选。
- API：4 个入口 × 2 组路径 × 2 种 partition，均认证 3 次、推理 0 次、协议正确的单一终态和一次用量记录。fixture 仅接受零费用日志/统计 SQL，不是生产金融持久性证明。

| 最终命令 | 结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0，包含新增 Core 测试及两个 Proxy 测试文件 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest / test 生命周期退出 0；最终主套件 **852 tests / 134 suites，852 通过** |
| `npm.cmd run test:unit -w @octafuse/core` | 完整 pretest / test 生命周期退出 0；最终主套件 **372 tests / 70 suites，372 通过** |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | **358 tests / 23 suites，358 通过**，退出 0 |
| `git diff --check` | 退出 0 |

成功套件均 0 失败/取消/跳过，计数相互重叠。最初定向集 134 项、首次专项 356 项通过后，又补 2 个“预算耗尽但普通 Key/缓存仍可用”用例，上表是最终代码的结果。类型检查最终重跑通过。

新增 Core 测试已进入 Core 主套件与 Proxy 专项脚本，现有 Vertex/API 文件继续由 Proxy 主套件、专项及专项类型检查收集。没有仅写用例却不接入收集器。没有重新尝试无外部条件变化的 workerd 启动：此前完整 OAuth fixture 与最小空 Worker 均 `0xc0000005 / ERR_RUNTIME_FAILURE`、未达到断言，故当前 Workers/Node 22 门禁仍为未验证；没有触发远程 CI 来替代记录。

## 4. 下一步、停止与授权边界

下一项仍为 **C02.B2.2**：先补 Embeddings/Rerank，再 Images、音频/Realtime 和独立管理调用，保持每个请求的同一辅助认证 owner；随后推进数据库边界、headers/有效 TTFT/idle。SQL 物理取消/持久写入超时恢复、Top-K 凭据读取、真实 Workers/DB、配额与生产 SLO 仍需验收。C02.1–C02.7 的复合条目及 C02.G 保持未勾选，C03–C20 不冒充完成。

停止条件：认证上限被回退重置、超出上限出站、认证失败误计为推理 unknown/资金准入、泄漏凭据或缓存跨身份复用。修复时不恢复无界认证/正文、全局未完成 I/O 或取消后的推理发送。未部署，没有生产回滚或删除数据。

本轮唯一外部操作是用户说明已登录并指定 `cinatoken` 后，经工具审批执行 GCP 登录/项目/服务启用列表只读检查；未启用 API、创建 key ring/key、改 IAM、读/导出密钥或调用 KMS Encrypt/Decrypt。测试 OAuth、模型端点、RSA 与 SQL 全为本地合成数据；没有付费模型、充值、账务更改、远端迁移或部署。

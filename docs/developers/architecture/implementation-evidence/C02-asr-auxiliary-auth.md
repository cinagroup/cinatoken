# C02.B2.2 — HTTP ASR 辅助认证、调度取消与异步任务边界

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续[图片证据](./C02-image-auxiliary-auth.md)与[请求级认证预算](./C02-auxiliary-auth-budget.md)，不覆盖历史记录。Google Cloud KMS / project `cinatoken` 已确认；本轮不重复云账号核验，不修改云资源或真实密钥。

## 1. 实现范围

- OpenAI transcription、DashScope 同步 ASR、异步 ASR 和原生 multimodal 四个 OAuth 调用点接入共享请求认证预算。认证 exchange 与推理许可分别最多 3 次，BYOK → 共享池 → 平台 → 后备 BYOK 展开及内部 proxy 调用不能重置。有效缓存和普通 Key 不消耗新认证许可。
- 两个 ASR proxy 固定从共享 dispatch budget 创建时间（未提供时为 proxy 开始时间）起算的 **120 秒绝对调度 deadline**，调用方只能收紧；跨尝试不能刷新。DashScope 原有更短 attempt timeout 保留，但不能延长请求上限。这不是上传/鉴权/路由准备全过程 deadline。
- 新请求级生命周期 helper 覆盖 OAuth、模型响应头和有界正文；取消/到期传播 signal，迟到响应取消正文，读取停止释放 reader 锁，不等待可能永不确认的 cancel。没有新增跨请求 pending I/O。
- OAuth 完成、URL 语法/协议检查及序列化/Headers 构造成功后，才在实际模型 POST 前进入既有准入和推理许可边界；POST 不自动跟随重定向。URL 检查不等于完整的 Target allowlist/SSRF 防护。
- 准入持久写入若已开始，取消后仍等待它完成/失败，再检查停止信号；写入失败原样上抛，不能变成可重试的模型异常。**未证明数据库物理取消、挂起写入能按时结束或崩溃恢复。**
- route 保留可信本地取消 499、deadline 504 与认证超限错误，不被上游错误规范化改成普通 502；标记的本地失败不触发用户模型熔断。没有据此声称所有认证失败的健康归因都已完成。

主要文件：[生命周期 helper](../../../../packages/proxy/src/services/egress/audio-request-lifecycle.ts)、[OpenAI driver](../../../../packages/proxy/src/services/egress/openai-audio-driver.ts)、[DashScope driver](../../../../packages/proxy/src/services/egress/dashscope-audio-driver.ts)、[proxy](../../../../packages/proxy/src/services/proxy.ts)、[Audio route](../../../../packages/proxy/src/routes/v1/audio.ts)、[原生 route](../../../../packages/proxy/src/routes/v1/dashscope-multimodal.ts)。

未修改 TTS、Realtime、Admin、Core、共享 dispatcher、收费 helper、依赖或 Wrangler/CI 配置；仅在既有测试脚本/专项类型检查增加收集项。

## 2. 异步任务只提交一次

提交 POST 占推理许可；任务查询 GET 与结果下载不再进入付费准入，也不被计成新的模型提交。查询最多 **120 次**，同时受原请求绝对 deadline 限制；结果下载保留既有最多 5 次重定向、HTTPS 与非 IP 字面量检查。整个重定向流程也受请求所有者限制，因此重定向正文 cancel 不确认不会无限阻塞调用方，取消后不再跟随下一跳。

任务已接受后，查询失败、下载失败、无效结果、取消/到期或查询次数用尽都不能触发重新提交。明确任务/子任务 FAILED 保留现有失败结算分类，但新增禁止重放标记；缺失、陌生任务状态或非终结子任务状态按**结果未知**处理，不能推断为零成本。明确失败是否存在上游费用仍需 C01/C05 的商业合同确认。

本轮未实现持久异步任务台账、断线后后台续查、进程重启恢复或供应商成本对账；不能把“不重复提交”解释成这些能力已具备。

## 3. 结算意图验证

ASR 不套用 Images 的取消后买家零收费规则。保留实际发送未知的诊断及现有最高额预留，等待权威核实；这不是最终向买家扣最高额的授权。

| 合成 API 场景 | 实际生成的结算意图 |
| --- | --- |
| 首次提交前认证超限、取消或 deadline | 零模型提交、无预留 |
| 明确 503 后认证超限/取消 | 一次提交，`settled / 0` |
| 无效已接受 2xx / 模型传输未知 | 一次提交，`expired / 1,500,000 micros` |
| 已接受正文后取消/deadline | 一次提交，保留 unknown，`expired / 1,500,000 micros` |
| 正常 1 秒转写成功 | 一次提交，`settled / 1,000 micros` |

金额来自合成每秒 USD 0.001 报价及 1,500 秒预留上限。fixture 经过真实 Hono/auth/planner/dispatcher/driver/admission/usage 调用链，断言 SQL 状态、金额与唯一日志/结算批次；仓储、HTTP 和密钥均为合成数据。SQL 捕获器不是实际数据库，不证明事务原子性、并发账户余额、恢复或资金到账。

## 4. 测试与修正过程

新增 **179 项**：[ASR 生命周期测试](../../../../packages/proxy/src/services/egress/asr-request-lifecycle.test.ts) **109**，[公开路由调用链测试](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts) **70**。

- 四种 ASR 路径覆盖 32 候选、多次内部调用、真实 BYOK/共享池展开、缓存/普通 Key、推理与认证独立上限、准入拒绝/写入失败、写入等待期间取消、Headers 无效和共享 120 秒 deadline。
- 客户端取消/deadline × OAuth 响应头/正文、模型响应头、已接受/明确拒绝正文；断言 signal、迟到清理、reader 解锁、cancel 无确认时仍结束以及无后续提交。
- 异步查询/下载响应头与正文、重定向 cancel 无确认、明确任务/子任务失败、120 次查询上限及四种缺失/陌生状态；已接受任务最多一个 POST。
- 公开接口：OpenAI、DashScope 同步/异步各覆盖 `/v1/audio/transcriptions` 与 `/api/v1/audio/transcriptions`；原生 multimodal 覆盖实际注册的 `/v1/dashscope/services/aigc/multimodal-generation/generation`。每条路径 10 种终态，共 70 项；原生接口没有 `/api/v1` 别名，本轮未新增路由。

两项既有 DashScope 测试按明确合同加强：准入持久化异常保持原错误身份；发送前取消禁止 failover。初轮类型检查纠正错误体 helper 的参数合同。接口 fixture 曾错误假定原生别名，且取消快失败检查的落败分支误读响应正文，均修正测试本身后重跑，没有放宽结算断言。收尾新增的四项陌生状态反例均先失败（unknown 标记缺失），修正 driver 后通过。中间通过结果不替代最后源码的完整复验。

## 5. 最终验证与基线

环境：Windows / Node **24.14.1**；仓库要求 Node **22**，该版本未运行。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `tsx --test packages/proxy/src/services/egress/asr-request-lifecycle.test.ts packages/proxy/src/services/egress/openai-audio-driver.test.ts packages/proxy/src/services/egress/dashscope-audio-driver.test.ts` | 155 tests / 9 suites，全部通过，退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest/main 生命周期退出 0；最终主套件 1,207 tests / 135 suites，全部通过 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 784 tests / 41 suites，全部通过，退出 0 |
| `git diff --check` / JSON、相对链接与哈希 | 通过 |

计数重叠，不相加；专项还新增收集既有 OpenAI/DashScope ASR 的 46 项测试，不把它们算作新写测试。Core 源码未变，未重跑完整 Core 主套件；专项仍运行其 OAuth/认证预算测试。既有 workerd 曾在断言前原生启动失败，本轮未重试或触发远程 CI，不宣称 Workers 验收通过。

Workers 最佳实践技能促使本轮沿用请求级 I/O 所有者、显式清理和有界正文，并保留持久写入的等待责任。[官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)已刷新；检查安装类型及 Wrangler schema/config。最新类型查询遇 npm EACCES，按技能回退已安装 **5.20260829.1**，未修改依赖。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。[快照](./C02-asr-auxiliary-auth-snapshot.json)保存 11 个本轮源码/测试/收集配置及 17 个关联文件的受测 SHA-256。最终受测哈希一致。对开始时 115 个 dirty/untracked 文件复核：109 个不变、6 个预期修改，无意外变化；另有 5 个此前干净的源码/既有测试变脏，新增 2 个源码/测试及本报告/快照。 C01 和历史 C02 证据保留，不以 HEAD 代替脏工作树证据。

## 6. 剩余项与安全边界

17 个应用 OAuth 调用点现已接入 **12** 个，仍有 **5** 个：TTS 2、DashScope Realtime 1、Node Realtime 1、Admin Playground 1；不计 Core 定义和测试 fixture。这个数字不代表已接入路径的完整入口、全部模态或真实平台已验收。

唯一下一实施项仍为 **C02.B2.2**：先 TTS，再 Realtime 和独立管理预览合同；随后补向量/图片/ASR 入口全过程、multipart 内存预算、路由准备和数据库取消/持久写入恢复，以及 headers/有效 TTFT/idle 时限。Top-K/全池读取解密、真实 Workers/DB/Node 22、共享市场授权、价格与 unknown 费用责任仍未完成。C02.1–C02.7 和 C02.G 不勾选，C03–C20 不声明完成。

停止条件：认证计数重置/超发、取消后新提交、异步任务重复提交、认证失败制造未知推理或预留、真实未知事实丢失、重复日志/结算、秘密泄漏。回退应关闭受影响路由或收紧候选，不恢复无界等待或删除在途结算事实。

本轮没有操作真实 OAuth/模型/KMS、启用 API、修改 IAM/默认项目、迁移、部署、付款或删除数据。用户提供的 project `cinatoken` 已在 [KMS 决策记录](./C01-google-cloud-kms-selection.md)登记；location、保护级别、服务身份和 IAM 仍待确认。


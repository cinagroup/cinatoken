# C02.B2.2 — TTS 辅助认证、流生命周期与结算边界

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续 [HTTP ASR](./C02-asr-auxiliary-auth.md)和[认证预算](./C02-auxiliary-auth-budget.md)证据，不覆盖历史结果。Google Cloud KMS / project `cinatoken` 已确认；区域、保护级别和真实 IAM 未冻结，本轮未重复账号核验或操作云资源。

## 1. 实现范围

- OpenAI Speech 与共享的 DashScope TTS 函数两个 OAuth 调用点接入请求级认证预算，覆盖 OpenAI、SpeechSynthesizer、Qwen、MiniMax 四种驱动。OAuth exchange 与推理许可分别最多 3 次；BYOK → 共享池 → 平台 → fallback BYOK 和内部多次 proxy 调用不能重置。有效缓存/普通 Key 不消耗新认证许可。
- TTS proxy 采用从共享 dispatch budget 创建（没有共享预算时为 proxy 开始）起算的 **300 秒绝对调度/流总 deadline**。调用方可收紧，跨尝试不能刷新；这是新增本地安全上限，不是已获批准的生产 SLO，也尚未覆盖入口上传、鉴权、Guardrail 和路由准备全过程。
- 复用 ASR 的请求级 I/O 所有者：OAuth 完成、URL 语法/协议验证、请求序列化和 Headers 构造成功后，才在实际模型 POST 前执行既有准入/推理许可。POST 使用 manual redirect；不把 URL 语法验证当作完整 Target allowlist 或 SSRF 防护。
- 准入持久写入开始后仍由请求等待其完成/失败，再检查取消；持久化异常原样上抛，不能伪装成模型失败并重试。未证明挂起写入按时结束、数据库物理取消或崩溃恢复。
- 明确非 2xx 错误正文限制为 **64 KiB**，不信任 Content-Length。错误正文停止/超限不抹掉已知 HTTP 失败事实；模型已发送但响应未知或无效 2xx 不得重放。
- 新 TTS 流所有者在客户端取消、总时限、协议失败或终态时，只完成一次 usage；即使客户端停止读取、底层 cancel 永不确认，也能本地结束计量并释放 reader 锁。父请求取消/时限传到 fetch signal；下游 body.cancel 直接取消 reader，不声称合成测试证明物理网络已关闭。
- OpenAI SSE 的有效 `speech.audio.done`、DashScope 对应终态能完成流，不再等待 HTTP EOF/取消确认。音频正文与 SSE 保持原映射；明确的本地协议错误可保留稳定描述，陌生传输/解析异常使用脱敏错误，不输出底层异常正文。
- 克隆音频的分块上传源提供显式停止操作：fetch 仍持有 reader 时，收到最终响应或取消也能停止继续生成 Base64；不依赖会因 locked 而拒绝的 body.cancel。保留已有引用能力/Guardrail 门禁，不新增克隆权限。
- Audio route 保留可信本地 499/504/认证超限错误，并跳过标记的本地失败的用户模型熔断。公开 SSE 已返回 200 后发生的取消仍表现为流错误，不声称能改写已发出的 HTTP 状态。

主要文件：[TTS driver](../../../../packages/proxy/src/services/egress/audio-speech-driver.ts)、[流所有者](../../../../packages/proxy/src/services/egress/audio-speech-stream-lifecycle.ts)、[proxy](../../../../packages/proxy/src/services/proxy.ts)、[Audio route](../../../../packages/proxy/src/routes/v1/audio.ts)。

本轮只修改 TTS 对应源码段、测试及测试收集配置。Core、共享 dispatcher、ASR driver/helper、Images、Realtime、Admin、计费 helper、Wrangler/CI 配置、依赖和 V2.1 原方案未修改。

## 2. 公开格式缺口：Qwen 不冒充可用

实测发现既有约束不相交：Qwen adapter 只接受 WAV，而公开 `/audio/speech` 解析器只接受 MP3/PCM。**Qwen 的 driver 生命周期通过，不代表公开 Qwen TTS 已接通。**

新增 6 个 API 反例覆盖两个前缀 × MP3/PCM/WAV：MP3/PCM 没有可兼容 Qwen 路由，返回 502；WAV 在公开请求校验返回 400；均为零 OAuth/模型调用、无预算预留和 usage 写入。本轮不把 WAV 标成 PCM、不绕过公开格式校验。若首发需包含 Qwen，必须补经验证的格式适配/转码合同或受支持的独立入口，并在 C17/C15 验收前保持对应能力禁用；该缺口没有被测试绿灯消除。

## 3. 结算意图验证

TTS 保留既有 unknown 预留规则，不套用 Images 的取消后买家零收费政策。合成价格为每 Unicode code point USD 0.001，输入 hello 共 5 个 code point；故预留上限为 5,000 micros。

| API 场景 | 本地捕获的结算意图 |
| --- | --- |
| 认证超限、发送前取消/时限 | 零推理、无预留 |
| 明确 503 后认证超限/取消 | 一次推理，settled / 0 |
| 发送后无响应、传输失败、无效 2xx | 一次推理，expired / 5,000 |
| 已返回音频/SSE 头后取消或时限（无下游读取） | 一次推理，usage 结束，expired / 5,000 |
| 正常音频/SSE 完成 | 一次推理，settled / 5,000；使用已校验输入字符数，不采信合成上游宣称的 999 字符 |

expired 代表保留未知结果的最高额预留等待核实，**不是最终向买家扣最高额的授权**。本轮未改变现有费用责任或支付规则。

fixture 使用真实 Hono/auth/planner/dispatcher/driver/admission/usage 链路，合成仓储、价格、RSA 凭据及截获 HTTP；断言最终 SQL 状态/金额、一次日志/结算批次，并拒绝陌生数据库操作和被吞掉的结算错误。SQL 捕获不是实际数据库，不证明事务原子性、并发余额、资金到账或恢复。

## 4. 测试与修正过程

新增 **269 项**：

- [生命周期测试](../../../../packages/proxy/src/services/egress/audio-speech-request-lifecycle.test.ts)：161 项。覆盖四种驱动、32 候选/独立内部调用、真实 BYOK/共享池展开、缓存、认证与推理独立上限、准入拒绝/挂起写入所有权、共享 300 秒时限、OAuth/模型响应头/错误正文/首 SSE 的停止、64 KiB 上限；音频/SSE × 客户端/时限/下游取消 × 无读取/挂起读取；协议终态/解析失败无 EOF 或 cancel ACK；克隆上传 reader 仍被 fetch 持有时停止。
- [公开 API 调用链](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts)：108 项。OpenAI、SpeechSynthesizer、MiniMax × 两个实际前缀，54 个发送前/响应头终态、48 个音频/SSE 后续终态；另 6 个 Qwen 格式拒绝反例。

既有 [TTS driver 测试](../../../../packages/proxy/src/services/egress/audio-speech-driver.test.ts) 22 项继续通过；其中旧测试要求返回底层 socket 异常，已加强为稳定脱敏错误及秘密 canary 不出现。专项新收集这 22 项，不把它们算成新增测试。

初轮类型检查暴露 driver 的无参 beforeUpstreamDispatch 与 proxy 的带 route 钩子发生类型交叉，使用 Omit 保留正确的 proxy 合同后通过。API fixture 初轮误以为公开入口支持 WAV，请求在解析层以 400 被拒绝；核对实际解析与 adapter 后改用公开 PCM 测试可服务的三种驱动，并明确增加 Qwen 拒绝反例，未放宽金额、调用次数或状态断言。后续补足克隆上传所有权后，重跑完整 suite；中间绿灯不替代最终验证。

## 5. 最终验证与基线

环境：Windows / Node **24.14.1**；仓库要求 Node **22**，该版本未运行。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `tsc --noEmit -p packages/proxy/tsconfig.dispatch-safety.json`（本地 .bin） | 退出 0；新增测试在 files 中 |
| `tsx --test packages/proxy/src/services/egress/audio-speech-driver.test.ts packages/proxy/src/services/egress/audio-speech-request-lifecycle.test.ts`（本地 .bin） | 183 tests / 3 suites，全部通过，退出 0 |
| `tsx --test --test-name-pattern=TTS packages/proxy/src/routes/v1/request-dispatch-limit.test.ts`（本地 .bin） | 108 tests，全部通过，退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest/main 生命周期退出 0；主套件 **1,476 tests / 135 suites** 全部通过 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | **1,075 tests / 44 suites** 全部通过，退出 0 |
| `git diff --check`、JSON/链接/哈希核对 | 通过 |

计数重叠，不相加。Core 源码未变，本轮未重跑完整 Core suite；专项仍包含其 OAuth/辅助认证测试。既有 workerd 在断言前原生启动失败，本轮未重试或触发远程 CI，不声称 Workers/Node 22 已验收。

Workers 最佳实践技能促使本轮采用请求级流所有者、有界错误正文、可停止上传源和显式 Promise 所有权，且不丢弃持久写入。已刷新[官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，核对本地 Wrangler schema/config 与 AbortSignal/RequestInit 类型。最新类型元数据查询失败（web Internal Error），按技能回退已安装 **5.20260829.1**，没有安装依赖。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。[快照](./C02-tts-auxiliary-auth-snapshot.json)记录本轮 9 个源码/测试/收集配置文件及关联文件的 SHA-256，最终核对受测文件未漂移。相对 TTS 开始时 124 个 dirty/untracked 文件：117 个不变、7 个预期修改（含两份文档索引）；另两个此前干净的 driver/测试变脏，新增两个生命周期源码/测试及本报告/快照，无意外改动。没有覆盖历史 C01/C02 证据或清理用户工作树。

## 6. 剩余项与下一步

17 个应用 OAuth 调用点现已接入 **14** 个，仍有 **3** 个：DashScope Realtime、Node Realtime、Admin Playground；排除 Core 定义和测试 fixture。这不代表所有已接入路径的完整入口/所有模态已验收。

唯一下一实施项仍为 **C02.B2.2**：Realtime → 独立管理预览合同；随后补向量/图片/HTTP Audio 的入口全过程、multipart 内存预算、准备/数据库取消与持久写入恢复，以及 headers/有效 TTFT/idle 分阶段时限。Qwen 公开格式适配单列 C17/C15 门禁。全池读取/解密、Top-K、真实 Workers/DB/Node 22、共享市场授权、价格及 unknown 费用责任均未完成。C02.1–C02.7、C02.G 保持未勾选，C03–C20 不声明完成。

停止条件：认证/推理超发、取消后重放、未知结算事实丢失、准入写入被遗弃、重复 usage/结算、秘密进入错误/日志或格式伪装。回退应关闭受影响路由或收紧候选，不能恢复无界等待、混用未知为零或删除在途事实。

本轮没有调用真实 OAuth/模型/KMS、启用 API、修改 IAM/默认项目、迁移、部署、付款或删除数据。

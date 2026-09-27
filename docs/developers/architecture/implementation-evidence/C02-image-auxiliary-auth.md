# C02.B2.2 — Images 辅助认证、调度取消与流结算

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续[向量调用链证据](./C02-vector-auxiliary-auth.md)与[请求级认证预算](./C02-auxiliary-auth-budget.md)，不覆盖历史结果。Google Cloud KMS / project `cinatoken` 的决定不变；本报告不是 KMS adapter、真实数据库或生产验收证明。

## 1. 实现范围

- `proxyImageGenerations` / `proxyImageEdits` 将共享请求预算的 `auxiliaryAuth` 传给 driver/Core。认证 exchange 最多 3 次、推理许可最多 3 次，计数独立；换 provider、私有 BYOK、共享池或平台凭据不重置。普通 Key 与有效 OAuth 缓存不消耗新的认证许可。
- 两个图片 proxy 固定一个绝对调度截止时间：默认从共享 dispatch budget 创建时间（没有预算时为 proxy 开始时间）加 300 秒，调用方只能收紧。重试不能重新获得 300 秒。保留图片专用的取消原因和结算合同，未套用会丢失这些元数据的文本通用包装。
- driver 的请求所有者覆盖 OAuth、模型响应头、有界 JSON 正文及 SSE 读取，客户端取消与调度到期传入 HTTP 信号。迟到响应取消正文；读取停止释放 reader 锁，不等待可能永不完成的 `cancel()` 确认。
- 准入之前校验 HTTP(S) URL 并完成请求序列化/Headers 构造；实际模型 fetch 使用 `redirect: 'manual'`。这不是完整的 Target/SSRF 白名单实现。认证超限与准入失败沿既有 dispatcher 边界返回或抛出，不转成可重试的模型异常。
- 取消发生在持久准入等待期间时，仍等待该写入边界完成或失败，然后检查停止信号，不进行后续模型发送。**未把数据库写入变成可物理取消操作，也未证明挂起写入能在 deadline 内完成或崩溃后恢复。**
- route 保留可信网关错误头及结构化错误，不将取消 499 / deadline 504 误规范化成上游 502。已标记的本地网关停止/发送前准入失败跳过用户模型熔断；不据此声称所有认证失败的健康归因都已完成。

关键文件：[Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)、[proxy](../../../../packages/proxy/src/services/proxy.ts)、[Images route](../../../../packages/proxy/src/routes/v1/images.ts)。未修改 Core、共享 dispatcher、图片收费 helper、依赖、Wrangler/CI 配置或 Admin。只在既有测试脚本和专项类型检查中增加收集项。

## 2. SSE 与账务边界

SSE 的生命周期不再依赖下游继续拉取：客户端取消、调度到期或协议失败会取消源 reader 并完成失败结算；下游未读取终止帧也不能使 settlement 一直悬挂。到期路径保留有界错误帧与 `[DONE]`；完整成功路径仍需已完成事件和 `[DONE]`。对迟到 `read()` 结果增加关闭检查，避免流关闭后再次 enqueue。

保留现有图片业务规则：客户端取消/网关图片超时不向买家收费、不保留买家最高额预留；driver 仍保留真实发送后的未知诊断事实。供应商可能已经发生的成本及最终差额承担仍须 C01/C05 冻结，不能用“买家为零”推断“上游零成本”。`imageAbortReason` 本身不再被 route 当成未知费用证据，认证阶段取消尤其不能凭空制造推理未知。

有限预算 API fixture 检查实际生成的 SQL 状态/金额参数：

| 终态 | 预留与结算意图 |
| --- | --- |
| 第一次模型发送前认证超限/取消 | 无预留、无模型发送 |
| 明确 503 后认证超限/取消 | 一次发送，最终 `settled / 0` |
| 无效已接受 2xx / 模型传输未知 | 一次发送，`expired / 40,000 micros`；这是预留上限，不是最终收费授权 |
| 已接受图片正文后客户端取消 | 一次发送，保留取消/未知诊断，买家 `settled / 0` |
| 正常图片成功 | 一次发送，`settled / 40,000 micros` |
| SSE 完整成功 / 客户端取消 / deadline | 一次发送、一次日志/结算批次；成功 40,000，取消/到期 0 |

上述金额是合成单张图片报价。SQL 捕获器不是实际数据库，不证明事务原子性、并发准入、崩溃恢复或资金到账。

## 3. 新增测试

新增 **120 项**：新 [image-request-lifecycle.test.ts](../../../../packages/proxy/src/services/egress/image-request-lifecycle.test.ts) **60**，既有 [request-dispatch-limit.test.ts](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts) **60**。

- Driver/proxy：32 个认证候选与多次内部 proxy 调用共享上限；真实私有 → 共享 → 平台 → 后备私有展开；缓存/普通 Key；准入拒绝与持久写入失败；准入挂起期间取消；无效 Headers 不占推理许可；重定向不自动跟随。
- 取消矩阵：generations/edits 的 OAuth 响应头/正文、模型响应头、已接受正文、明确拒绝正文；验证停止信号、锁释放、迟到清理、无后续发送及已知/未知区分。另测 OAuth 自身 30 秒上限与图片跨尝试 300 秒共享 deadline。
- SSE：下游不读取、读取挂起、源 cancel 永不确认、协议失败终止帧未读取、成功完成等条件下的结束与 reader 清理。
- 公开 API **48 项**：`/v1`、`/api/v1` × `images`、`images/generations`、`images/edits` × 8 种终态，走真实 Hono/auth/planner/dispatcher/driver/admission/usage 调用链，仓储、HTTP、账号和 SQL 使用合成 fixture。
- 公开 SSE **12 项**：两个前缀 × 两个 generations 路径 × 完整成功/客户端取消/deadline；取消/到期测试在下游未读取时等待后台结算，检查恰好一批持久化意图及释放源读取锁。

初轮测试发现取消错误被规范化成 502，以及成功路径 fixture 未接纳真实生成的 `guardrail_budget_windows` SQL；专项类型检查发现 route fixture 缺少 `providerSharedChannelType`。分别修正错误包装、fixture 表名及字段后重跑。中间尝试的通用错误 helper 仍把 499 规范化为 502，最终改为直接构造可信图片取消错误体。没有放宽最终状态/金额断言或跳过失败测试。

## 4. 最终验证与基线

环境：Windows / Node **24.14.1**；仓库 `.nvmrc` 指定 **22**，该版本尚未验证。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `tsx --test packages/proxy/src/services/egress/image-request-lifecycle.test.ts` | 60 tests / 1 suite，全部通过，退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest/main 生命周期退出 0；最终主套件 1,028 tests / 135 suites，全部通过 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 559 tests / 32 suites，全部通过，退出 0 |
| `git diff --check` / 证据 JSON、相对链接及受测哈希检查 | 通过 |

各套件均 0 失败/取消/跳过，计数重叠，不相加。专项另外纳入原有 Images driver 的 25 项测试，因此相对上轮专项增加 145 项，不代表新写 145 项。Core 源码未变，未重跑其完整主套件；专项仍包含 Core OAuth/认证预算测试。既有 workerd 在断言前原生启动失败，本轮未重试或触发远程 CI，不宣称 Workers 验收通过。

依 Workers 最佳实践技能，沿用请求级所有者、显式资源清理和有界正文读取，不新增跨请求 pending I/O。已刷新 [Cloudflare 官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)并检查相关类型与 Wrangler schema/config；npm 最新类型查询 EACCES，按技能回退安装版本 **5.20260829.1**，未更新依赖。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。[受测快照](./C02-image-auxiliary-auth-snapshot.json)登记本轮 7 个源码/测试/收集配置和 18 个关联文件的 SHA-256，测试后哈希一致。对开始时 110 个 dirty/untracked 文件复核：104 个不变、6 个预期改动、无意外改动；另有 2 个此前干净的图片源码变脏，新增 1 个测试及本报告/快照。C01 和此前 C02 证据、其他用户改动保持不变，不以 HEAD 代替脏工作树证据。

## 5. 剩余工作与停止条件

17 个应用 OAuth 调用点现已接入 **8** 个，仍有 **9** 个：Audio speech 2、OpenAI audio 1、DashScope ASR 3、DashScope realtime 1、Node realtime 1、Admin Playground 1。计数不含 Core 定义和测试 fixture，不代表这 8 个调用所在的全部入口生命周期均已验收。

唯一下一实施项仍为 **C02.B2.2**：音频/Realtime 的认证预算和生命周期，然后独立管理预览合同。随后补向量/图片入口全过程、multipart 内存预算、路由准备与数据库物理取消/持久写入恢复、headers/有效 TTFT/idle。图片本轮绝对 deadline 不覆盖请求上传、鉴权、guardrail、路由准备全过程，持久准入也不能靠放弃等待来“取消”。

Top-K 与全池读取/解密问题、真实 Workers/DB/Node 22、生产 SLO/配额、共享市场授权、供应商成本责任仍未验收。C02.1–C02.7 复合条目及 C02.G 保持未勾选，C03–C20 不声明完成。

停止条件：认证预算重置/超发、取消后新发送、认证失败制造未知推理/收费、真实未知发送事实丢失、重复日志/结算、凭据泄漏。回退应关闭受影响路由或收紧候选，不恢复无界认证/正文等待，不删除在途结算事实。

外部动作仅有公开文档查询及 GCP 只读元数据复核：本机有活跃登录，`cinatoken` 项目 ACTIVE，KMS API 未列入已启用服务。默认沙箱拒绝启动 CLI 后，经工具审批只读执行；未读取/输出访问令牌，未修改默认项目、API、IAM 或密钥。未访问真实 OAuth/模型端点、执行 KMS 密码操作、迁移、部署、支付或删除数据。location/保护级别仍待确认，参见 [C01 当前决定](./C01-google-cloud-kms-selection.md)。

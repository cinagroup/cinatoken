# C02.B2.2 — embeddings/rerank 入口时限与准备取消

日期：2026-09-06。状态：**本页本地子集 LOCAL_PASS；C02 为 DOING**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [Admin 预览](./C02-admin-playground-lifecycle.md)及 [向量辅助认证](./C02-vector-auxiliary-auth.md)，不覆盖历史结果。

## 1. 本轮实际改变

1. [入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)精确接纳 POST `/v1/embeddings`、`/v1/rerank` 及 `/api/v1`/尾斜杠形式。GET catalog、子路径、Batch 和其他模态不因此接入。为保持现有文本调用方兼容，内部 context/helper 仍沿用 text 名称；不是第二套 vector owner。
2. [embeddings](../../../../packages/proxy/src/routes/v1/embeddings.ts)和 [rerank](../../../../packages/proxy/src/routes/v1/rerank.ts)使用入口创建的 dispatch budget；请求开始时间、定价/guardrail 快照时间和后续调度绝对时限来自同一入口时间戳。此前向量仅从调度阶段起算，现已扣除入口、上传、鉴权和准备耗时。直接挂载 route 的旧本地调用仍可在没有中间件时创建预算，不把该 fallback 当成公开入口验收。
3. 上传使用既有 pull-based 50 MiB 总上限；rerank 继续执行自己的 8 MiB 严格 JSON 限制。迟到/静默上传可被取消或 deadline 中止，早期拒绝会释放未读源。取消、超时、超限分别保留 499/504/413 和稳定错误码，不误报为无效 JSON。
4. [guardrail 服务](../../../../packages/proxy/src/services/request-guardrails.ts)增加可选 PreparationControl，向量调用方传入同一 owner。只读策略评估、Key/Workspace 限额读取和审计摘要计算有取消边界；审计落库使用 owned mutation，已经开始的写入须等待确认。其他未传 control 的调用方保持原合同。模型/时区/路由/endpoint/policy 读取和 provider 加密包装层沿既有 control 传递。
5. [有界 JSON 读取器](../../../../packages/proxy/src/services/egress/bounded-json-request.ts)不再等待可能永久挂起的 cancel acknowledgement，仍观察其拒绝；保留上层 RequestExecutionStoppedError/RequestBodyTooLargeError 身份。未放宽 UTF-8、JSON 对象、字节或 Content-Type 校验。
6. [embeddings driver](../../../../packages/proxy/src/services/egress/openai-embeddings-driver.ts)与 [rerank driver](../../../../packages/proxy/src/services/egress/openai-rerank-driver.ts)的模型 POST 补 `redirect: manual`。新增测试发现原默认 fetch 可在底层自动重定向，绕过可见 dispatch 计数；本轮没有通过删除断言掩盖这一缺口。
7. [测试脚本](../../../../packages/proxy/package.json)和 [专项类型检查](../../../../packages/proxy/tsconfig.dispatch-safety.json)纳入两个新文件，现有 CI 路径会收集；未运行远程 CI。没有 schema、迁移、Core 账务、Admin 业务代码、锁文件或云配置变化。

请求时限仍为此前本地 300 秒安全上限；不是获批生产 SLO。入口完成后，dispatch 使用原始客户端 signal 与相同绝对时间，准备 owner 在 handoff 清理；不会因为准备 owner 结束而给下一阶段续期。

## 2. 新增 109 项测试

[向量入口测试](../../../../packages/proxy/src/routes/v1/vector-request-lifecycle.test.ts) **99 项**，使用真实 createProxyApp → Hono 路由、鉴权、guardrail、planner、driver 和用量记录流程；请求/响应是 Node Web API，repository 行及 SQL sink 是合成的。**没有本机 HTTP socket 或真实数据库的端到端事务证明**。

| 范围 | 项数 | 关键断言 |
| --- | ---: | --- |
| 入口选择、静默上传 | 17 | 精确路径；两个别名 × 两 operation × 声明长度有无 × 取消/超时；不开始 guardrail 或推理，挂起 cancel 不阻塞 |
| 早期拒绝、声明大小、正常返回、剩余时限 | 16 | 缺 Key 时不读上传；声明超限在 storage 前拒绝；正常仅一次模型调用/一次用量批写；鉴权消耗 299,990ms 后 OAuth 只剩 10ms |
| 准备阶段读取消 | 40 | 两 operation × 取消/超时 × guardrail、Key 限额、Workspace 限额、model、config、surface、routes、provider、endpoint、policy 十个等待点；晚到结果不继续下一阶段 |
| 存储与鉴权确认 | 8 | 潜在初始化/兼容鉴权副作用仍由原请求等待；确认返回后不开始 guardrail/模型请求 |
| 审计摘要、审计写入、兼容加密回写 | 12 | 取消摘要计算不开始审计；已开始审计等待确认；真实 Web Crypto/加密包装层的首个 enc:v2 回写等待确认，第二个回写不再启动 |
| 实际超限、重定向、清理 | 6 | 实际 50 MiB 超限仍为 413；307 不隐藏第二次 POST；准备 owner 的 abort listener 在响应 handoff 后清理 |

兼容回写调用的 Web Crypto 和包装层是真实本地代码，但数据库更新/确认是合成屏障；不能视为真实迁移或恢复验收。成功路径价格为合成零价，SQL sink 只接纳限定的用量统计语句，不证明实际充值、预算事务或卖家收益。

[读取器测试](../../../../packages/proxy/src/services/egress/bounded-json-request.test.ts) **10 项**：恰好到字节上限、声明/实际超限时 cancel 挂起、客户端取消、三种上层错误身份，以及坏 JSON/非对象/坏 UTF-8。使用小字节边界测试，不把它算作 Workers 内存峰值测量。

首轮失败还暴露了 fixture 的三个问题：未向 app.fetch 提供环境使缺 Key 路径得到 500；rerank 使用了不受合同支持的 prompt_tokens 字段；policy 读取未启用相关路由约束。均按真实合同修正 fixture 后重测。专项类型检查另要求兼容回写返回实际更新计数，并为 fetch mock 参数补类型；未使用 any 或双重类型断言规避检查。

## 3. 最终验证与快照

Windows / Node.js **v24.14.1**。新测试不访问外部服务；完整 Proxy 回归中的既有 SQLite 测试仍是本机内存库。Node 22、真实 workerd/托管 D1/PostgreSQL/MySQL、实际入口断连链路与远程 CI 均未验收。

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test packages/proxy/src/routes/v1/vector-request-lifecycle.test.ts packages/proxy/src/services/egress/bounded-json-request.test.ts` | 退出 0；109 tests，0 fail/cancelled/skipped |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；pretest 链通过；主 suite 1,875 tests / 135 suites，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；1,500 tests / 50 suites，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 最终退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0 |
| `git diff --check` | 退出 0；证据写入后再次检查 |

套件计数重叠，不能相加。最终类型修正只涉及新 fixture 的返回计数与参数类型，之后专项 109 项重跑通过；生产源码与全量回归受测版本一致。没有单独重跑 Core 全套或 Admin 418 项业务套件，不继承其历史绿色状态来声称本轮执行。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；本轮开始 **159** 个 dirty/untracked 文件，上一份 135 文件快照复核无差异。文档写入前仅上述 **12** 个非忽略源码/配置路径发生变化或新增 dirty 状态，其他既有修改保留。[147 文件 SHA-256 快照](./C02-vector-ingress-lifecycle-snapshot.json)覆盖相关受测源码、配置、历史保护文件与迁移；历史快照不覆盖。

本轮没有云账号访问、真实 OAuth/KMS/模型调用、充值/支付、业务库迁移、部署或远程 CI。Google Cloud KMS/project `cinatoken` 的既有决定未改，location/保护级别/身份/IAM 等仍待授权与验收。

## 4. 技能影响与未完成项

Workers 最佳实践技能要求本轮区分只读取消和不可遗弃的写入、清理 stream/timer/listener，并检查底层 fetch 的次数边界。公开依据：[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)。最新 registry 获取失败，按技能 fallback 核验已安装 workers-types **5.20260829.1** 与 Wrangler schema；Proxy 模板已有 enable_request_signal，本轮未修改绑定或云配置。Node 模拟不能证明实际 Worker 断连语义。

- **时限计时与物理完成分开**：到期后不开始新的准备/出站，但 storage 初始化、旧 Key 查询中的兼容写入、预算懒重置、认证失败限流及已开始的审计/回写仍可能等待外部确认。没有引入可遗弃 mutation 的 Promise.race；数据库物理超时、晚到连接清理、崩溃恢复仍属 C02 后续。
- 同步 JSON 解析/策略扫描无法被 JS timer 抢占，50 MiB 不是整个 isolate 的总内存上限。multipart、并发请求的总内存预算和 CPU/SLO 实测未完成。
- 本轮不完成 headers/有效 TTFT/idle 的独立阶段时限。其他模态及 Admin 完整入口尚未统一；向量以外的 driver/SDK 重试/redirect 仍须逐点复核。
- [Realtime 提交边界](./C02-realtime-fallback-recovery.md#3-已复现但未解决的发布边界)不变：marker 丢确认且实际零出站的保守预算消费、Guardrail 零更新计数恢复仍待修正；unknown 不可当作确认费用。共享音频卖家收益缺失、Qwen HTTP TTS 格式等商业门禁仍保留，不开放未验收供给。
- 本轮没有解决全池读取/解密或实现 Google KMS Vault，C07/C09 等顺序不变。

**唯一下一项：C02.B2.2 — Images 入口、鉴权、选路/准备的时限及上传内存边界。** 后续再补 HTTP Audio/Admin 完整入口、分阶段时限及数据库确认恢复。C02.1–C02.7/C02.G 不勾选；C01、C03–C20 状态不变。

停止/回退：若真实环境无法验证取消或写入收尾，不升级验收层级；收紧或暂停对应入口的新请求，等待既有写入确认，不靠重放模型 POST、重置预算事实、关闭超时或退回明文凭据掩盖问题。本轮没有新增生产禁用开关或执行切流。

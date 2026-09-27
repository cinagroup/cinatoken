# C02.B2.2 — 同池并发观察候选

日期：2026-09-09。Checklist v1.109；整体状态 **STAGING_PARTIAL**，新候选仅本地验证，不提升 C02.G。
Owner / Reviewer：Codex 当前任务实现及本地自检；独立平台/发布签核待定。

## 改动与不变项

- 新增 `images-sse-capacity-peer-{observation,handler,gateway}.ts` 和纯配置工具；不修改已冻结的容量池、host-expiry 探针、金融算法或历史发布产物。
- 复用原组合创建的唯一逻辑池与 UUID。每池最多一个观察流，跨请求只共享数值代次，不存储 Request、Response、Promise、controller 或 timer。
- 固定 staging origin、D1、正文日志关闭和 Batch 关闭门禁。观察入口为 `GET /__staging/sse-capacity/watch`，必须有 `x-c02-capacity-watch: v1`，拒绝 query、fragment、Upgrade、正文和 peer 请求头。
- 响应为 NDJSON，立即输出第一个样本，随后按需每秒最多一个；最多 180 个样本，诊断 deadline 为 180 秒。每条不超过 512 bytes、总量小于 128 KiB；HWM=0，不保存历史队列，未读取时最多保留首条与终止条。
- `POST /v1/images/generations` 必须携带 `x-c02-capacity-peer: <pool UUID>:<watch epoch>`。同池、同代次检查在业务正文读取、数据库访问、容量准入和上游调用之前；不匹配返回 409 与 `dispatch_started:false`，缺失/畸形返回 400。
- UUID 通过本地函数调用原固定 census 取得，**没有自 HTTP 请求**。其他既有路由仍走原有 handler；peer 头不能附在其他路径。此候选是受 Access 保护的实验组合，不是公开身份认证接口。
- 新 handler 移除实验头后调用原业务 handler，并让取消探针观察原始传入 Request 的 signal。独立观察流关闭/取消/超时只结束诊断，不释放业务 lease、不写结算事实、不输出 SSE `[DONE]`。
- 配置仅替换 main，保留关闭的公网/预览/路由、无 Cron、原 staging D1 和私有上游 service binding。不创建资源，不自动部署。

## 本地验证

33 项新增测试包括：单池构造/身份稳定、并发 watcher 抢占、过期或跨池代次拒绝且不读正文、待处理 pull 取消、已取消 signal、背压、180 样本及帧长/总量上限、deadline、环境/路径/header 拒绝、纯配置隔离，以及两项真实 SQLite handler 集成。

SQLite 集成运行 before-hold / after-hold 两条原有探针链：有效 completed + 实际上游 DONE、原始请求取消记录、独立恢复 0/1、重复恢复 0、唯一合成出站 1；观察流确实读到同池占用。恢复已成功也不释放原请求尚未终止的容量 owner，关闭观察流同样不释放；明确终止本地模拟 ACK 后才观察到 idle。after-hold 留一条合成 success / charged_cost 0.1，before-hold 无成功日志。它们不是 Cloudflare 原生取消实验。

本轮开发测试保留说明：首轮 31 项单测中 30 通过、1 失败，原因是维护路由的测试 context 错用了“诊断不得 waitUntil”的断言；更正业务 context 后通过。新 SQLite 夹具首轮两项失败，原因是合成加密 secret 少于现有 32 字符要求；更正仅测试字符串后两项通过。未为测试改动加密要求或业务生命周期。

完整回归 **1,629/1,629 通过**，失败/取消/跳过均为 0，staging TypeScript 检查通过；执行前后核对历史 **1,645 条文件摘要**及 7 个新增源码/测试/配置文件摘要，全部一致。命令、输出及源码摘要见 [本地原始结果](../../../../.wrangler/staging/sse-capacity-peer-v209-verification-result.json)；机器可读汇总见 [v1.109 结果](./C02-images-sse-capacity-peer-results.json)。新增 Node 22/24 CI 工作流仅已编写，尚未远程执行；本机为 Node v24.14.1。

## 不可越过的证据边界

1. Cloudflare 不保证两次请求路由到同一实例。peer gate 只核对当前模块的登记代次，不提供路由亲和性；拒绝时停止本次推理实验，不能重试来碰撞实例。
2. gate 的登记代次不是持续存活证明。观察流可能在异步准备或业务运行中断开；平台直接终止 invocation 时，取消/finally/timer 不保证运行，数值登记也可能残留。不得把登记标记、计时器或不存在的新样本当作容量释放/继续存活的证据。
3. 180 秒是诊断请求的本地有界计时设计，不是平台保证执行清理的承诺。所有业务 lease 均不依赖该超时释放。
4. 下一轮必须用有界客户端解析器验证 schema、实例、代次、严格递增序列及对应观察阶段，区分首条旧样本、截止/断流和实际新样本。没有 held 和原生取消后的有效同池样本，仍判 INCONCLUSIVE。
5. 并发观察流让一个独立 invocation 保持活动。这可以研究业务 invocation 的原生取消，不能证明 isolate eviction；原生 V3 tail 及原客户端时钟顺序仍必需。
6. 逻辑预留 1024 bytes 是测试计数，不是物理内存建议。物理工作集、其他消费者、unknown/幂等、C02.G、C01 剩余选择及 C03–C20 仍开放。

## 云端、预算与下一步

本轮无部署、无 Cloudflare 管理 API/公共 HTTP/远端 D1 写入，无模型或 KMS 调用，无生产修改。首轮 HTTP 累计仍 **382**、真实模型/KMS 累计 **0/0**，**US$2 累计上限不重置**；最终增量账单尚未核实。

云端最后观察仍来自 [v1.108](./C02-images-sse-access-confirmation.md)，时间 `2026-09-08T12:59:42.118Z`，不是今天的新复核：四个 staging 入口关闭、双 Access deny-all、临时 token/tail 已删除、数据库基线恢复。旧 Gateway 版本 `448e313a-7fef-4712-bde0-412173954b65` 未被本候选替换。

唯一下一项：先实现并验证有界 peer 客户端/阶段证据判定器，包含所有失败停止与预算记账，再准备新的封闭构建及必要的平台验证。不重放 v208 操作器、不推理重试、不重放迁移、不凭本地结果开启生产容量。

设计依据：[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)影响了请求所有的流/计时器、有界背压和 service binding 复用；[Workers 运行模型](https://developers.cloudflare.com/workers/reference/how-workers-works/)解释跨请求实例不保证一致。类型核对使用已取回的 `@cloudflare/workers-types 5.20260908.1`，实际 staging 类型检查仍以项目生成绑定声明为准。

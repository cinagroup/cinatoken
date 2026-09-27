# C02.B2.2 — 非成功响应的有界证据读取

日期：2026-09-09；Checklist v1.120。此次修复的是后续 staging 执行器的拒绝响应证据缺口，不是对历史 v219 HTTP 409 原因的追认，也不是同池或物理容量验收通过。

## 原因及实现

现有协调器 `dispatch` 在拿到响应后调用 `session.markHeaders`；后者记录 status/id 并立即要求 HTTP 200。因此 v219 的 409 没有进入 window 的正文读取阶段，原始正文和真实结束回调缺失。历史证据及已经发布的执行器、Worker bundle 均保持原样。

新增 `staging-sse-peer-rejection-capture.mjs`，以及可用于下一轮独立窗口的 `createSseCapacityPeerRunWithRejection` 入口。后者直接组合原有资源 setup、协调器、window、finalizer，只包装实际 HTTP 传输，不复制或改变财务算法。冻结的旧 CLI 尚未切换；下次云端窗口须显式接入该新入口，并完成新的 preflight 和预算检查，不能重跑已消费的操作目录。

- 仅观察固定 staging 网关 `/v1/images/generations` 的一个 POST；先占用本地一次性发送计数再调用原传输，失败也不重试。原有公开 HTTP 预算计数不变。
- HTTP 200 原 Response 与 body 原封不动交还，不 clone、不 tee、不提前读取成功 SSE。
- 非 200 先采样并持久化实际响应头到达事实，再读取最多 **8 KiB / 128 次 read / 2 秒**的正文。头部与最终日志各有 **1 秒**独立上限；读取期间响应不对协调器开放，总附加预算最多约 4 秒，仍受原协调器的整体 dispatch 时限约束。
- 仅保存 HTTP 状态、generation header 是否存在、JSON 媒体类型是否合规、单调时钟样本、捕获字节数、读取次数、完整或前缀 SHA-256。原始正文、URL/query、Cookie、Access 凭证、任意响应头及错误文本不进入报告。
- 只有真实 EOF、无 generation header、正确状态和媒体类型，且完整 UTF-8 字节精确匹配冻结网关的 canonical 拒绝 JSON，才记录 allowlist 中的 `gatewayDeclaration`。重复键、额外字段、BOM、未知 reason、错误 HTTP 状态、伪造 `dispatch_started=true` 均仅保留摘要。
- 该 declaration 只是网关返回的声明，**不是**原生 host 终止、账务为空、物理释放或安全重发的证明。`nativeProof=false`、`settlementProof=false`、`retryAllowed=false` 固定保持。
- 超限、读取失败、取消、未到 EOF、锁失败或无 body 均不得伪造 EOF。原 reader 的 cancel 及晚到 read 有拒绝处理，不等待不合作的 cancel 完成；报告中的最终观察不被晚回调改写。
- 日志失败保留内存事实并将组合运行标记 ATTENTION_REQUIRED。不会把本地观察到的拒绝 EOF 写成旧 session 的推理完成事实；未知结算收尾门禁未放宽。
- 组合运行结束时封存报告并取消捕获生命周期；晚到响应头立即取消 body，不创建新证据或新日志。封存发生于日志未确认期间时保留 durability failure。已经交给外部持久化回调的写入不能撤回，但不会等待它无限期完成，也不将它当成已确认。

Cloudflare 技能促使本次明确有界流读取、响应所有权和 Promise 收尾，参考[当前 Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。此次是 Node 本地执行器修改，无新 Worker API/绑定/配置；类型参考本地 `@cloudflare/workers-types` 5.20260829.1，不据此宣称最新平台类型或 Windows workerd 验收通过。

## 验证

新增 37 项读取器测试，包含真实本机 loopback HTTP 分块 409、晚到响应头及读/日志进行时封存；另有 5 项完整资源/window/finalizer + SQLite 集成测试。管理 API、tail 和外部 HTTP 在后五项中为本地模型，数据库事务实际执行。

完整集成覆盖：canonical 409、敏感未知正文、日志失败、发送后确认丢失，以及完全未发送时原清理路径仍有效。验证真实发送次数仍为 1、公开请求模型为 8、无恢复 RPC、已发送窗口不删 fixture，key 撤销、token/tail 收尾和最终隔离检查继续执行。捕获拒绝正文不改变原失败结果。

第二轮联合回归 **1,897/1,897 PASS**，失败/取消/跳过均为 0，staging 类型检查 PASS；前后核验既有 1,783 条摘要和 6 个新源码/测试/CI 文件未变。见[最终验证回执](../../../../.wrangler/staging/sse-capacity-peer-v221-r2-verification-result.json)。本机 Node v24.14.1 通过；Node 22/24 CI 已定义并本地解析配置，但未在远程运行。

保留首轮失败：1,893 项中 1,892 通过，一个新增“有效前缀但未 EOF”的测试因默认流预取触发提前取消，实际尚未捕获字节，与断言预期不符。将该测试及读取中取消测试的 highWaterMark 设为 0，明确在读取动作时触发预定事件，没有放宽读取器对取消的处理。同时补上复查发现的晚到响应封存保护及 4 项测试。修改前 3 个源码的逐字节副本与首轮验证回执均保留，第二轮使用独立文件，不覆盖失败。

## 云端状态和后续

本轮没有管理 API、公开 staging HTTP、部署、D1 读写或实际模型/KMS 调用。最后云端观察仍来自 v220 清理回执，不冒充本轮复核：56 表干净基线、31 条测试记录已删除、入口关闭，累计公开 HTTP 390、真实模型/KMS 0/0；US$2 累计上限不重置，最终增量账单未核实。

历史 v219 仍为 INCONCLUSIVE_REJECTED_409，其拒绝正文不可追回。下一步完善真正同池的因果观察协议与新一次性执行入口，再开展受预算约束的 Workers 验证；不得盲目重复推理以碰撞同一实例。完整 C02.B2.2 物理容量/跨消费者、unknown/幂等、C02.G、C01 剩余决策及 C03–C20 仍开放。有效 completed 图片和实际上游 DONE 均已验证后的不可逆成功结算规则未变。

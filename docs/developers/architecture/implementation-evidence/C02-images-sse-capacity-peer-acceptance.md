# C02.B2.2 — 原生取消、同池样本与账务事实联合校验

日期：2026-09-09；Checklist v1.111。整体 **STAGING_PARTIAL**，本轮新增本地核心协调器；C02.G 未通过。
Owner / Reviewer：Codex 当前任务实现和本地自检，独立平台/发布签核待定。

## 已完成的核心整合

`staging-sse-capacity-peer-acceptance.mjs` 不接受 `nativeVerified:true` 等布尔替代证据，而是重新执行原 native V3 校验和完整账务 oracle。只支持同一轮、唯一实际 after-hold 请求，并将以下事实逐项绑定：

- 原请求 generation ID、响应池 ID、原始 headers 单调时点；baseline 必须早于该请求。
- 同一 D1 held 行的精确字节与有效 nativeResult；原 pending job、空日志及上游 completed/DONE/terminal 事件顺序。先验证有界字段投影，再写入观察日志。
- held 标记的前置时点必须等于原 D1 回执，held 样本必须早于客户端取消；不能把事后观察倒填为 held。
- 同一请求的取消观察、未改变的 held 行、真实部署版本、原生 tail 警告及同一进程捕获的单调回执；post-native 标记必须在这些原始证据的观察回执之后。
- 先恢复 1、再去重 0 的两份独立 RPC 回执，失败/uncertain 等计数全为 0；第一 RPC 不得早于 post-native 同池样本。
- 两次 RPC 后实际重新读取的六组账务事实、snapshot/cancel 行。去重前后全部字段一致，并复用原完整账务 oracle 检查 1 committed、0 unknown、1 platformCancelled。这里只校验生成的精确清理计划，**不执行 SQL 或退款**。

最强结果 `AFTER_HOLD_PEER_EVIDENCE_PASS` 只表示输入满足这一个 after-hold 证据合同；仍为 `c02GatePassed:false`、`isolateEvictionProven:false`、`cleanupExecuted:false`。同池在 post-native 或 post-recovery 仍占用时保留明确占用分类，不因原生或账务证据通过就改成容量成功。

`staging-sse-capacity-peer-coordinator.mjs` 把这些要求接入实际可调用的核心流程：

1. 先建立有界 peer 观察；只允许现有 session 中唯一 after-hold 推理，扣共享次数预算并持久化 PENDING 后才调用一次 send。响应 generation ID 和池身份必须匹配。
2. held 观察验证通过并取得同池新样本后才进入正常取消步骤；客户端须等待真实 pending body read 结束，再登记 finish。已有 headers 的失败请求强制 abort 时，同步记录首次实际取消时点并标注 `forcedAbort`；不自动生成 body finished。外层 finally 必须等待实际 pending read 结束，再调用 `finishAbortedPrimary`，且失败/停止状态保持不变，不升级为成功。
3. 先用 session 原始 tail/receipt 执行 native V3 校验，之后才发送 post-native 标记。
4. 至多调用恢复 RPC 两次。首次结果不确定、首次账务/新读探针不匹配时立即停止，不发第二次。成功路径再取 post-recovery 新样本并运行联合校验。
5. HTTP 次数预算复用外层 reserve：成功核心为 1 watch + 1 inference + 3 marker + 2 recovery = **7 次**，不包括 Access 探测或管理 API。既有 US$2/32 HTTP 计划合同不变；这不是单独重置的预算。
6. 自有 lifecycle abort 传播给主请求和 RPC；journal/读事实 5 秒、首次 headers 15 秒、RPC 30 秒，并检查单调时限。关闭后即使 callback 不合作或迟到，也不能恢复状态或发起后续 RPC。保留 `lastRpcFinished` 供外层安全清理等待使用。

`OBSERVED` 是核心证据收集的终态，不代表入口已关、临时资源已删除、数据库已清理或全 C02 已验收。核心 close 只停止自有请求/观察流。

## 测试与边界

新增 14 项测试，其中一项包含 28 种跨请求、跨阶段、错误时钟、缺失 DONE、原生警告/版本错误、RPC 确认复用、账务篡改和恢复后探针变更的拒绝检查。

成功链使用真实 SQLite handler 产生的完整账务行；peer 数值、tail 和单调时点是**显式本地模型**，不记录为 Cloudflare 实测。覆盖首次推理结果不确定不得重放、写前日志失败禁止 send、原生证据缺失禁止 marker/RPC、首次恢复不确定禁止第二次、关闭时中止活跃 RPC、迟到响应取消、关闭后迟到事实不得恢复流程，以及不改变数据库事实。

开发中 v211 已获得 1,723 项回归通过；收尾审查另发现“失败强制 abort 也须捕获首次实际时点”的缺口。更改前将原协调器/测试按字节归档，归档摘要与 v211 报告一致；不覆盖原验证结果。新增两项测试证明首次 forced abort 不被后续 close 重写，实际读体未结束时不生成 finished，失败状态不转成功。

当前完整回归 **1,725/1,725 通过**，失败/取消/跳过均为 0，staging TypeScript 检查通过；执行前后核对历史 **1,673 条摘要**和 **4 个新增文件摘要**，全部一致。命令/输出见 [v212 本地结果](../../../../.wrangler/staging/sse-capacity-peer-v212-verification-result.json)，机器汇总见 [v1.111 结果](./C02-images-sse-capacity-peer-acceptance-results.json)。Node 22/24 CI 仅新增定义，未运行远程 CI；本机 Node v24.14.1。没有改动 Worker、业务结算算法或此前已发布的冻结文件。

## 尚未完成与下一步

还没有将核心协调器接入新云端入口脚本。下一步把旧操作器中经过验证的资源闭环迁入**新的一次性入口**：最新封闭构建及真实版本/模块摘要、只读前检、Access/tail/token 管理、总预算与写前日志、失败后的关闭顺序、撤销精确测试 key、350 秒安全等待、全字段 guarded 原子清理、最终隔离与源码复核。继续复用已冻结的辅助函数，不执行旧 v208 脚本。失败分支须保存原 forced abort/真实 body finish 和剩余 RPC 预算；仅有完整原生与 owned-row 证据才可执行既有合成恢复/清理，证据缺失时保留数据并明确报告，不能为了清理而填造时间或重放推理。

必须先完成该外层与封闭构建，再进行必要的平台验证。本轮没有部署、管理 API、公开测试 HTTP、远端 D1 写入、模型/KMS 调用或生产修改。首轮测试 HTTP 累计 **382**、真实模型/KMS **0/0**，**US$2 累计上限不重置**；最终增量账单未核实。

最后云端观察仍来自 [v1.108](./C02-images-sse-access-confirmation.md)，时间 `2026-09-08T12:59:42.118Z`；四入口关闭、双 Access deny-all、临时 token/tail 删除及数据库基线恢复均为该历史观察，不是今天新复核。云端原池容量仍 **INCONCLUSIVE_HELD**。有效 completed + 实际上游 DONE 后取消不撤销成功费用的规则保持；物理容量、unknown/幂等、其他消费者、C01 剩余选择、C02.G、Node 22/远程 CI 与 C03–C20 仍开放。

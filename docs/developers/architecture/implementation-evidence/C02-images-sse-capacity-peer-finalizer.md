# C02.B2.2 — Peer 实验的外层关闭与失败收尾

日期：2026-09-09；Checklist v1.112。整体 **STAGING_PARTIAL**；新增 Node 操作器收尾模块，未开启新的云端窗口，C02.G 未通过。

## 本轮实现

`staging-sse-capacity-peer-finalizer.mjs` 接受同一个 session、核心协调器、共享 HTTP 预算和固定 staging 传输。调用 `finish` 只启动一次；重复或并发调用返回原 Promise，不重新执行推理、RPC、管理写入或清理事务。模块没有推理回调，不能重放模型请求。

1. 关闭核心协调器，保留首次实际 abort；并行关闭固定网关入口、等待原 pending body read 真正结束。入口确认延迟不能推迟原始 finish 取样。读体超时不补造 finished，迟到回调不恢复流程。
2. 网关关闭后，用原 session collector 的 tail/单调回执重新验证唯一 after-hold 请求。重新读取 staging D1 的 snapshot/cancel 行并逐字节比对原证据；缓存、修改过的行和布尔结论均不能授权恢复。
3. 若核心失败且此前完全没有 RPC 尝试，在原共享预算下最多补做一次合成账务恢复。要求数据库 UUID/名称、全局唯一 owned pending job、intent/snapshot/预算身份、payload 摘要和固定 recovery 控制行检查通过，并先写 PENDING。沿用原 session 的两次 RPC 总上限，不开新的预算。正常核心仍要求恢复 1、去重 0；失败收尾的单次恢复不冒充该验收。
4. 只要原 session 已经尝试 RPC，或核心已有 PENDING RPC 记录，外层不发替代 RPC。新恢复 ACK 丢失也不重试；保存错误分类，后续只读持久化事实。恢复成功不会把失败的 peer 实验改成成功。
5. 无论观察、原生证明、恢复或日志是否失败，仍尝试两个固定入口关闭。复用现有入口确认器和双 Access 关闭器：每个入口至多一次关闭 POST，最多三次有界确认 GET；移除两边策略引用后才删除自有共享 token。不因请求元数据损坏而跳过入口关闭。
6. 停止本地 tail socket，仅凭本次明确获得的 tail ID 删除对应远端 tail，保留其他 tail。创建 ACK 丢失且没有 ID 时不猜测归属，保留数据并报告需处理。日志失败允许继续固定资源关闭，但不授权恢复或账务数据删除。
7. 独立核验 staging D1 身份并撤销精确测试 key。双 Access 已关闭、自有 tail 已确认处理、key 已撤销、原生证明完整且日志可用后，才等待原单调时钟的 350 秒安全窗口及 RPC/读体结束余量；每次 sleep 不超过 20 秒。
8. 复用 V3 全字段账务 oracle：安全等待后重新读六组账务及探针、owner/key；snapshot/cancel 再次逐字节匹配原证明；先持久化原始事实，再执行一次 guarded 原子删除，最后复读确认。pending/不明账务不删除，不写费用、退款、零成本或伪造 receipt。

输出分别记录 `experimentResult`、`cleanupPassed`、资源状态及有界错误阶段。`CLOSED` 只描述收尾完成，不代表实验通过；始终保留 `c02GatePassed:false` 和 `isolateEvictionProven:false`。恢复 ACK 丢失后，即使完整数据库证据允许清理，仍返回 `ATTENTION_REQUIRED`，不隐去确认丢失。

## 验证与测试夹具

新增 19 项测试，直接组合现有核心协调器、新收尾模块、双 Access 模拟状态和真实 SQLite 事务。覆盖正常完成、失败单次恢复、恢复 ACK 丢失、日志/原生证明缺失、未知 tail 归属、tail 删除确认丢失、关闭入口不生效、入口 ACK 丢失、原 RPC 不确定且账务已完成/仍 pending、无推理 headers、错误资源归属、读体超时和迟到回调、recovery 控制行、snapshot/cancel 字节变化和原 RPC 预算已用尽。

新增夹具 `images-sse-capacity-peer-finalizer-fixture.mjs` 从原 host-expiry 清理夹具派生，保留原文件不变。显式模拟 host-stop 后禁止原 producer 再执行 SQL，独立恢复连接仍使用同一真实 SQLite。开发时发现原夹具只拒绝一个 held ACK，延迟 producer 仍可能继续记账，不能将这种延迟写入当成收尾 RPC 的结果。因此新夹具隔离两个执行方，而非改写数据库账务结果。**该故障注入、tail、peer、管理 API 和单调时点全是本地模型，不是 Workers 原生证据。**

联合回归 **1,744/1,744 通过**，失败/取消/跳过均为 0，staging TypeScript 检查通过；执行前后 **1,686 条历史摘要及 4 个新增文件摘要**一致。完整命令、退出码及输出见 [v213 联合验证](../../../../.wrangler/staging/sse-capacity-peer-v213-verification-result.json)，摘要及继承证据见 [v1.112 机器结果](./C02-images-sse-capacity-peer-finalizer-results.json)。Node 22/24 CI 仅定义，未执行远程 CI；本机 Node v24.14.1。

## 尚未完成

本轮接入的是可调用外层收尾模块及本地整合测试，**不是已可执行的新云端入口脚本**。仍须把只读前检、封闭候选构建与版本/module 摘要、固定 API/D1 传输、Access/tail 创建、总预算日志、真实 pending read 与原 session collector 接入新的一次性操作器，再做平台验证；不重跑旧 v208 脚本。

没有部署、Cloudflare 管理 API、公开测试 HTTP、远端 D1 写入、真实模型/KMS 调用或生产改动。首轮测试 HTTP 累计仍为 **382**，真实模型/KMS **0/0**，**US$2 累计上限不重置**，最终增量账单未核验。最近云端观察仍为 [v1.108](./C02-images-sse-access-confirmation.md) 的 `2026-09-08T12:59:42.118Z`，本轮未复验，原池容量 **INCONCLUSIVE_HELD**。

完整物理容量、其他消费者、unknown/幂等、C02.G、C01 剩余决策、Node 22/远程 CI 和 C03–C20 均继续开放。有效 completed + 真实上游 DONE 后成功不可撤销的业务规则保持不变。

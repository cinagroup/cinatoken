# C02.B2.2 — 一次性资源编排与未发送清理

日期：2026-09-09；Checklist v1.115。整体 **STAGING_PARTIAL**，云端 windowResult / candidateNativeResult 均为 NOT_RUN。业务成功结算点保持有效 completed 图片与上游真实 DONE 均已验证；该点之后的客户端取消不撤销费用。

## 资源编排已接入

新增 `staging-sse-capacity-peer-run.mjs`，将原 session、固定管理传输、只读前检、Access/tail 资源、规范原子 seed、真实读体窗口和 finalizer 组合为一次性的可调用资源运行器。重复调用共享同一 Promise；不部署、不创建新预算，不自动重发不确定推理或 RPC。它仍需绑定到新的 CLI 入口与已封闭部署后的真实观察基线，不能直接把旧历史版本当作 Peer V2 候选。

顺序为：校验原 key/计划和固定目标 → 已验证前检 → 创建本轮 tail 并连接原 collector → 创建本轮 1h Access token → 修改两个既有 app 的专有策略并复读 → 打开仅 staging 的 workers.dev（preview 不开）→ none/invalid/valid 认证探针 → 一次原子 seed → 原读体窗口 → 同一 finalizer → 终态隔离复读。

- 认证探针复用既有严格响应检查，只有明确 RETRY 才在三次内等待重查；无 command header 的 controller 认证探针不能启动恢复。所有公开尝试与 peer/watch/marker/推理/RPC 共用原 32 次上限，累计基数仍为 382。正常核心的七次预算不另开计数器。
- tail socket 使用 `trace-v1`、有界帧与握手时间；原字节交给原 session collector。无自动重连，创建 ACK 丢失无明确 ID 时不猜测归属。消息日志串行、有界排队；日志失败污染 collector、停止 socket，不能继续把旧的成功观察当成足够的删除依据。握手/open/send 异常进入 finally，而非逃逸为未处理异常。
- 规范夹具与三种 armed 探针在同一个 D1 batch 写入，发送前持久化 PENDING；明确 ACK 后才设置 `seedAcknowledged`。不拆分、不重发。API token/key/Access secret/tail URL 不进入运行报告。
- readObservation / cancel / 完整账务查询使用固定 SQL 和原 owner。恢复仍由原 session 的总 RPC 上限控制；每次调用前检查全局唯一 job、owner、状态及恢复控制行，固定 URL/空 body/command，不跟随重定向。
- finalizer 接管前切换管理传输到不可重新开放的 cleanup 模式；传递其原 AbortSignal 到 D1。无论 setup 或窗口在哪里失败，已发生资源修改时都进入同一外层关闭路径，保留原生证明与账务守卫。
- 完成关闭后再读取四个 staging Worker 的 settings/deployments、入口、域名、cron 和三个生产 Worker 的 settings，按原封闭基线比对。终态漂移仍是 ATTENTION_REQUIRED，即使测试数据已成功删除也不掩盖。

## 未发送推理的独立清理路径

新增 `staging-sse-capacity-peer-unused-fixture.mjs`。它不能替代发出请求后的原生/账务 reconciliation，仅支持以下条件同时成立：

1. 原进程明确收到规范 seed 的 ACK，有原时钟的 seedFinished；推理发送计数为 0，原 session 没有 RPC 完成样本，任何请求项都没有 headers / generation ID。
2. 同一个 finalizer 已确认双 Access 关闭、自有 tail 处理及精确测试 key 撤销；没有 finalizer journal 故障。
3. 从 seed ACK 起保留 350 秒安全余量，每次 sleep 最多 20 秒；之后重新读取完整表计数与每一条 seed 行。
4. 全局账务六表的基线为零，当前全部表计数精确等于基线加规范 seed；每条 seed 行恰有一个匹配，owner 的预算已花费/预留均为零，key 已撤销且摘要正确，armed 探针字节未变。
5. 先严格持久化全部观察事实，再将逐表计数守卫、全部行的 balanced exact-field 守卫、精确探针删除和既有 fixture cleanup 合在**一个原子事务**中；最后重新比对全表计数恢复基线。不生成费用、退款、usage 或 receipt。

seed 确认丢失、任何推理尝试、任何 RPC、缺少资源关闭证明、探针/预算变化、读后竞争或事实日志失败均不能使用此路径。对于这类未开始或失败的实验，清理成功也不等于实验通过；原 finalizer 中缺少原生请求证据的诊断仍保留，不伪造 native PASS。

## 验证范围

新增 15 项测试，真实组合 resource run、window、coordinator、finalizer、session 和 SQLite 原子事务；前检、管理 API、tail socket 与公开 HTTP 是本地模型。覆盖未发出推理的正常清理、seed ACK 后日志失败、前检失败、tail 创建/握手/send 失败、token/policy ACK 丢失、认证失败、终态 settings 漂移、seed/推理 ACK 不明、armed 探针篡改、事实日志失败，以及守卫读后预算变化导致整个删除事务回滚。

测试没有把 mocked 前检或 socket 当成 Cloudflare 原生证据。正常完整 SSE 结算/恢复路径的既有测试随联合回归运行；本轮新增测试主要针对 setup/finally 和未发送分支，不声称新资源编排已经在真实 Cloudflare 成功跑通。

联合回归 **1,809/1,809 通过**，失败/取消/跳过为 0，staging 类型检查通过。验证前后检查 1,726 条历史摘要与四个新增文件摘要。[完整验证结果](../../../../.wrangler/staging/sse-capacity-peer-v217-verification-result.json)和[机器证据](./C02-images-sse-capacity-peer-resource-run-results.json)保留命令、输出与摘要。Node v24.14.1 本机通过；Node 22/24 远程 CI 仅定义，尚未执行。

## 待继续

还需完成新的 CLI 绑定：完整不可变输入/源码验证、封闭候选部署及后置版本/module 观察、创建原 session 与真实管理传输/前检/资源运行器、工作区内 durable journal、最终隔离证据和累计预算发布；随后执行 Workers 线上验收。新运行器没有默认执行入口，不会因 import 自动开公网。旧 v208 脚本及历史发布包不重跑、不覆盖。

本轮没有部署、Cloudflare 管理 API、公开 HTTP、远端 D1 写入、真实模型/KMS 调用或生产改动。首轮累计 HTTP **382**，真实模型/KMS **0/0**，**US$2 累计上限不重置**，最终增量账单仍未核验。最后实际云端观察为 v1.108 的 `2026-09-08T12:59:42.118Z`，容量 **INCONCLUSIVE_HELD** 保留。

完整 C02.B2.2 物理容量及其他消费者、unknown/幂等、C02.G、C01 剩余决策和 C03–C20 仍开放；本轮资源编排不替代完整目标。

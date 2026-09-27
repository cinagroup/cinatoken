# C02.B2.2 — v219 拒绝请求的隔离 fixture 清理

日期：2026-09-09；Checklist v1.119。此次工作仅处理 v219 遗留的 31 条专属合成测试数据，不重新发送推理，不证明原生 host 终止或完整容量通过。原请求仍为真实发送一次、HTTP 409、无 generation ID，拒绝正文缺失；原始回执不变。

## 实现与清理边界

新增 `staging-sse-rejected-quarantine-cleanup.mjs` 和固定 v220 执行器。与“没有发送请求”的清理路径分开，始终保留 `primarySends=1`、`nativeProof=false`、`experimentPassed=false`。它只接受已发布的特定隔离场景：seed 明确 ACK、请求 409 且无 generation ID、无恢复 RPC、原入口/token/tail/key 关闭证明存在、原 finalizer 仅缺主响应结束和 native proof，当前账务六表为空。

执行条件与顺序：

1. 验证原始回执、计划、fixture 检查、源码/测试及 bundle 的不可变摘要；本轮目录独占保留，不覆盖失败记录。
2. 新只读检查 staging D1 身份、实际代码/version/settings、四个 staging 入口/preview/域名/cron、生产 settings、双 Access deny-all、全部历史 token 与 tail 缺席，以及 Workers/D1 当前可读账单。
3. 首次读出 schema、56 表计数和完整 31 行；28 条 fixture 必须与历史完整快照一致。三个 probe 的 key/value/description 必须匹配 canonical armed 字节，另外捕获此前未记录的数据库维护字段。
4. 从上述当前观察之后的新单调时钟开始，**实际再等待 350 秒**，每次 sleep 不超过 20 秒。没有把旧请求的缺失 finished 样本补造出来，也不跨进程比较单调时钟。
5. 再次关闭状态检查和完整数据读取；等待期间的任何字段、probe 元数据、schema 或计数变化均停止删除。事实日志先 fsync 持久化，再发送删除事务。
6. **一个 175 语句原子 batch**：schema JSON 精确守卫、56 表计数前置守卫、31 条完整行守卫、按依赖顺序的 31 个精确主键删除、56 表计数后置守卫。没有针对账务六表的 INSERT/UPDATE/DELETE；不调用恢复、充值、扣费或退款。
7. 提交后再次读出 56 表计数，并独立复查云端隔离状态。确认丢失不重试 batch；即使服务器实际已删除，也不能把丢失的 ACK 改成成功。

schema 守卫将已读到的 SQLite JSON 聚合结果放进同一删除事务，避免 schema 在“读后、写前”变化而漏检。逐行谓词复用平衡树守卫，避免 D1 表达式深度问题。事务后的计数条件仍在 COMMIT 前，发生意外级联或副作用时可回滚整批。原子回滚语义核对当前 [Cloudflare D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)；没有采用技能引用中不适用的 Sessions 示例。

## 本地验证

新增 **22 项**测试，实际 SQLite 执行完整事务；关闭状态和时钟在本地建模。覆盖正常 31 行清理、两轮关闭检查失败、armed 字节/元数据变化、日志失败、预算/行/全表计数竞争、读后 schema 改变、事务内意外副作用、删除 ACK 丢失，以及错误状态、已分配 generation、伪装未发送、已有 RPC、外来 owner、未撤销 key、非空账务基线及不完整行快照。

初始测试发现本地轻量 D1 没有 Wrangler 管理的 `d1_migrations` 表，已在测试中显式建模；未修改远端 schema。另发现 canonical probe 快照不含数据库维护字段，已改为在本轮等待前捕获全行，等待后再次逐字段比对。

联合回归 **1,855/1,855 PASS**，失败/取消/跳过为 0，staging 类型检查通过，历史 1,770 条摘要及新增源码验证前后不变。Node v24.14.1 本机通过；Node 22/24 远程 CI 仅定义，未运行。见[验证结果](../../../../.wrangler/staging/sse-capacity-peer-v220-verification-result.json)。

## 线上执行结果

实际执行结果为 **CLEANED_QUARANTINE**，见[本轮回执](../../../../.wrangler/staging/peer-v220-quarantine/result.json)。同一新单调时钟实测等待 **350,006 ms**；唯一删除 batch 收到 ACK，删除 31 条专属合成记录，随后 56 表计数恢复干净基线。账务六表仍为空，未执行账务写入。原始完整行快照和删除前日志保留供审计与人工重建参考，但数据未自动恢复，也不应重放原请求。

管理 API **94/94 ACK**，其中一次删除事务；D1 管理查询报告读 3,690 行、写 31 行。新增公开 HTTP **0**，首轮累计仍为 **390**；本轮未部署、未发推理或恢复 RPC、真实模型/KMS 累计 **0/0**，生产写入 **0**。US$2 累计上限不重置；当前可读 Workers/D1 账单费用为 0，但存在账单延迟，最终增量费用尚未核实。

最终独立复核于 `2026-09-09T02:58:01.927Z` 完成：四个 staging Worker 版本及设置不变、入口/preview/域名/cron 关闭，双 Access deny-all，历史 token 与 tail 均不存在，三个生产 Worker 设置摘要不变。该清理不补造原请求正文、响应结束或 native 证明；原 v219 窗口仍为 **INCONCLUSIVE_REJECTED_409**，整体 **STAGING_PARTIAL**。

## 后续门禁

下一步补充有界的非成功响应证据，并继续真正的同池因果观察。不得盲重发推理、用不同实例样本代替同池证明或放宽成功结算点。有效 completed 图片与真实上游 DONE 均已验证后的不可逆结算规则未改；本次 409 未达到该点。

完整 C02.B2.2 物理容量/跨消费者、unknown/幂等、C02.G、C01 剩余决策以及 C03–C20 仍开放。即使本次 fixture 清理成功，整体仍为 STAGING_PARTIAL。

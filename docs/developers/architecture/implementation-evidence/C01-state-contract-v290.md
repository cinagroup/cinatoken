# C01 v290：技术状态边界冻结与 PostgreSQL 实现入口

2026-09-21，Checklist v1.187。**C01.3 技术合同完成；C01 整体与实现 / 集成门禁未通过。** 用户已确认派发认领 / 上游结果不明不自动重发、恢复同一持久结算事实、隔离过期执行者，以及交付 / 上游结果 / 记账 / 资源分别记录；不确认 unknown 收费，也不承诺跨网络 exactly-once。

## 本轮产物

[ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)将批准的技术边界展开为工程合同：

- 区分预算 reservation、credential capacity lease、dispatch claim、恢复 lease 和本地资源 hold；定义八个独立状态维度。
- 区分 claim ACK 丢失与 settlement ACK 丢失：前者不因读回自己的 claim 重获发送许可，后者可精确核对同一原子回执。
- request 级 unknown 禁止通过换 attempt / model / credential 绕过；恢复不具备模型调用权限。
- 保留此前批准的 Images SSE 成功点；结算事实先耐久接受，再交付成功 DONE。交付、财务提交和资源终态不互相冒充。
- 定义同一事实的不可变保存、原子发现、幂等提交和事务内 fencing，列出 ST-01–ST-14 验收矩阵及 PostgreSQL 有限实施顺序。

没有把完整 credential / quote / policy 字段、财务规则、撤权时点或参数假装成已有实现；具体 DDL / 提交顺序在 C03 继续完成。C01.4–C01.10 的其他决策保持未完成。

## 当前代码核查所得差异

1. D1 intent 只支持 Images 两个 operation，四种状态；语法上 attempt_index 最大 32 不代表允许发送 32 次，现有 request 出站次数基线仍为 3。上下文摘要不等于业务授权。
2. 普通预算 `markDispatched()` 可幂等返回 true；不能将它复用为一次性发送认领。现有 PostgreSQL `forfeitDispatched/expireBefore` 的预留额处理不能自动成为本次 unknown 最终收费政策。
3. D1 的快照、任务、fencing 与原子回执已有可测试合同；生产 PostgreSQL 尚缺对应恢复实现，不能仅翻译状态名称或切换驱动就宣告完成。
4. 资源完成通道只有 `confirmed/unconfirmed` 的登记工作确认，并不是物理堆测量或 SQL 取消证明；恢复 / 记账不得等待它才承认已成立的成功事实。

## 验证

检查了三个测试文件及其 SQLite / 子进程 fixture 后，实际执行：

```text
node --import tsx --test --test-concurrency=1 \
  packages/core/src/storage/recovery/dispatch-intent.d1.test.mjs \
  packages/core/src/storage/recovery/usage-settlement.d1.test.mjs \
  packages/core/src/storage/recovery/usage-recovery.d1.test.mjs

tests 88 / pass 88 / fail 0 / skipped 0
duration_ms 84417.4788
```

这些既有测试执行真实本地 SQLite SQL，含 CAS、身份冻结、原子回滚、合成 ACK 丢失、进程退出后独立恢复、过期 lease 拒绝与容量持有。不是新增 88 个用例，也不是原生 Cloudflare D1、PostgreSQL / Hyperdrive 或生产并发验收。fixture 的临时 SQLite 文件按其固定白名单清理；没有删除用户数据或 staging 现场。未重跑完整业务 suite、SSE wire 或所有模态。

本轮只修改技术决策 / 方案 / Checklist 文档，不修改运行时源代码、配置或 SQL 迁移。不调用云端、真实数据库、模型或 KMS，不新增资源，累计 US$2 和既有 C02 维护窗口不变。

## 下一有限步骤

C03.1 / C03.3 的 **PostgreSQL dispatch intent 子集**：先核对现有 schema / 租户主键与数据库测试工具，再实现显式、未接生产工厂的增量草案和 CAS 仓储，覆盖 ST-01–ST-03 及越权 / 过期 / 重启边界。它不决定价格 / 收费、不授予完整 dispatch 权限，也不解决其他 C03 项。其后再扩展结算与恢复事实；资金 / 授权未决项继续单独冻结。

C02 云端阻塞保留，C01.G / C02.G / C03.G 未通过，原始 C00–C20 目标没有缩小。

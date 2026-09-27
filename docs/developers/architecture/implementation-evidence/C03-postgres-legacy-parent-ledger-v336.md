# C03 v336：旧请求 parent 切换前的正式版本账本门禁

2026-09-24；**隔离 PostgreSQL 18.6 子集通过，C03.7／C03.G 保持开放**。正式 PostgreSQL 迁移仍为 73 条；本轮没有执行远端 SQL、部署或云调用。

原 legacy-aware parent 切换 bundle 只依赖各提案检查 `schema_migrations` 中存在 `0073_recovery_api_key_workspace_lock.sql`。目标账本若缺少中间版本或含未审查版本，末尾版本标记仍满足该检查。现在 [bundle 生成器](../../../../scripts/db/cutover/build-request-legacy-parent-default-acl-activation.mjs)先校验本地 73 份正式迁移源码的固定 SHA-256，再把**准确 73 个版本名集合**写入切换事务。集合双向差异在迁移 advisory lock `746923551`、锁等待/语句时限生效之后检查，在默认 ACL 变更及 parent DDL 之前失败并回滚。版本集或源码变化会要求重新审查、重固定 bundle。

[原生报告](./C03-postgres-native-legacy-parent-ledger-v336-report.json)使用夹具自行创建并清理的回环 PostgreSQL 18.6，**1/1、11 阶段、cleanup PASS**。它先应用当前 73 份正式迁移与 expand 提案，再分别删除 `0041_workspaces.sql` 账本行、插入 `9999_unreviewed.sql` 行，确认切换拒绝且 parent 表不存在。恢复准确账本后，原有旧列级 writer、活跃旧 intent 排空、旧 intent／日志登记、旧日志兼容、parent+gate 同事务切换及回滚断言仍通过。生成器单测 **1/1**、`scripts/tsconfig.json` 全量类型检查及定向 diff 检查通过；两项测试已位于现有 Linux CI 工作流，本轮未运行 Linux job。[机器摘要](./C03-postgres-legacy-parent-ledger-v336-results.json)记录报告与源码摘要。

此门禁只能证明**当前源码已审查**且**目标迁移账本版本名准确**。正式账本没有历史 SQL 内容校验和；人工伪造版本行、曾经应用不同 SQL 后写入相同版本名，仍需独立 schema/函数/授权目录与运维审查。生产旧库规模、索引及约束锁窗、批准的保留期与 contract、历史部署二进制、真实 Workers/Hyperdrive/Queue、物理连接关闭与故障演练均未证明。C03.7／C03.G 不勾选，恢复生产路径保持禁用。

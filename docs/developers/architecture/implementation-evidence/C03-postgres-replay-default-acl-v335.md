# C03 v335：回放 expand 默认函数授权闭合

2026-09-24；**隔离原生 PostgreSQL 子集通过，C03.7／C03.G 仍开放**。正式 PostgreSQL 迁移保持 73 条；本轮只修改 review-only 提案和本地夹具，没有远端 SQL、部署或云调用。

v333 新增 `guard_request_log_replay_id_update()` 时，expand 提案末尾的默认 ACL 反查仍只枚举原四个函数。若 migrator 的默认函数 ACL 给其他角色 `EXECUTE`，对 `PUBLIC` 和 runtime 的显式撤销之后，新函数上的额外授权会漏过 expand 审计。这个 trigger 函数是 `SECURITY INVOKER`；本轮发现的是提案声明的授权合同漏检，不主张它本身可被直接调用来改写日志。现将新函数纳入非 owner 授权反查，并更新财务直连授权生成器固定的提案 SHA，以免切换后的授权计划因源文件变化而拒绝。

[回放登记原生报告](./C03-postgres-native-replay-reservations-v335-report.json)在新建且已清理的回环 PostgreSQL 18.6 上 **1/1、22 阶段、cleanup PASS**。新增负例给 migrator 配置额外默认函数 `EXECUTE`，在同一安装事务中只移除旧四函数的额外授权，确认仅新增日志 ID guard 留有漂移时 expand 拒绝并整笔回滚。清除测试默认 ACL 后，正常 expand、七源有界回填、parent gate、并发/事务回滚、日志 ID 保护与只读保留期分类继续通过。

[财务直连授权原生报告](./C03-postgres-native-financial-replay-grant-v335-report.json) **1/1、15 阶段、cleanup PASS**，验证更新后的 SHA pin、精确函数/触发器/ACL 目录检查及独立 LOGIN。[当前普通旧 handler 兼容报告](./C03-postgres-native-legacy-handler-compat-v335-report.json) **1/1、5 阶段、cleanup PASS**，验证普通两参数日志写入、现存仓储归属/列表/统计读者在切换前后继续工作，新 parent ID 碰撞整笔回滚。财务授权单测 **4/4**、`scripts/tsconfig.json` 全量 TypeScript 检查退出码 0；源码、三份报告 SHA 见[机器摘要](./C03-postgres-replay-default-acl-v335-results.json)。

旧 handler 夹具使用当前源码，不是历史部署二进制。仍缺代表性生产旧库及锁窗、批准的保留期与 contract、真实 Workers/Hyperdrive/Queue、物理连接关闭等 C03 验收；生产保持禁用。

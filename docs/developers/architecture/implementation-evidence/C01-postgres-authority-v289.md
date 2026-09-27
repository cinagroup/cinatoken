# C01 v289：PostgreSQL 权威选择已批准

2026-09-21，Checklist v1.186。**C01.1 决策完成；C01 整体、数据库实现 / 集成 / 生产发布未完成。**

用户明确确认“PostgreSQL 为生产环境唯一的预算/资金权威数据库”，仅授权设计与本地实现，不包含迁移、部署或新增云资源。已形成 [ADR-0001](../decisions/ADR-0001-production-financial-authority.md)，同步方案的存储边界、运行时拓扑与恢复合同；没有修改运行时代码、配置或迁移 SQL。

## 从当前源码得到的下一步变化

- Worker 通用解析器仍默认 D1。显式 `postgres` 必须有 Hyperdrive，缺失时抛错；不会自动回落 D1。这个兼容性行为没有被文档选择悄悄改变，也不能认证未来生产能力的后端门禁。
- `createImageUsageRecoveryFactory` 要求 `client.driver === 'd1'`，恢复仓储和四张恢复表为 D1 / proposals 路径；当前 PostgreSQL 正式迁移目录未发现对应四表名。不能只将生产驱动改为 PostgreSQL 就声称耐久 Images 恢复已经可用。
- 旧运行时架构中的 Hybrid 模式允许 Proxy PostgreSQL / Admin D1 并存，可能被误读为同一资金域的有效生产拓扑。已改为只可用于隔离开发 / 离线迁移，不允许生产资金写入分属两库。D1 / MySQL 通用能力和历史实验保留，不删除。
- C02 的云端阻塞仍然存在，但用户本轮的数据库选择提供了新的可推进事实。按 Checklist 3.1，继续 C01.3 技术合同和相关 C03 设计前置，不再把 Zone / Pages 权限当成所有本地设计的阻塞；也不把草案视为签核。

## 本轮验证

实际执行：

```text
node --import tsx --test packages/core/src/storage/runtime-database-config.test.ts
tests 5 / pass 5 / fail 0 / skipped 0
```

五项既有测试分别覆盖显式维护模式、双绑定下默认 D1、显式 PostgreSQL、缺 Hyperdrive 时拒绝和不支持的 Worker MySQL / 隐式 PostgreSQL。只证明当前通用配置解析行为，不是新后端门禁或云端数据库测试。未运行完整业务 suite、迁移、真实 SQL、Workers / PostgreSQL 集成。

文档相对链接、Checklist 表结构和新决策引用另做本地检查。没有网络调用、部署、D1 / PostgreSQL 查询、模型或 KMS 调用；没有新增资源或变更 US$2 上限。生产实际后端未在本轮观察。

下一工作包：C01.3 的技术状态 / 事件合同，重点是把上游发送认领、结果确定性、不可变结算事实、幂等提交、恢复 lease 与物理资源终态分开，为 PostgreSQL 的 C03 schema 提供前置依据。unknown 收费、最长待核实时间和差额承担仍由用户另行决定，不沿用方案中的“按预留上限结算”文字作为自动收费授权。

# 部署与运维文档

这里面向负责把 Gateway 跑在生产环境、升级、迁移、排障和维护运行时的人。

## 部署

| 场景 | 文档 |
|------|------|
| 部署模式总览（Cloudflare 默认） | [deployment/README.md](./deployment/README.md) |
| Cloudflare 外部用户快速部署 | [deployment/cloudflare-quickstart.md](./deployment/cloudflare-quickstart.md) |
| Cloudflare Worker + Admin + D1（运维） | [deployment/cloudflare.md](./deployment/cloudflare.md) |
| Docker / 自托管 / Postgres / MySQL | [deployment/docker.md](./deployment/docker.md) |
| Zeabur 容器平台 | [deployment/zeabur.md](./deployment/zeabur.md) |

## 迁移与切换

| 场景 | 文档 |
|------|------|
| D1 与 Postgres 之间 ETL、对账和切换 | [migrations/d1-postgres-cutover.md](./migrations/d1-postgres-cutover.md) |
| 1.11.x → 2.0：单键 Provider + 路由拓扑（迁移 0015 / 0016） | [migrations/single-provider-key-cutover.md](./migrations/single-provider-key-cutover.md) |
| 2.1.2 → 2.2.0：Gemini operation 收敛（迁移 0017） | [migrations/gemini-models-generate-cutover.md](./migrations/gemini-models-generate-cutover.md) |
| 2.1.2 → 2.2.0：Route Pool 按 priority 层覆盖策略（迁移 0018） | [migrations/route-pool-tier-strategies-cutover.md](./migrations/route-pool-tier-strategies-cutover.md) |
| 2.1.2 → 2.2.0：路由策略 canonical ID 硬切换（迁移 0019） | [migrations/route-strategy-canonical-ids-cutover.md](./migrations/route-strategy-canonical-ids-cutover.md) |
| 2.2.0 → 2.3.0：Route Pool Provider Sticky（迁移 0020） | [migrations/route-pool-sticky-routing-cutover.md](./migrations/route-pool-sticky-routing-cutover.md) |
| 2.2.0 → 2.3.0：路由策略展示对齐 ID 硬切换（迁移 0021：`hash_affinity` / `weight_priority`） | [migrations/route-strategy-display-ids-cutover.md](./migrations/route-strategy-display-ids-cutover.md) |
| 2.3.0 → 2.4.0：音频字符、具名 Admin Key 与审计索引（迁移 0022–0025） | [2.4.0 发布说明](../releases/2.4.0.md#升级说明) |
| 2.6.0 → 2.7.0：用户级模型计费倍率（迁移 0026） | [2.7.0 发布说明](../releases/2.7.0.md#升级说明) |
| 2.7.0 → 2.8.0：周期额度与永久额度拆分（迁移 0027） | [2.8.0 发布说明](../releases/2.8.0.md#升级说明) · [0027 迁移说明](./migrations/0027-user-wallet-credit.md) |
| User audit 兼容导出移除说明 | [migrations/user-audit-legacy-exports.md](./migrations/user-audit-legacy-exports.md) |

升级到 **2.3.0** 时应在同一维护窗口内按 **0020 → 0021 → 同版本 Proxy / Admin 部署**执行；0021 无旧策略 ID 别名，禁止新旧版本混跑。

升级到 **2.7.0** 时须确保迁移已执行到 **0026**。若当前为 2.3.0，需要依次执行 0022–0026；更早版本还应先完成上表中的前序迁移。随后统一部署 v2.7.0 的 Proxy、Admin 与 migrate 镜像。未配置 `charged_cost_factors` 的用户行为保持不变。

升级到 **2.8.0** 时必须应用 **0027**。v2.8.0 服务会直接读取新列，请在维护窗口内备份并暂停请求及额度写入，先执行 0027，再立即部署同版本 Proxy / Admin；禁止新旧版本混跑。服务核验通过后，门户再改用 `POST /api/admin/users/:id/wallet/credit`，不要再通过累加 `budget_max` 发放购买额度。上线前请按数据库运行 [0027 迁移说明](./migrations/0027-user-wallet-credit.md) 中的只读审计脚本。

## 本地演练

本地 D1、Node + Postgres、Node + MySQL 的组合启动方式放在开发者文档中：[developers/local-development.md](../developers/local-development.md)。

发布版本、Changesets 和 GHCR 镜像发布见 [maintainers/release-versioning.md](../maintainers/release-versioning.md)。


## CinaToken 2.14.0 集成迁移

本仓库保留 main 的门户、共享密钥、组织权限与整数额度预留账本。上游新增迁移在既有历史之后追加；不要把上游同名 0027–0030 文件插入或重放到本仓库历史中。

| 能力 | D1 | MySQL | PostgreSQL |
| --- | --- | --- | --- |
| 永久额度 Wallet、加额幂等审计 | 0078 | 0076 | 0082 |
| Key / 用户 RPM 与入口 Host 日志 | 0079 | 0077 | 0083 |
| Provider kind | 0080 | 0078 | 0084 |
| MCP 服务与目录 | 0081 | 0079 | 0085 |

Wallet 初始余额为零，既有周期额度、已消费额和预留账本不做上游历史余额重新分配。新增购买额度使用 Wallet credit 接口。PostgreSQL 使用 `cinatoken_gateway`；D1 的 Provider kind 迁移重建完整依赖闭包，保留门户共享渠道、Endpoint 证据、路由数据策略、索引和触发器。

升级需先备份并停止旧写入实例和在途请求，在隔离数据库验证迁移后再部署同版本服务。数据库迁移文件的合并及本地检查不代表生产迁移或平台验收已经执行。

原有 Web 工作台保留；模型、供应商、路由、调试台和模拟器的新增高级编辑功能可从相应 `/gateway/*/advanced` 入口访问，沿用当前 Console 身份和写入条件。

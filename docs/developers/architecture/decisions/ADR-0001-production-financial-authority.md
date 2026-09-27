# ADR-0001：PostgreSQL 为生产预算与资金唯一权威

- 状态：**ACCEPTED — 选型与设计边界已批准；实现 / 集成 / 生产切换未验收**。
- 日期：2026-09-21。
- 对应：Checklist C01.1；约束 C01.3 / C01.5 / C01.9、C03–C05、C11、C15。
- 决策人：用户。原确认问题限定为设计与本地实现，不迁移、部署或新增云资源；答复为“确认 PostgreSQL 为唯一权威（推荐）”。执行记录：Codex。

## 决定

本次 OpenRouter 型共享平台的生产预算 / 资金状态只以 **PostgreSQL** 为权威。已有业务边界为 `cinatoken_gateway` schema；CinaAuth 继续是身份权威，不因可能共用数据库实例而取得或让渡预算 / 资金权威。

同一生产资金域内，Proxy、Admin/Portal、Chain Worker、结算 / 对账 / 恢复消费者必须指向同一权威数据集，不能各自选择一个数据库再异步合并余额。这里的“唯一”是单一逻辑权威，不规定数据库实例数量、托管厂商、复制拓扑或区域。

适用事实包括预算预留 / 派发 / 释放 / 结算、用户 / Key / Workspace / Guardrail 的预算状态，以及已定义的充值、退款、收益、提现和关联不可变凭证。**数据库选择不批准这些领域之间的金额换算、收费、自动退款或 unknown 差额责任**；它们仍由 C01.5–C01.7 另行冻结，策略预算也不因此等同现金余额。

## 后端与运行时边界

| 场景 | 本次决定的含义 |
| --- | --- |
| Workers 首发 | 沿用项目现有显式 PostgreSQL / Hyperdrive 接入路径；不更改当前配置，不宣称原生验收完成 |
| Node 备选 | 连接同一生产权威 PostgreSQL；Node 的备用身份不是第二个资金主库 |
| 现有 D1 staging | 仍是已隔离的实验 / 兼容性验收环境，不承接生产余额；既有失败现场、围栏及 US$2 上限保留 |
| D1 / MySQL 仓储 | 保留现有通用实现，不删除或自动迁移。它们不是本次发行版的新预算 / 资金生产权威；非支持后端的显式拒绝及误配置测试在 C03.6 / C15 验收 |
| KV、缓存、分析系统及报表 | 可以是派生投影，但不得凭滞后值批准余额或覆盖权威账本；投影修复不能双向回写成另一权威 |

PostgreSQL 不可用或配置不完整时，不得回退到 D1 / MySQL / 内存余额继续生产收费。D1 与 Hyperdrive 同时绑定不构成双写许可；当前解析器在未显式选择驱动时仍默认 D1，因而仅预置 PostgreSQL 绑定不代表本决策已经被运行时强制执行。

## 当前实现与尚缺证据

1. `runtime-database-config.ts` 已实现显式 PostgreSQL 模式缺少 Hyperdrive 时拒绝，不自动回落 D1；但没有本次发行版级的“仅 PostgreSQL 资金权威”启用门禁。不能把通用解析器测试视为该门禁已实现。
2. 现有 `image-usage-recovery.ts` 工厂明确拒绝非 D1，配套 intent / settlement / recovery repositories 也是 D1 路径；四张恢复表位于 D1 proposals。扫描当前 PostgreSQL 正式迁移未发现这些恢复表的对应定义。**既有 D1 恢复证据不能认证 PostgreSQL 路径；此缺口必须在生产启用前关闭。**
3. 既有 PostgreSQL schema 限定与本地引擎结果保留；它们不证明当前远端 schema、角色、连接容量、Hyperdrive 时限、取消或故障恢复满足目标。
4. 本决定不核验当前生产实际使用哪个后端，不授权改运行参数、迁移历史余额或修复远端角色。生产运维责任人和放行证据仍待落实。

## 切换与恢复约束

沿用[切换 runbook](../../../operators/migrations/d1-postgres-cutover.md)的备份、源写入冻结、全量复制、精确对账、共同数据面和首笔新写后的回滚限制；命令示例不是执行授权。具体迁移版本须在实施时按当前代码与源 / 目标 schema 重新核验，不能直接复用历史尾版本号。

不得以双库同时接收生产资金写入实现无停机切换。PostgreSQL 接受新写入后，不得仅切回旧 D1 配置；需要停止相关写入、保全增量和经过批准的恢复 / 对账流程。任何远端动作仍须单独确认目标、备份、维护窗口、费用与回滚边界。

## 后续验收（全部仍待完成）

- C01.3：固定 request / attempt、dispatch claim、上游结果、结算恢复、资源释放之间的独立状态与提交顺序；不得让恢复 lease 获得重新调用模型的权限。
- C01.5–C01.7：冻结资金领域、unknown 收费责任和价格生效点；本 ADR 不代替这些决定。
- C03：基于 PostgreSQL 设计增量 schema / CAS / 唯一约束 / 权限，并补生产恢复路径；不新建脱离现有 request / generation / reservation 的平行账本。
- C03.6 / C15：验证错误后端、缺失配置、跨服务数据面不一致均无法启用本次生产预算 / 资金能力；现有独立 D1 实验不受自动切换影响。
- 集成与发布：原生 PostgreSQL / Hyperdrive 的并发、ACK 丢失、旧 lease fencing、恢复、最小权限、容量和回滚证据齐全后才可放行。

本 ADR 完成的是 C01.1 **选择与边界冻结**；C01.G、C02.G、C03.G 和生产发布仍未通过。

## 代码与合同依据

- [运行时数据库选择](../../../../packages/core/src/storage/runtime-database-config.ts)、[其本地测试](../../../../packages/core/src/storage/runtime-database-config.test.ts)、[StorageContext](../../../../packages/core/src/storage/context.ts)。
- [Images 恢复工厂](../../../../packages/proxy/src/services/image-usage-recovery.ts)、[D1 恢复实现目录](../../../../packages/core/src/storage/recovery)、[D1 草案迁移](../../../../packages/core/migrations-proposals/d1)。
- [PostgreSQL schema 合同](../../reference/postgres-schema-policy.md)、[实施记录](../implementation-evidence/C01-postgres-authority-v289.md)。

# D1 → `cinatoken_gateway` PostgreSQL 迁移与切换

本文定义 CinaToken 将业务数据从 Cloudflare D1 迁入 PostgreSQL 的生产边界和操作顺序。目标 PostgreSQL 可以与 CinaAuth 共用同一数据库实例，但 CinaToken 只拥有 **`cinatoken_gateway` Schema**；不得读写 CinaAuth 的身份、会话或迁移表。

> 当前 Phase 3 已完成目标 Schema 初始化和运行身份隔离：2026-08-24 使用环境中的 Cloudflare API Token，经一次性受保护 Worker 在 CinaAuth 所用 PlanetScale PostgreSQL 18.6 内创建 `cinatoken_gateway`、专用 migrator/runtime 角色和两个独立 Hyperdrive；两个 256 位随机密码只在 Worker 内存、PostgreSQL 与 Hyperdrive 写入式配置之间传递。目标已完成 0001–0030，幂等重跑为 0 新执行/30 跳过；访问探针确认 migrator 仅拥有本 Schema DDL 权限，runtime 只有业务表 DML/函数执行权限且不能读写 `schema_migrations`。所有临时 Worker 均已删除。生产 D1 的 22 张必需表和 11 项不变量预检仍通过，但最终备份、源写入冻结、ETL/对账和灰度尚未执行，因此生产继续使用 D1。

## 1. 不变量

- 业务表固定在 `cinatoken_gateway`，运行时 `search_path=cinatoken_gateway,public`。
- 若只存在历史 `octafuse_gateway`，迁移器会在持有 advisory lock 后将其原地改名；若新旧 Schema 同时存在，迁移器拒绝继续，必须人工对账。
- D1 与 PostgreSQL 的迁移版本必须一一对应。目前目标必须完成 `0030_chain_job_transactions.sql`。
- `portal_sessions`、`admin_sessions` 不迁移，目标会话会被清空；切换后普通用户和管理员都必须重新登录。
- 整数微单位列是门户资金的权威状态；旧 `NUMERIC(18,6)` 列只作兼容投影。
- ETL 不复制 CinaAuth 用户、账户、Session 或 OAuth/OIDC 数据。CinaAuth 仍是身份权威，CinaToken 仅保存稳定身份映射和业务数据。

## 2. 上线前置条件

1. 对源 D1 和目标 PostgreSQL 分别完成可恢复备份，并记录备份标识、时间和校验结果。
2. 使用两个专用数据库角色：`cinatoken_gateway_migrator` 拥有 Schema 并仅用于迁移/ETL，`cinatoken_gateway_runtime` 仅拥有业务表运行时权限。不得复用 CinaAuth Hyperdrive 的数据库用户。
3. 目标没有任何线上读写流量；源 D1 已进入维护模式并冻结所有业务写入。远程 D1 的逐表查询不共享一个事务快照，未冻结源库时不能形成一致副本。
4. `DATABASE_URL` 通过进程环境或秘密管理器注入，不写入仓库、Shell 历史、命令参数或日志。
5. 已确认 D1 完成 0030，且没有未处理的重复活跃提现、负数资金余额或损坏外键。
6. 已创建指向目标 PostgreSQL 的 CinaToken 专用 Hyperdrive 配置；其数据库用户必须是 `cinatoken_gateway_runtime`，Proxy、Admin/Portal 与 Chain Worker 使用同一个 Hyperdrive ID。

### 2.1 源 D1 只读预检

在冻结前和最终复制窗口冻结后各执行一次：

```powershell
npm run db:preflight:d1-source
```

脚本只执行固定的聚合/元数据 SQL，不接受任意查询，不输出 Key、Session、交易原文或用户字段。它验证：

- 0030 和全部 ETL/会话表存在；
- 外键、CinaAuth 身份对、重复身份映射和空邮箱；
- 资金微单位非负且与兼容投影一致；
- 每用户最多一笔活跃提现，提现金额和锁定余额一致；
- 链上 Outbox 类型、交易摘要和业务行引用有效；
- 0024 删除的 `MASTER_KEY` 不再残留。

2026-08-24 的生产只读快照：2 个用户、1 个 CinaAuth 映射、1 个 API Key、1 组用户资金行、Portal/Admin Session 各 1；提现、NFT、账本和链上 Outbox 均为 0。所有 11 项不变量通过。此快照仅证明当时状态，最终冻结后必须重跑，且 Session 仍按本方案不迁移。

最终窗口的冻结顺序固定为：先以 `CINATOKEN_MAINTENANCE_MODE=true` 部署 Proxy 与 Admin，并从公网确认二者均返回带 `Retry-After` 的 503；再移除 `cinatoken-chain-jobs` 的 Chain Worker consumer，等待在途批次结束；最后在一段观察间隔前后分别读取 D1 Time Travel bookmark 和全套只读预检，只有 bookmark 与业务计数保持不变才可传入 `--source-frozen`。恢复服务时由 Postgres 生产部署重新加入 Queue consumer，不能在 D1 ETL 期间提前恢复。

## 3. 初始化目标 Schema

### 3.1 安全预配角色

由秘密管理器向一个受控进程注入以下变量，不得把真实值写入 `.env`、仓库、工单、聊天、Shell 历史或命令参数：

- `DATABASE_URL`：临时 DBA 连接，必须具有目标数据库 `CREATE` 和 `CREATEROLE`；
- `CINATOKEN_GATEWAY_MIGRATOR_PASSWORD`：随机生成且至少 24 字符；
- `CINATOKEN_GATEWAY_RUNTIME_PASSWORD`：另一份独立随机密码，至少 24 字符。

先强制回滚演练：

```powershell
$env:CINATOKEN_GATEWAY_DRY_RUN = 'true'
npm run db:provision:pg-roles
Remove-Item Env:CINATOKEN_GATEWAY_DRY_RUN
```

只有演练返回 `transaction rolled back` 后，才执行正式预配：

```powershell
npm run db:provision:pg-roles
```

预配事务持有 advisory lock，创建两个 `LOGIN` 角色并显式禁止 `SUPERUSER`、`CREATEDB`、`CREATEROLE` 和复制权限；Schema 归 migrator 所有，`PUBLIC` 无权访问。PostgreSQL 18 中创建者默认对新角色为 `SET FALSE`，脚本只在事务内临时设为 `SET TRUE` 以分配 Schema 所有权，随后立即恢复。仅在经过审批的轮换窗口设置 `CINATOKEN_GATEWAY_ROTATE_PASSWORDS=true`。

正式预配完成后立即从进程环境清除 DBA URL 和两个明文密码；密码的持久保存只允许在获批的秘密管理器中完成。

2026-08-24 的正式预配由 `hyperdrive-bootstrap-worker.ts` 完成。它在运行时生成独立 256 位密码，通过现有管理员 Hyperdrive 预配数据库角色，并直接调用 Cloudflare Hyperdrive API；Cloudflare API Token 和一次性 `PREFLIGHT_TOKEN` 均通过 Worker Secret 注入，未进入命令参数或仓库。PlanetScale SQL 创建的角色对外连接时使用 `{role}.{branch_id}` 路由用户名，数据库内 `current_user` 仍为无后缀角色。引导 Worker 完成后已删除。

### 3.2 以 migrator 执行迁移

将进程中的 `DATABASE_URL` 替换为 **migrator** 连接（不要在命令前内联连接串），在仓库根执行：

```bash
npm run db:migrate:pg
npm run db:grant:pg-runtime
```

`db:grant:pg-runtime` 会验证当前用户和 Schema owner 都是 `cinatoken_gateway_migrator`、迁移已到 0030，然后向 runtime 授予所有业务表/序列/函数的最小运行权限，并明确撤销其对 `schema_migrations` 的全部权限。

迁移必须可重复执行。随后用只读 SQL 验证：

```sql
SET search_path TO cinatoken_gateway, public;
SELECT current_schema();
SELECT version, applied_at
FROM cinatoken_gateway.schema_migrations
ORDER BY version;
```

预期 `current_schema()` 为 `cinatoken_gateway`，迁移记录完整到 `0030_chain_job_transactions.sql`。若 `octafuse_gateway` 与 `cinatoken_gateway` 同时存在，停止操作，不得删除或自动合并任一侧。

在仅持有 Hyperdrive、无明文连接串的 Cloudflare 操作环境中，使用 `postgres-migrations-worker.ts` 将固定的 30 个 SQL 模块打包到一次性 Worker。入口只接受强 Bearer Token，不接受任意 SQL；迁移和 advisory lock 位于同一事务，成功后调用同一套 runtime 授权逻辑。2026-08-24 首次执行为 30/30，第二次为 0 新执行/30 跳过，随后迁移 Worker 已删除。

### 3.3 创建专用 Hyperdrive

使用 Cloudflare Dashboard 或不会把请求体写入历史的受控 API 流程，以 `cinatoken_gateway_runtime` 凭据创建独立 Hyperdrive。当前 Wrangler `hyperdrive create` 只接受命令行中的连接串或密码参数，因此本流程禁止用该命令传入生产密码。创建后只记录非敏感 Hyperdrive ID，并对绑定执行只读身份/Schema/权限探针；现有 `cinaauth` Hyperdrive ID 不得写入 CinaToken 生产配置。

临时诊断 Worker 必须先通过 stdin/秘密管理器配置至少 32 字符的 `PREFLIGHT_TOKEN` Secret，并由不会记录 Authorization Header 的受控客户端访问。两个诊断入口在 Secret 缺失或 Bearer Token 不匹配时均 fail closed；验证结束后删除整个临时 Worker，而不是只删除 Secret。

2026-08-24 已创建两个独立配置：`cinatoken-gateway-migrator` 只用于迁移/ETL，`cinatoken-gateway-runtime` 用于长期业务运行，二者均禁用 SQL 结果缓存。`hyperdrive-access-probe-worker.ts` 的双身份探针已验证角色、Schema owner、0030/30 条迁移记录、业务表 DML、函数执行、禁止 `TRUNCATE`、禁止访问迁移表等合同，探针 Worker 随后删除。生产配置只预置 runtime Hyperdrive ID；在最终 ETL/对账和放行门完成前不得设置 `DATABASE_DRIVER=postgres`。

## 4. 演练

先对 D1 备份或本地持久化副本演练，目标必须是隔离的非生产 PostgreSQL：

```bash
DATABASE_URL='postgres://...' npx tsx scripts/db/cutover/etl-d1-to-postgres.ts \
  --d1-source=local \
  --d1-persist-to=./.wrangler/state \
  --truncate \
  --target-offline \
  --source-frozen \
  --batch-size=1000
```

`--target-offline` 和 `--source-frozen` 是强制确认项。ETL 会：

1. 校验目标 Schema、0030 迁移和全部表；
2. 获取 PostgreSQL 事务级 advisory lock；
3. 在同一目标事务中暂时禁用资金触发器，避免复制历史收益/提现时二次记账；
4. 按外键顺序复制全部持久业务表，并把 SQLite 的 `0/1` 布尔值转换为 PostgreSQL 布尔值；
5. 清空目标 Portal/Admin Session，恢复触发器并原子提交。

任一目标 SQL 或 D1 读取失败都会回滚目标事务。`--tables` 只用于离线修复，不能与 `--truncate` 同用，也不能代替最终全量复制；Upsert 不会删除目标中的陈旧行。

## 5. 最终复制与对账

在源写入冻结、目标离线、备份已验证后，执行最终全量复制：

```bash
DATABASE_URL='postgres://...' npx tsx scripts/db/cutover/etl-d1-to-postgres.ts \
  --d1-source=remote \
  --truncate \
  --target-offline \
  --source-frozen \
  --batch-size=1000
```

紧接着对账：

```bash
DATABASE_URL='postgres://...' npx tsx scripts/db/cutover/reconcile-d1-postgres.ts \
  --d1-source=remote
```

对账覆盖所有迁移表行数、请求费用/Token 汇总、用户预算审计、资金微单位汇总以及目标会话清空。任何 `ERR` 都必须阻断切流；脚本以非零状态退出。

此外应抽样核验：

- API Key、Provider 密钥和共享密钥能否由目标运行时正确解密和使用；
- CinaAuth `sub` 到 CinaToken `users.external_system/external_user_id` 的映射唯一且稳定；
- 普通用户只能访问自己的密钥、收益、提现和徽章，管理员权限仍由服务端授权判定；
- 提现创建、确认、失败退款和队列重放不会重复扣款或重复广播交易。

## 6. 灰度、切换与回滚边界

只有在 Cloudflare 各运行时全部支持同一 PostgreSQL/Hyperdrive 数据源、集成测试通过后，才可进入灰度：

Wrangler 配置由环境变量生成，不提交数据库连接串：

```dotenv
# 第一步只预置绑定；未设置 DATABASE_DRIVER 时仍读取 D1
HYPERDRIVE_ID=<cloudflare-hyperdrive-config-id>

# 仅在隔离探针和最终对账通过后，三个 Worker 同时设置
DATABASE_DRIVER=postgres
```

本地隔离演练使用 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 传递连接串。不得在仓库、`wrangler.jsonc`、实例 env 或命令行参数中保存连接串；不得用 `wrangler dev --remote` 对生产库做调试。

1. 保持 D1 写入冻结；使用内部入口验证 Proxy、Admin、Portal 和 Chain Worker。
2. 观察 5xx、延迟、连接池/Hyperdrive、`api_key_request_logs`、资金账本与链上 Outbox。
3. 所有探针通过后再切生产入口，并解除 PostgreSQL 写入限制。

在 PostgreSQL 接受第一笔生产写入前，可以无数据分叉地切回 D1。接受新写入后，本仓当前没有 PostgreSQL→D1 反向复制能力；直接回切会丢失或重复业务事件。此时只能停止写入、导出增量、双向对账并经过人工批准后回切。

## 7. 生产放行门

- [ ] 源/目标备份可恢复
- [x] 目标角色权限最小化，migrator/runtime Hyperdrive 相互隔离
- [x] Schema 仅为 `cinatoken_gateway`，0030 完整、重复执行无变化
- [ ] 最终复制发生在源冻结与目标离线窗口
- [ ] 全量对账零差异，目标 Session 为零
- [ ] 普通用户/管理员越权测试与 CinaAuth 身份映射测试通过
- [ ] 资金并发、队列重放和链上 Outbox 故障测试通过
- [ ] Cloudflare Hyperdrive/Worker 运行时适配完成并通过灰度
- [ ] 监控、告警、回滚负责人和停止条件已登记

相关文档：[部署索引](../deployment/README.md) · [Docker/Node 说明](../deployment/docker.md) · [本地测试拓扑](../../developers/local-development.md)

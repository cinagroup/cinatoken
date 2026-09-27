# C03 v312：普通恢复 SQL 末次派发与恢复身份离线预检

2026-09-23；**LOCAL ADMISSION PASS，ROLE/ORIGIN PREFLIGHT ONLY，PRODUCTION DISABLED，C03 DOING**。承接 [v311 固定扫描门禁](./C03-postgres-owned-scan-deadline-v311.md)。本轮没有连接数据库、执行角色 SQL、创建 Hyperdrive、部署或启用 Queue 消费者。

## 普通恢复 SQL 的候选门禁

[恢复 owner](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)把 v310 创建的同一不可续期截止经 `recovery_admission_deadline` 传入普通 `unsafe()`；[runner](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)在容量、SQL 和 socket 前要求 v312 `recoveryStatementDeadlineFence` 能力标记。旧 v311 候选不再能承接带截止的普通恢复运行；不带截止的旧路径保持原有边界。普通 SQL 不取得 `owned_cancel`，固定扫描仍使用 v311 的独立选项。

[独立 postgres.js 3.4.9 候选](../../../../scripts/db/diag/postgres-recovery-statement-deadline.mjs)在普通 Query 构帧后、首次写出前，及参数查询 Describe 后 Bind／Execute 写出前复查截止。带截止的小帧在该检查调用栈内写出，避免 `setImmediate` 排队穿过截止。Node loopback 的两种 post-Describe 情况已直接捕获客户端出站协议帧：Parse/Describe 已发，而到期或同步池关闭重入后均未发 Bind/Execute。拒绝仍退役所在连接；若同连接有其他管线查询，可能连带中断它们，当前未证明共享管线隔离。已经派发的 SQL 不被追溯取消，驱动内部 BEGIN/COMMIT/ROLLBACK、服务器执行/锁等待、可信物理关闭均未获得绝对期限保证。

## 恢复角色与 origin 预算的离线草案

[预算验证器及显式文件 CLI](../../../../scripts/db/cutover/postgres-recovery-origin-budget.ts)仅计算调用者提交的 15 分钟内同实例快照，要求 PostgreSQL 17+、全部同实例 Hyperdrive 清单、服务端保留槽、非 Hyperdrive 预算、峰值需求和安全余量齐全；每个 Hyperdrive 配置下限为 5。结果明示 `snapshot-arithmetic-only`，不认证输入，也不证明软上限下实时可用连接。[Cloudflare 文档](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/)说明配置下限为 5、origin 上限是软限制，并要求合并考虑同一数据库的多个配置。2026-09-05 的 PS-5 历史事实为 `max_connections=25`、超管预留 3、CinaAuth/runtime/migrator 配置上限 15/5/5；配置合计 25 已超过普通 22 槽，历史负例必拒绝新 recovery origin。这不是今天生产实例的实时快照。

[角色 SQL 草案](../../../../scripts/db/cutover/postgres-recovery-role-policy.ts)只在上述预算输入通过后生成两段供审查的事务文本：独立 `NOLOGIN`、`PASSWORD NULL` 的 `cinatoken_gateway_recovery`，按数据库设置四项正数 timeout 新登录默认值；migrator 阶段按固定表、列和函数目录授权，并在 grant 前核查角色成员、对象/触发器、gateway 内的 PUBLIC 权限。没有执行 SQL、设置密码或让角色登录。PostgreSQL 17 的 [`transaction_timeout`](https://www.postgresql.org/docs/17/runtime-config-client.html)包含显式事务与单语句隐式事务；[`ALTER ROLE ... IN DATABASE SET`](https://www.postgresql.org/docs/17/sql-alterrole.html)在新会话登录时生效。这些默认值仍须原生验证，不能视为客户端无法改变的硬上限。

草案固定返回 `runtimeCompatible:false`。四张恢复关系尚在 `migrations-proposals`，未进入正式 PostgreSQL migrations；现有资金 writer 又在 `api_keys` 和 append-only `api_key_request_logs` 上使用 `FOR UPDATE`，但草案故意不给 UPDATE 权限。[PostgreSQL 17 SELECT 文档](https://www.postgresql.org/docs/17/sql-select.html)明确锁读也要求被锁表至少一列 UPDATE 权限，改成 `FOR SHARE` 同样不能绕过。现有 runtime grant 也撤销日志 UPDATE，不能为通过权限检查放宽不可变日志。后续需先修改/验证锁读与并发合同，再以原生角色负例验证 42501、函数与 PUBLIC 权限。外部 schema、数据库 TEMP/PUBLIC 权限及真实 Hyperdrive 身份均未验收；当前 grant phase 不能作为可运行部署脚本。

## 本地验证与剩余门禁

| 验证 | 结果 |
| --- | --- |
| owner/deadline/扫描 mock 与 Core runner 类型 | **50/50 PASS**；Core recovery TypeScript PASS |
| v312 独立候选 | ESM/CJS/CF 普通 SQL wire 各 **10/10**；继承 v311 扫描各 **13/13**、v307 无截止回归各 **6/6**；双次构建字节一致 |
| 实际 owner→候选回环 | ESM/CJS/CF 各 **2/2 PASS**；到期排队 SQL 拒绝且 owner 保持 unconfirmed |
| 原资金恢复与 Proxy | PGlite runner **31/31 PASS**；Proxy TypeScript PASS |
| 预算、角色离线策略 | origin **10/10**、角色 **5/5** PASS；本地独立 TypeScript 检查 PASS；未执行生成的 SQL |

候选未接正式依赖或采用插件，默认生产路径保持关闭。DBL-04/05/06、PG17+ 实例/角色和同实例连接预算实时核实、完整服务端期限、原生 PostgreSQL、Workers/Hyperdrive、真实 Queue ACK/retry/DLQ 及 C03.G 继续开放。没有云端 API、远端 SQL、部署、模型或 KMS 调用；首轮 staging 累计 US$2 上限不重置。[机器摘要](./C03-postgres-statement-deadline-role-preflight-v312-results.json)列出源码和候选产物摘要。

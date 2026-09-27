# C03 PostgreSQL 恢复任务、有限认领与过期隔离（v294）

日期：2026-09-21。状态：**LOCAL_PASS / NATIVE_ACCEPTANCE_PENDING**，C03.1 / C03.3 子集继续推进；C03 整体 DOING。前置为 [ADR-0001](../decisions/ADR-0001-production-financial-authority.md)、[ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)和 [v293 不可变结算事实/outbox](./C03-postgres-settlement-facts-v293.md)。

## 实际交付

- [独立 proposal](../../../../packages/core/migrations-proposals/postgres/request-usage-recovery-jobs.sql)：新增恢复任务表、复合事实/租户外键、状态守卫、全局及租户 partial due index；不加入自动迁移目录，不回填财务数据。
- [PostgreSQL 仓储](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts)：`ensure / inspect / scanUnregistered / scanDue / claim / fail`。类型检查入口为 `packages/core/tsconfig.recovery-jobs-postgres.json`，没有接入 production factory / public export。
- [测试](../../../../packages/core/src/storage/recovery/usage-recovery-jobs.postgres.test.mjs)和[三进程 fixture](../../../../packages/core/src/test-support/postgres-recovery-jobs-child.mjs)：真实本地 PGlite 执行 proposal 与 SQL，并保留故障注入和错误实现负对照。

没有 `commit / complete / renew / dispatch` API，也没有恢复 runner、Queue 定时投递、最终结算回执、扣账或卖家入账。表当前只允许 pending / leased / blocked；**committed 必须留给后续已核验财务结果的事务路径**，不能用独立“任务完成”更新冒充。

## 注册、引用与可发现性

任务通过不可变 fact 关联完整 request / attempt / user / API key / workspace / operation / context / claim / payload digest。任务冗余的 tenant / workspace 列由复合 FK 约束，供有界扫描索引使用；其他身份从不可变 fact 读取，不建立另一份 mutable 身份权威。

v293 的快照和 outbox 已原子成立，本轮任务注册允许后续进行：`scanUnregistered` 对有 outbox 但没有任务的事实做每页最多 50 条反连接扫描，`ensure` 幂等补建。**无时间高水位**；反复扫描直到补齐缺失任务，未来新提交可再次发现。数据库报错或任务注册失败不删除 outbox；注册 ACK 不明只精确读回，不重试写入、不授予执行权。

已有任务（包括 blocked）不被重复注册或重置。`scanDue` 也只返回轻量完整引用和 revision，不加载 payload；普通查询/注册结果不返回 lease token 或 proof。全局 `kind: all` 仅供受信平台恢复服务，tenant scope 不是调用者身份认证的替代品；HTTP/角色授权尚未接线。

## 状态与时间边界

| 情形 | 必须及实际得到的结果 |
| --- | --- |
| pending 到期 / leased 过期，再认领 | 完整身份 + revision 比较；先锁一个 job 行，再在 UPDATE 守卫中读取 `clock_timestamp()`；新 token、新 revision、attempts + 1 |
| 认领事务返回了行，但 COMMIT ACK 还未到 | 不交付 proof；事务失败/ACK 不明不读回授予所有权，不内联重试 |
| 相同 revision 重试 / 活跃 lease 被抢占 | not_claimed；不会增加尝试次数或授予第二个 owner |
| 旧 lease 已过期、新 owner 尚未接管 | 旧 proof 的任务失败报告仍为 not_owned；伪造客户端 expiresAtMs 无效 |
| 已被新 revision 接管 | 旧 token、旧 revision 或两者混用均不能修改任务 |
| 新认领在锁等待后执行 | TTL 从实际数据库变更时间起算，不从等待前或事务开始起算 |
| proof 在 ACK 传输期间过期 | 查询到/收到 proof 不保证仍有效；后续任务更新在数据库再次拒绝。最终财务写入也必须独立重验 |
| 瞬时失败 / 中断 | 数据库生成有界退避，清除 lease，revision + 1；旧 proof 不能延后/重置退避 |
| snapshot_invalid / settlement_conflict | blocked，固定错误码，不保存任意异常文本；不自动重新入队 |
| 五次认领耗尽 | 过期后可被独立 exhausted 转移关闭为 blocked；不会无限恢复或重发模型 |

`last_transition` 分开记录 claimed / failed / exhausted / enqueued：尤其在第 5 次 lease 刚到期时，**合法的到期耗尽分类**不能让**过期旧执行者的失败报告**通过同一宽松分支。测试已覆盖这一边界。失败事务回滚保留原 owner；失败 ACK 丢失保留已持久退避，但不返回已确认结果，不允许旧 proof 再报告一次。

沿用已禁用 D1 原型的技术参数：最多 5 次恢复认领、lease 1–300 秒、瞬时失败退避 5/10/20/40 秒。它们不是新的推理次数、unknown 计价规则或 C01.10 生产参数签核。无续期、无自动解除 blocked。

## 验证证据

Windows / Node 24.14.1，PGlite 0.5.8 / PostgreSQL 18.3 WASM，68 个既有正式迁移。数据库及合成身份均为本地临时 fixture，不读取远端数据库或真实凭据。

| 执行 | 结果 |
| --- | --- |
| 初版 jobs suite | 39/39 PASS，19,976.3569 ms |
| 扩展 proof 复制及三进程重开 | 41/41 PASS，27,158.3694 ms |
| 最终新增 suite（含锁等待后 TTL、迟到 ACK） | **43/43 PASS**，29,451.7885 ms，0 skip，计数含父测试 |
| 既有 PG facts + D1 recovery 回归 | **76/76 PASS**（44 + 32），40,821.0347 ms，0 skip；D1 财务测试不计 PG 财务证据 |
| 专项类型检查 | PASS，退出 0 |
| v291 / v292 / v293 源码摘要 | 5 / 3 / 5 个均未变 |

负对照将**仅测试库**的守卫改为 `transaction_timestamp()`，延迟 1.1 秒后错误实现仍允许过期失败报告；原始 `clock_timestamp()` 实现相同场景拒绝。另有仅测试库时钟 oracle 验证完整 5/10/20/40 退避序列，以及时钟退回到上次修改之前时的拒绝；这些不冒充操作系统时钟/NTP 或原生锁竞争验收。

三进程按以下顺序验证：① 保存事实与 outbox，但不注册任务；② 新进程扫描补建、提交认领后模拟 ACK 丢失；③ 再次重开，待旧 lease 到期，从 DB 读取候选并只取得 revision=2 / attempts=2。第三进程验证原始价格输入，不能重新认领派发，最终测试性 blocked，无消费日志/预算扣减。未向子进程传递原请求、lease token 或原 revision；只有临时磁盘路径、执行阶段和固定测试租户范围。

上述重开是正常关闭进程/磁盘重开，不是突然断电或原生 WAL 崩溃证明。ACK 故障来自适配层注入，不是本轮真实 PostgreSQL 网络代理。各 SQL 身份、时间、孤儿 scope、直接非法状态变更、三种 search_path 阴影、整数损坏和缺失 schema 场景均已覆盖；没有性能吞吐/延迟承诺。

复跑：

```powershell
$env:GATEWAY_PGLITE_MODULE = (Resolve-Path '.wrangler/staging/pg-schema-v250/package/dist/index.js').Path
$env:GATEWAY_PG_FINANCIAL_BASELINE = ''
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/usage-recovery-jobs.postgres.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/usage-settlement-facts.postgres.test.mjs packages/core/src/storage/recovery/usage-recovery.d1.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-jobs-postgres.json --noEmit
```

测试只清理已确认终止子进程的、经绝对路径/父目录检查的本次 mkdtemp 库；观察不明时保留现场。本轮相应临时目录剩余 0，删除的是可重建合成测试数据，无用户/staging 数据删除。

## 未完成与下一有限步骤

1. **任务更新的 fencing 不等于资金提交的 fencing**。本轮未实现最终 receipt、余额/预算/日志/任务完成的同事务边界，也未证明 ST-08 / ST-09 或完整 ST-10 / ST-13。
2. 下一项审计并实现同一不可变事实的 PostgreSQL 回执及最终权威写事务内 fence；必须复用现有资金/预算事务，不增加平行账本，不用当前价格重算。任何 unknown 金额、撤权规则、报价/卖家收益决策仍依赖未决 C01 项；相关生产路径保持关闭。
3. runner 的 admission、在途 DB 操作持有者、取消/超时、全局公平性、永久失败人工处理、监控、容量和 Queue 扫描调度未完成。仓储方法没有因此被视为有界运行的生产消费者。
4. 角色/RLS、实际最小权限、禁止 DDL/TRUNCATE/停用触发器、归档/删除、索引/约束升级锁和旧读者兼容仍未验收。当前内部仓储依赖受信 DB 调用者；token/revision 条件是仓储协议，不声称任意拥有原始 SQL UPDATE 权限的调用者都被认证。
5. [v292 原生启动阻塞](./C03-postgres-native-runtime-v292.md)未解除，VC++ 系统更新仍待许可；本轮原生业务测试 **0** 项执行，未重跑 initdb、安装运行库、重启或改连远端。

PostgreSQL 最佳实践技能影响了短事务、单 job 锁后校时、partial due index 和权限限制记录。复用已缓存的官方[当前时间语义](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)及[显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)资料，无新网络查询。

无云管理、远端 SQL、部署、模型、KMS、系统更新；首轮累计 **US$2 不重置**。C01.G / C02.G / C03.G 均开放，C04 TODO，完整 checklist 目标继续保留。[机器摘要](./C03-postgres-recovery-jobs-v294-results.json)

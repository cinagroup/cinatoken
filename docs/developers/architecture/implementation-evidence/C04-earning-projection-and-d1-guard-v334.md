# C04 v334：收益统计修复与 D1 历史防护子集

2026-09-24；**本地子集，C04.1–8/G 均仍开放**。[机器摘要](./C04-earning-projection-and-d1-guard-v334-results.json)记录本轮命令、报告与源码摘要。

## 已入账历史的 D1 防护

当前正式 D1 `0027` 迁移把请求日志、共享 Key、卖家用户删除级联到 `shared_key_earnings`。在加载全部 **68 条正式 D1 迁移**的 SQLite/D1 夹具里，负对照删除已用 Key 后收益明细从 1 变 0，而卖家账本仍有 1 条、余额仍为 **40,000 micros**；负对照在 savepoint 内立即回滚。[review-only D1 提案](../../../../packages/core/migrations-proposals/d1/shared-key-earnings-history-guard.sql)安装后，直接改删收益行及删除三类父行均被拒绝；重复 request-log 收益不会再入账，无收益的 Key 仍可删除，外键检查无遗留错误。[本地测试](../../../../scripts/db/cutover/d1-shared-key-earnings-history.test.mjs) **1/1 PASS**。提案未进入正式迁移，不代表已有 D1 部署受到保护。

管理员与卖家的共享 Key 删除路由把上述 D1 错误及 v333 PostgreSQL 防护提案的精确 `23514` 约束错误映射为安全的 HTTP **409**，其他数据库异常保持原处理。[路由测试](../../../../packages/admin/lib/routes/shared-key-history-error.test.ts) **2/2 PASS**，Admin 类型检查通过；这些 409 只有在相应数据库防护被实际安装后才可能出现。两项测试已登记当前工作树的 Proxy dispatch safety CI；Linux CI 尚未运行。

## 已入账明细后的统计重建

`settleSharedKeyEarning` 正常路径仍对 Key 汇总执行一次增量 UPDATE，但会比较最初读到的 input/output 计数及原始金额 decimal 字符串；若并发写入或全量重建改变快照，转为从已提交收益明细重建，余额和收益行不再增加。重复请求、统计更新失败、增量结果 ACK 丢失也走此幂等重建；Key 的当前价格变为 0 时仍能按已有明细修复统计。D1/PG/MySQL 仓储新增明细查询和全量重建，PG/MySQL 重建先锁父 Key 再聚合；D1 使用单条写语句。合成服务回归覆盖重建与增量交错、两笔正常结算争同一快照，**9/9 PASS**；D1 SQLite 仓储 **1/1**、PG PGlite SQL **1/1**，Core 专项及 Proxy/Admin 类型检查通过。

这些测试尚不证明原生 PG 多会话或 MySQL InnoDB 并发；D1/PG 当前无 `shared_key_id` 聚合索引，重建可能扫描全表。若进程在收益明细提交后永久退出且无重复投递，仍无持久扫描任务发现落后的汇总，因此 **C04.7 只取得局部修复，不勾选完成**。当前 CI 已登记服务、D1 仓储与专项类型检查，PGlite 夹具仍仅本地运行；Linux CI 尚未运行。

## MySQL 门禁

[MySQL 外键切换审查](./C04-mysql-earning-history-fk-gate-v334.md)指出当前正式 `0027` 的三个 `ON DELETE CASCADE` 也能删除已入账明细。MySQL 官方文档说明级联不会运行子表触发器，因此不能直接移植 D1/PG 的子表触发器；改变外键删除行为需真实目标版本、数据与锁窗验证。本轮未运行 MySQL 引擎、未提交自动迁移，MySQL 历史防护保持开放。

## 尚未通过的门禁

本轮没有创建不可变报价快照、typed 经济 outbox、专用收益消费者或持久补投/扫描任务。同步结算仍不能保证请求事实与收益明细原子提交。规模、并发与 MySQL 实机证据仍需补齐。正式迁移计数保持 PostgreSQL **73**、D1 **68**、MySQL **64**；生产禁用，无远端 SQL、部署或云调用。

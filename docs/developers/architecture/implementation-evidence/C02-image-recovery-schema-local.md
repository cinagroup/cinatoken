# C02.B2.2 — 恢复 SQL 定义与源 artifact 本地核验

日期：2026-09-07；Checklist v1.56；**LOCAL_PASS 子集，C02.G 未通过。** 接续 [受保护控制入口](./C02-image-recovery-control-local.md)。详细计数、命令和源文件摘要见 [结果 JSON](./C02-image-recovery-schema-local-results.json)。

## 1. 已实现的检查

旧生产者只统计九个触发器名称并尝试读几个列，无法识别同名的空触发器；独立消费者没有实际定义预检。本轮改为仓库内固定的 artifact：

| 范围 | 核验内容 |
| --- | --- |
| 源迁移 | 68 份正式迁移的有序名称/原始内容 SHA-256 集合摘要，三份 proposal 的有序名称/原始内容摘要 |
| 表 | 四张恢复表完整 CREATE 定义，包括 ALTER 后 receipt 的 lease 字段、CHECK、FK、PK/UNIQUE |
| 索引 | 四个显式索引的完整定义、七个 SQLite 自动索引的身份/null SQL 形状 |
| 触发器 | 九个完整定义，包括 claim、immutable、enqueue、transition、fence、complete |

共 **24 个对象**；正确 SQL 文本合计 **10,072 UTF-8 字节**。运行时比较 type、name、所属表、SQL 字节数和完整 SHA-256，额外/缺失对象也拒绝。测试以相同名称、相同字节长度把租约 `>` 改成 `<`，或把 CHECK 上限 `5` 改成 `9`，证明不能只靠名称/长度通过。

SQLite schema 表保存对象的 CREATE 文本及 ALTER 后变化，自动 PK/UNIQUE 索引的 SQL 是 null。检查遵循这些实际表示，不自行压缩空白或改写字符串常量。[SQLite schema table](https://www.sqlite.org/schematab.html)

新文件为 `usage-recovery-schema-artifact.ts`、`usage-recovery-schema-d1.ts` 和本地源核验脚本。三个 proposal 原文、68 份正式迁移、财务 critical-write、租约和收费规则均未修改。artifact 为当前任务本地自审，不冒充独立 Reviewer 或签名发布证明。

## 2. 运行时接线与有界持有

- 普通 Images 生产者在出站意图/预算准入前核验；结果 DTO 已拥有后、持久化前再核验；独立快速结算任务在查找/认领任务前再核验。没有成功缓存。
- 独立消费者先取得容量，再读取定义和计算摘要，之后再次检查准入窗口/取消，才扫描任务。验证失败不开始 claim 或账务写入；容量在实际查询/哈希结束后才归还。
- 单次只读查询 `main.sqlite_master`，匹配指定表或指定对象名；最多 **25 行**（第 25 行用于发现额外对象）。SQL 的 CASE 在返回前将超过 **4,096 字节**的定义置 null，类型/名称/表名分别限制 16/128/128 字符。这里约束的是返回工作集，不保证数据库扫描成本恒定。
- 固定 `UsageRecoverySchemaError` 不暴露原始 SQL、定义内容或数据库错误。不采用 DDL 自动修复、不接受调用者提供的“正确摘要”。

Cloudflare D1 支持基于 SQLite 的 schema 检查；本轮验证在本机 SQLite 3.51.2 执行，真实 D1 表示兼容性尚未验证。[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)

依据 Workers 最佳实践，将校验读取和摘要计算纳入实际持有链，并检查类型、绑定与离线包；文本限额不是 Workers 物理内存结论。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 3. 源 artifact 检查与发布边界

```powershell
npm run check:usage-recovery-schema -w @octafuse/core
```

命令只读本地固定路径，先核对源摘要，再把一致的 68+3 份 SQL 应用到新建的内存 SQLite，比较实际 24 个对象。无文件 DB、网络、远端迁移、自动重建/批准 manifest 或 enable 参数。源内容/顺序/名称改变时，失败发生在执行候选 SQL 之前。

源摘要与实际定义摘要是不同证明：前者检测部署输入漂移；后者检测数据库中的对象定义漂移。二者都不是对仓库管理员/发布凭据的密码学隔离。格式或行尾变化也可能拒绝；不同 SQLite/D1 版本若给出不同 CREATE/ALTER 表示，应保留失败、审阅候选并核验兼容性，不能自动更新摘要或忽略差异。

仍必须另行完成：远端 DB 身份、受控迁移和禁止并发 DDL、专用 Access/服务绑定授权、回填状态、数据与 receipt/job/log 一致性。此检查不覆盖无关表、TEMP shadow、PRAGMA/连接状态、内部 B-tree 损坏、恶意 DBA 或在检查后改 schema；也不证明 DML 回填已执行。Core 原有回填事务测试继续保留，但它不代替云端回填证明。

## 4. 测试与兼容变化

新增 **67 项**：

- 47 项 Core/schema/source：完整重建、输入漂移、九个同名空触发器、四个错误索引、四个表 ALTER、对象归属/缺失/格式变化、等长谓词/约束变更、长 SQL/长名称/100 个额外索引、有界返回、坏返回结构、无缓存、容量/取消/时限与错误脱敏。
- 20 项真实 Images 接线：生成/编辑各九个同名触发器替换，在推理、intent、reservation、snapshot、job 或日志写入之前拒绝；两项交付后的快速结算定义变化，保留 accepted snapshot/job，不认领，恢复原定义后只结算一次且不重发推理。

两项旧测试按更强检查分离故障：

1. payload 篡改测试在修改 payload 后恢复原封不动的 immutable trigger，使它仍验证坏 payload 进入 blocked，而不是被 schema 检查提前拦住；没有放宽 payload/金额断言。
2. 上游返回期间丢失 enqueue trigger：旧测试允许先存孤立 snapshot、然后返回 503；新检查在存 snapshot 前就拒绝。因此 snapshot 从期望 1 改为 0，503、一次原推理、零 job/日志保持。它仍没有足够事实恢复用量，不自动重试或退款。

Core 链 **19 + 37 + 32 + 47** 项通过；Images 定点链 **48 + 20** 项通过；完整 staging 链 **35 + 7 + 130 + 39 + 48 + 60 + 24 = 343** 项通过，最后 24 项进程退出测试已等待至退出码 0；不把定点测试的重叠计数累计成独立场景。Core recovery、staging、dispatch-safety 三项定向类型检查通过。完整 Core 类型检查依旧 **FAIL：32 条与既有基线完全相同**；基线比较脚本退出 0 不是完整类型检查成功。

Wrangler 4.127.1 双 Worker 绑定类型检查通过；接收 Worker 离线包 **342,080 字节 / gzip 64.95 KiB**，仅外部依赖 `cloudflare:workers`，导出 `UsageRecovery`/default。这不是发布、真实 Workers RPC/D1 证明或内存测量。本轮未重跑完整 2,687 项 dispatch-safety 行为 suite，不将上一轮通过计为本轮结果。

## 5. 仍未启用及下一项

下一项为**显式实验容量配置与 schema 发布前核验**：先计入定义查询/摘要的新增工作集，再在独立 staging 重验资源、SQL 定义/回填与最小 Access 策略，开展真实 Workers RPC/取消/终止/恢复和完整容量样本。没有生产容量默认值。

双 Worker 源配置保持 disabled、无公开路由/cron；三个 SQL 仍是 proposals，正式迁移仍为 68。生产工厂未启用恢复/容量池，历史 [漏日志问题](./C02-staging-image-storage.md) 仍开放。完整报价/权益/owner、财务 unknown、卖家收益/outbox、SSE、审计保留和客户端幂等门禁不因此通过。

本轮额外执行 **3 次只读云管理 GET**，staging D1 身份、Gateway 入口关闭（含 previews）和已有 Access deny-all 策略均返回 200 且符合预期；不据此宣称新恢复控制应用已授权，也未重测写权限。部署、远端 SQL、真实模型/KMS 均 **0**；历史 staging HTTP **98**、模型/KMS **0**。首轮累计上限 **US$2 不重置**，最终增量账单未核验。没有套餐升级、自动充值、生产读取/写入或 VC++ 系统修复。Wrangler 版本/帮助检查曾提示本地用户目录日志写入被 sandbox 拒绝，这不是 Cloudflare 权限失败；后续指定资源 GET 核验成功，未修改系统配置。

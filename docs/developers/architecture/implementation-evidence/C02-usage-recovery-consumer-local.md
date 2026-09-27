# C02.B2.2：有界独立结算恢复执行器（本地基础）

2026-09-07，Checklist v1.51，LOCAL_PASS 子集。C02 DOING，C02.G / 完整恢复与容量仍 NOT_PASSED；Owner / 自检：Codex，独立 Reviewer 未指定。[结构化结果与源码摘要](./C02-usage-recovery-consumer-local-results.json)。没有部署、远端迁移、真实模型或 KMS 调用。

## 1. 实际实现

- [SQL 草案](../../../../packages/core/migrations-proposals/d1/request-usage-recovery-jobs.sql)：结算快照插入时，由同一数据库事务创建 pending 任务；避免另一次 Queue 发送失败造成任务丢失。已有快照可回填，只有回执及身份/金额匹配的日志同时存在才标为已完成，回填不重放账务。仍在 proposals，正式迁移保持 68 份，未自动应用。
- [领取仓储](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-d1.ts)：显式平台/租户扫描范围、按到期时间与 request id 排序的索引、有界标量引用；单条 CAS 领取，随机 token + revision，每次领取消耗一次恢复尝试。确认丢失不回查授予执行权，等待新租约恢复；不是重新授予模型调用权。
- [独立执行器](../../../../packages/core/src/storage/recovery/run-usage-recovery-d1.ts)：每次只扫描一批，先获取容量再查询，逐项从持久化快照复用原结算。不是常驻服务，没有 polling、Cron、Queue binding、HTTP 入口或外部模型调用。
- [结算仓储](../../../../packages/core/src/storage/recovery/usage-settlement-d1.ts)及[原 critical write](../../../../packages/core/src/db/d1/critical-writes.impl.ts)：在原 batch 的回执写入点，以数据库 UTC 时钟验证当前 token/revision/有效期；回执触发任务完成，后续账务 SQL 失败会整体回滚。新领取替换旧租约后，旧执行者不能再提交或改写任务状态。

回执、任务完成、日志、尝试、统计、原预算与审计在同一事务内完成。数据库检查的是执行 SQL 时的时间，不使用 batch 排队前的 JavaScript 时间。事务的写入序列化防止另一执行者在中途接管；ACK 返回时租约过期不否定已经原子提交的事件。重复消费者仍核对同租户/事件/快照/金额，已完成事件可只读确认。

**原默认结算调用未改为自动恢复，也不依赖新表。** 新 SQL 禁止无租约插入恢复回执，但不是针对拥有数据库写权限者的安全边界。旧默认写入仍可能先生成无回执日志；新执行器将其视作待对账冲突，不再次收费。生产者/路由接入必须明确唯一写入路径，不能同时运行新旧两条结算链。

## 2. 有界策略及容量

| 项目 | 本地技术边界 |
| --- | --- |
| 单次扫描 / 消费并发 | 1–50 个标量引用 / 1–4 个消费者；不批量加载 50 份完整 JSON |
| 租约 / 运行准入窗口 | 调用方显式提供 1–300 秒 / 1–60,000 毫秒，无生产默认值 |
| 恢复重试 | 最多 5 次领取；暂时失败依次退避 5 / 10 / 20 / 40 秒，第 5 次失败或过期耗尽转 blocked |
| 持久化错误 | 固定枚举，不存储 SQL 异常、凭据或模型正文；损坏快照/身份冲突立即 blocked |
| 容量 | 调用方必须显式提供每消费者预留；先预留后扫描，所有已启动 D1 Promise 结束后归还 |

运行窗口限制**新任务准入**，不是硬完成期限或 D1 取消能力。租约过期、客户端取消或另一消费者失败，都不释放仍在等待数据库的内存额度；执行器使用 allSettled 等待所有已启动工作结束，没有 timeout race、脱离持有关系的 Promise 或 TTL 强制归还。原 [数字容量池](../../../../packages/proxy/src/services/request-capacity.ts) 通过结构接口复用，不持有请求/凭据。

测试的 1,024 字节预留是故意使用的小型逻辑计数夹具，**不是内存估计或可发布配置**。256 KiB 快照上限也不等于 Worker 工作集；解析、摘要、SQL 参数、扫描引用、数据库与运行时缓冲仍须实测。不同事件/消费者必须共池或有可验证的隔离；此执行器不提供分布式容量限制。

blocked 保留事实和预算供对账；没有自动解封、退款、释放 reservation、卖家收益或 unknown 财务终结政策。恢复次数不是推理次数，缺少结果快照时仍无法重建 usage。

## 3. 验证

[新增专项](../../../../packages/core/src/storage/recovery/usage-recovery.d1.test.mjs) **32/32 PASS**，含 **6 项真实子进程退出**，全部无跳过。首批 25 项通过，补充 SQL 状态/NULL 防线、损坏快照、扫描上限、丢失退避确认、取消扫描与并行异常持有后扩展为 32 项。

覆盖同事务任务创建失败回滚、历史回填、索引/租户范围、单 CAS 竞争、租约过期/接管、实际 SQL 执行前过期、快照/领取/最终 batch ACK 丢失、五次耗尽、退避、账务写后回滚、原日志冲突、坏快照隔离；覆盖容量不足时零数据库 I/O、输入复制、截止后不领取、扫描/结算未返回期间不释放，以及一个消费者异常时等待其他在途消费者。

子进程在领取提交后、账务 batch 前、batch 提交后以退出码 73 退出，分别覆盖零价与 0.25 合成预算。另一子进程只取得测试数据库路径与测试时钟，自己扫描持久化任务；不传入原请求、结算 DTO 或引用。最终恰好一条日志/回执/尝试，原金额只入账一次。仅清理测试创建目录中固定 allowlist 的 SQLite 文件和空目录，不删除用户数据。

回归：意图 **19/19**、原结算 **37/37**、普通预算 **33/33**、Images staging 本地专项 **42/42（35+7）**；Core 恢复、Proxy dispatch-safety 和 staging 三项定向类型检查通过。新专项通过 posttest 接入既有 Core pretest 链；不声称执行整个 Core unit suite。

最初定向检查曾因领取结果联合类型无法收窄而 FAIL，拆分为三个可区分分支后 PASS。**完整 Core 类型检查仍 FAIL：32 条诊断**，Compiler API 重新检查与 v1.50 诊断的文件/位置/代码/消息完全一致；未删除旧诊断或排除新增模块来宣称全包通过。

以上均为 Node 24 + 真实 SQLite 事务测试。可控时钟只替换测试连接函数，不是生产时钟实现。它们不等同于 Cloudflare D1 多实例竞争、isolate 终止或 Workers 工作集验收。

## 4. Workers 约束、外部操作及下一步

Cloudflare / Workers 最佳实践技能影响了实现：使用参数化 D1 binding、数据库内检查与显式 await；把运行期限和实际资源持有分开，关键事实不依靠 waitUntil 存活。[D1 batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 Workers types 只读核对为 5.20260907.1，项目仍使用 5.20260829.1；未升级依赖或修改部署配置。

本轮没有 Cloudflare/GCP 管理操作、远端 SQL 或发布。历史 staging HTTP 仍为 **98**，真实模型/KMS **0**；首轮累计 **US$2 上限不重置**，最终增量账单未核验。权限已解除的历史验证与最后关闭状态沿用 [staging 记录](./C02-staging-image-storage.md)，不是本轮重新查询云端。

下一项仍为 C02.B2.2：接可信、已脱敏的结算生产者与普通 Images 路由，在允许的交付模式下明确成功交付前的持久化顺序；避免新旧重复写入，单列 SSE 合同，再接入受保护的有界触发入口并回到独立 staging 故障验收。未持久化结果、C04 调度前报价/权益/owner 快照、卖家收益 outbox、其他数据库、完整容量与运行 SLO 均未完成。线上“5 次成功仅 4 条日志”仍开放，C02.G 不勾选，生产容量池保持关闭。

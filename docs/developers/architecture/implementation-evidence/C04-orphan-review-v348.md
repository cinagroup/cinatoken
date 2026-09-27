# C04 v348：quote claim 孤儿待查工作项

2026-09-25。**Review only，默认关闭，未部署。**[SQL proposal](../../../../packages/core/migrations-proposals/postgres/shared-key-orphan-review-v348.sql)、[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-orphan-review-v348.native.test.mjs)和[机器报告](./C04-orphan-review-v348-results.json)只证明本地持久待查协议；C04.2、C04.3 和 C04.G 均未验收。工作项不写买家余额、request log、经济事件、seller 收益或 provider cost，也不能从缺失经济事件推出未发送或零费用。

## 覆盖与并发依据

v347 反例证明 `claimed_at` 不是提交时间。该 proposal 不设 `claimed_at` 高水位：安装事务先以 `SHARE ROW EXCLUSIVE` 锁住 quote attempt 与 economic event 源表，创建两个 `AFTER INSERT` 行触发器，然后全量回填已提交 attempt。安装前的源事务先提交并进入回填，或等待安装提交后由触发器入队。新 attempt 与 `jobs` 创建／累计在**同一 COMMIT**；晚提交、旧 `claimed_at` 的行也不能越过覆盖。原函数对同一 attempt ID 的确认重放不会再插入 attempt，所以不会重复计数；新 attempt 在同一 request ID 的工作项上增加 `claim_count` 并留下审计。

claim 函数先取 `hashtextextended('shared_quote_attempt:' || request_log_id, 0)` 事务 advisory lock；新触发器重取同一锁。买家 request log 的现有触发器在插入前取同一锁，经济 event 的新触发器也先取该锁再更新 job。worker 操作依相同顺序取 advisory lock、重读行、然后取得行锁。因此最终 event 与待查状态只能按提交顺序前进。只有**已提交的经济 event**能自动将工作项标记 `resolved_event`；该状态仅说明 quote claim 的无 event 孤儿问题已消失，不证明 event 内的 provider cost 或 seller 用量已明确。

调度器每次从 `list_due(NULL,NULL,limit,min_age_seconds)` 开始，按 `(due_at,request_log_id)` 临时分页，调用 `claim_job` 时自带 UUID 租约令牌。这个分页键不是持久发现水位。页间有新提交、延迟事件或锁竞争时，下一个完整遍历仍从头开始。`claim_job` 在 advisory lock 后使用 `FOR UPDATE SKIP LOCKED`；返回零行可表示行锁竞争、请求锁竞争、尚未到期、event 已关闭或确实无工作，不能把零页当作清空证明。运营可用 migrator 权限周期性**全量**对账 attempt 与 job 的缺失/计数差异，不能把一次 cutoff 扫描替代触发器覆盖证明。

## 状态、身份与审计

| 动作 | 可调用的直接 LOGIN | 持久结果 |
| --- | --- | --- |
| attempt INSERT | 既有 quote producer | 同事务创建或更新一条 request 级 `pending` job；绝不写收费事实。 |
| `list_due` / `claim_job` | 独立 `cinatoken_gateway_shared_orphan_worker` | 只给到期工作租约；同 token 在有效租约内重放返回同一租约；到期重领增加尝试次数。 |
| `fail_job` | 同一 worker | 记录原因并安排重试；第 8 次失败进入 `dead_letter`。同 token 重放返回 `already_recorded`。 |
| `requeue_dead_letter` | 独立 `cinatoken_gateway_shared_orphan_recovery` | 带 caller UUID 与原因的人工重开；相同 UUID 重放不重复增加 recovery 次数。 |
| economic event INSERT | 既有经济事件写者 | 同事务标记 `resolved_event` 并废止旧租约；旧 worker token 无法重开。 |

私有 `job_audit` 记录每次 revision、动作、直接 `SESSION_USER`、原因和操作 token，并拒绝 UPDATE/DELETE/TRUNCATE。普通 runtime、quote producer、worker 均没有工作项表的直接写权；worker 与 recovery 必须是 `NOINHERIT`、没有任何 `pg_auth_members` 入边或出边的直接 LOGIN，仅获对应函数 EXECUTE，函数核验直接 `SESSION_USER` 和 READ COMMITTED。预检拒绝特权角色及角色继承，后检拒绝额外 schema/table/function ACL。migrator 是 owner，仍可运维修改，故部署时须审计授权、触发器状态及全量覆盖；本 proposal 不建立不可篡改的外部审计仓库。

## 本地原生验证

自有 loopback PG18.6 安装 **73/73** 正式迁移及 review-only quote、attempt、outbox、orphan proposal；**1/1 测试、12/12 阶段、cleanup PASS**。夹具验证：缺激活断言原子回滚；worker 角色 membership 与 recovery `INHERIT` 的安装负例；安装与未提交 claim 跨越锁和回填；COMMIT ACK 不明及同一 attempt 重放；第二 attempt 计数；旧 `claimed_at` 晚提交；重复 due 扫描与租约／失败 ACK 重放；`SKIP LOCKED` 零页而待查 census 非零；8 次失败、dead letter 与人工重开；晚到 event 等待 worker request lock 并废止租约；直接角色越权被拒，未解决 request 的 log/event/旧收益仍为零。夹具用 migrator 提前推进 `next_attempt_at` 以免等待八轮真实时间；没有生产规模基准。

报告固定 SHA-256：PG73 corpus `23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc`；quote proposal `1249a7ff07f95b48c7b45a41833c96c9a028e4bfe3a47e44e9dc6b72c3c77246`；attempt proposal `c89c79e803fd69a2d09d44b33be3301aeb8aa4ed72c5dff5518439ec29fafb83`；outbox proposal `f92835c72ff02cba23879ed90ad640832455ccb98764f28fe4ee04ce52aab1ac`；v348 proposal `aa299de2f5c2be07ca8f8a9b4fa91b70456d91b166ea5c70257d91b202626752`；夹具 `6f830e1525240c5ae853d65844eb7de9102d393aad19d11fef7099db3829fd98`。

## 仍需完成

生产 activation、独立凭证管理、真实调度器、持续 trigger/ACL 健康检测、全量覆盖对账、backlog/锁竞争压测、值班界面和保留期策略仍缺失。更关键的是 claim 无法证明物理发送或实际 provider 费用；跨进程 admission／send／usage 证据及经授权的买家补正、卖家结算协议仍需独立建立。这个工作项只保证模糊事实不会因扫描水位或请求进程丢失而从待查集合消失。

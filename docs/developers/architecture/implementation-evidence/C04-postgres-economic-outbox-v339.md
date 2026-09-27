# C04 v339：每跳经济事实与买方结算同事务 outbox 提案

2026-09-24。**Review only、默认关闭；C04.2／C04.3／C04.G 仍未验收。**[机器摘要](./C04-postgres-economic-outbox-v339-results.json)和[原生报告](./C04-postgres-economic-outbox-v339-report.json)固定本轮运行及源码 SHA。未运行远端 SQL、未改正式迁移或生产结算路径。

## 当前事实与数据来源

- 正式 provider_attempt_availability 只有 route/provider、可用性分类、HTTP status 和观察时间，按保留期删除；没有报价、计费用量、上游成本或财务确定性，不能当作每跳经济事实。
- api_key_request_logs 记录整单 token 与买方金额、选中 route 和部分价格审计；它不保存每个可能收费 attempt 的 seller 报价版本或成本。recordUsage 调用 insertRequestUsageAndChargeTx 完成买方日志／预算后，才另起调用 settleSharedKeyEarning，并重新读取当前 Key 价格／owner／佣金。现有 shared_key_earnings 对 request_log_id 唯一，一条日志只能有一条旧收益明细。
- 现有 C03 request_usage_settlement_outbox 是请求 usage 恢复事实的发现索引，写于**买方结算之前**；它不是共享 Key 收益事件，也不包含每跳报价或 provider 成本。

## 提案合同

安装顺序为 73 个正式 PG 迁移 → [v338 不可变报价](../../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql) → [v339 派发前 quote attempt](../../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql) → [v339 typed economic outbox](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql)。经济提案要求 migrator 直接 LOGIN、明确的事务内 activation 值和精确 73 版本 ledger；私有 schema／表／函数在安装提交时只允许 migrator owner，防止 migrator 默认权限把财务源暴露给第三方角色。安装前拒绝任何已经有请求日志的 quote attempt，避免把事后补事件伪称原子结算。

派发前 attempt 先经专用 LOGIN 的 claim_shared_key_dispatch_quote_attempt 持久固定 exact transition_id／quote_version_id、seller、Key、route 与 attempt index，**提交成功后才可发物理请求**。经济事件按 event_id=request_log_id 固定 v1 类型、版本、买方金额／usage／certainty、attempt 数量和总体 certainty；不可变子行逐 attempt 引用已持久的报价 ID，并记录本跳用量、provider 成本微单位、各自的 actual／estimated／unknown／confirmed_zero 确定性和脱敏证据摘要。早期失败跳也保留自己的成本，不能只以最后成功跳代替。未知不等同零费用。

对于已有 quote attempt 的请求，api_key_request_logs 的 deferred trigger 要求**同一 COMMIT**出现事件且事件覆盖所有 attempt；事件的 deferred trigger 对照日志中的买方金额、token 和身份，验证子行数量、引用与总体 certainty。事件／子行不能 UPDATE、DELETE 或 TRUNCATE。dispatch claim 与买方日志 INSERT 都先获取同一个 request advisory transaction lock；晚到 attempt 等买方 COMMIT 后被拒绝。锁不刷新 REPEATABLE READ／SERIALIZABLE 的旧快照，因此买方日志、经济事件和旧收益插入都要求 READ COMMITTED；对请求日志的限制覆盖所有请求，部署前须审计全部写入者。缺事件或缺某一跳事实时，日志和同事务买方预算写入一起回滚。事件可以凭 event ID 扫描恢复，但 recorded_at 在提交前写入，未来 C04.6 扫描**不能只用时间水位**，必须有可恢复的投递／lease／重扫协议。

对仍存在的旧同步收益路径，提案在 shared_key_earnings INSERT 前锁相同请求日志；已加入经济事件的请求拒绝旧收益。事件插入也拒绝已存在旧收益的日志。原生负例覆盖两方向，防止仅凭 outbox 自己的唯一键误称不会双付。**提案没有收益消费者，也不会支付新事件**；未来要有与旧路径共享 request_log_id／经济事件幂等键的受控切换和支持一单多跳的收益明细。生产开关只能在消费者及恢复协议完成后考虑。

## 本地验证

[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-economic-outbox.native.test.mjs)启动自有 loopback PostgreSQL 18.6，安装 73 正式迁移及三份提案，**1/1、16 阶段、cleanup PASS**。覆盖默认关闭／中间版本替换及额外迁移拒绝、恶意 migrator 默认授权导致安装原子回滚、普通 runtime 私有表拒绝、两会话旧 REPEATABLE READ 快照不能绕过经济事实、缺事件／缺 outcome 回滚日志与合成买方余额、买方金额不符拒绝、unknown 不能宣称 confirmed、先后两版报价各保留一跳费用、重复事件／事实修改拒绝、旧收益双付和旧已付日志改编拒绝、attempt index 对调拒绝、晚到 attempt 在买方 COMMIT 后拒绝。

本夹具通过手工 SQL 在一个事务内更新**合成**买方余额、插入日志、事件和子行，证明数据库事务合同可行；当前 insertRequestUsageAndChargeTxPg 尚未调用事件写入，且其已有 replay 早退分支需要同一事件检查。buyer_charge_basis／buyer_usage_certainty 当前日志没有可靠 typed 来源，必须由未来 critical writer 的已验证结算输入提供。provider_cost_micros／证据摘要仍需与实际 provider usage 或账单事实核实。共享 Key 的所有协议入口、D1/MySQL 对等合同、真实 Workers/Hyperdrive/Queue、消费者、unknown reconciliation、历史审计及生产权限／锁窗均未验证，因此 C04.2／3 和总门禁保持开放。

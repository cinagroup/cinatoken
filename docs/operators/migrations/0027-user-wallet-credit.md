# 周期额度与永久额度（Budget / Wallet）

本文件保留上游文档编号。本分支在已有迁移历史后追加 Wallet，实际脚本是：

| 数据库 | 迁移文件 |
| --- | --- |
| D1 | [0078_user_wallet_credit.sql](../../../packages/core/migrations-d1/0078_user_wallet_credit.sql) |
| MySQL | [0076_user_wallet_credit.sql](../../../packages/core/migrations-mysql/0076_user_wallet_credit.sql) |
| PostgreSQL | [0082_user_wallet_credit.sql](../../../packages/core/migrations-postgres/0082_user_wallet_credit.sql) |

既有 `budget_max`、`budget_base`、`budget_spent`、整数消费值、epoch 和活动预留均保持原值。Wallet 的 `wallet_granted`、`wallet_spent` 初始为零。此分支不执行上游 0027 的历史余额重新分配，不免除已有超支，也不重新发放周期额度。附带的旧审计 SQL 仅供研究上游回填模型，不能作为本分支已完成生产审计的证据。

有限额度的准入在同一个预留账本中计算两池总可用额，避免并发请求重复使用永久余额。结算先消费剩余周期额度，再消费永久额度；`settled_wallet_micros` 保存每笔预留的永久池分摊。未知结果沿用保守上限结算，后到的实际用量优先退还该笔永久池消费。周期重置保留永久余额，其永久池退款仍可核对；请求日志的 `charged_wallet_cost` 由原子结算决定。

上线时使用同一版本 **2.14.0** 的迁移器、Proxy 与 Admin：先备份并暂停写入及在途请求，在隔离数据库验证完整迁移链，再执行迁移和部署。新增购买额度通过 `POST /api/admin/users/:id/wallet/credit` 发放，并用稳定的 `external_ref` 保证幂等。

迁移后检查原有周期余额和预留未改变、Wallet 初值为零、重复 credit 只加额一次，并验证跨池扣费、超时后的实际结算、周期重置、用户审计和请求日志。完整编号表见[操作文档](../README.md#cinatoken-2140-集成迁移)。

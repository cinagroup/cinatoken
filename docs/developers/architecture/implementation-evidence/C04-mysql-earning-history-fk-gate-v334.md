# C04 v334：MySQL 收益历史外键切换门禁

2026-09-24；**只读设计审查，未执行 MySQL SQL**。当前 `migrations-mysql/0027_user_portal_shared_keys.sql` 把 `shared_key_earnings` 对请求日志、共享 Key、卖家用户的三个外键都定义为 `ON DELETE CASCADE`。任一相关父行被删除时，已入账收益明细可能消失，而账户余额和账本并不由同一逆向事务撤销。

MySQL 官方文档说明外键级联**不会触发子表触发器**；因此 PostgreSQL/D1 的 `BEFORE DELETE ON shared_key_earnings` 防护不能直接移植到 MySQL。要从父删除处建立持久约束，需要把这三个外键改为 `RESTRICT`，并另设直接修改收益行的保护。官方文档还指出：同一 `ALTER TABLE` 中删除并重建外键需要 `ALGORITHM=INPLACE`；添加外键在保持 `foreign_key_checks=ON` 时只支持 `COPY`，而把检查关掉再打开**不会重新扫描历史数据**。[外键语义](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html)、[在线 DDL 约束](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)、[检查开关](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html)。

所以本轮不提交一个声称安全的自动 MySQL 迁移。后续切换必须先确定运行版本、实际外键目录和数据规模，再完成写入封闭、备份、孤儿/金额核对、受控 DDL 与失败回滚演练；尤其不能用未经复核的 `foreign_key_checks=OFF` 换取 `INPLACE` 后便宣布历史数据有效。当前本机没有 MySQL 服务或容器，尚无真实 MySQL 锁窗、原子性或级联拒绝证据。C04 的 MySQL 侧仍未验收，生产资金权威仍按 ADR-0001 限定为 PostgreSQL。

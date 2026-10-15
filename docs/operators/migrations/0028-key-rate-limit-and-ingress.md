# 0028：按 Key / 按用户限流与请求入口 Host（本分支追加迁移）

本文件保留上游文档编号。实际脚本为 D1 `0079_key_rate_limit_and_ingress.sql`、MySQL `0077_key_rate_limit_and_ingress.sql`、PostgreSQL `0083_key_rate_limit_and_ingress.sql`，位于对应 `packages/core/migrations-*` 目录。

## 变更

- `api_keys.rate_limit`：TEXT JSON。`NULL` / 空对象 = 该 Key 不限。当前形状为 `{"rpm": <非负整数>}`（每 60 秒滚动窗口）；`rpm: 0` 拒绝计次请求。后续可在同一对象增加其它维度。
- `users.rate_limit`：TEXT JSON，形状与 Key 相同。`NULL` / 空对象 = 用户层不限。窗口按该用户**所有 Key 合计**；不复制到新建 Key，也不要求 `key.rpm <= user.rpm`。
- 代理服务双重执行：先消耗 Key 窗口，再消耗用户窗口；Key 已超限则不再消耗用户窗口。对外仍是 `429` + `gateway.rate_limited`。`GET /v1/me` 两层都不计入。
- `api_key_request_logs.ingress_host`：记录入口 Host，**不做准入**。
- Proxy 在写入用量日志时回写 `api_keys.last_used_at`。
- 窗口计数**不落库**：默认在代理服务进程 / isolate 内存中（与熔断同一一致性）；后续可换成 Redis 等集中存储。内存 subject 前缀为 `k:` / `u:`。

## 步骤

1. 备份后对目标库执行完整追加迁移链（或官方 migrate 镜像）。
2. 滚动更新 Proxy / Admin。
3. 管理后台用户详情可设置用户合计 RPM；密钥（Keys）页可设置单 Key RPM。未设置的存量行行为不变。

## 回滚

Worker / 容器回退即可。新列可留空不用；不必立刻 `DROP COLUMN`。

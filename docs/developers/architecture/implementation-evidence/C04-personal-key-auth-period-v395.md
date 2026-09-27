# C04 v395 — 专用 personal Bearer 鉴权与保守周期重置

这是 review-only PostgreSQL 原型。SQL 尚未成为正式 migration，生产 `authenticateApiKey` 未切换。正式迁移数量保持 PG73 / D1 68 / MySQL64。

SQL：[personal-key-auth-period-v395.sql](../../../../packages/core/migrations-proposals/postgres/personal-key-auth-period-v395.sql)。客户端：[postgres-personal-key-auth-v395.ts](../../../../packages/proxy/src/services/postgres-personal-key-auth-v395.ts)。原生 fixture：[postgres-personal-key-auth-period-v395.native.test.mjs](../../../../scripts/db/cutover/postgres-personal-key-auth-period-v395.native.test.mjs)。机器结果：[C04-personal-key-auth-period-v395-report.json](C04-personal-key-auth-period-v395-report.json)。

## 身份与权限

新独立 `LOGIN NOINHERIT cinatoken_gateway_personal_key_auth` 只具有 `cinatoken_gateway` schema 的 USAGE 和 `authenticate_personal_gateway_key_v395(text)` 的 EXECUTE。它不能读取 `api_keys` / `users` 原表、Provider 密钥或财务表，也不能调用 capability、quote、grant、close、私有 period helper。安装要求 direct migrator、显式 activation、PG73 名单和 v388 分支的精确 catalog：14 张依赖表的全部 **37 个 user trigger**、28 个相关函数的 owner/body/security/config 与 EXECUTE ACL 一致；新 role、默认 ACL、已有函数的额外 EXEC/WITH GRANT OPTION 或新增 trigger 都拒绝安装。报告保留完整 catalog 便于逐项核验。

唯一身份输入是完整 inference Bearer。入口限制 printable `sk-`，排除 management namespace，真实 hash 优先绑定 `hashref:sha256:…`；旧明文行通过同一事务迁移 hash、storage key 和既有 preview。实际 key/user/workspace 状态、过期时间及 personal owner 一并核验。organization workspace 不在此入口范围。

返回 `AuthenticatedApiKey` 白名单及 `keyLimitEpoch`：key/user/workspace ID、user email、budget max/spent/epoch/period/reset、BYOK-limit flag、既有 user/key metadata 合并结果和 charged-cost-factors JSON。User metadata 按既有 `resolveMeMetadata` 覆盖同名 key 字段。结果递归冻结，不返回 Bearer、key hash、Provider URL/密钥或 C04 隐私数据。

客户端捕获连接、Bearer 和 signal；真实 SQL transaction 验证 `current_user = session_user = auth LOGIN` 和 read committed，再设置 2s lock / 15s statement 边界。成功、无效身份均等待 COMMIT 与专属连接 close ACK；pending、畸形结果、取消、未知 COMMIT 或不确认的 close 都不能产生可用鉴权上下文。Hyperdrive adapter 的角色 URL 仅是本地 factory key，真实连接仍须通过 origin role 检查。

## 周期政策

未到期或 `none` 不写预算。到期后，只有无未完成个人义务时才恢复 `budget_max = budget_base`、清 `budget_spent`、递增 epoch、按原 UTC 锚点推进到未来 reset time，并在同一事务插入周期审计。Daily/weekly 保持 UTC 时刻；monthly 保持逐次月底夹紧语义，例如 1/31 → 2/29 → 3/29。入口不允许调用者提供当前时间、账户、金额、epoch 或审计内容。

到期且存在非零 reserved counter、live ordinary reservation、相关 live Guardrail reservation/window，或者任何尚未具备完整 v388 terminal/log/event 的 C04 grant，返回 `period_reset_pending`，客户端拒绝鉴权。已经 admitted 但没有 grant 的非零 reservation 同样阻止重置；unlimited 请求零预留而已 grant / start 也阻止重置。SQL 先锁 key/user/workspace，再锁 obligation 表，避免检查与写回之间产生新的义务；此原型会序列化无关账户的预算写，尚未验证生产吞吐。

v367/v388 当前依据旧 epoch 续租与收口，因此这里明确采用“义务完成后再重置”。它不能证明跨周期不中断兼容。Real no-fetch resolver 和 v388 closer 完成终态并释放所有 holds 后，下一次 auth 才能重置。Terminal/log/event 缺少任一 companion 时仍 pending；日志时间戳按 typed timestamptz 比较，避免 closer 使用 Singapore 时区、auth 使用 UTC 时误判 JSON 时间字符串。已 admitted 的无 holds 请求若先被合法 auth 推进 epoch，真实 v362 granter 必须返回 stale，不能继续发送旧 quote。

## 本地验证与限制

专用客户端定向单测 **7/7 PASS**，覆盖白名单/冻结、metadata 合并、角色与隔离、源金额及额外密钥字段、DSN/Bearer 边界、COMMIT/close 不确定及取消时等待 owned cleanup。

原生验证 **20/20 stages PASS，cleanup PASS**；包含 **14 个安装负例**，报告记录 **47 个文件 pins + PG73 aggregate**。Fixture 运行真实 PostgreSQL 18.6、73 个正式 migration 及原始 proposals；现代和 legacy Bearer 均调用真实 SQL auth，预算准入/grant/start/no-fetch/terminal 也调用真实专用 LOGIN wrapper。Audit 失败及其后 legacy key write 失败分别验证 reset/audit/epoch/key 的事务回滚。物理 ACK-loss proxy 实测 1 个连接、1 次 extended COMMIT、1 次后端 `CommandComplete(COMMIT)`、1 次响应丢弃；第一次不释放身份，独立读取确认一次 reset/audit 和 legacy migration，fresh auth 不增加 quote 或审计。来源核验仍以机器报告中的 status、stages、cleanup 和 source SHA256 为准。

本机 fixture 的 fault injection 可调整自有 grant deadline 或制造 audit 失败；运行角色没有这些权限。精确 catalog 固定 v388 安装分支；已经增加 v389 recovery enqueue trigger 的数据库需要单独审阅组合安装契约，不能直接绕过此检查。没有远程 SQL、部署、生产凭据或付费 Provider 请求。实际 Cloudflare/Hyperdrive origin、生产 auth 接线、organization auth、完整跨 epoch 义务迁移、D1/MySQL parity、Linux CI 与容量仍需后续验证；C04 仍未验收。

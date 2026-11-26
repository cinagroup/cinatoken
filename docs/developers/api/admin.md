# 管理接口

后台 Console Session 与具名 Admin API Key 共用的管理 API。

## 部署与路径（cinatoken）

- **对外 URL**：`{GATEWAY_MASTER_URL}/api/admin/...`（Admin Pages 根 URL；外部集成方约定使用同名环境变量。例如创建 Key：`POST .../api/admin/keys`）。由 **Admin Pages**（`packages/admin`）提供，**Proxy Worker 不提供 `/admin`**。
- **本文档中的路径**：一律指内部 Hono 挂载路径 **`/admin/...`**（与实现代码一致）；集成时请将前缀换成 **`/api/admin`**。

## 认证

外部系统在请求头中携带具名 Admin API Key：

```bash
Authorization: Bearer sk-admin-<64 hex characters>
```

浏览器登录统一通过 CinaAuth；回调创建数据库 Session，签发 `cinatoken_session` Cookie，并以 `console:cinaauth:<subject>` 识别 Console。会话读取仍接受迁移期的 `admin_session` Cookie；旧密码登录 `POST /api/auth/login` 已返回 `410`。Console 拥有完整业务权限，也是唯一可以管理集成密钥的主体。

OIDC Core 的标准 `sub` 上限为 255 个 ASCII 字符，保存的 Console username 另有 9 字符 `cinaauth:` 前缀。MySQL 必须先应用 `0072_admin_session_username_oidc_capacity.sql`，将 `admin_sessions.username` 扩至 264，保留既有字符集、排序规则、非空和无默认值属性；回退应用时保留加宽列与现有会话。D1/Postgres 此列原为 TEXT，不新增对应迁移。此修复不修改认证校验、Cookie 或其他身份列，也不证明发行方支持治理 header 的 600 字符容忍度；原生 MySQL DDL及真实身份服务登录仍需验收。其他管理域的审计 actor 容量须独立核验，不能仅据会话可保存宣称长主体全部业务可用。标准定义见 [OIDC Core §2](https://openid.net/specs/openid-connect-core-1_0.html#IDToken)，本地检查及剩余门槛持续记入 [Web 迁移 checklist](../architecture/web-frontend-migration.md)。

Web 管理入口使用服务器 Cookie 会话，不内置集成 Bearer Key。`GET /api/auth/check` 仅在 CinaAuth 当前角色验证成功且主体一致时返回 `authenticated: true`、`principalType: "console"`、`verification: "verified"` 和精确 `subject`。API Key 验证成功不会返回 Console subject；身份服务故障可返回 `verification: "degraded"`，也不提供 subject。旧响应缺少 subject 时，严格 Web Gate 不授予管理权限；先发布后端扩展，再启用新管理页面。每个管理业务请求继续独立复验权限，前端入口验证不能替代它。

集成密钥（Integration Keys）在后台 **系统集成 → 集成密钥（Integration Keys）** 创建。每个外部集成应使用独立、最小权限 Key；Key 主体记录为 `admin_key:<id>`。权限包括 `users.*`、`user_keys.*`、`oauth.read`、`oauth.write`、`oauth.consent`、`providers.*`、`models.*`、`routes.*`、`config.*`、`analytics.read`、`logs.read`、`playground.execute`、`mcp.read`、`mcp.write`、`mcp.secrets.read` 和 `maintenance.*`；`*.write` 自动包含对应 `*.read`，`*.secrets.read` 不随 write 授予，`*` 代表全部可委派业务权限，但不包含集成密钥或 Session 管理。

升级迁移会把非空 `system_config.MASTER_KEY` 原值复制为普通全权限 Key `legacy-master`，确保旧调用方继续工作；随后的迁移会删除该配置行。新认证只读取 `admin_api_keys`。请在稳定后为外部系统创建具名 Key，并轮换或吊销 `legacy-master`。

无效或已吊销 Key 返回 `401`；权限不足返回 `403`，响应包含 `required_permission`。任何 Bearer Key（包括 `*`）均不能访问 `/admin/access-keys/*`。

### 集成密钥生命周期审计

`/admin/access-keys` 的全部响应（含认证、校验、存储错误与预检）均为 `Cache-Control: private, no-store`。列表/详情只返回至多 12 位前缀加掩码，且至少隐藏 secret 末 4 位；历史短 Key 的前缀可以为空。创建、PATCH 中显式替换 secret、rotate 的成功响应按原约定返回一次完整 Key；`GET /:id/secret` 是显式 reveal，必须在审计提交后才返回 Key。

创建、修改、轮换、吊销、重新激活和显式 reveal 都记录 `admin_access_key_audit`，主体来自本次已认证的 `console:<username>`。三库把记录和实际写操作放在同一事务内；MySQL/Postgres 对 Key 行加锁以取得一致的权限/状态前后快照。审计写失败、审计表缺失或插入未获确认时，写操作回滚，reveal 不返回 secret。自动认证查找、hash 惰性修复和 last-used 更新不属于 Console 生命周期动作，不产生此类记录。新建审计不回填历史行为。

审计只包含 `id`、`key_id`、`action`、`change_mask`、`actor_kind`、`actor_id`、权限前后数组、状态前后值和 UTC 时间；不保存 secret、hash、prefix、name、description 或请求正文。权限只允许已知有限词表并去重排序，历史异常或过长权限 JSON 记为 `null`。`action` 为 `created` / `updated` / `revealed` / `rotated` / `revoked` / `activated`；PATCH 同时改 secret 和 status 时 `action` 优先记 `rotated`，完整变更由 `change_mask` 与状态字段表达。位值 `name=1`、`description=2`、`permissions=4`、`secret=8`、`status=16`，reveal 为 `0`。这里只记录已提交的动作；失败尝试继续由 API 错误日志表达。

**标准 OIDC actor 容量**：完整 `console:cinaauth:` 前缀长 17，标准 subject255 对应 actor272。集成密钥审计的写入与读取均接受 Console 前缀之后至多264个 Unicode code point，保留既有控制字符拒绝语义，原样保存合法 actor；异常历史 actor 或非 Console 审计主体使读取返回私有错误，不截断、哈希或静默跳过该行。MySQL 先追加 `0073_admin_access_key_actor_oidc_capacity.sql`，将审计 `actor_id` 扩至272并保留原属性；D1/Postgres 该列原为 TEXT，无新迁移。这与 Session 的0072独立，需一并升级仓储与全部写实例；应用回滚时保留两列加宽，旧 writer 对长 actor 的拒绝和原子保证兼容窗口仍须记录。原生DDL、驱动及真实身份验收继续见主 checklist。

`GET /admin/access-keys/:id/audit?page_size=50&cursor=...` 仅允许 Console Session，返回 `{ success:true, data:{ entries:[...], next_cursor:string|null } }`。每页默认 50、最多 100；仅接受 `page_size` 和 `cursor`，空、重复、未知或无效参数返回私有 `400`。游标绑定 Key ID，以 `(created_at,id)` 倒序进行 keyset 分页，不使用 OFFSET，不返回全量 count；MySQL/PG 游标保持六位微秒、D1 使用本接口写入的三位毫秒 UTC。不存在的 Key 返回 `404`；存储失败返回私有错误。游标是分页定位值，不构成跨请求事务快照。

**部署顺序**：先应用 D1 `0072_admin_access_key_audit.sql` / MySQL `0068_admin_access_key_audit.sql` / Postgres `0077_admin_access_key_audit.sql`，核验表与 `(key_id,created_at DESC,id DESC)` 索引；Postgres 完成 runtime grant reconciliation 并核验审计表只有 `SELECT,INSERT`，没有写改/删除/截断或可转授权限。D1→PG ETL 预检要求上述迁移，保留审计并逐字段核对安全 metadata。迁移是追加 schema，旧 Admin 仍可运行，但旧实例的生命周期动作不产生新审计；必须部署全部新 Admin、排空旧实例与旧写路径后，才启用 Web 集成密钥页面并声称审计完整。若回退到旧 Admin，审计保证会出现兼容窗口；保持 Web 路由开关关闭并记录该窗口。新 Admin 在未迁移或权限不足的库上会拒绝变更/reveal，禁止绕过审计作为降级。

登录成功 / 失败、登出与 `401` 未认证不落库，而是以结构化 JSON 写入日志流（Cloudflare Logs / 容器 stdout），`event` 取值 `admin.auth.login`、`admin.auth.login_failed`、`admin.auth.logout`、`admin.auth.unauthorized`，附带 `client_ip`、`user_agent`，Bearer 场景另附 `key_prefix`（前 12 位）。请在日志平台按 `event` 建立告警规则（例如同一 IP 的 `admin.auth.login_failed` 频次）。

## 时间与时区约定

存储 / 查询 / 业务日界 / `BUSINESS_TIMEZONE` 的完整约定见 **[time-and-timezone.md](../reference/time-and-timezone.md)**。摘要：库内 UTC；API 时间字段返回 ISO 8601 UTC（`Z`）；Admin 墙钟与业务日界按 `BUSINESS_TIMEZONE`。

- **计费币种**：`system_config.BILLING_CURRENCY` 仅允许 **`USD`** 或 **`CNY`**（各库的 **`0002_seed.sql`** 默认 `USD`），与 `pricing_profile` / Key 预算数值单位一致；`GET /v1/me` 返回 `billing_currency`（见用户接口文档）。**`PUT /admin/config`** 写入该键时由服务端白名单校验。
- **全局路由策略**：`system_config.ROUTE_STRATEGY`（默认 `hash_affinity`；四选一，见 [route-strategies.md](../reference/route-strategies.md)）。**`PUT /admin/config`** 白名单校验；Route Pool / 模型级配置可覆盖。
- **用户计费倍率合成**：`system_config.USER_CHARGED_COST_FACTOR_MODE`（默认 `multiply`；另允许 `min`）。控制 `users.charged_cost_factors` 如何与路由 Charged 有效倍率合成最终用户费用。**`PUT /admin/config`** 保留白名单兼容；Web 使用带版本条件和身份前置的专用 `PUT /admin/config/user-charged-cost-factor-mode`。Proxy 进程内缓存约 30s。
- **Proxy 错误告警（可选）**：`ALERT_WEBHOOK_WECOM_URL`、`ALERT_WEBHOOK_FEISHU_URL` 存**完整**群机器人 Webhook URL（含 query `key` / hook id）。**未配置或值为空则不告警**。Proxy 在 **`api_key_request_logs.status = error`** 且用量写入成功后，分别向已配置的 URL 发送一条**按错误类型归类**的文本摘要（企业微信 `msgtype=text`、飞书 `msg_type=text`）：首行含类别与优先级（如上游超时、供应商鉴权、限流、5xx、敏感内容拦截、请求/模型错误、路由配置），并分组展示影响用户、路由/协议、供应商、原始 `error_message`、处理建议与发生时间（UTC+8）；发送失败只打日志，不影响请求。键名常量见 `@octafuse/core` 导出 `ALERT_WEBHOOK_WECOM_URL_KEY` / `ALERT_WEBHOOK_FEISHU_URL_KEY`。

### `/admin/keys` 统一响应格式

所有 **`/admin/keys`** 与 **`/admin/keys/:id`**、**`/admin/keys/:id/logs`** 的 JSON 响应使用同一信封：

- 成功：`{ "success": true, "data": ... }`，部分接口另有 `message`、`total`、`page`、`page_size` 等字段。
- 失败：`{ "success": false, "message": "..." }`，HTTP 状态码 4xx/5xx。

若认证无效，在到达业务处理函数前返回 `{ "success": false, "message": "Unauthorized" }`（401）；权限不足返回 403。

---

## Admin API 矩阵 {#admin-api-matrix}

逻辑分层：**Catalog**（供应商 → 模型 → 模型路由）、**Tenancy / Billing**（用户 / Key、`system_config` 中的配额相关项）、**Observability**（全站日志、按 Key 日志、分析聚合）。下列为 **Admin 应用** 对外 **`/api/admin/*`**（内部 **`/admin/*`**）的路径与主要数据表；外部调用方需持有对应资源权限。

| 路径 | 方法 | 主表 / 数据源 | 消费者 |
|------|------|----------------|--------|
| `/admin/users` | GET, POST | `users`（分页列表 / 按外部对幂等创建） | Admin UI、外部集成方 |
| `/admin/users/:id` | GET, PATCH, DELETE | `users`（`:id` 为 uuid 或 `ext:…` 外部路由，见下节） | Admin UI、外部集成方 |
| `/admin/users/:id/display-discounts` | GET | 该用户 `charged_cost_factors` 叠进公开目录 `discounts`（只返回已配置倍率的模型） | 外部集成方 |
| `/admin/users/:id/models` | GET | 按已保存倍率模拟 `GET /v1/models`（默认 `default,free` 文本模型，最多 40 条） | 管理后台 |
| `/admin/users/:id/keys` | GET, POST | `api_keys`（用户范围内） | Admin UI |
| `/admin/users/:id/keys/:keyId` | PATCH, DELETE | `api_keys` | Admin UI |
| `/admin/users/:id/logs` | GET | `api_key_request_logs`（按 `user_id`） | Admin UI |
| `/admin/users/:id/audit-logs` | GET | `user_audit_logs`（按 `user_id`） | Admin UI |
| `/admin/users/:id/budget/transition/preview` | POST | `users`（只读计算） | 外部集成方 |
| `/admin/users/:id/budget/transition` | POST | `users` + `user_audit_logs`（原子转换） | 外部集成方 |
| `/admin/users/:id/wallet/credit` | POST | `users.wallet_granted` + `user_audit_logs`（`wallet_credit`，`dedup_key` 幂等） | 门户加购、外部集成方 |
| `/admin/keys` | GET | `api_keys` **JOIN** `users`（分页列表；预算只读） | Admin UI、外部集成方 |
| `/admin/keys` | POST | `api_keys`（+ 可能 `users`） | 外部集成方、运维脚本 |
| `/admin/keys/maintenance/scrub-legacy-secrets` | POST | `api_keys` 历史明文在线清理（分批、幂等） | 生产迁移运维 |
| `/admin/keys/:id` | GET | `api_keys` **JOIN** `users` | 外部集成方、Admin UI |
| `/admin/keys/:id` | PATCH, DELETE | `api_keys` | Admin UI、外部集成方 |
| `/admin/keys/:id/logs` | GET | `api_key_request_logs`（Key 范围，分页） | 外部集成方、Admin UI |
| `/admin/providers` | GET, POST, GET/PATCH/DELETE `/:id` | `providers`（单键 `api_key` + `status`；列表脱敏） | Admin UI |
| `/admin/providers/:id/api-key` | GET | `providers.api_key` 明文揭示 | Admin UI |
| `/admin/providers/:id/quota` | GET | 按 `kind` 实时查询上游余额 / 周期额度；不落库、不回显密钥 | Admin UI |
| `/admin/providers/import/catalog` | GET | 内置 Provider 模板摘要（无密钥） | Admin UI |
| `/admin/providers/import` | POST | 请求体 `{"ids":["0","1",…]}`：catalog 键（非 provider id）；普通模板新增 UUID 行、同名自动后缀及待替换 key。受支持托管模板使用固定 Provider id 和 `env:NAME` 引用，固定 id 已存在则进入 `skipped_existing`，不覆盖。返回 `created`、`updated`（恒为 0）、`skipped_existing`、`failed`，允许部分成功 | Admin UI、运维脚本 |
| `/admin/models` | GET, POST, GET/PATCH/DELETE `/:id` | `models`（含可选 `route_policy`），`model_tags`；列表与详情 GET 顶层返回当前 `billing_currency` | Admin UI |
| `/admin/models/import/catalog` | GET | 内置静态目录可选项摘要（不含完整 `pricing_profile`） | Admin UI |
| `/admin/models/import` | POST | 请求体 `{"ids":["…"]}`：仅导入指定预设 → `models`，`model_tags`（按 `BILLING_CURRENCY` 选用 USD/CNY 价；**同 id 不覆盖**，记入 `skipped_existing`） | Admin UI、运维脚本 |

| `/admin/providers/sync/diff` | GET | 各 Provider 与内置官方模板的差异报告：按 `kind` 分组，逐字段（`description`、`endpoints.<protocol>`）列出新增 / 变更 / 仅本地有；另列出 `kind` 已不在模板中的 provider（`orphans`） | Admin UI |
| `/admin/providers/sync/apply` | POST | 请求体 `{"items":[{"provider_id","fields":["description","endpoints.openai",…]}]}`：服务端重算差异，只把选中字段写成官方值；不写 `api_key` / `status` / `name` / `kind` | Admin UI |
| `/admin/models/sync/diff` | GET | 各 Model 与内置静态目录的差异报告：按厂商分组，逐字段（`display_name`、`vendor`、`context_window`、`max_tokens`、`description`、`released_at`、`input_modalities`、`output_modalities`、`pricing_profile`）列出新增 / 变更；价格按 `BILLING_CURRENCY` 取目录价并逐叶子路径对比。目录里没有的自建模型、目录未给出的字段不参与 | Admin UI |
| `/admin/models/sync/apply` | POST | 请求体 `{"items":[{"model_id","fields":["description","pricing_profile",…]}]}`：服务端重算差异，只把选中字段写成官方值（经 `updateModelService`，路由价格覆盖时段对齐照常执行）；不写 `tags` / `metadata` / `route_policy` | Admin UI |
| `/admin/routes` | GET（`?model_id=&provider_id=`）, POST, GET/PATCH/DELETE `/:id` | `model_surfaces`、`route_pools`、`model_routes`（Surface → Pool → Target） | Admin UI |
| `/admin/routes/context` | GET | 仅当前有效全局路由策略、计费币种和业务时区的归一化只读投影；要求 `routes.read` 与 `config.read` | Admin UI |
| `/admin/routes/pools/:poolId` | PATCH | `route_pools.strategy` / `tier_strategies` / `sticky_routing`（Pool 策略与 Provider 粘性） | Admin UI |
| `/admin/routes/pools/:poolId/sticky/bindings/summary` | GET | 活跃粘性绑定按 target 聚合（epoch 有效且未过期） | Admin UI |
| `/admin/routes/pools/:poolId/sticky/bindings` | GET | 分页列出当前粘在 Provider 上的用户（可按 `route_target_id` 筛选） | Admin UI |
| `/admin/routes/pools/:poolId/sticky/bindings/lookup` | GET | 按 `user_id` / `email` + surface 上下文反查单用户绑定 | Admin UI |
| `/admin/routes/pools/:poolId/sticky/bindings/:affinityHash` | DELETE | 强制解绑（不校验 `binding_token`） | Admin UI |
| `/admin/routes/pools/:poolId/sticky/reset` | POST | bump `sticky_epoch`，使本 pool 全部绑定失效 | Admin UI |
| `/admin/playground` | POST | Routes：`routeId` 直连上游；Tools：`toolId`+`provider` 读 catalog 直连引擎；不经 Gateway 计费/请求日志/failover，上游自身可能产生费用 | Admin UI、运维联调 |
| `/admin/playground/context` | GET | `playground.execute` 下的模型/路由/Provider/工具安全投影、可读详情、币种与平台上传限制；不读取 Provider 凭据 | Web / Next Playground |
| `/admin/playground/preview` | POST | 安全、有界的目标与请求预览；不读取凭据、交换 OAuth 或发送上游请求 | Web / Next Playground |
| `/admin/playground/realtime` | GET / WebSocket | DashScope ASR/TTS 诊断；Node 返回 501，Cloudflare 使用原生升级 | Web / Next Playground |
| `/admin/simulator/context` | GET | 同时要求 `models.read` 与 `routes.read`；只返回模型/路由/surfaces、Key/日志独立权限与协议能力 | Web / Next Simulator |
| `/admin/keys/:id/verify-secret` | POST | `user_keys.read`；比较所选不可变 Key 与输入的原始秘密，只返回 id/owner/workspace/verified，不恢复或生成秘密 | Web / Next Simulator |
| `/admin/stats` | GET | 多表聚合（含 `api_key_request_logs`、`api_keys` 等） | Admin UI |
| `/admin/config` | GET, PUT | `system_config`（含 `ROUTE_STRATEGY`） | Admin UI |
| `/admin/config/overview` | GET | 八个指定设置键的非秘密只读投影 | Web Admin UI |
| `/admin/config/tools/overview`、`/:family/providers/:provider/detail`、`/:family/audit` | GET | 四族安全配置投影与 group 审计 | Web / Next Tools UI |
| `/admin/config/tools/:family/providers/:provider/save`、`/reveal` | POST | 完整 family 版本原子配置 / 强制审计单字段揭示 | Web / Next Tools UI |
| `/admin/config/billing-currency`、`/admin/config/route-strategy`、`/admin/config/user-charged-cost-factor-mode`、`/admin/config/stream-first-event-timeout-ms`、`/admin/config/stream-first-event-timeout-route-groups` | PUT | Web 专用固定键条件写入，返回新版本 | Web Admin UI |
| `/admin/config/webhooks/:channel` | PUT, DELETE | `wecom`/`feishu` 独立条件替换/清除，只返回启用状态与新版本 | Web Admin UI |
| `/admin/config/webhooks/:channel/reveal`、`/verify` | GET, POST | 显式揭示单个 URL / 按候选值只读核对 | Web Admin UI |
| `/admin/access-keys`、`/:id`、`/:id/secret`、`/:id/rotate`、`/:id/revoke`、`/:id/audit` | GET, POST, PATCH | `admin_api_keys` + `admin_access_key_audit`；仅 Console Session，同源写请求；生命周期/reveal 原子审计 | Admin UI |
| `/admin/mcp-servers` | GET, POST | `mcp_servers`（列表脱敏 URL 与鉴权头） | Admin UI |
| `/admin/mcp-servers/:id` | GET, PATCH, DELETE | `mcp_servers`（`pricing` 为服务默认按次价格） | Admin UI |
| `/admin/mcp-servers/:id/reveal` | GET | 明文 URL 与鉴权头；需要 `mcp.secrets.read` | Admin UI |
| `/admin/mcp-servers/:id/test` | POST | 执行上游 `initialize` 与三类目录读取，返回连接信息及数量，不保存目录 | Admin UI |
| `/admin/mcp-servers/:id/sync` | POST | 拉取目录并返回新增、变更、移除差异；新条目默认停用 | Admin UI |
| `/admin/mcp-servers/:id/items/status` | POST | 批量 `enabled` / `disabled` | Admin UI |
| `/admin/mcp-servers/:id/items/:itemId` | PATCH | `{ pricing }` 设置工具按次价格（`v=2`、`unit=request`、`standard`、`chargedFactor`、`meteredFactor`、空 `config`；兼容 v1 独立单价），整组替换服务价格；`null` 恢复服务默认价格 | Admin UI |
| `/admin/mcp-servers/:id/items/accept` | POST | 批量接受待发布定义：`{ "ids": [...] }`，返回 `{ accepted, skipped }`；已不在待审状态、已移除或不存在的 id 计入 `skipped`，不会报错 | Admin UI |
| `/admin/mcp-servers/:id/items/:itemId/accept` | POST | 接受已启用条目的待发布定义 | Admin UI |
| `/admin/access-keys`、`/:id`、`/:id/secret`、`/:id/rotate`、`/:id/revoke` | GET, POST, PATCH | `admin_api_keys`；仅 Console Session，同源写请求 | Admin UI |
| `/admin/business-timezone` | GET | `system_config.BUSINESS_TIMEZONE` | Admin UI（Provider 首屏加载） |
| `/admin/maintenance` | GET（`maintenance.read`）, PUT（`maintenance.write`） | `system_config.MAINTENANCE_MODE`；见下文「维护模式」 | Admin UI、数据迁移、运维脚本 |
| `/admin/request-logs` | GET | `api_key_request_logs`（**GlobalLogs**，多条件筛选分页） | Admin UI |
| `/admin/request-logs/summary` | GET | `api_key_request_logs`，按维度精确汇总条数、Token 与四项金额 | 外部集成方（门户对账） |
| `/admin/budget-audit-logs` | GET | **`user_audit_logs`**（左联 **`users`** 取 `email` 等，多维筛选分页） | Admin UI |
| `/admin/analytics/models` | GET | `api_key_request_logs`，可选联 `model_tags` | Admin UI |
| `/admin/analytics/providers` | GET | `api_key_request_logs`，按 Provider 聚合 | Admin UI |
| `/admin/analytics/users` | GET | `api_key_request_logs`，左联 **`users`**（用户维度） | Admin UI |
| `/admin/analytics/keys` | GET | `api_key_request_logs`，按 `api_key_id` 聚合（需 `user_id`） | 外部集成方、Admin UI |
| `/admin/analytics/reliability` | GET | `api_key_request_logs` | Admin UI |

`GET /admin/models` 与 `GET /admin/models/:id` 的顶层 `billing_currency` 来自当前 `system_config.BILLING_CURRENCY`，缺省或无效配置按网关现行规则解释为 `USD`；读取配置失败则请求失败，不返回伪默认值。它说明当前网关如何解释模型金额，不是单条旧记录写入时的币种证明：旧 `models` 行没有逐行币种字段，历史配置变更后的原始币种无法从该字段反推。静态导入目录的顶层币种仍只描述本次预览/导入所用的价格分支。

静态导入预览与写入仅支持 `USD`/`CNY` 价格分支。若遗留配置是有效但未支持的三字母币种（例如 `EUR`），两者返回错误，导入在访问模型仓库前停止，避免 USD 数值被当作 EUR 写入；缺省或无效配置仍依网关现行规则按 `USD` 处理。
`POST /admin/playground` 的 `routeId`、`routeDraft`、`toolId` 三选一。路由编辑器「快速测试」使用 `routeDraft`，包含 `model_id`、`provider_id`、`provider_model_name`、`request_protocol`、`request_operation`、`upstream_protocol`、`upstream_operation`、`adapter` 与可选的 `custom_params`（JSON 对象或字符串）；`body` 为测试请求对象。草稿只在本次请求中生效，不创建或更新路由，供应商端点与密钥仍从服务端读取。响应、流式输出及 `x-playground-*` 调试头与 `routeId` 模式一致；实时 WebSocket 仍使用已保存的 `routeId`。

说明：**GlobalLogs**（`/admin/request-logs`）与 **KeyScopedLogs**（`/admin/keys/:id/logs`）互补；**UserScopedLogs**（`/admin/users/:id/logs`）按 `user_id` 拉全量请求历史。**全局审计列表**（`/admin/budget-audit-logs`，表为 **`user_audit_logs`**）记录预算与用户/密钥生命周期事件，与请求日志正交。各类审计行何时产生（含高频 `usage_charge`）见 [`../reference/user-audit-logs.md`](../reference/user-audit-logs.md)。**数据模型总览**见 [`../architecture/user-keys-data-model.md`](../architecture/user-keys-data-model.md)。

Web 工具调用记录缺省查询 REST 工具；旧链接 `?source=mcp&server=<slug>` 切换为 `provider_id=octafuse-mcp` 和 `model_id_prefix=mcp:<slug>/`。Server 筛选无需读取当前 MCP 目录，已删除服务的历史仍可查询。进入请求日志时保留同一 Provider 和模型前缀，列表校验该范围，不把错误来源的数据当作筛选结果；切回 REST 会清除 MCP Server 条件。Web 导航中的 MCP 服务器使用 `/admin/mcp`；Web 页面灰度开关 `CINATOKEN_WEB_ADMIN_MCP_ENABLED` 默认关闭，只接管该路径及尾斜杠的 GET/HEAD。`/gateway/mcp` 保留原管理页入口。

Web MCP 管理使用同源 Cookie 会话与精确 Console subject，不在浏览器内置集成凭据。列表返回每个服务的 `enabledCount` / `pendingCount`；详情的 `server` 不含这两个计数字段，条目数组位于 `items`。详情条目新增只读 `pricingState`：`inherit` 表示数据库价格为 `null`，`override` 表示有效独立规则，`invalid` 表示非空存储规则无法解析。该扩展不修改数据库；旧响应缺少来源且价格为 `null` 时，Web 显示来源未知，不推断为继承价格。无效规则不显示成零价或默认价。

编辑连接时，`url` 留空会省略该字段，保留原 URL；不得把 `urlMasked` 回写。省略 `authHeaders` 保留整组，提供对象替换键集合；已有同名键的空字符串保留其秘密，空对象清除全部。普通编辑保留 v1 独立 standard/charged/metered 单价，仅显式切换才改为 v2 价格和倍率。`mcp.write` 不授予 reveal 权限。秘密仅在显式 reveal 后短暂显示，离开服务或切换身份即清除。

Web 支持粘贴远程 HTTP(S) URL 或 MCP 客户端 JSON 配置，不执行 stdio、SSE 或 OAuth 登录配置。客户端目录测试仅允许 `initialize`、`tools/list`、`prompts/list`、`resources/list`，发送前核验所选原始 Gateway Key 及其用户/工作区归属，再确认 Console subject。Proxy 目标源须符合既有 `CINATOKEN_WEB_PROXY_ORIGINS` 的 CSP 白名单及 Proxy CORS 配置。请求为无 Cookie 的 POST `/mcp` 或 `/mcp/:slug`；校验 JSON-RPC ID、方法对应结果和协议版本，界面保留脱敏响应，复制 curl 使用占位凭据。客户端测试不执行工具。

写入仅按各 MCP 端点的实际 ACK 判断结果，不虚构通用 ACK。同步可能部分写入后返回失败，此时保持待核对标记，刷新或重进页面均不自动重发；用户核对后再显式解锁。前端接受变更前重读待发布定义，发现变化则要求重新审核；该检查不替代服务端并发控制。

### 与 Proxy `GET /catalog/models` 的区别 {#admin-vs-proxy-catalog}

名称里虽都有 “catalog / models”，但 **Admin 不提供** Proxy 上的公开 discovery 接口；下列三者勿混用：

| 接口 | 部署 | 鉴权 | 数据含义 |
|------|------|------|----------|
| **`GET /catalog/models`**（Proxy） | `GATEWAY_URL` | 无 | **运行时**可调用模型 + `protocols` / `protocols_by_group` / `inbound`（由 active `model_routes` 聚合） |
| **`GET /admin/models`** | Admin `/api/admin/*` | Console Session 或 `models.read` | 库内 **全部**模型 CRUD 列表（含 tags、路由计数；**不**含按 route 的协议聚合） |
| **`GET /admin/models/import/catalog`** | Admin | Console Session 或 `models.read` | 仓库内 **静态 preset** 摘要，供导入 UI 勾选，**非**运行时 route 真相 |

门户 / 公开站应使用 Proxy **`GET /catalog/models`**，详见 [用户接口 · 公开模型目录](./user.md#公开模型目录catalog-discovery)。用户个性化折扣用 **`GET /admin/users/:id/display-discounts`** overlay。门户仍走 Catalog + display-discounts；Agent 拉列表不再计入 RPM。Agent 与兼容客户端默认仍用 **`GET /v1/models`**（需用户 Key，默认 `default,free` route group）。

---

## 维护模式（`/admin/maintenance`） {#admin-maintenance}

开启后，Proxy 对推理入口返回 **503** + `Retry-After`（错误码 `gateway.maintenance`），并可选同时冻结 Admin 的写接口。数据迁移的核心切换用它冻结写入；它也可单独用于任何维护窗口。运维说明见 [维护模式](../../operators/maintenance-mode.md)，客户端看到的响应见 [错误码](./error-codes.md)。

状态存在 `system_config.MAINTENANCE_MODE`（JSON 文本，无 schema 迁移）。`PUT /admin/config` 不接受这个键，一律走本接口，避免写入未经校验的值。

### `GET /admin/maintenance`

需要 `maintenance.read`。直接读库（不走缓存），返回当前状态：

```json
{
  "success": true,
  "data": {
    "config": {
      "enabled": true,
      "message": "",
      "messages": { "en": "Back in about {minutes} minutes", "zh": "维护中，预计 {minutes} 分钟后恢复" },
      "expected_end_at": "2026-10-25T05:30:00.000Z",
      "block_admin_writes": true
    },
    "effective_message": "维护中，预计 29 分钟后恢复",
    "remaining_minutes": 29,
    "retry_after_seconds": 300,
    "propagation_seconds": 5
  }
}
```

关闭时 `effective_message`、`remaining_minutes`、`retry_after_seconds` 为 `null`。`propagation_seconds` 是各 Proxy 节点读取配置的缓存上限，即开关最迟多久后全网生效。

### `PUT /admin/maintenance`

需要 `maintenance.write`。整体覆盖当前状态，请求体：

| 字段 | 说明 |
|------|------|
| `enabled` | **必填**，布尔。`false` 时其余字段忽略，库里只留 `{"enabled":false}` |
| `message` | 默认提示，≤500 字符，可含 `{minutes}`；空则用内置文案 |
| `messages` | `{ "<语言>": "<提示>" }`，键如 `zh`、`en`、`zh-CN`，按请求的 `Accept-Language` 先精确后主语言匹配 |
| `duration_minutes` | 预计时长（分钟，> 0，≤ 10080），由**服务端**按当前时间折算成 `expected_end_at` |
| `expected_end_at` | ISO 8601 绝对时间；与 `duration_minutes` 二选一，同时给返回 400 |
| `block_admin_writes` | 默认 `true`：冻结期间 Admin 写接口返回 503 |

文案选择顺序：`messages` 匹配 → `message` → 内置文案（`Accept-Language` 首选 `zh*` 用中文，其余用英文）。模板含 `{minutes}` 但没有预计时间时，退回不带时间的内置文案，不会出现"预计  分钟"。

### Admin 写冻结

`block_admin_writes` 为真时，除 `GET` / `HEAD` / `OPTIONS` 外的 Admin 请求返回 `503`（`{ "success": false, "message": "...", "code": "gateway.maintenance" }` + `Retry-After`）。**不受影响**：`/admin/maintenance`（否则无法解除）、`/admin/access-keys/*`（迁移要临时签发密钥）、`/admin/playground/*`。门户的开通用户、加额请求会收到 503，应自行重试；加额有 `dedup_key` 幂等，重试不会重复加。读取配置失败时 Proxy 与 Admin 都 **fail-open**，宁可继续服务，也不因配置读取故障冻结全网。

---

## Users（`/admin/users`）

`:id` 路径参数支持：

- 网关 **`users.id`**（UUID）；
- 或 **`ext:`** 前缀的外部身份路由（与 `parseAdminUserRouteId` 一致）：
  - **`ext:<urlencode(system)>/<urlencode(external_user_id)>`**（`/` 分隔）；
  - 或 **`ext:<urlencode(system)>\u001F<urlencode(external_user_id)>`**（ASCII **0x1F** 单元分隔符；**推荐**，避免 `external_system` 本身含 `/` 时与分隔符混淆）。

### `GET /admin/users`

分页列出用户；查询参数：

| 参数 | 说明 |
|------|------|
| `page` / `page_size` | 分页，默认 `1` / `20`，`page_size` 最大 `100` |
| `email` | 可选，模糊匹配 `users.email` |
| `external_system` / `external_user_id` | 可选，精确匹配外部对 |
| `max_budget` | 可选：`positive` \| `zero_or_negative` \| `null` |
| `status` | 可选，精确匹配 `users.status` |
| `sort` | 可选，白名单：`budget_spent` \| `budget_max` \| `budget_base` \| `budget_reset_at` \| `created_at`；默认 `created_at` |
| `order` | 可选：`asc` \| `desc`；默认 `desc`。与 `sort` 均在服务端 `ORDER BY`（分页全局有效） |

非法 `sort` 或 `order` 返回 **`400`**，body 含 `message` 和当前完整白名单。

`budget_reset_at` 排序时 NULL 规则：`asc` → `NULLS LAST`，`desc` → `NULLS FIRST`（与 Keys 列表一致）。

响应：`{ success, data: [...], total, page, page_size }`；列表行含 **`active_keys_count`**（激活中的 API Key 数）、**`keys_count`**（该用户全部 API Key 数，含已吊销）、**`rate_limit`**（用户层 JSON，与 Key 同形状：`{"rpm": n}` 或 `null`）等（与实现 `AdminUserListItem` 对齐）。

列表、详情、用户子资源及创建的响应（包括提前拒绝的 401/403）均为 `Cache-Control: private, no-store`；列表和详情需要 `users.read`，创建需要 `users.write`。Web 管理页只投影所需字段，不把完整列表行持久化。

### `POST /admin/users`

按 **`(external_system, external_user_id)`** 幂等创建（若已存在则返回已有用户）；无外部对时每次新建随机 uuid 用户。请求体至少含 **`email`**；可选 `budget_max`、`budget_base`、`budget_period`、`metadata`、`charged_cost_factors` 等（与 `AdminUserCreateInput` 对齐）。外部对须同空或同非空。

`charged_cost_factors` 为 `{ "<models.id>": number | { "<route_group>" | "*": number } }`（倍率 ≥ 0）。数字覆盖该模型全部分组；对象先按本次 route group 匹配（trim 后小写），未命中再用 `"*"`。仅含 `"*"` 的对象写入时折叠成数字。`null` 或 `{}` 表示清空。未知目录模型 ID、未知 route group（`"*"` 除外，且须是该模型已有路由的分组）、负数或非对象会返回 **400**。创建后可在管理后台用户详情的用户专属倍率中按模型和路由组维护。

### `GET /admin/users/:id`

用户详情（`getUserInfo`：含预算列、外部身份、`charged_cost_factors` 对象或 `null`、`rate_limit` 等；周期型预算可能触发懒重置）。**不含**密钥列表；枚举密钥请用 **`GET /admin/users/:id/keys`**。用户列表行（`GET /admin/users`）含 **`active_keys_count`**、**`keys_count`**，以及与详情相同的 **`rate_limit`** 与 `charged_cost_factors`（对象或 `null`）。

### `GET /admin/users/:id/display-discounts`

只读：把该用户 `charged_cost_factors` 按全局 `USER_CHARGED_COST_FACTOR_MODE` 叠进公开目录同款 `discounts`（官方时段 × 代表路由 Charged，再按 route group 叠用户倍率）。每个分组的查找顺序是具体分组、`"*"`、模型级数字；没有命中的分组保持目录折扣。需 **`users.read`**。**只返回至少有一个分组配置了倍率的模型**；未配置时 `data` 为空数组。不计入用户 API Key / 用户合计 RPM。

可选 query：`route_groups`（CSV，大小写不敏感）。省略或空 → 全部 active 路由组（与 `GET /catalog/models` 相同，**不是** `/v1/models` 的 `default,free` 默认）。

响应：`{ success, data: [{ id, discounts }] }`。`discounts` 形状与 `GET /catalog/models` / `GET /v1/models` 的 `discounts` 相同。不要用 **`GET /admin/models`**（运维 CRUD，无展示折扣）。

公开目录用 `GET /catalog/models`，用户个性化折扣用本接口 overlay；Agent 仍用用户 Key 的 `GET /v1/models`。

### `GET /admin/users/:id/models`

只读预览：按该用户**已保存**的 `charged_cost_factors` 组装与 Proxy `GET /v1/models` 相同的列表折扣。不调用 Proxy，不使用用户 API Key，不计入 RPM。需 **`users.read`**。未配置用户倍率时仍返回目录折扣，便于对照 Agent 看到的 `catalog_factor`、`route_factor`、`composite_factor`。

Query 与 `/v1/models` 对齐：

| 参数 | 默认 | 说明 |
|------|------|------|
| `route_groups` | `default,free` | CSV，大小写不敏感 |
| `kind` | `llm` | `llm` \| `image` \| `audio` \| `all` |
| `model` | 空 | 按模型 ID 或展示名包含匹配；空则按目录顺序返回 |

Web 详情中可显式加载这一预览并按模型、类型和分组筛选；未保存的倍率草稿不会送到该 GET，也不会参与结果。过滤变化、失败或权限拒绝清除旧快照；只保留模型/价格/分时的安全投影，不展示任意 metadata。分组候选另按 `routes.read` 显式读取并只保留 model/group，候选权限不足不阻止编辑已有值。

单次最多 40 条。响应 `{ success, data: { object: "list", data, preview } }`。`data.data[]` 的 `model_info.discounts` 与 `/v1/models` 相同；`preview` 含 `user_charged_factor_mode`、实际采用的 `route_groups` / `kind`，以及是否 `truncated`。不含 `inbound`。

### `PATCH /admin/users/:id`

更新邮箱、预算计划、`status`、`metadata`（合并或 `metadata_replace`）、外部身份对、`charged_cost_factors`（对象或 `null`，校验规则与创建相同）、`wallet_granted` / `wallet_spent`（永久额度绝对值，运维修正）、`rate_limit`（用户层 JSON，与 Key 同形状；`null` 表示该层不限）等。仅改用户计费倍率时，审计 `reason_code` 为 `admin_patch_charged_cost_factors`；仅改用户限流时为 `admin_patch_rate_limit`；仅改永久额度绝对值时为 `admin_patch_wallet`（周期额度同时变化时仍为 `admin_patch_budget`）。**密钥级字段不可在此修改**（密钥 `rate_limit` 走 `PATCH /admin/keys/:id`）。加购增量请用下方 **`wallet/credit`**，不要把金额加进 `budget_max`。

Web 计费倍率编辑保留数字与按分组对象，具体分组优先于 `*`；分组 trim 后小写，重复模型/分组不能提交，0 与极小非零数保持原值，单独 `*` 与数字作等价核对。保存需要非空原因，只发送 `charged_cost_factors` 和 `reason`，不回写预算、钱包或限流。成功详情必须返回相同的规范化因子；结果无法确认时按 Console 身份和目标用户保留持久标记，刷新不重发。人工核对当前用户与两次新鲜身份后可确认解锁；旧 generation 不能清除新操作标记。

用户路由接受可选的 `X-CinaToken-Expected-Console-Subject`，提供时严格检查；未携带头的现有 Console/API Key 调用及 `ext:` 外部身份语法保留。Web 因子保存和新预览读取均携带该前置条件。

Web 用户管理只提交本次实际修改的永久额度计数，要求非空更正原因，并限制为非负、最多六位小数；单独更正永久额度不触发周期重置。列表与详情使用服务端的 `wallet_balance`，保留历史负余额。旧服务端未返回完整 `wallet_granted` / `wallet_spent` / `wallet_balance` 时显示不可用并禁用更正，不以零填充。创建用户时两个计数留空会省略字段，显式填零则保留零。

`users.rate_limit` 是该用户**所有 Key 合计**的共享池，不会复制到新建 Key，也不要求 `key.rpm <= user.rpm`。只限制某一把钥匙时，只写该 Key 的 `rate_limit`，用户层保持 `null`。Key 层与 User 层的 `rpm` 都是从当前时刻回溯 60 秒的滚动窗口，不是 UTC 自然分钟。

Web 用户详情与网关 Key 编辑器提供保持不变、移除此层限制（`null`）、设置 RPM 三种操作，区分用户共享池与 Key 独立上限。`0` 是有效限制，禁止计量调用；前端接受非负安全整数并要求审计原因。缺失或无法识别的旧响应显示不可用，普通资料编辑不回写 RPM；显式修改后核对确认响应中的限速值。Key 写入继续携带 `expected_revision`。现有用户/Key 创建与账户 Key API 不接受该字段，Web 不向这些接口附加 RPM。

用于**绝对值**设置、运维修正、取消/到期回收等不依赖当前预算快照的变更。若需基于当前 `budget_max/budget_spent` 计算结转并原子写入，请使用下方 **`budget/transition`**。

### `POST /admin/users/:id/budget/transition/preview`

只读预览预算转换，不写库。请求体（`AdminBudgetTransitionInput`）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `target_budget_base` | 是 | 新周期基础额度（数值，≥ 0） |
| `budget_period` | 是 | `none` \| `daily` \| `weekly` \| `monthly` |
| `budget_reset_at` | 否 | 下次重置时间（ISO UTC）；缺省按 `budget_period` 推算。显式时间须距当前至少 5 分钟；`budget_period=none` 只能省略或传 `null` |
| `carryover_strategy` | 否 | `remaining_or_overage`（默认）或 `none` |
| `reset_spent` | 否 | 是否将 `budget_spent` 归零，默认 `true` |
| `metadata` | 否 | JSON 对象，merge 进 `users.metadata`（仅 apply 时写入） |
| `reason` | 否 | 审计 `reason_text`（仅 apply 时写入） |
| `expected_before` | 否 | 将预览响应的完整 `before` 快照原样回传；预算 epoch、花费、预留或计划已变化则 409，适合交互式确认 |

`remaining_or_overage` 计算：`carryover = (budget_max ?? 0) - budget_spent - budget_reserved_micros / 1_000_000`，`next_budget_max = target_budget_base + carryover`（`carryover` 可为负，表示超额抵扣）。若新上限会低于零，预览和应用均返回 400。

响应：`{ success, data: { before, after, carryover } }`，其中 `before/after` 含 `budget_max`、`budget_base`、`budget_spent`、`budget_period`、`budget_reset_at`、`budget_epoch`、`budget_reserved_micros`，新版还含完整的 `wallet_granted`、`wallet_spent`、`wallet_balance`。预览只计算已到期周期的有效状态，不写库；`carryover` 会扣除预留额，永久额度前后保持相同。Web 将完整钱包快照一并回传和核对；刷新后钱包变化会使旧预览失效，提交回执还须匹配已确认的前后快照和最终用户数据。

### `POST /admin/users/:id/budget/transition`

原子应用上述转换并写入 `user_audit_logs`（`eventType=admin_adjust`，`reasonCode=budget_transition`）。请求体与 preview 相同（`metadata`/`reason` 在 apply 时生效）。交互式客户端应附 `expected_before`，并把预览计算出的 `after.budget_reset_at` 明确传回，避免自动重置时点在两次请求间移动。过期快照会在任何懒重置写之前返回 409；提交前预算快照变化也会拒绝旧预览。

响应：`{ success, message, data: { transition: { before, after, carryover }, user: <getUserInfo> } }`。换档只动周期额度，永久额度不变。

### `POST /admin/users/:id/wallet/credit`

永久额度增量加额（门户加购、注册赠额、退款扣回）。请求体：

| 字段 | 必填 | 说明 |
|------|------|------|
| `amount` | 是 | 非零 JSON number，须可精确表示为安全整数微单位（最多六位小数）；不接受字符串、布尔值或隐式舍入。保留有符号增减，最终累计发放额不可为负 |
| `kind` | 是 | `topup` \| `signup_bonus` \| `admin_adjust` \| `refund` |
| `external_ref` | 是 | 写入原始 `user_audit_logs.dedup_key`；1–255 个 Unicode 字符，拒绝空白引用、控制/格式字符及非法 UTF-16。旧 POST 继续去除首尾空白 |
| `reason` | 否 | 审计 `reason_text`，最多 2000 个字符，拒绝控制/格式字符 |

响应保留 `{ success, status, data: { status: "applied" \| "duplicate", walletGranted, walletSpent, walletBalance, receipt } }`。三个原有钱包字段仍是本次事务/查询快照中的**当前钱包值**，不能当作该订单的历史入账证明；新增 `receipt` 才是原订单的不可变快照。完整流水继续使用 `GET /admin/budget-audit-logs?user_id=&event_type=wallet_credit`。

同一用户、字面引用、金额微单位和类型一致时返回 `duplicate`，不再加额，且回执仍属于第一次提交；金额或类型不同返回 409。MySQL 的既有排序规则若匹配到另一字面引用，也返回 409，不伪装成重复成功。旧记录缺少可验证回执时拒绝再次加额；当前余额不能补造原订单的证明。新写不改去重键编码、不新增迁移。

### `POST /admin/users/:id/wallet/credit/verified`

Web 使用的 v1 加额入口。请求字段同上，额外**必须**携带 `require_receipt_version: 1`，拒绝未知字段。该入口按字面引用处理；Web 表单先去除首尾空白。权限为 `users.write`；Console 调用必须携带 `X-CinaToken-Expected-Console-Subject` 并与当前认证主体一致，命名 Admin Key 继续由自身权限授权。返回原有钱包字段和严格 v1 `receipt`：

```json
{
  "version": 1,
  "userId": "f2b74bc0-32f3-4613-aea7-96f723d08e12",
  "externalRef": "ORDER-20261018-001",
  "amountMicros": 5000001,
  "kind": "topup",
  "auditId": "d2b74bc0-32f3-4613-aea7-96f723d08e12",
  "creditedAt": "2026-10-18T00:00:00.000Z",
  "before": { "walletGranted": 20, "walletSpent": 3, "walletBalance": 17 },
  "after": { "walletGranted": 25.000001, "walletSpent": 3, "walletBalance": 22.000001 }
}
```

金额与钱包快照按主单位和微单位双向核对。快照描述该订单提交时的状态，后续消费或其他加额不会改变它；币种仍遵循网关当前计费配置，本回执不新增历史汇率或币种换算。三个数据库分别使用 D1 完整原始读集 CAS＋批内提交守卫、PostgreSQL/MySQL 同事务锁行与最终快照重读，使审计与钱包更新一起提交或回滚。旧 D1 REAL 仅允许严格 ULP 范围内的已存浮点尾数规范化；新输入和 SQL DECIMAL 字符串仍要求精确微单位。

### `GET /admin/users/:id/wallet/credit/receipt?external_ref=…`

按用户和**唯一一个完整字面引用**精确查询，要求 `users.read`，使用 `private, no-store`。响应为 `{ success: true, data: { version: 1, status: "recorded", receipt } }`，或不含回执的 `status: "not_found" | "legacy_unverified"`。`legacy_unverified` 表示存在历史/损坏证据但无法确认 v1 回执；查询不写账本。

`not_found` 只表示本次读取未发现回执，不能证明先前写入未提交：请求仍可能在途，或读取尚未看到新提交。Web 先核验 Console/Portal 绑定，再用此接口确认版本能力，随后调用独立 `/verified` 写入口，避免滚动升级时旧实例静默接受旧写路径。未知版本、旧接口、错误用户/引用/金额/类型或不自洽快照均不能确认成功。

Web 在派发前将已冻结的用户、引用、金额、类型、说明及代次保存到本标签页的 sessionStorage；存储失败则不派发。超时、取消、5xx、网络失败或无效 ACK 保留未知锁，刷新和作用域版本更新不会清除。查询 `not_found` 不解锁；用户明确核对后只能重试相同冻结订单，不能自动换引用或重放。后续重试被拒绝也不能否定最初未知请求。只有匹配本代次的可验证回执，或首次派发的明确拒绝，才能释放对应标记。主体或目标用户改变时，其他主体的订单不展示、不用于恢复。

### `DELETE /admin/users/:id`

物理删除用户；**级联删除**其 **`api_keys`**。`user_audit_logs.user_id` 按迁移为 **`ON DELETE SET NULL`**，历史审计保留。

### `GET /admin/users/:id/keys` / `POST /admin/users/:id/keys`

列出或在该用户下新建密钥（`POST` 体：`name`、`metadata`、`reason` 等）。响应与全局 `POST /admin/keys` 一致（返回明文 `key` 一次）。

### `PATCH /admin/users/:id/keys/:keyId` / `DELETE ...`

与全局 **`PATCH/DELETE /admin/keys/:id`** 语义一致，但限定密钥属于该用户。`DELETE` 会吊销 Key 并保留审计墓碑，不物理删除行。

### `GET /admin/users/:id/logs`

分页返回该 **`user_id`** 的 `api_key_request_logs`。

| 查询参数 | 说明 |
|----------|------|
| `page` | 默认 `1` |
| `page_size` | 默认 `20`，最大 `100` |
| `status` | 可选，精确匹配 |
| `api_key_id` | 可选；限定该用户下的一把 Key。不属于该用户则 `404` |

### `GET /admin/users/:id/audit-logs`

分页返回该用户的 **`user_audit_logs`**（仅 `user_id` 范围）。

---

## 列出 API Keys

分页列出 Key；预算与邮箱来自 **`JOIN users`**（只读）。支持按 **`users.email`** 模糊筛选与 **`user_id`** 精确筛选。

### 请求

```
GET /admin/keys?page=1&page_size=20
```

### 查询参数

| 参数 | 说明 |
|------|------|
| `page` | 十进制整数 1–1000000，默认 `1`；不接受零、负数、小数、前导零或部分解析 |
| `page_size` | 每页条数，默认 `20`，最大 `100` |
| `email` | 可选，对 **`users.email`** 模糊匹配（响应字段仍为 `user_email`） |
| `user_id` | 可选，精确匹配 `api_keys.user_id` |
| `sort` | 可选，白名单：`budget_spent` \| `budget_reset_at` \| `created_at`；默认 `created_at` |
| `order` | 可选：`asc` \| `desc`；默认 `desc`。与 `sort` 均在服务端 `ORDER BY`（分页全局有效） |

非法 `sort` 或 `order` 返回 **`400`**，body 含 `message`（例如 `Invalid sort; allowed: budget_spent, budget_reset_at, created_at`）。

未知或重复查询参数、显式空筛选、超限值返回 400。`email` 是非空的邮箱片段（最长 320），`user_id` 是非空的 opaque 用户 ID（最长 600）；二者不接受空白/控制字符。`page_size` 严格为 1–100。列表、详情、写入、日志及 maintenance 的内部 Hono 与外层 Next 响应全部为 `Cache-Control: private, no-store`，包括 401/403、Origin 拒绝、413 和存储错误。

`budget_spent` / `budget_reset_at` 排序列来自 JOIN 的 **`users`**；`created_at` 来自 **`api_keys`**。`budget_reset_at` 的 NULL 规则：`asc` → `NULLS LAST`，`desc` → `NULLS FIRST`。

三库每种排序都追加同方向的 Key ID tie-breaker，避免相同预算/创建时间跨页重复。列表顶层 `capabilities` 为已验证 principal 的 `user_detail`、`request_logs`、`budget_audit`、`effective_guardrails`、`can_write` 布尔值，分别对应 `users.read`、`logs.read`、`logs.read`、`guardrails.read`、`user_keys.write`；Console 全为 true，Bearer 按原有 write 包含 read / `*` 规则映射，不扩大授权。

### 响应

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "key": "sk-…",
      "user_id": "string",
      "workspace_id": "personal:user-id",
      "name": "Display name",
      "user_email": "user@example.com",
      "budget_max": 100,
      "budget_base": 100,
      "budget_spent": 0,
      "budget_period": "monthly",
      "budget_reset_at": "2024-02-01T00:00:00.000Z",
      "status": "active",
      "metadata_preview": "{\"field_count\":2}",
      "metadata_unavailable": false,
      "profile_revision": "sha256:<64 lowercase hex characters>",
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "total": 120,
  "page": 1,
  "page_size": 20
}
```

普通列表不返回 `metadata` 或 `metadata_raw`，只返回无字段名/值的 JSON 字符串摘要 `metadata_preview`（仅 `field_count`）或 null。编辑须单独无缓存读取详情。全局 Keys 普通读及 PATCH/DELETE 的 `key` 统一为 `sk-…`，不信任历史 storedPreview，即使它看似标准掩码也不回显；使用 immutable ID、name、owner/workspace 辨识。此投影调整仅作用于全局 Admin Keys DTO，其他 Core key 映射保持原有合同。

---

## 创建 API Key

每次调用在 `api_keys` 中 **新建一行**（同一用户可有多把 **active** 密钥）。预算与邮箱在 **`users`** 表上维护，请使用 **`PATCH /admin/users/:id`**，**不要**在创建或更新 Key 的请求体中携带预算或 `user_email` 字段。

### 请求

```
POST /admin/keys
```

### 请求体（二选一关联用户）

**路径 A — 已有网关用户**

| 字段 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 网关 `users.id`（须已存在） |
| `name` | 否 | 密钥显示名 |
| `metadata` | 否 | JSON **对象**或可解析为对象的 JSON **字符串**；写入该 Key 行 |
| `reason` | 否 | 写入本次新建密钥的 `key_created` 审计 `reason_text` |

**路径 B — 按外部身份匹配或创建用户后再建密钥**

| 字段 | 必填 | 说明 |
|------|------|------|
| `external_system` | 是 | 与 `external_user_id` 成对；上游产品 / 租户标识 |
| `external_user_id` | 是 | 上游用户标识 |
| `email` | 是 | **新建**用户时写入 `users.email`；若外部对已存在则 **不会**用本次 email 覆盖库中已有邮箱 |
| `name` | 否 | 密钥显示名 |
| `metadata` | 否 | 同上 |
| `reason` | 否 | 同上 |

路径 B 新建用户时，服务端为该用户写入默认预算：`budget_max = 0`、`budget_period = none` 等；后续请在 **Users** 管理接口中调整计划。

`user_id` 与「`external_system` + `external_user_id`」不得混用为不完整组合（例如仅 `external_system` 无 `external_user_id` 会 **400**）。

### 审计 `reason`（POST）

仅当本次在库中 **新建** `api_keys` 行时，`reason`（若提供）进入对应 `key_created` 审计的 `reason_text`。

### 响应

```json
{
  "success": true,
  "message": "Key created successfully",
  "data": {
    "key": "sk-xxx...",
    "key_id": "uuid",
    "id": "uuid",
    "user_id": "string",
    "workspace_id": "personal:user-id",
    "status": "active",
    "name": null,
    "profile_revision": "sha256:<64 lowercase hex characters>",
    "owner": { "email": "user@example.com", "external_system": null, "external_user_id": null }
  }
}
```

> **明文 `key`** 仅在本次响应中返回完整值；客户端须立即保存。列表与详情接口中的 `key` 始终为安全预览，不能用于鉴权，也不能再次取回明文。

POST 两种 ownership 严格互斥：已有 `user_id`，或完整外部身份对加有效 email；拒绝所有未知/预算字段。响应 `owner` 来自实际解析出的用户，外部身份已存在时 email 可与本次输入不同。个人 workspace 为 `defaultWorkspaceId('personal', user_id)`；自动新用户的 budget_max/base/spent 均为 0、period 为 none。创建仍使用 `user_keys.write`，不会因为 Web 门控而改成 `users.write`。每次 POST 都创建新 Key；未知结果不能自动重试。

### 清理历史明文 Key

迁移 `0033_gateway_key_secret_removal.sql`（MySQL 为 `0029_key_hash_and_gateway_secret_removal.sql`）完成且新版本 Admin 已部署后，具有 `user_keys.write` 的管理员可分批调用：

```http
POST /admin/keys/maintenance/scrub-legacy-secrets
Content-Type: application/json

{ "limit": 100 }
```

响应 `data.scrubbed` 为本批实际清理数，`data.remaining` 为仍保存旧格式的行数。该操作幂等；重复调用直至 `remaining = 0`。清理只改变认证材料的存储形式，不改变 Key ID、状态、归属、审计或请求日志。

### 示例（已有用户）

```bash
curl -X POST http://localhost:8789/api/admin/keys \
  -H "Authorization: Bearer sk-admin-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "integration-ci",
    "metadata": {"env":"staging"},
    "reason": "provision-from-billing"
  }'
```

### 示例（外部身份）

```bash
curl -X POST http://localhost:8789/api/admin/keys \
  -H "Authorization: Bearer sk-admin-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "external_system": "my-saas",
    "external_user_id": "acct_123",
    "email": "user@example.com",
    "name": "default-key"
  }'
```

### 在指定用户下创建（Admin UI 常用）

当已掌握 `users.id` 时，也可调用子资源（用户由路径解析，请求体无需再传 `user_id`）：

```
POST /admin/users/:id/keys
```

请求体仅支持：`name`、`metadata`（对象或 JSON 字符串）、`reason`（可选）。响应信封与 `POST /admin/keys` 相同（`data.key`、`data.key_id` 等）。

---

## 更新 API Key（名称 / 状态 / metadata / 限流）

**不支持**在 `PATCH /admin/keys/:id` 上修改预算、`user_email` 等用户级字段；若传入 `budget_max`、`budget_base`、`budget_spent`、`budget_period`、`reset_budget`、`budget_reset_at`、`user_email` 等，服务端返回 **400**（提示改用 **`PATCH /admin/users/:id`**）。

### 请求

```
PATCH /admin/keys/:id
```

### 路径参数

| 参数 | 描述 |
|------|------|
| `id` | API Key ID (UUID) 或完整的 API Key (`sk-…`) |

### 请求体

至少提供以下字段之一：

```json
{
  "name": "new-label",
  "status": "revoked",
  "metadata": { "plan": "pro" },
  "expected_revision": "sha256:<revision read from detail>",
  "rate_limit": { "rpm": 60 },
  "reason": "Admin update"
}
```

| 字段 | 说明 |
|------|------|
| `name` | 可选；最长 255 的字符串（trim）或 `null` 清空，不接受控制字符 |
| `status` | 可选；严格白名单 `active`、`disabled`、`revoked` |
| `metadata` | 可选；**对象**时与现有 key `metadata` **合并**；**字符串**时视为整段替换（与 `metadata_replace` 语义相同） |
| `metadata_replace` | 可选；JSON 对象或其 JSON 字符串，整段替换；`null` 或空字符串清空。与任何形式的 `metadata` 互斥 |
| `reason` | 可选；最长 1000 的字符串，不接受控制字符，缺省由服务端默认 |
| `expected_revision` | 客户端从列表/详情取得的 opaque profile 条件；PATCH/DELETE 使用相同 JSON body 字段，不放 URL |

| `rate_limit` | 可选；JSON 对象。`null` 表示该 Key 不限。当前仅支持 `rpm`（非负整数，该 Key 从当前时刻回溯 60 秒的滚动窗口内允许的请求数；`0` 拒绝所有计次请求）。与用户层 `users.rate_limit` **双重执行**（两层都是回溯 60 秒，各自独立计数），两者都要通过；超限仍返回同一 `429` + `gateway.rate_limited`（不区分哪一层）。`GET /v1/me` 与 `GET /v1/models` 两层都不计入。计数在代理服务进程内存中（多 isolate / 多副本为软上限）。省略则不改 |

### 响应

`data` 返回重新读取的完整安全详情（PATCH 另含 `key_id`），包括权威 `status`、owner/workspace 与新 `profile_revision`，不使用 `{updated:true}` 推测成功状态。mutation 与审计使用三库原子提交，审计失败不生效；请求内 CAS 还核对 workspace 和当前用户审计快照。

`profile_revision` 是对精确 `[协议版本,id,user_id,workspace_id,name,status,原始 metadata 字符串或 null]` 的 SHA-256 profile 条件。它不受 JOIN 预算读变化影响，metadata 空白/键序变化也产生冲突；相同 profile 的 ABA 仍是同一个条件，不宣称单调变更序号。客户端提交的陈旧条件返回 409，且不写 mutation/成功审计，应重读并让操作者重新决定。不能把服务端本次读取生成的 CAS 当成客户端版本保护。

默认允许旧客户端省略 expected_revision；Web 始终携带。部署所有新 Admin 实例、排空旧写入实例并升级所有需要继续使用的脚本/UI 后，可显式设置 `CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION=true`，届时缺失条件返回 428，格式无效返回 400。此变量仅 exact `true` 生效，本实现未开启；不需要新 schema/migration，旧客户端仍可有条件或默认兼容无条件调用，回滚前需关闭严格变量。

metadata 新输入必须是 JSON 对象、UTF-8 最多 64 KiB、深度最多 16、每个容器最多 1000 项；拒绝非有限数字、不可 JSON 值以及 `__proto__`/`prototype`/`constructor` 键。详情 `metadata_raw` 保留可安全审阅的原始 bytes（字符串）供临时编辑器，`metadata` 仍保留解析对象兼容旧 UI；超限、非法 JSON、非对象或结构不安全的历史内容返回 `metadata_unavailable=true`、raw=null 且省略 parsed metadata，禁止 merge/replace，仍可 name/status 修改。raw 不应进入列表或普通 Query cache。

### 示例

```bash
curl -X PATCH http://localhost:8789/api/admin/keys/uuid-here \
  -H "Authorization: Bearer sk-admin-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "rotated-label",
    "status": "active",
    "reason": "gwui:reactivate"
  }'
```

---

## 获取 Key 详情

根据 Key ID 或 Key 本身获取详细信息。

### 请求

```
GET /admin/keys/:id
```

### 路径参数

| 参数 | 描述 |
|------|------|
| `id` | API Key ID (UUID) 或完整的 API Key (sk-xxx 格式) |

### 响应

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "key": "sk-…",
    "user_id": "string",
    "user_email": "user@example.com",
    "budget_max": 100.00,
    "budget_base": 100.00,
    "budget_spent": 15.50,
    "budget_period": "monthly",
    "budget_reset_at": "2024-02-01T00:00:00.000Z",
    "status": "active",
    "last_used_at": "2026-09-05T04:12:00.000Z",
    "rate_limit": { "rpm": 60 },
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-20T14:22:00.000Z",
    "spend": 15.50,
    "max_budget": 100.00
  }
}
```

> 注：`spend` 和 `max_budget` 字段用于兼容 LiteLLM 格式。详情同时包含 workspace/name/profile_revision、metadata_preview/raw/unavailable；安全规则见上。

### 示例

```bash
curl http://localhost:8789/api/admin/keys/uuid-here \
  -H "Authorization: Bearer sk-admin-xxx"
```

---

## 删除 Key

吊销该 **`api_keys`** 并保留行为审计所需的墓碑行。同步物理删除会与已经通过认证、但尚未完成请求日志/预算结算的在途请求竞争，因此公开管理 API 不提供物理删除；离线数据保留流程必须先证明没有在途请求。

### 请求

```
DELETE /admin/keys/:id
```

可选 JSON body：`{"expected_revision":"sha256:...","reason":"Operator revocation"}`。省略/409/428 规则与 PATCH 相同。重复 DELETE 仍保留原有审计墓碑事件。

### 路径参数

| 参数 | 描述 |
|------|------|
| `id` | API Key ID (UUID) 或完整的 API Key (sk-xxx 格式) |

### 响应

成功：
```json
{
  "success": true,
  "message": "Key revoked and retained as an audit tombstone",
  "data": { "id": "uuid", "status": "revoked", "key": "sk-…", "profile_revision": "sha256:<new profile condition>" }
}
```

失败（Key 不存在）：
```json
{
  "success": false,
  "message": "Key not found"
}
```

### 示例

```bash
curl -X DELETE http://localhost:8789/api/admin/keys/uuid-here \
  -H "Authorization: Bearer sk-admin-xxx"
```

---

## 获取 Key 请求日志

获取指定 Key 的请求日志，支持分页和状态过滤。

### 请求

```
GET /admin/keys/:id/logs?page=1&page_size=20&exclude_status=incomplete
```

### 路径参数

| 参数 | 描述 |
|------|------|
| `id` | API Key ID (UUID) 或完整的 API Key (sk-xxx 格式) |

### 查询参数

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `page` | integer | 1 | 页码，从 1 开始 |
| `page_size` | integer | 20 | 每页数量，最大 100 |
| `exclude_status` | string | - | 排除指定状态的日志（如 `incomplete`） |

### 响应

日志行结构与 D1 `api_key_request_logs` 一致（节选常用字段）；`data` 为当前页的日志数组。

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "api_key_id": "key-uuid",
      "user_email": "user@example.com",
      "model_id": "glm-4",
      "provider_id": "zhipu",
      "request_protocol": "openai",
      "upstream_protocol": "openai",
      "input_tokens": 150,
      "output_tokens": 320,
      "cache_read_tokens": 0,
      "cache_write_tokens": 0,
      "reasoning_tokens": 0,
      "total_tokens": 470,
      "metered_cost": 0.0045,
      "standard_cost": 0.0045,
      "charged_cost": 0.0045,
      "route_group": "default",
      "status": "success",
      "latency_ms": 1250,
      "error_message": null,
      "raw_usage": "{\"prompt_tokens\":150,\"completion_tokens\":320}",
      "created_at": "2024-01-20T14:22:00.000Z"
    }
  ],
  "total": 156,
  "page": 1,
  "page_size": 20
}
```

> 注：路由模型请求的准入、预算上限和最终结算以 Route 绑定的 chosen verified **Model Endpoint** 价目为标准价事实源；`models.pricing_profile` 只保留作目录、静态 preset 和历史 UI 兼容，不能替代 Endpoint。文本/Embedding 与已支持的 Image 按张/参考图、Audio 时长/Unicode 字符计量均遵循这一规则；尚未支持的 Image/Audio meter 在 dispatch 前 fail closed。`metered_cost` / 路由侧 `charged_cost` 在 Endpoint 标准价上应用有效 Route 倍率，Endpoint discount 只进入用户扣费基数；用户模型倍率只再次作用于最终 `charged_cost`。**Tools** 仍在 catalog 直接配置三账本绝对单价。**`request_protocol`** 是客户端入口，**`upstream_protocol` / `upstream_operation`** 是所选 Route 快照，Audio adapter 必须按实际上游 operation 取价。历史字段 `total_cost` 与 **`billing_factor`** 列已移除。

### 示例

```bash
curl "http://localhost:8789/api/admin/keys/uuid-here/logs?page=1&page_size=10" \
  -H "Authorization: Bearer sk-admin-xxx"
```

面向用户的「有活跃路由的模型」列表：**Agent / SDK** 用 **`GET /v1/models`**（用户 Key）；**门户 / 公开 discovery** 用 Proxy **`GET /catalog/models`**（无需 Key，含协议能力，见 [用户接口](./user.md#公开模型目录catalog-discovery)）。

**管理端基础数据**（Console Session 或具有对应权限的 `Authorization: Bearer <ADMIN_API_KEY>`，响应多为 `{ success, data, count? }`）：**`/admin/keys`**（上文用户 Key）与下列 Catalog API。

### Providers（`/admin/providers`）

一个 Provider = **一把** `api_key` + **`status`**（`active` \| `disabled`）+ **`kind`**。**无** `/admin/providers/:id/keys*` 子资源（迁移 0015 已删除 `provider_api_keys`）。

`name` 是账号别名。`kind` 取导入模板的稳定英文 `name`（如 `OpenCode Zen`），或显式自定义 `__custom__`。已有行默认 `''`，表示尚未分类。唯一约束是 `(name, kind)`：同一别名可以属于不同类型；同一类型下同名返回 **409**，正文为 `A provider with this name and type already exists`。列表与详情会附带运行时解析的 `kind_labels`、`kind_descriptions`（中、英、日、韩介绍，无模板时为 `null`）、`vendor_key`、`icon_key`、`catalog_links`（均不落库）。`note` 是运营手写备注。已设置 `kind` 时图标、介绍与链接只跟模板走；`__custom__` 使用通用图标且没有官方介绍；空 `kind` 仍按名称与 Endpoint 推断图标，介绍为 `null`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/providers` | 列表；`api_key` **脱敏**；含 `kind`、`endpoints`、`custom_params`、`status`、`has_pending_key`、`quota_supported`、`routes_count`、`active_routes_count` |
| POST | `/admin/providers` | 创建；**`name` + `api_key` + `kind` 必填**；`kind` 须为已知模板英文名或 `__custom__`；管理后台不提交 `id`，由服务端生成 UUID。API 仍可传可选 `id`。另可传 `note`、`endpoints`、`custom_params`、`status` |
| GET | `/admin/providers/:id` | 详情（脱敏 `api_key`） |
| PATCH | `/admin/providers/:id` | 部分更新；省略 `kind` = 不改类型；`kind: ""` = 标为尚未分类；省略 `api_key` = **不改密钥**；显式 `api_key: ""`（或 `null`）= **清空密钥**；`status` 仅 `active` \| `disabled`。改 `kind` 不覆盖已有 `endpoints`；省略 `custom_params` = 不改，显式 `null` = 清空 |
| DELETE | `/admin/providers/:id` | 删除；仍被 `model_routes` 引用时返回 **409**，须先删除或改绑对应 Target |
| GET | `/admin/providers/:id/api-key` | **揭示明文** `api_key`（`{ success, data: { api_key } }`） |
| GET | `/admin/providers/:id/quota` | 用该账号现有 `api_key` 实时查询额度。权限是 `providers.read`，响应不含密钥。不支持的 `kind`、空密钥或导入占位密钥返回 **400**。上游非 2xx 或响应无法解析返回 **502**（`message` 只有状态码，没有响应体）。超时返回 **504** |
| GET / POST | `/admin/providers/sync/diff`、`/sync/apply` | 与官方模板同步：`diff` 只读，只比对端点；`note` 不参与。差异只在管理员手动检查时计算，列表接口不带 |
| GET / POST | `/admin/providers/import/catalog`、`/import` | 静态模板导入（占位 key，须手动替换）。写入 `kind =` 模板英文名；`name` 按 `locale`（`zh` 中文，`ja` 日文，`ko` 韩文，其余英文）；介绍不入库。仅同一 `kind` 下同名才追加 `(2)` 后缀 |

**`custom_params`（Provider 级默认参数下界）**：JSON 对象，按**上游协议**分组，形如 `{ "openai": { "headers": {...}, "body": {...} }, "gemini": { "body": {...} } }`；协议 key 须为已支持的上游协议（`openai` / `anthropic` / `gemini` / `dashscope` / `minimax` / `volcengine` / `elevenlabs`），非法 key 返回 **400**。单个分组内的 `headers` / `body` 形状与 Route 级 `custom_params` 信封里的同名字段一致（受保护头不可配置，返回 **400**）；但 Provider 层**没有** `force_override`（该字段仍只属于 Route）。运行时该 Provider 下每条 Route 按自身 `upstream_protocol` 取出对应分组，与 Route 自己的 `custom_params` 合并为一份有效参数后再发往上游：headers 优先级为「协议默认头 < Provider < Route < 客户端（Route 未开 `force_override.headers` 时）」，body 优先级为「适配器默认 < Provider < Route < 客户端同名字段（Route 未开 `force_override.body` 时）」；**Route 打开 `force_override.body` 后，整份合并后的有效 body（含其中的 Provider 默认值）一起强制覆盖客户端**，不是只强制 Route 自己配置的字段。Provider 未配置该协议或该字段为空时行为与改造前完全一致。原生透传入口（DashScope / MiniMax / ElevenLabs / Volcengine 的直连路径）不合并 body 默认值（只替换 `model`），但仍会合并 headers。序列化后超过 32KB 返回 **400**。

Web 列表与编辑保留服务端 `kind`，新建和复制可显式选择类型；普通编辑不回写未改的类型，复制仍要求新凭据且保持禁用。官方差异按字段手动选择，端点按整个协议替换，默认不选；旧类型迁移仅 PATCH `{kind}`，建议类型不会自动应用。`POST /admin/providers/sync/apply` 成功处理批次时另含顶层 `acknowledgement: { domain: "providers", operation: "sync" }`，不含 `id`；`data` 为 `{updated, skipped, failed:[{provider_id,message}]}`。失败可能发生在配置已持久化之后，不能断言零写入。Web 分开显示逐项未完成及可能部分应用的提示并隐藏原始错误文本，已知结果须重新检查再应用；缺失/错误 ACK 或结果计数不符保持未知写锁。服务端应用时重算当前官方值，未提供差异版本条件写入。

Web 额度只在支持的已配置账号详情中显式查询，不自动刷新或轮询；新查询清除上次快照。显示原币种、有符号余额和供应商原单位，缺失计数显示不可用，不换算为网关币种或补零。

`GET /admin/providers/:id/quota` 的 `data` 是归一化快照，不保存。请求发往与该 `kind` 默认域名同一注册域的 https origin；保存的 Endpoint 若换了注册域，则回退默认 origin。

```json
{
  "success": true,
  "data": {
    "adapter": "deepseek",
    "checkedAt": "2026-09-25T05:00:00.000Z",
    "state": "ok",
    "balances": [{ "currency": "CNY", "total": 9.99, "granted": 0, "paid": 9.99 }],
    "windows": []
  }
}
```

`state` 为 `ok`、`low`（任一窗口已用 ≥ 90%）、`exhausted`（返回的余额全部 ≤ 0、厂商标记不可用，或任一窗口已用 ≥ 100%）或 `unknown`。

| `kind` | 上游 | 映射 |
|--------|------|------|
| `DeepSeek` | `GET /user/balance` | 余额（含币种、赠送、充值） |
| `Moonshot AI` | `GET /v1/users/me/balance` | 可用余额、代金券、现金。`api.moonshot.cn` 为 CNY，`api.moonshot.ai` 为 USD |
| `SiliconFlow` | `GET /v1/user/info` | `totalBalance` / `balance` / `chargeBalance`，币种 CNY |
| `SiliconFlow (International)` | 同上，`api.siliconflow.com` | 同上，币种 USD |
| `OpenRouter` | `GET /api/v1/key` | Key 消费上限窗口 `key_limit`（USD）。未设上限时没有 `usedPercent` |
| `Novita AI` | `GET /openapi/v1/billing/balance/detail` | `availableBalance` / `cashBalance`，单位是 1/10000 USD |
| `DeepInfra` | `GET /payment/checklist` | 负的 `stripe_balance` 转为可消费 USD；正的 `limit` 与 `recent` 组成消费上限窗口。`suspended: true` 视为已用尽 |
| `StepFun` | `GET /v1/accounts` | `balance` 为可用余额（CNY）。累计充值与累计赠送不写入快照 |
| `Vercel AI Gateway` | `GET /v1/credits` | `balance` 为剩余额度（USD） |
| `OpenCode Go` | `GET /zen/go/v1/usage` | `rolling` / `weekly` / `monthly` 的已用百分比与重置时间。`rolling` 记为 `5h`。`status: rate-limited` 视为该窗口已用尽 |
| `Command Code` | `GET /alpha/billing/credits`；成功后再读 `GET /alpha/billing/subscriptions`，需要推算每月上限时再读 `GET /alpha/usage/summary` | 与 Provider API 同一把 Key。`monthlyCredits`、`purchasedCredits`、`freeCredits` 相加为剩余美元；有 `remainingCredits` 时以它为准。`windowLimits` 的 `fiveHour` / `weekly` 记为 `5h` / `weekly`（`used` / `cap` 为美元）。每月窗口优先用 `credits.monthlyCreditsGranted` 作上限，已用为上限减去 `monthlyCredits`。没有该字段、且已有滚动窗口时，用本账期 `totalMonthlyCredits` 加上剩余月度额度作为上限。重置时间取订阅 `currentPeriodEnd`。后两个请求失败或超时不影响已读到的余额和滚动窗口。按量计费且没有滚动窗口时，不编造每月窗口 |
| `ElevenLabs` | `GET /v1/user/subscription` | 请求头是 `xi-api-key`。响应字段仍是 `character_count` / `character_limit`，产品已改称 credits，数值不变，记为窗口 `credits`。`next_character_count_reset_unix` 为重置时间。`status: free_disabled` 视为已用尽。欧盟等驻留域名与默认 `api.elevenlabs.io` 同一注册域时，请求发往已保存的端点主机 |
| `MiniMax` | `GET https://www.minimaxi.com/v1/token_plan/remains`，失败时再请求 `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | 优先取 `general` 模型的 5 小时与每周窗口。`*_usage_count` 是剩余次数；次数为 0 时改用剩余百分比。两台主机都在 `minimaxi.com` 上 |
| `Zhipu GLM (Coding Plan)` | `GET /api/monitor/usage/quota/limit` | `CREDIT_LIMIT` / `TOKENS_LIMIT`。`unit=3,number=5` 为 5 小时，`unit=6,number=1` 为每周。`usage` 是上限，`percentage` 是已用百分比 |
| `Z.AI GLM (Coding Plan)` | 同上，`api.z.ai` | 同上 |

`Kimi Code (Coding API)` 的额度接口没有稳定公开契约，当前 `quota_supported` 为 false。ZenMux、xAI、OpenAI、Anthropic 以及火山、百炼、腾讯的余额查询需要另一把管理密钥或 AK/SK，也不在这一接口里。

`endpoints` JSON 权威形状：

```json
{
  "openai": {
    "base": "https://api.example.com/v1",
    "endpoints": {
      "chat": "https://api.example.com/v1/chat/completions",
      "responses": "https://api.example.com/v1/responses",
      "embeddings": "https://api.example.com/v1/embeddings",
      "rerank": "https://api.example.com/v1/rerank",
      "images.generations": "https://api.example.com/v1/images/generations",
      "images.edits": "https://api.example.com/v1/images/edits",
      "audio.transcriptions": "https://api.example.com/v1/audio/transcriptions",
      "embeddings": "https://api.example.com/v1/embeddings"
    }
  },
  "anthropic": {
    "base": "https://api.example.com/v1",
    "endpoints": { "messages": "https://api.example.com/v1/messages" }
  },
  "gemini": {
    "base": "https://generativelanguage.googleapis.com/v1beta/models",
    "auth": "query-key",
    "endpoints": {
      "models.generate": "https://example.com/v1beta/models/{model}:{action}",
      "models.embed": "https://example.com/v1beta/models/{model}:{action}"
    }
  }
}
```

`base` 走标准路径派生；capability 完整 URL 模板存在则覆盖派生结果。Gemini canonical 键为 **`models.generate`**（向量模型另有 **`models.embed`**，用于 `:embedContent` / `:batchEmbedContents`），模板必须含 `{model}` 与 `{action}`；历史 `generateContent` / `streamGenerateContent` 键仍可读写，但新 UI 与规范化后的路由只生成 `models.generate`。可选 **`gemini.auth`**：`query-key`（`?key=`）或 `bearer`（`Authorization`）；省略则为 `query-key`。`auth` 仅允许出现在 `gemini`。

### Models / Routes

#### 四个早期管理域的主体、私有缓存与写入回执

`/admin/providers`、`/admin/models`、`/admin/endpoints`、`/admin/routes` 的所有响应（包含 BFF/Hono 早退的 401/403/413/500/503）使用 `Cache-Control: private, no-store`。权限仍来自已认证 Console Session 或具名 Bearer；任何请求提供 `X-CinaToken-Expected-Console-Subject` 时，值必须是当前可信原始 Console subject 的 canonical `encodeURIComponent`，包括读取和 Provider Key 揭示请求。错误编码返回 400，主体不符返回 403，具名 Bearer 提供该 Console 头返回 400。旧无头 Console/Bearer 继续兼容，**不具有同主体前置保护**；新 Web 每次写入须先 fresh 验证稳定 userId+subject 并发送此头，该头不选择 actor、也不授予权限。

现有 `success`、`message`、`data` 保持兼容；成功写入追加 `acknowledgement`：

```json
{"domain":"models","operation":"update","id":"actual-model-id"}
```

`domain` 固定为 `providers | models | endpoints | routes`。CRUD 的 `operation` 为 `create | update | delete`，`id` 为实际资源 ID；批量导入为 `import`、DeepSeek 初始化为 `bootstrap`，均无 `id`。导入仍以 `data.created / skipped_existing / failed` 判断每项结果，处理回执不代表全部成功。Endpoint 关联为 `link | unlink`，`id` 是 endpoint ID、`related_id` 是 target ID。Pool policy 为 `policy`，`id` 是 pool ID；单 Sticky 删除为 `clear-sticky`，`related_id` 是小写 SHA256 affinity hash，已不存在的 binding 可返回 `data.cleared:false`；epoch reset 为 `reset-sticky`。Provider DashScope 操作保持官方原生 JSON，只有 HTTP 2xx 通过 `X-CinaToken-Acknowledgement` JSON 响应头提供 `{domain:"providers",operation:"resource",id:providerId,related_id:"hotwords"|"voices"}`；仍须检查官方 payload 的业务错误。失败无成功回执，未知网络/5xx/损坏或错 ID 回执不可自动重放。

#### Model route_policy 原子当前值前置

`PATCH /admin/models/:id` 新增可选 `expected_route_policy:string|null`，必须提交列表/详情 GET 中 **原始** `route_policy`，不要解析后重新序列化或规范化期望值。显式 `null` 与未提供、空字符串均不同。服务仅规范化新策略；D1 精确二进制条件 UPDATE RETURNING 与条件标签变更共享 batch，Postgres 精确 `COLLATE "C"` 当前值条件 UPDATE 与标签共享事务，MySQL 精确二进制锁行读和同条件 UPDATE 与标签共享事务。条件请求中的所有合法模型字段、定价 keep/set/clear 和可选标签一起生效；匹配的无变化请求也有正确回执。

```json
{"route_policy":"{\"strategy\":\"weighted_random\"}","expected_route_policy":null}
```

陈旧或模型已不存在返回 409 `{success:false,code:"model_route_policy_conflict",message:...}`，且不回退无条件更新/单独写标签；错误类型或超出 65536 字符返回 400 `invalid_model_route_policy_precondition`。此合同比较**当前值**，A→B→A 后 A 再次匹配，不宣称检测历史 ABA。客户端二次 GET 不能替代原子条件更新。

`CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION` 默认关闭，仅精确 `true` 时 route_policy 写缺前置返回 428 `model_route_policy_precondition_required`。无前置旧客户端在开关关闭时保留原行为。上线须先升级所有 Admin 实例及客户端、排空旧无条件写端，再启此服务保护，随后启独立 Web 入口；旧实例仍可覆盖新条件写，不能仅启页面即宣称消除所有竞争。无需新增迁移；D1 当前正式模型 schema、Postgres schema/表权限及 MySQL 原生事务/隔离、真实两连接竞争和审计仍独立验收。本次模型前置写没有新增治理审计，不把既有字段更新扩大宣称为全域审计保证。

- **`/admin/models`**：CRUD；`PATCH` 可写 **`route_policy`**（TEXT JSON 或 `null` 清空）。含 **`GET /admin/models/import/catalog`** 与 **`POST /admin/models/import`**。Image / Audio 路由按 Core 适配器注册表区分可选请求入口、上游 operation 和显式转换 adapter，具体组合仍由服务端校验。
- **`/admin/routes`**：REST `GET/POST`、`GET/PATCH/DELETE /:id`；列表支持 `?model_id=&provider_id=`。创建时校验 provider 对该协议是否配置了 `endpoints` base 或任一 capability，并创建或复用对应 Request Surface / Route Pool。

Web 路由编辑器直接使用 Core 注册表推导操作：DashScope 原生 TTS 包含 HTTP、SSE、多模态与两类实时会话，ASR 包含原生异步文件转写；异步选项须同时具备提交与任务查询端点。仅展示用途的旧 `dashscope + audio.transcriptions` 不作为新入口。编辑器提供 Qwen / Wan 图像转换预设、所选适配器调用路径、上游能力、受保护字段和 `extra_body` 示例；OpenAI 异步 ASR 转换由网关等待上游结果，原生 DashScope 接口则返回任务并由客户端携带回执查询。配置脱敏时不推测新路由拓扑；未改变拓扑的旧目标仍可作其他局部编辑。

- **`GET /admin/routes/context`**：要求 `routes.read` 与 `config.read`，返回 `{ "success": true, "data": { "global_route_strategy": "hash_affinity", "billing_currency": "USD", "business_timezone": "UTC" } }` 形状；实际值按当前系统配置归一，示例值不是固定常量。缺省/无效策略采用 Core 默认 `hash_affinity`，币种按当前网关规则归一并保留有效遗留 `EUR`，时区按 IANA/UTC 归一。任何配置读取失败返回 500，不伪造默认值；全部响应用 `Cache-Control: private, no-store`。此接口不返回完整配置、秘密、模型 `route_policy` 或供应商数据；后两者仍由各自权限保护的 API 提供。
  - **`priority`**：层（Proxy 按 **DESC** 硬序）。
  - **`weight`**：同层权重，整数 **≥ 1**（默认 1）；非法 → **400**。
  - **`POST`** 省略或空白 **`route_group`** → **`default`**；**`PATCH`** 若含 `route_group` 则不得为仅空白（否则 **400**）。
  - **`request_protocol` / `request_operation`**：公开请求入口，例如 `openai` + `chat` / `responses` / `embeddings` / `rerank`；省略 operation 使用兼容值 `*`。
  - **`upstream_protocol` / `upstream_operation`**：Target 实际调用的协议 / capability；省略 operation 时跟随请求 operation。
  - **`adapter`**：同协议、同 operation 使用 `passthrough`；OpenAI ASR / TTS 转 DashScope 使用白名单中的显式 adapter。未声明的跨协议或 operation 组合返回 **400**，见 [DashScope 音频架构](../architecture/dashscope-audio.md)。
  - **`routing_metadata`**：仅描述该具体 Route Target 可公开用于选择的能力，不参与上游请求。JSON 形状为 `{ "supported_parameters": ["tools", "response_format", "speed"], "quantization": "fp8", "endpoint_slug": "provider/turbo", "endpoint_class": "standard", "region": "us", "context_length": 128000, "max_prompt_tokens": 120000, "max_completion_tokens": 16384 }`；参数名、量化值、公开 endpoint slug、端点分类、地域与三个容量值会被严格规范化，未知字段或非法值返回 **400**。容量值只能是正安全整数或 `null`，且必须来自该具体 endpoint 的可核验规格；不得从模型目录值或 `custom_params` 猜测。Chat 的 `max_tokens` / `max_completion_tokens`、Responses 的 `max_output_tokens`、Messages 的 `max_tokens` 会在首次上游调用前按 `max_completion_tokens` 过滤，未知或不足均 fail closed。`endpoint_slug` 最长 120 字符，只允许字母、数字、点、下划线、连字符和 slash 分段，保存后会小写化；它会出现在公开目录中，禁止填入内部 ID、URL 或秘密。slash 变体必须显式设置 `endpoint_class` 为 `standard` 或 `service_tier`，不得仅根据后缀猜测；普通请求仍排除所有 service-tier 与未分类历史变体，完整 slug 可通过 `provider.order` / `provider.only` exact opt-in。自动服务等级只识别已核验且显式分类的 `provider/flex`、`provider/fast`、`provider/priority`；每一层必须作为独立 Endpoint/Route 绑定，提供与该层一致的上游参数和价格证据。原生 `speed` 也只会发给 `supported_parameters` 明确包含 `speed` 的当前 verified Endpoint；如 Provider 用单独的 `*-fast` 模型，应把 `/fast` Route 的 `provider_model_name` 显式配置成该 sibling，网关不会根据名称猜测或改写模型。其它 suffix 保持 exact-only。`region` 只是管理员声明的供应端点位置发现标签，不是推理数据驻留保证。Proxy 以 fail-closed 方式读取，损坏或缺失元数据不会被推断为支持。
  - **`custom_params`**：仍是发送给上游的请求默认参数；不得用它承载路由能力、数据策略或凭据。`routing_metadata` 与 `custom_params` 的信任和出站边界必须保持分离。
  - **`GET` 响应**：除 Target 字段外包含 `route_pool_id` 与 `surfaces`（JSON 数组字符串），用于还原 Surface → Pool → Target 拓扑。
- **`PATCH /admin/routes/pools/:poolId`**：设置当前 Pool 的策略与按层覆盖。body 示例：

```json
{
  "strategy": "hash_affinity",
  "tier_strategies": { "10": "hash_affinity", "0": "weight_priority" },
  "sticky_routing": { "enabled": true, "idle_ttl_seconds": 3600 }
}
```

  - **`strategy`**：四策略之一；`null` / 空值表示继承模型 / 全局配置。
  - **`tier_strategies`**：priority（整数键）→ 策略名；`null` / `{}` 清空列。非法 key 或策略名 → **400**。
  - **`sticky_routing`**：`{ enabled: boolean, idle_ttl_seconds?: number }`；`idle_ttl_seconds` 默认 3600，范围 60–86400；写入时递增 `sticky_epoch` 使旧绑定失效。
  - 字段均可选，至少提供其一。

- **Sticky 绑定可观测 / 排障**（挂在 `/admin/routes/pools/:poolId/sticky/*`，须在 `/:id` 通配之前注册）：
  - **`GET .../sticky/bindings/summary`** → `{ total_active, stale_count, targets: [{ route_target_id, active_count, share, last_updated_at }] }`。活跃行条件：`pool_epoch = route_pools.sticky_epoch` 且 `expires_at > now`。
  - **`GET .../sticky/bindings?page=&page_size=&route_target_id=`** → `{ items: [{ affinity_hash, user_id, email, model_id, route_group, protocol, route_target_id, expires_at, remaining_seconds, updated_at }], total, page, page_size }`。按 `updated_at` 倒序；`page_size` 默认 20，上限 100。用户信息来自绑定行的 `affinity_key`（迁移 0034）；该迁移前写入、尚未续期的行 `user_id` / `model_id` 等为 `null`。
  - **`GET .../sticky/bindings/lookup?user_id=&email=&model_id=&route_group=&protocol=&request_operation=`**  
    用 surface 上下文（`resolveModelSurface`）校验属于该 pool，再按 `SHA-256(userId|model|routeGroup|protocol)` 查绑定。`email` 与 `user_id` 二选一。返回 `{ user_id, affinity_hash, affinity_key, binding }`；`binding` 可为 `null`。
  - **`DELETE .../sticky/bindings/:affinityHash`**：强制删除该 hash 行（管理端解绑，无 token CAS）。
  - **`POST .../sticky/reset`**：仅 bump `sticky_epoch`，返回 `{ sticky_epoch }`。历史行不立即删除，随 GC / 覆盖消失。

完整拓扑与 operation 白名单见 [route-topology.md](../architecture/route-topology.md)。

### Model Endpoints（`/admin/endpoints`）

Endpoint 是 Route 可调用能力、价格和公开发现的权威证据，不等同于 Provider 出站 URL，也不能由 `models.pricing_profile`、Route `price_override` 或 `routing_metadata` 推断。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST | `/admin/endpoints` | 列表（可按 `model_id`、`provider_id`、`status` 筛选）/创建 draft |
| GET / PATCH / DELETE | `/admin/endpoints/:id` | 详情、部分更新、删除；修改价格/能力/证据会把已核验记录自动降级为 draft |
| POST / DELETE | `/admin/endpoints/:id/routes/:routeTargetId` | 绑定/解绑具体 Route Target；模型与 Provider 必须一致 |

发布顺序固定为：创建 draft → 绑定 Route → 填写公开 HTTPS 证据和未来到期时间 → `PATCH { "status": "verified" }`。核验时会逐绑定检查 exact operation、Provider 出站能力和 Route+Provider subject fingerprint；缺失、漂移、过期或 operation 不匹配均 fail closed。

`audio_capabilities` 使用严格的 operation-scoped v1 JSON。旧 Endpoint 迁移后为 `{}`/unknown，不会从 legacy audio 价格猜测回填。例如按秒转写：

```json
{
  "v": 1,
  "pricing_by_operation": {
    "audio.transcriptions": {
      "currency": "USD",
      "meter": {
        "kind": "duration",
        "unit": "second",
        "price": "0.0001",
        "minimum_units": 1,
        "increment_units": 0.25
      },
      "request": "0",
      "discount": 0
    }
  }
}
```

TTS 使用 `characters` + `unicode_code_point`；token meter 必须声明五个价格分项和 `require_authoritative_breakdown: true`，但数据面在尚无权威分项 usage 时会在 dispatch 前安全拒绝。Realtime TTS session 不是独立推理计费 operation，不得把 session 创建费冒充会话内 inference 费用。

OpenAI-compatible TTS 还可在同一 v1 JSON 中声明请求形状证据。`speech_by_operation` 只接受 `audio.speech`，且必须同时存在该 operation 的价格证据：

```json
{
  "v": 1,
  "pricing_by_operation": {
    "audio.speech": {
      "currency": "USD",
      "meter": {
        "kind": "characters",
        "unit": "unicode_code_point",
        "price": "0.00002",
        "minimum_units": 0,
        "increment_units": 1
      }
    }
  },
  "speech_by_operation": {
    "audio.speech": {
      "supports_default_voice": false,
      "reference_audio_media_types": ["audio/wav", "audio/mpeg"],
      "reference_audio_default_media_type": "audio/wav"
    }
  }
}
```

- `supports_default_voice` 为 `true` / `false` / `null`；只有 `true` 允许普通合成省略 `voice`。
- `reference_audio_media_types` 最多 16 个精确、无参数的 `audio/*` media type；data URI 必须命中该列表。
- raw Base64 没有自描述格式，只有配置了且命中列表的 `reference_audio_default_media_type` 才能路由。
- 声明任一 reference-audio 格式时，Endpoint 的 `supports_voice_cloning` 必须为 `true`。未知、矛盾或未核验事实均在 Admin 或 dispatch 前 fail closed。

### Playground / Simulator 浏览器诊断合同

- 所有context/preview/verify-secret成功及错误响应均为private,no-store；SSE另保留no-transform。Playground需playground.execute，安全context中的价格/参数详情另按read授权；Simulator context同时需models.read与routes.read，Key目录和日志各独立授权。
- Playground沿用POST /admin/playground：JSON含routeId或toolId/provider与body，geminiAction/imageOperation按操作显式提供。preview为POST /admin/playground/preview的2MiB JSON，同目标与body，可附uploadManifest（images数组与audio的name/type/size），只预览元数据，不传二进制。Tools不接受uploadManifest或multipart；preview不读取凭据、交换OAuth或发上游，自动Gemini认证返回execution-only/deferred提示，执行时才确定最终认证。
- Web Playground 目录兼容 openai / anthropic / gemini / dashscope / minimax / volcengine；未知协议保留为不可执行路由，不使其余目录失效。模板按模型类型、操作和 Adapter 选择：原生 MiniMax / Volcengine 生图使用各自 JSON，转换 Adapter 使用 OpenAI 字段；非 OpenAI 图像路由不提供 multipart edits。支持原生图片 URL/base64 与完整 SSE 事件预览，MiniMax TTS 的 hex 音频可播放，流式最终完整音频不会与增量重复拼接。发送前重新核验路由的协议、操作和 Adapter，未知组合不回退为 Chat。
- Routes调用可用multipart：单值routeId/body（JSON文本）、可选geminiAction/imageOperation，重复image图片文件与单个file音频文件；拒绝未知/重复文本字段及multipart preview。每图20MiB、最多5图，audio25MiB；Node合计100MiB/encoded multipart104MiB，CF32/36MiB；按实际字节流限幅并处理取消/deadline，虚假Content-Length不能绕过。DashScope同步转写另限10MiB编码body。
- 现有HTTP客户端不强制新增Playground主体头；提供X-CinaToken-Expected-Console-Subject时严格核对规范encodeURIComponent编码。新浏览器始终提供；实时浏览器使用cinatoken-playground与cinatoken-playground-subject.BASE64URL(encodeURIComponent(subject))子协议，subject不入query/上游。CF保留原生101及固定诊断子协议，Node返回501，不伪装升级成功。
- Simulator POST /admin/keys/:id/verify-secret仅接受不可变ID与body {secret}，query/掩码/hash引用/额外字段拒绝；Console必须提供当前规范subject头。只比较所选记录与原始秘密的哈希，返回id/user_id/workspace_id/verified，不揭示/生成/修改Key，也不表示disabled/expired/budget等Proxy准入成功。原始秘密仅当前运行内存；每次Send重新核验主体与绑定后，独立Proxy HTTP transport以该Key请求（credentials:omit/redirect:error），不附Console Cookie/Admin主体头或自动重试。原生WS使用Gateway Key子协议，不添加Admin认证/主体头；浏览器会自动携带同源匹配Cookie，无法设置fetch的omit选项。
- Web Simulator 按协议、操作与 Adapter 匹配六协议原生/转换入口，区分 HTTP 与实时操作；未知目录项仅禁用自身。原生 MiniMax 语音支持 hex/SSE 音频预览，原生图片与 DashScope HTTP 音频使用各自模板。DashScope 异步转写提交后仅在当前页面内存保存任务 receipt，手动查询前重新核验主体、Key/owner/workspace 和 Proxy；不轮询或自动重发。查询以 `X-CinaToken-Task-Receipt` 请求头携带 receipt，URL、显示的请求快照和浏览器持久存储不包含秘密。Proxy CORS 允许该请求头，并公开 `X-CinaToken-Settlement-Basis` / `X-CinaToken-Request-Id` 诊断头；不公开 receipt 响应头。提交结果无法确认有效 receipt 时显示未知结果，不视为可安全重试。
- Simulator context币种无config.read或未配置/非法/读取失败均为null。Playground在playground.execute授权下读取币种，缺失/非法为null，读取异常使context返回502；其服务端解析Tools catalog推导configured状态，不把凭据返回浏览器。Simulator只投影audio_operation，不返回pricing_profile。原始上游结果与脱敏、有界metadata分别展示，usage不是账本结算；Playground不写Gateway账本/请求日志/failover，上游自身仍可能收费，Simulator的Proxy计费/日志/实时TTS财务守卫沿用原行为。

### `models.route_policy`（`PATCH /admin/models/:id`）

模型级路由策略覆盖（优先级低于 Route Pool 与 `tier_strategies`，高于全局 `ROUTE_STRATEGY`）。形状与解析见 [route-strategies.md](../reference/route-strategies.md)。

```json
{
  "strategy": "hash_affinity",
  "rules": {
    "openai:default": { "strategy": "hash_affinity" },
    "openai.chat:default": { "strategy": "weight_priority" }
  }
}
```

- **清空**：`null` 或空串 ⇒ 列 `NULL`（回退全局）。
- **校验**：`normalizeModelRoutePolicyInput`；须含顶层 `strategy` 和/或至少一条合法 `rules`。
- **运行时**：仅 Proxy failover 路径；Admin Playground **不走**策略排序。解析时先看 `route_pools.tier_strategies[priority]`，再看 `route_pools.strategy`，然后才是模型 `route_policy`。

### `GET /admin/models/sync/diff` 与 `POST /admin/models/sync/apply`

- **用途**：静态目录（`packages/admin/lib/model-presets/*.json`）更新后，让已导入的 `models` 行与官方值对齐。差异只在管理员点「检查官方更新」时计算，`GET /admin/models` 列表不带差异信息。
- **比对范围**：按 `models.id` 与目录项一一对应，字段为 `display_name`、`vendor`、`context_window`、`max_tokens`、`description`、`released_at`、`input_modalities`、`output_modalities`、`pricing_profile`。目录未给出（null）的字段不报差异，不会建议清空；模态不看顺序；价格按 `BILLING_CURRENCY` 选 `usd` / `cny` 分支，按叶子路径（如 `tiers[0].input_price`）展示新增 / 变更 / 仅本地有。
- **选择提示**：差异响应中普通字段的 `default_apply` 为采用官方的建议，`pricing_profile` 为 false。Web 为全部字段默认不选；可批量选中筛选范围内的元数据，价格需逐项选择并额外确认计费影响。「保留当前」不落库，下次检查仍会显示。
- **应用**：请求体 `{ "items": [{ "model_id": "...", "fields": ["description", "pricing_profile"] }] }`。服务端重新计算差异，只处理确实存在差异的所选字段，经 `updateModelService` 写入（路由价格覆盖的时段对齐照常执行）；不写 `tags`、`metadata`、`route_policy`，不碰路由。响应 `{ updated, skipped, failed: [{ model_id, message }] }`，单个模型失败不影响其它；失败可能发生在持久化后的后续步骤，不能据此断言零写入，应核查当前状态。
- **写入确认**：成功处理批次的响应另含顶层 `acknowledgement: { domain: "models", operation: "sync" }`，不含资源 `id`；`data` 保留逐项更新、跳过与失败数量，不能将批次已处理等同于每项成功。Web 校验计数与失败 ID 范围，已知结果要求手动重新获取差异后才能再次应用；错误或缺失 ACK 进入现有未知写入保护，不自动重放。服务端在应用时重算目录值和币种，不提供差异版本/CAS 保证。
- **权限**：与其它 Admin 路由相同，后台 Session，或具有 `models.read` / `models.write` 的 `Authorization: Bearer <ADMIN_API_KEY>`。

### `GET /admin/models/import/catalog`

- **行为**：返回 `packages/admin/lib/model-presets/*.json`（合并后）每条预设的摘要（`id`、`display_name`、`vendor`、`kind`、`context_window`、`max_tokens`、`description`、`i18n`、`tier_count`、`pricing_label`、`pricing_preview`），供管理端勾选后再调用 **`POST /admin/models/import`**。`kind` 为 `llm` \| `image` \| `asr` \| `tts` \| `embedding`（与管理后台模型列表 Kind 一致，规则见 [模型类型](../reference/model-kinds.md)）；语音识别与语音合成已分开，用户接口 `GET /v1/models?kind=asr` / `kind=tts` 与之对齐（`kind=audio` 为两者的兼容别名）。英文描述与本地化摘要直接维护在对应的模型预设记录中。价格预览按当前 **`BILLING_CURRENCY`** 选用 `usd` / `cny` 分支（与导入写入同源）；响应另含顶层 **`billing_currency`**。

### `POST /admin/models/import`

- **请求体**：`{ "ids": ["glm-5", "gpt-5.2", ...] }`（**`ids` 必填**；须为非空字符串数组；重复 id 会去重；顺序保留）。介绍留在静态目录，不写入 `note`。
- **行为**：仅处理 `ids` 中在静态目录存在的 id；根据当前 **`BILLING_CURRENCY`**（`USD` → `usd` 分支，`CNY` → `cny` 分支；库内为其他历史值时按 **`USD`** 分支取价）把该分支**整段**写入 `models.pricing_profile`（含 `tiers` / 图音频单价，以及可选官方时段 `schedule`）；**已存在同 `id` 的不导入、不覆盖**，该 id 记入 **`skipped_existing`**；否则 **INSERT** 新建。标签由运营在导入后自行维护，导入**不**写入 `model_tags`。未知 id 或校验失败记入 **`failed`**，其余仍处理。
- **响应** `data`：`{ "billing_currency_used", "created", "updated"（恒为 0）, "skipped_existing": string[], "failed": [{ "id", "message" }] }`。

### 运维验收：Embedding 模型

Embedding 与 LLM 共用 Models + Routes，不新增独立管理页；数据面提供 `POST /v1/embeddings` 和 `GET /v1/embeddings/models`。

1. **Provider**：配置 OpenAI 或兼容 Provider Key。`endpoints.openai.base`（例如 `https://api.openai.com/v1`）可自动派生 `/embeddings`；非标准地址可显式填写 `endpoints.openai.endpoints.embeddings`。
2. **Model**：创建或编辑模型，将 `output_modalities` 设为 `["embeddings"]`，填写真实 `context_window`；`pricing_profile.tiers[].input_price` 使用每百万输入 token 单价，`output_price` 设为 0。
3. **Route**：创建 `request_protocol=openai`、`request_operation=embeddings`、`upstream_protocol=openai`、`upstream_operation=embeddings` 的活动路由；`provider_model_name` 填真实上游模型 ID。
4. **Discovery**：用户 Key 调用 `GET /v1/embeddings/models` 应出现该模型；普通 `GET /v1/models` 默认不出现，使用 `kind=embedding` 或 `output_modalities=embeddings` 查询。
5. **调用与审计**：调用 `POST /v1/embeddings` 后，在 Request Logs 核对 `request_operation=embeddings`、输入 token、`charged_cost` 和选中的 Route Target。日志不会保存原始 input、user 或 embedding 数组。

```bash
curl -sS "$GATEWAY_URL/v1/embeddings" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"production smoke test"}'
```

### 运维验收：Rerank 模型

Rerank 与 LLM 共用 Models、Endpoints 与 Routes；数据面提供 `POST /v1/rerank` 及 OpenRouter 别名 `POST /api/v1/rerank`。

1. **Provider**：配置兼容 Rerank 的 Provider Key。`endpoints.openai.base` 可派生 `/rerank`；版本根不同或非标准路径时，显式填写 `endpoints.openai.endpoints.rerank` 的完整 HTTPS URL。
2. **Model**：将 `output_modalities` 设为 `["rerank"]`，填写可核验的 `context_window`。按请求收费时，在 verified Endpoint `pricing.request` 填每次调用价格，并将 token 单价设为 0；按 token 收费时填写真实 prompt 单价。
3. **Route**：创建 active 的 `openai + rerank` Request Surface，并使用 `upstream_protocol=openai`、`upstream_operation=rerank`、`adapter=passthrough`。Admin 的 operation 选择器会按 Rerank 模态只显示该操作。
4. **Endpoint**：绑定同一 Model/Provider/Route Target，填入权威证据、未来到期时间、上下文上限、支持参数（例如 `top_n`）及价格，然后核验为 `verified`。
5. **调用与审计**：使用测试 Gateway Key 发起小批量请求，核对 `request_operation=rerank`、Provider、request/token 费用和 Generation。请求日志只保存文档数量与类型汇总，不保存 query 或文档正文。

生产验收不得复用未授权的付费密钥；先用供应商沙箱或明确批准的小额调用验证响应、取消和账单。

### 运维验收：文生图模型 `gpt-image-2`

> 模型与计费总览见 [文生图模型（Image Models）](../reference/image-models.md)。

不新增独立「Images」管理页；与 LLM 共用 Models + Routes。Admin 内闭环：**Routes → Playground → Simulator → Request Logs**。

1. **Provider**：配置可用的 OpenAI（或兼容）Provider Key，并在 `endpoints.openai` 写 `base`（如 `https://api.openai.com/v1`）或 `endpoints.images.generations` 完整 URL。
2. **Import**：Admin → Models → Import → 勾选 **`gpt-image-2`**（`output_modalities: ["image"]`，`pricing_profile.tiers` 含 `image_*` token 单价）。**已存在同 id 不会覆盖**——旧按张行需 **删除后 re-import** 或打开编辑填入 token 单价后保存。
3. **列表**：筛选 Kind=Image，卡片应显示 Image token 单价（如 text / img-in / img-out）。
4. **Routes**：为 `gpt-image-2` 建路由；弹窗 Billing「Standard (catalog)」应显示 **token 分项单价**；`upstream_protocol` 对 OpenAI 兼容生图锁定 `openai`，DashScope 转换允许 `dashscope`（保存 anthropic/gemini 应 400）。Models admin 本身不引用 provider base URL。
5. **Playground**（不计费、不写 logs）：选 openai 透传路由 → Send → 上游由 `resolveUpstreamEndpoint(…, images.generations)` 解析（通常 `…/images/generations`）返回图并可预览。DashScope 转换路由同样可测：请求体仍用 OpenAI Images JSON，调试台改写成 `images.generations.multimodal`。anthropic / gemini 路由禁用 Send。
6. **Simulator**（真实 Proxy）：选同一模型 → 协议锁定 openai → 请求打到 `{proxy}/v1/images/generations` → 出图；**Open Request Logs** 核对 `raw_usage` 与 `pricing_audit.kind=image_tokens`，`charged_cost` 随 usage 分项变化（非固定按张）。DashScope 转换路由也走这条 OpenAI 入口（adapter `dashscope-image-*`），不要改成 dashscope 协议。
7. **回归**：任意 LLM 模型仍走 chat/completions（Playground / Simulator 行为不变）。
8. **curl**（可选，用户 API Key）：

```bash
curl -sS "$GATEWAY_URL/v1/images/generations" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red apple","size":"1024x1024","quality":"low","n":1}'
```

成功响应含图片；请求日志按上游 `usage` token 分项扣费。用户 API 说明见 [user.md「Images」](user.md#images图片生成--编辑)。

### 运维验收：语音转写 `whisper-1` / `gpt-4o-*-transcribe`

不新增独立「Audio」管理页；与 LLM / Image 共用 Models + Routes。Admin 内闭环：**Routes → Playground → Simulator → Request Logs**。用户 API 见 [user.md「语音转写」](user.md#语音转写audio-transcriptions)。

1. **Provider**：配置可用的 OpenAI（或兼容）Provider Key；`endpoints.openai.base`（如 `https://api.openai.com/v1`）即可派生 `/audio/transcriptions`，或在 `endpoints.openai.endpoints["audio.transcriptions"]` 写完整 URL。
2. **Import**：Admin → Models → Import → Kind=Audio → 勾选例如 **`whisper-1`**（`per_second`）或 **`gpt-4o-mini-transcribe`**（`token`）。**已存在同 id 不会覆盖**——改价需删除后 re-import，或打开编辑后保存。
3. **列表**：筛选 Kind=Audio；卡片按模式展示按秒单价或 token in/out（$/1M）。
4. **Routes**：为模型建路由；`upstream_protocol` **锁定 openai**（保存 anthropic/gemini 应 400）；Billing「Standard (catalog)」应显示对应 Audio 目录价。
5. **Playground**（不计费、不写 logs）：选该 openai 路由 → 上传音频 → Send → 上游由 `resolveUpstreamEndpoint(…, audio.transcriptions)` 解析；非 openai 路由禁用 Send。
6. **Simulator**（真实 Proxy）：选同一模型 → 协议锁定 openai → 请求打到 `{proxy}/v1/audio/transcriptions` → 出转写文本；**Open Request Logs** 核对：
   - `whisper-1`：`billing_kind=audio_per_second`、`audio_duration_seconds`、`pricing_audit.kind=audio_per_second`
   - `gpt-4o-*-transcribe`：`billing_kind=audio_tokens`、`pricing_audit.kind=audio_tokens`（含 `tokens.*`）
7. **curl**（可选，用户 API Key）：

```bash
curl -sS "$GATEWAY_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -F model=whisper-1 \
  -F file=@recording.webm \
  -F language=zh \
  -F response_format=json
```

### 运维验收：国内文生图 `seedream-*`（火山方舟）

与 `gpt-image-2` 共用同一套 OpenAI Images 驱动；Seedream 目录价为 **`image_billing_mode: per_image`**（按张），不再用 16384 token 折算。

1. **Provider**：Admin → Providers → Import → **Volcengine Ark**（`openai` 只配 `endpoints.chat`，生图走 `volcengine.base`；**不要**写 `openai.base`，否则会派生出不存在的 `/images/edits`）。填入火山 API Key。
2. **Import**：Models → Import → 勾选：**`doubao-seedream-5-0`** / **`doubao-seedream-5-0-pro`**。**已存在同 id 不会覆盖**——改价需删后 re-import、PATCH，或跑 `node scripts/db/migrate-image-billing-modes.mjs --dry-run` / `--apply`。
3. **目录价口径**（**`per_image`**；权威单价 `image.default`；与火山方舟 / BytePlus 公开价对齐）：
   | catalog / `provider_model_name` | 官方约价 | `image.default` CNY | USD |
   |---|---|---|---|
   | `doubao-seedream-5-0` | ¥0.22 / 张（一口价，不按分辨率翻倍） | **0.22** | **0.035** |
   | `doubao-seedream-5-0-pro` | 单图生成 ≤261 万像素（1.5K 及以下）¥0.30 / 以上 ¥0.60；参考图首张免费、之后 ¥0.02 | `by_size`：`1k` / `1.5k` **0.30**，`2k` **0.60**；缺省 **0.60**（方舟默认 2K）；`image.input.default=0.02` | **0.045** / **0.09**；input **0.003** |
4. **Routes**：OpenAI SDK 入口选适配器 `volcengine-image`（上游 `volcengine` / `images.generations`）；流式与方舟原文走原生透传 `POST /volcengine/api/v3/images/generations`。`provider_model_name` 填方舟 Model ID。`watermark` 等由客户端请求或 route `custom_params` 按需传入，**不**写在模型预设里。
5. **Playground / Simulator**：选该路由 → generations；Seedream **图生图**走 `POST /v1/images/generations` + JSON `image`（勿用 multipart `/v1/images/edits`，火山无 OpenAI edits 形态）。
6. **Request Logs**：核对 `pricing_audit.kind=image_per_image`、`billing_kind`、`output_image_count=1`、`charged_cost≈官方单价×charged_factor`。
7. **curl**（用户 API Key）：

```bash
curl -sS "$GATEWAY_URL/v1/images/generations" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seedream-5-0","prompt":"海边灯塔水彩封面","size":"2K","n":1,"watermark":false}'
```

### Legacy `pricing_profile` / Endpoint / `price_override` 契约

- **模型目录兼容价**：`models.pricing_profile`（TEXT JSON）仍供 catalog、静态 preset、kind 推断和旧 UI 展示；路由推理的运行时价目必须配置在 `/admin/endpoints`，并完成 Route 绑定与 verified 核验。
  - **Token（LLM）**：canonical `{ "tiers": [...] }`。非末档 `upto` 为有限数字 **≥ 0**；**末档 `upto` 为 JSON `null`**（开放上界）。LLM 选档 basis 为上游 **`input_tokens`**（`packages/core/src/db/pricing-profile.ts`）。
  - **Image 双模式**（显式 `image_billing_mode`；Admin 保存禁止混配）：
    - **`token`**：`{ "image_billing_mode": "token", "tiers": [ { image_* $/1M ... } ] }`；仅作 legacy 目录描述。Endpoint token meter 当前数据面不支持，会在 dispatch 前 fail closed。
    - **`per_image`**：`{ "image_billing_mode": "per_image", "image": { "default", "input"?, "uncertain_result_policy"? } }`（**无 `tiers`**）；对应运行时安全子集必须另在 Endpoint `image_capabilities.pricing` 声明。日志列仍使用 `billing_kind` / `input_image_count` / `output_image_count`。
    - 无 mode 且仅有 legacy `image` 块不会成为 Endpoint 证据；不得据此自动扣费或自动回填。
    - `gpt-image-2` / Gemini：token 预设；Seedream / GLM / Grok：per_image 预设（见 [image-models.md](../reference/image-models.md)）。
  - **Audio 双模式**（显式 `audio_billing_mode`；Admin 保存禁止与 Image 计费字段混配）：
    - **`per_second`**：legacy `{ "audio_billing_mode": "per_second", "audio": { "price_per_second", "minimum_seconds"? } }` 只作目录描述；运行时须在 Endpoint `audio_capabilities.pricing_by_operation` 为 exact operation 声明 `duration` / `second` meter。
    - **`token`**：legacy `{ "audio_billing_mode": "token", "tiers": [...] }` 只作目录描述；Endpoint token meter 虽可声明五维价格，但当前数据面尚无权威分项 breakdown，因而 dispatch 前 fail closed。
    - 预设：`whisper-1` → `per_second`；`gpt-4o-mini-transcribe` / `gpt-4o-transcribe` / `gpt-4o-transcribe-diarize` → `token`（见 [user.md「语音转写」](user.md#语音转写audio-transcriptions)）。
  - **官方分时时段（`schedule`，可选）**：与 `tiers` / `image` / `audio` 同级，写入已有 `pricing_profile` TEXT JSON，无独立迁移。元素复用路由侧窗口形状 `{ start, end, factor, days? }`，单一 `factor` 作用于该档全部单价（input / output / cache / image_* / audio_*）。命中窗口取 `factor`，未命中为 `1`（无需 `mode`）。时区沿用 `system_config.BUSINESS_TIMEZONE`，不写入 JSON。半开区间 `[start, end)`，仅 `end` 可为 `24:00`，`start` 不得为 `24:00`；`factor ≥ 0`；同侧窗口禁止重叠。非法 `schedule` 会使整个 `pricing_profile` 解析失败。未配置时行为与历史一致。
  - Request log：迁移 **`0013_request_log_image_billing`** 增加 `billing_kind`、`input_image_count`、`output_image_count`；**`0014_request_log_audio_billing`** 增加 `audio_duration_seconds`。
- **模型 Kind（Admin UI，无独立 DB 列）**：
  - **Audio（ASR/TTS）**：优先使用 OpenRouter 输出模态；ASR 为 `output_modalities: ["transcription"]`，TTS 为 `["speech"]`。旧数据仍可由有效 `audio_billing_mode`（`per_second`/`token` 为 ASR，`per_character` 为 TTS）兼容识别，但新建与静态预设不再把它们写成通用 `text`/`audio` 输出。
  - **Image（文生图）**：非 Audio，且 `output_modalities` 含 `image`（**不要**用 `input` 含 `image` 判断——多模态 LLM 也会有）。
  - **Rerank（重排序）**：`output_modalities` 含 `rerank`；输入固定为 text，保留可核验的 `context_window`，不设置生成 `max_tokens`。
  - **LLM**：排除 Audio、Image、Embeddings 与 Rerank 后的其余模型；仅当 `output_modalities` 缺失时，才用历史 `pricing_profile.image` 兜底判定。
  - Models / Routes UI 侧栏 Kind 为 **`all` | `llm` | `image` | `audio` | `rerank`**；Models 的 URL `?kind=` 与 `?vendor=` 组合并默认 `all`。Playground 没有 `all`，默认 `llm`，可选 Rerank Route 后载入 `query + documents` 模板并直连配置的 rerank URL。静态导入目录暂只有 `llm | image | audio` 预设。Image 卡片按 mode 展示 `/M` 或 `/image`；Audio 卡片按 mode 展示 `/s`、`/character` 或 token in/out。
  - 文生图与语音转写**不使用**聊天字段 `context_window` / `max_tokens`（多数预设与保存为 `null`；Admin 卡片/表单隐藏这两项；部分 ASR token 预设可带 context/max 供上游约束）。Rerank 仅隐藏并清空 `max_tokens`。LLM 的 `max_tokens` 缺省仍为 8192。迁移 **`0010_models_max_tokens_nullable`** 允许 `max_tokens` 为 NULL。
- **路由计价（canonical）**：`model_routes.price_override` 只维护相对 Endpoint 标准价的倍率（不复制计费模式或基础单价），**不再**要求 nested `metered` / `charged` tiers：

```json
{
  "provider_factor": 0.5,
  "provider_factor_starts_at": "2026-10-01T00:00:00.000Z",
  "provider_factor_expires_at": "2026-11-01T00:00:00.000Z",
  "charged_factor": 1.2,
  "metered_factor": 1.0,
  "schedule": {
    "mode": "override",
    "provider": [
      { "start": "00:00", "end": "08:00", "factor": 0.4, "validity": { "starts_at": "2026-10-15T00:00:00.000Z", "expires_at": "2026-12-01T00:00:00.000Z" } }
    ],
    "charged": [
      { "start": "00:00", "end": "24:00", "factor": 1.2, "days": [1, 2, 3, 4, 5] },
      { "start": "00:00", "end": "24:00", "factor": 0.8, "days": [6, 7] }
    ],
    "metered": [
      { "start": "00:00", "end": "24:00", "factor": 1.2, "days": [1, 2, 3, 4, 5] },
      { "start": "00:00", "end": "24:00", "factor": 0.8, "days": [6, 7] }
    ]
  }
}
```

  - `charged_factor` / `metered_factor`：相对 Endpoint 标准价的默认倍率（缺省 `1`；`metered_factor` 缺失时可回退读历史 `provider_factor`）；未命中分时时段时使用。
  - `schedule`（可选）：分时窗口，时区为 `system_config.BUSINESS_TIMEZONE`；半开区间 `[start, end)`，仅 `end` 可为 `24:00`；允许跨午夜。可选 `days` 为 ISO 星期数组（`1`=周一 … `7`=周日）；省略表示每天。跨午夜时 `days` 锚定窗口**开始日**（例如周五 `22:00–06:00` 覆盖周五 22:00 至周六 06:00）。窗口在请求进入 Gateway 时锁定，长流式请求跨越边界不会切换倍率。同侧窗口在一周循环上禁止重叠。
  - `schedule.mode`：
    - **缺省或 `"multiply"`**（存量）：`charged_cost` = Endpoint 用户扣费基数 × `charged_factor` × 命中窗 `factor`（未命中窗按 `1`）；`metered_cost` 以 Endpoint 标准价同理。
    - **`"override"`**（Admin UI 新写入）：命中窗时窗口 `factor` 就是对标准价的倍率；未命中用上方默认 `charged_factor` / `metered_factor`。两侧共享同一套 start/end（及可选 `days`），各写自己的 `factor`。
  - `standard_cost` 为 chosen Endpoint 标准价结果。嵌套 `metered`/`charged` tiers **写入时剥离、运行时忽略**。`pricing_audit.schedule.evaluated_at_utc` 记录本次选窗使用的请求开始时刻，并带 `local_weekday`（1–7）。非法 `mode` 或非法 `days` 在 Admin API 写入时拒绝。
- **公开列表**：`GET /v1/models` 返回完整 `pricing_profile` 字符串；`model_info.input_price` / `output_price` 为 **兼容展示**：取各档中 **最低 `input_price`** 所在档的 in/out。详见 [user.md「获取模型列表」](user.md)。

#### Gateway Admin UI — Model Routes「Billing & Cost」

与 Proxy `usage-tracker` 一致：

| 区块 | 含义 | 数据来源 |
|------|------|----------|
| **Standard price** | Legacy 目录价展示（只读；不能证明 Route 可计费） | `models.pricing_profile`；运行时标准价请在 `/admin/endpoints` 查看和维护 |
| **Charged factor** | 用户侧默认倍率（窗外） | `price_override.charged_factor` |
| **Metered factor** | 供应侧默认倍率（窗外） | `price_override.metered_factor` |
| **计费倍率** | 统一展示默认行与时段行。默认行显示“全部时段”或“其他时段”；每行可编辑三侧倍率及独立供应商有效期。模型已配官方时段时 start/end/days 只读 | `price_override.schedule`（`mode: "override"`） |

编辑旧配置时会将继承的供应商有效期显式保留到每行，之后调整默认行日期不影响其他时段；保存继续使用 `override` 模式。

路由列表卡片展示 **`Ch ×`** / **`M ×`**；配置了供应商倍率时附加 **`P ×`** 及生效中 / 未开始 / 已过期。有 schedule 时附加 **Sch** 提示。公开折扣按目录价 × 有效供应商倍率 × 用户倍率展示。

---

## 仪表盘与聚合（`/admin/stats`、`/admin/config`、…） {#admindashboard}

与 **`/admin/keys`** 相同，请求需使用 Console Session，或携带具有对应权限的 **`Authorization: Bearer <ADMIN_API_KEY>`**。成功响应一般为 `{ "success": true, ... }`；无效或已吊销 Key 返回 401，权限不足返回 403 及 `required_permission`。

### `GET /admin/stats`

要求 `analytics.read`。统计中的近期日志仅为事件摘要；完整请求日志由需要 `logs.read` 的独立接口提供。成功和认证/权限错误响应均为 `Cache-Control: private, no-store`。

查询参数：

| 参数 | 说明 |
|------|------|
| `range` | `1h` / `1d` / `24h` / `7d` / `14d` / `30d`（UI 快捷按钮；`90d` 仍可通过 API 传入）；无 `start_date`+`end_date` 时默认 `1d` |
| `start_date` / `end_date` | UTC `YYYY-MM-DD HH:mm:ss`；**与 Request Logs / Analytics 相同**；两者同时提供时优先于 `range` |
| `preset` | 仪表盘对比提示。`today` 且起点等于业务日界时，与前一业务日的相同已过时长比较；其余值比较紧邻之前的等长时段，不影响请求时间窗解析 |

响应 `data` 含：

- **`gateway`**：活跃 Key 数、`keysTotal` / `keysActive`、`accountsTotal` / `accountsActive`、当日请求数/费用/Token/错误率
- **`kpi`**：时间窗内总请求、成功率、三档成本、`activeUsers`、错误率、Token 汇总（input/output/cache）、`avgLatencyMs`、近 60 秒近似 **`rpm`** / **`tpm`**
- **`modelDistribution`**：按 `model_id` 聚合 Top 10（请求、Token、三档成本）
- **`topUsers`**：按 `charged_cost` 排序 Top 12
- **`timeseries`**：按 `granularity`（仅 `range` 时 `1h`/`1d`/`24h`→`hour`，更长→`day`；显式起止时不超过 48 小时为 `hour`）的 Token/请求/成本趋势；含 `cache_hit_rate`。`bucket` 是 `BUSINESS_TIMEZONE` 墙钟（日：`YYYY-MM-DD`，小时：`YYYY-MM-DD HH:MM:SS`），不是 UTC
- **`granularity`**：`hour` | `day`
- **`recentLogs`**、**`recentErrors`**：每项仅含 `id`、`model_id`、`provider_id`、`provider_name`、`status`、`created_at`；不返回错误原文、请求体、路由轨迹、计价审计、用户或密钥详情

### `GET /admin/config`

要求 `config.read`，返回 `system_config` 全表：`{ success, data: [{ key, value, description }, ...] }`。固定 14 个 Tools catalog/active/legacy 配置键始终掩码，即使具有 `config.secrets.read` 也不能从此接口读取原文；Tools 凭据只可经下述强制审计 reveal 读取。其他键继续按 `config.secrets.read` 权限脱敏，授权后仍可能包含凭据，不能把完整列表放进普通 Web Query 缓存或持久存储。响应使用 `Cache-Control: private, no-store`。

### `GET /admin/config/overview`

要求 `config.read`，仅按键读取 `BUSINESS_TIMEZONE`、`BILLING_CURRENCY`、`ROUTE_STRATEGY`、`USER_CHARGED_COST_FACTOR_MODE`、`STREAM_FIRST_EVENT_TIMEOUT_MS`、`STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS`、`ALERT_WEBHOOK_WECOM_URL`、`ALERT_WEBHOOK_FEISHU_URL`。不枚举完整配置表，不返回 Webhook URL 或其他配置键。两个首数据超时键保留历史原始字符串供核对，其余设置沿用既有安全规范化。示例：

```json
{
  "success": true,
  "data": {
    "businessTimezone": { "value": "Asia/Singapore", "source": "configured", "revision": "legacy" },
    "billingCurrency": { "value": "USD", "source": "configured", "revision": "legacy" },
    "routeStrategy": { "value": "hash_affinity", "source": "configured", "revision": "legacy" },
    "userChargedCostFactorMode": { "value": "multiply", "source": "configured", "revision": "legacy" },
    "streamFirstEventTimeoutMs": { "value": "30000", "source": "configured", "revision": "legacy" },
    "streamFirstEventTimeoutRouteGroups": { "value": "default,VIP", "source": "configured", "revision": "legacy" },
    "webhooks": { "wecom": { "configured": true, "revision": "legacy" }, "feishu": { "configured": false, "revision": null } },
    "canWrite": true,
    "canReveal": false
  }
}
```

`businessTimezone.source` 为 `configured`、`legacy`、`missing` 或 `invalid`，语义与专用时区 GET 相同。`billingCurrency.source` 为 `configured`（USD/CNY）、`unsupported`（有效三字母遗留值，例如 EUR，`value` 保留 EUR）、`missing` 或 `invalid`（后两者的有效值按现行网关规则为 USD）。`routeStrategy.source` 为 `configured`、`missing` 或 `invalid`，后两者的有效值为 `hash_affinity`。`userChargedCostFactorMode` 的 `value` 为 `multiply` 或 `min`，`source` 为 `configured`、`missing` 或 `invalid`；后两者按 Core 默认值 `multiply`，不回显非法原值。旧版本服务缺此字段时 Web 显示不可用且只禁用这一项。Webhook 的 `configured` 与 Proxy 的非空 trim 判断一致。每个 `revision` 是该键行的不含秘密版本号：无行时为 `null`，迁移前旧行初始为 `legacy`，成功写入后变为新的 UUID；空字符串配置仍是有行，版本不为 `null`。`canWrite` 表示当前主体持有 `config.write`；`canReveal` 表示持有 `config.secrets.read` 的权限，**此接口不会揭示秘密**。

`streamFirstEventTimeoutMs` 和 `streamFirstEventTimeoutRouteGroups` 均为 `{value:string,source:"configured"|"missing"|"invalid",revision:string|null}`。`value` 保留数据库原始字符串，SQL null 显示为空串；trim 后为空的 `source` 为 `missing`，非空但不满足当前新写入校验为 `invalid`。`invalid` 不代表运行时关闭，例如旧值 `10ms` 当前仍按 10 毫秒、`1e3` 按 1 毫秒解析；Web 展示原值及解析结果并要求显式编辑，不在读取时规范化写回。旧服务缺任一字段或版本时，只禁用对应控件，不改用全表 GET。

此 GET 支持可选 `X-CinaToken-Expected-Console-Subject` 条件；一旦提供，就在读库前校验规范编码和当前可信 Console subject，非法或 API Key 携带该头返回 400，主体不符返回 403。旧无头调用保持兼容。Web 首数据超时的未知结果核对在重新验证身份后携带此头，避免校验与读取之间切换身份后错误解除原主体的待核对状态。

任何指定键读取失败均返回通用 500，不伪造默认配置或泄露存储错误；未认证/缺少 `config.read` 返回 401/403。成功和错误响应均为 `Cache-Control: private, no-store`。该安全投影可用于普通 Web Query 缓存；原有完整配置 GET 不能替代它。

### Web 固定键配置写入与 Webhook 核对

以下端点的对外路径均加 `/api` 前缀。保留原有 `GET/PUT /admin/config` 供 Next 页面和已有调用方使用；Web 配置页只使用固定键子路由及业务时区的通用单键 PUT，不请求全表。固定键 PUT/DELETE 必须携带读取时的条件：已有行发送 `If-Match: "<revision>"`，无行发送 `If-None-Match: *`。缺少条件返回 428 `config_precondition_required`，非法条件返回 400 `config_precondition_invalid`；版本过期返回 412 `config_revision_conflict`，不写配置或审计。成功写入与审计在同一数据库事务中提交并返回新版本。两个预先打开的 Web 标签持有同一旧版本时，最多一个条件写入可提交。

| 请求 | 输入 | 成功 `data` | 权限 |
|------|------|--------------|------|
| `PUT /admin/config/billing-currency` | `{ "value": "USD" }` 或 `CNY` | `{ "billingCurrency": { "value": "USD", "source": "configured", "revision": "新 UUID" } }` | `config.write` |
| `PUT /admin/config/route-strategy` | `{ "value": "hash_affinity" }` 等现有四策略之一 | `{ "routeStrategy": { "value": "hash_affinity", "source": "configured", "revision": "新 UUID" } }` | `config.write` |
| `PUT /admin/config/user-charged-cost-factor-mode` | `{ "value": "multiply" }` 或 `min` | `{ "userChargedCostFactorMode": { "value": "min", "source": "configured", "revision": "新 UUID" } }` | `config.write` |
| `PUT /admin/config/stream-first-event-timeout-ms` | `{ "value": "30000" }`，空串或整数文本 0–2147483647 | `{ "streamFirstEventTimeoutMs": { "value": "30000", "source": "configured", "revision": "新 UUID" } }` | `config.write` |
| `PUT /admin/config/stream-first-event-timeout-route-groups` | `{ "value": "default,VIP" }`，最多 4096 个 UTF-16 单元 | `{ "streamFirstEventTimeoutRouteGroups": { "value": "default,VIP", "source": "configured", "revision": "新 UUID" } }` | `config.write` |
| `PUT /admin/config/webhooks/:channel` | `{ "value": "https://..." }` | `{ "webhook": { "configured": true, "revision": "新 UUID" } }` | `config.write` |
| `DELETE /admin/config/webhooks/:channel` | 无请求体 | `{ "webhook": { "configured": false, "revision": "新 UUID" } }` | `config.write` |
| `GET /admin/config/webhooks/:channel/reveal` | 无请求体 | `{ "channel": "wecom", "value": "完整 URL 或空串" }` | 同时持有 `config.read` 和 `config.secrets.read` |
| `POST /admin/config/webhooks/:channel/verify` | `{ "value": "待核对 URL" }` | `{ "channel": "wecom", "matched": true, "configured": true }` | 同时持有 `config.read` 和 `config.secrets.read` |

倍率模式专用写入的 Console 请求必须携带 `X-CinaToken-Expected-Console-Subject`（值为当前 subject 的一次规范 URL 编码）；缺失、非法或不匹配在写库前拒绝。Web 在写入前重新读取 `/api/auth/check` 和 `/api/user/me`，核验 Console subject、用户 ID 与管理员关联。全局模式影响未来请求，缓存传播最多约 30 秒；相乘模式按路由有效倍率 × 用户倍率，取较小值模式取二者最小值。无用户覆盖时路由计费保持原义。模式草稿须确认后保存，缺失/错误响应保留持久未知标记；只有显式重新读取兼容服务的当前快照后才核对解锁，不自动重发。

两个首数据超时专用 PUT 与倍率模式一样要求 Console 的规范 expected-subject 请求头，API Key 仍按 `config.write` 授权。只接受单字段 `{value:string}`；移除首尾空格后存储，空串响应 `source:"missing"`，但版本仍为新 UUID。毫秒新写入拒绝指数、后缀、分数、负数及超出 32 位 timer 范围的值；`0` 和空串均关闭。组列表不降低大小写、不要求成员当前存在、不重新排序；空串仅选中 `default`，只有整个 trim 后字符串 `*` 或大小写不敏感的 `all` 代表全部，`*,VIP` 是两个字面组名。非空纯逗号列表、超过 4096 单元或含未配对 UTF-16 代理项（无法在 UTF-8 数据库中原样保存）的新值返回 400，历史原值仍按原 Proxy 规则读取。通用 PUT 使用相同新值校验。

每项独立保存、独立版本和持久未知状态，两个保存不是一个原子操作。成功 ACK 只证明单键配置与审计提交；Proxy 每个实例约 30 秒缓存且分别读取两个键，因此不承诺两个键同时生效或立刻生效。保护从上游 2xx headers 后等待第一个 body chunk 开始，心跳 chunk 也会满足；它不是首 token、完整 SSE 事件、流空闲超时或总请求期限，只覆盖 Chat/Responses/Messages/Gemini 文本流入口，不覆盖 Images/Audio/Realtime/MCP/Tools，也不保证换路由成功。新写入上限避免 Node/Web timer 溢出；超上限历史值继续原运行时语义，界面提示风险而不猜测实际触发延迟。

`:channel` 只能为 `wecom` 或 `feishu`。新替换入口只接受长度不超过 2048 的 HTTPS URL，且 WeCom 主机须精确为 `qyapi.weixin.qq.com`、飞书主机须精确为 `open.feishu.cn`；不接受非默认端口、URL 凭据、片段或控制字符。首尾空格可去除后存储。`verify` 的非空候选也受相同校验；空串可核对清除。历史遗留 URL 只可通过显式 `reveal` 读取。旧通用 `PUT /admin/config` 为兼容现有调用未增加此 URL 限制，仍可写任意非空 Webhook 值，应按原有高权限接口管理。

条件写入在数据库内比较版本，成功响应表示配置与审计已原子提交，无写后重读竞争窗口。412 是确定未提交；存储失败或 HTTP 请求结果未知仍须保持未确认状态，不能自动重放写入，也不能以 overview 的 `configured: true` 判定“替换成功”：同时持有秘密读取权限者可显式调用只读 `verify` 对照候选 URL；仅有写权限者须保留未确认状态。`PUT/DELETE` 的响应、错误与服务端错误日志都不包含 Webhook URL。`verify` 只返回布尔对照结果，不返回或记录候选 URL；`reveal` 应仅在用户明确操作后调用，其明文响应不得进入普通 Query 缓存、持久存储或日志。上述所有端点（含提前结束的认证/权限/存储错误）均使用 `Cache-Control: private, no-store`。

旧通用 `PUT /admin/config` 与上述固定键写入均在同一事务内更新 `system_config` 并追加一条 `config_change_audit`。通用 PUT 可选用同样条件并在成功时返回顶层 `revision`；默认关闭的服务端开关 `CINATOKEN_ADMIN_CONFIG_REQUIRE_REVISION` 不启用时，旧无条件调用仍会成功并更新版本。所有 Admin 实例设为精确 `true` 后，通用 PUT 对 `BUSINESS_TIMEZONE`、`BILLING_CURRENCY`、`ROUTE_STRATEGY`、`USER_CHARGED_COST_FACTOR_MODE`、两个 `STREAM_FIRST_EVENT_TIMEOUT_*` 键和两个 Webhook 键缺少条件即返回 428，不读写配置或审计；Tools八个catalog/active键另受下述独立完整版本合同管理，其他键维持兼容。部署必须先完成数据库迁移、发布并排空旧 Admin 实例，再启用此开关，最后开启 Web Config 入口；未排空的旧实例仍可能接受无条件写，已打开的旧 Next 配置页将收到 428，应迁往 Web。审计只存 UUID、已知配置键（旧接口写入的任意非白名单键统一记为 `[nonstandard]`）、Webhook 通道、`set`/`clear` 动作、`console`/`admin_key` 主体类型与 ID、`committed` 结果及时间；不存配置值、URL、请求体或可复原指纹。审计表只记录已提交的变更：输入拒绝、版本冲突及数据库失败的尝试不入表。部署时必须依序应用 Core 的 D1 `0069`→`0070`、MySQL `0065`→`0066`、Postgres `0074`→`0075` 迁移，再发布新 Admin；未迁移数据库上的配置写入会失败并回滚，不能降级为无审计写入。该单键审计表尚无查询API；Tools使用独立group审计及下述查询接口。

### `PUT /admin/config`

请求体：`{ "key": "string", "value": "string" }`（`key` 必填；`value` 可省略或 `null` 视为空字符串）。

- 要求 `config.write`；成功与校验/存储失败响应使用 `Cache-Control: private, no-store`。
- **`BILLING_CURRENCY`**：仅允许写入 **`USD`** 或 **`CNY`**（大写）；否则返回 `400` 与 `success: false`。
- **`ROUTE_STRATEGY`**：仅允许 **`hash_affinity`** \| **`weighted_random`** \| **`weight_priority`** \| **`weighted_round_robin`**（小写）；非法 → `400`。这是全局同层路由策略缺省，模型 `route_policy` 与 `route_pools.strategy` 可覆盖。详见 [route-strategies.md](../reference/route-strategies.md)。Proxy 进程内缓存约 **30s**。
- **`BUSINESS_TIMEZONE`**：新写入只接受有效 IANA 区域/`Etc/...` 标识或显式 `UTC`，首尾空格会去除并存为规范输入；空值、非法名称、控制字符、超 128 字符、`EST` 等旧别名及 `+01:00` 等偏移新写入均返回 `400`，不写库。旧库中仍可读取有效的 Intl 别名/偏移；专用 GET 用 `source: "legacy"` 标示，而不是悄然改写。用 `UTC` 重置，不用空值重置。

Agent Tools 的八个 catalog/active 键仍接受受控通用 PUT 兼容；新 Web 及旧 Next 工具页均使用下述专用原子接口。六个旧 Search/Fetch provider/apiKey/cost 键拒绝新写：

| 工具 | Catalog 键 | Active 键 | Provider 白名单 |
|------|------------|-----------|-----------------|
| Web Search | `WEB_SEARCH_CATALOG` | `WEB_SEARCH_ACTIVE` | `bocha`、`tavily`、`cleversee`、`tencent_wsa`、`deepseek` |
| Web Fetch | `WEB_FETCH_CATALOG` | `WEB_FETCH_ACTIVE` | `firecrawl`、`tavily`、`jina`、`deepseek` |
| Web Deep Search | `WEB_DEEP_SEARCH_CATALOG` | `WEB_DEEP_SEARCH_ACTIVE` | `firecrawl`、`jina`、`deepseek` |
| AI Detection | `AI_DETECTION_CATALOG` | `AI_DETECTION_ACTIVE` | 当前 `tencent_tms`（多 provider 架构，可扩展） |

Catalog JSON 以 Provider id 为键。新价格使用版本化 `pricing`，例如：

```json
{
  "bocha": {
    "apiKey": "your-provider-key",
    "pricing": { "v": 2, "standard": 0.01, "chargedFactor": 1.2, "meteredFactor": 0.8 }
  }
}
```

标准价与倍率均须为非负有限数字，两个倍率省略时为 1；标准价先舍入到六位小数，再计算收费和成本并分别舍入到六位小数，倍率保留精度。REST 与 MCP 共用 `resolveToolFactorPrices` 和价格编辑器。用户倍率为 0 时用户免费，仍记录供应成本。三个联网工具成功时计 1 request；AI Detection 的凭证字段并集 + `pricing` + 可选 `billingUnitChars` 保持原字符计费：按输入字符数向上取整为计费单元，单元数乘三个已解析单价。

旧 `{ apiKey, metered, standard, charged, cost }` 继续按独立单价结算；仅有旧 `cost` 时三列相等。序列化时，新价格只保存 `pricing` 定义，旧价格保持旧格式。界面仅在用户修改价格后写入新格式，连接凭证修改不会转换旧价格。标准价为 0 但收费或成本非零等无法无损转换的情况，会提示重新填写价格；保存前仍执行原价格。新格式的无效版本、倍率或混合独立单价会拒绝写入，读到无效新格式也不会回退为默认或免费价格。

价格继续使用现有 `system_config` JSON，不新增数据库字段、不迁移数据。用户鉴权与限流保持生效；REST 的余额预检在解析实际价格后执行，免费服务与 `GET /v1/tools/pricing` 可在零余额下使用。日志的 `tool_pricing` 保存当次倍率快照，公开价格接口继续返回计算后的三个单价及 `cost = charged`。设置 Active 前必须配齐该引擎所需凭证（未实现引擎不可 Active）。每种工具同时只启用一个 Active Provider。

### Tools 完整版本、原子保存与审计

以下端点外部调用均加 `/api` 前缀。family 为 `web-search`、`web-fetch`、`web-deep-search`、`ai-detection`，provider 须属于上表对应白名单；不接受未知或重复 query、字段或非规范版本/cursor。

| 请求 | 输入与权限 | 结果 |
| --- | --- | --- |
| `GET /admin/config/tools/overview` | `config.read`，无 query | 同一 15-key 快照的四族安全状态、币种及能力；无 catalog/凭据原文 |
| `GET /admin/config/tools/:family/providers/:provider/detail` | `config.read`，无 query | 确切引擎的安全编辑投影及完整 family `version` |
| `POST /admin/config/tools/:family/providers/:provider/save` | `config.write`；版本、原因、价格、全部必需 credential 操作 | `{outcome,auditId,detail}`；applied 或 unchanged |
| `POST /admin/config/tools/:family/providers/:provider/reveal` | `config.read`+`config.secrets.read`；版本、原因及单一 field | 审计提交后返回该字段 value、auditId、version、`expiresInSeconds:60` |
| `GET /admin/config/tools/:family/audit` | `config.read`；limit 默认 20、1–100，before 为本族 cursor | `{entries,next_cursor}`；metadata-only，六位时间与 ID keyset |

Console save/reveal 始终要求 `X-CinaToken-Expected-Console-Subject`，内容为当前 verified 原始 subject 的规范 `encodeURIComponent`；该前置只核对当前身份，不能指定审计 actor。具名 Bearer 按现有配置权限授权，不能携 Console header 或绕过相同 groupCAS。所有成功、认证/权限和输入/存储失败均为 `Cache-Control: private, no-store`。

保存 body 为 `{operation,expected_version,reason,prices,credentials,accept_loss_pricing,settings?}`。operation 仅 `save` 或 `save_activate`，prices 包含 metered/standard/charged，有限非负、最多六位小数；charged 低于 metered 须显式 `accept_loss_pricing:true`。credentials 中每个必需 field 必须明确 `{op:"keep"}`、`{op:"set",value:"..."}` 或 `{op:"clear"}`；keep 由服务器合并，不需 reveal，掩码和空串不可作为替换值。腾讯 AI 需要 secretId/secretKey，可显式处理 region/bizType 与正 safe-integer billingUnitChars；AI 按 trim 后的 Unicode code point 数、每 unit 向上取整且至少一 unit 计费。

Tools 的 reason 必填，trim 后最多600个 Unicode code point；秘密替换值最多4096个 UTF-16 code unit。Console header 解码后的 subject 上限仍为600个 UTF-16 code unit，不与 reason 的码点上限混用，也不扩大 CinaAuth 发行方的标准 subject 承诺。候选中的新凭据及全部已知旧凭据字面量在安全投影中清除后，才截取审计原因；安全历史不保存凭据散列。

普通 save 保持有效引擎及当前 ready 状态；首次使默认引擎 ready 或改变 effective 选择须 save_activate，否则 409 `tools_activation_required`。save_activate 在一次事务保存 catalog/active 并写一条安全 group 审计；不再调用两个 PUT。有效 legacy 转 catalog 在服务器同事务搬运完整旧 entry 并保留原 effective 选择。无效/未知 catalog 保留原文并阻止普通覆盖；币种缺行按 USD 但保留 null revision 依赖，非法/unsupported 币种禁止工具写入，不做 FX。

expected_version 是有界 opaque 完整 family 版本向量，包含 legacy 及币种依赖，不含值或秘密指纹。缺版本 428，陈旧向量 409 且零部分写；全部同值返回 unchanged、auditId=null，reveal 仍须提交强制审计。审计只包含可信 actor、脱敏原因、固定字段名、credential 操作/configured 布尔、前后选择与版本，不包含 catalog/凭据值。原文只在临时组件内存，60 秒、关闭、隐藏、离开或身份/能力失效时清理，不进 Query 缓存、日志或持久存储。

通用 PUT 的八个 Tools 键进入同一 group 事务与安全审计；默认 false 的 `CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION` 兼容缺条件时仅做一次 fresh 内部 CAS，不能保护旧客户端陈旧草稿或使旧两次 PUT 原子。精确 true 时必须提供完整 `tools_version`、reason 及 Console 主体前置；已提供的条件始终校验。部署先应用 D1 0076/MySQL 0074/PG 0081、核 mutex 种子及最小权限，升级所有读写客户端并排空旧 writer，再启用保护及独立 Web 入口。回滚保留新表、mutex 与兼容读者。

网络取消/超时或无效写响应仍为未知结果，不能自动重放。Web 与旧 Next 保留仅含隔离 generation/family/provider/operation 的持久 marker；人工恢复须 fresh 同主体详情/审计/能力、明确 ack 及再次验证，最后 generation CAS 解锁并丢弃旧草稿。configured=true 或当前审计页为空均不能证明原候选已保存，未知 reveal 不重发原文。

### 运维验收：Agent Tools（Playground / Simulator）

Admin 内闭环：**Tools Config → Playground（引擎）→ Simulator（Proxy）→ Request Logs**。

1. **Config**：Admin → Tools → Configuration，在“连接设置”维护凭证，在“计费规则”维护**标准价、用户倍率、供应倍率**并保存；Active 指向已配齐凭证的引擎（AI Detection 第一版为 `tencent_tms`）。修改价格并保存后 catalog JSON 应包含 `pricing: { v: 2, standard, chargedFactor, meteredFactor }`。
2. **Playground Tools**（不计费、不写 logs）：Admin → Playground → **Tools** 模式，或 Config 行内 **Test in Playground**（`?mode=tools&tool=…&provider=…`）。选工具 + **任意 catalog 引擎**（不限 Active）→ Send → 直连上游引擎，确认密钥与响应形态。
3. **Simulator Tools**（真实 Proxy）：Admin → Simulator → Kind=**Tools** → 选工具与用户 API Key → Send 打到 `{proxy}/v1/tools/{id}` → 核对响应 `cost`（= charged）与预算；**Open Request Logs**（已按该工具与所用 API Key 筛选）核对三列不同（若配置了不同单价）、`budget_spent` 仅增 charged、失败请求三列 0、`pricing_audit` v4 `fixed_tool_cost`。
4. **边界**：Playground Tools **不经** Proxy、**不扣**用户预算、**不写** `api_key_request_logs`；Simulator Tools **走** Proxy 全链路。二者共用 **`@octafuse/tool-engines`** 引擎客户端（Admin 不得再依赖 `packages/proxy`）。LLM / Image / Audio 的 Routes 模式行为不变。
5. **curl**（可选，用户 API Key，等价 Simulator）：

```bash
curl -sS "$GATEWAY_URL/v1/tools/ai-detection" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"sample paragraph for AI-rate detection"}'
```

与 **Proxy 错误 Webhook** 相关的键（默认不存在于种子数据，按需 `PUT` 写入即可）：

| `key` | 说明 |
|-------|------|
| `ALERT_WEBHOOK_WECOM_URL` | 企业微信群机器人 Webhook 完整 URL；非空则在该渠道告警。清空 `value` 可关闭。 |
| `ALERT_WEBHOOK_FEISHU_URL` | 飞书自定义机器人 Webhook 完整 URL；非空则在该渠道告警。清空 `value` 可关闭。 |

### `GET /admin/business-timezone`

要求 `config.read`，只读取 `system_config.BUSINESS_TIMEZONE`，返回有效业务时区及原始配置来源；不返回完整配置列表：

```json
{ "success": true, "data": { "business_timezone": "Asia/Shanghai", "source": "configured" } }
```

`source` 为 `configured`（符合当前 IANA/UTC 写入规则）、`legacy`（旧库中有效的 Intl 别名或偏移）、`missing`（未配置或仅空格）、`invalid`（旧值无效）；后两者的 `business_timezone` 均回落 `UTC`。读取存储失败返回 500，不伪装成 UTC。响应使用 `Cache-Control: private, no-store`；外层认证提前返回的 401/403 也受同样缓存保护。Admin UI 登录后由 `BusinessTimezoneProvider` 调用，用于时间列展示与时间范围自定义输入。

### `GET /admin/request-logs`

全库 `api_key_request_logs` 筛选分页（与按 Key 的 `/admin/keys/:id/logs` 互补）。

新增可选 `ingress_host`：对实存 Host 快照精确匹配，保留大小写、端口和 IPv6 方括号，不按 URL/DNS 重写。首尾空白可去除，最长255字符；非字符串、控制字符、仅空白或重复同名参数在查询前返回400。省略或空字符串表示不筛选。三库计数和列表使用相同绑定条件，MySQL 显式二进制比较，不受默认大小写不敏感排序规则扩大；与 provider_id、model_id_prefix、用户/Key/工作区和时间条件按 AND 组合。列表及安全详情响应可返回 nullable/optional ingress_host，旧数据缺失不伪造主机。非空主机条件完成实际仓储读取后，响应追加 `applied_filters: { ingress_host: "规范化后的条件" }`；省略或清空主机时不新增 `ingress_host` 成员；主机、模型前缀和供应商集合三者都未筛选时才省略整个 `applied_filters` 对象，保持旧响应形状。Web 仅显式应用草稿，保留其他筛选；无效 URL 不读日志，带筛选时必须同时收到精确匹配的服务端确认和逐行主机匹配，否则拒绝旧结果。这也覆盖第一页碰巧全部匹配但 total 含其他主机、以及空页无法逐行核对的旧服务端。筛选、分页和显式刷新关闭旧展开；恢复曾用条件时不自动重开详情。

`model_id_prefix` 现在同样要求完整范围确认：规范化时只去首尾空白，最长600，拒绝控制字符、非法UTF-16、非字符串、纯空白和重复query；空字符串或省略不筛选。D1 使用 SUBSTR/BINARY，MySQL 使用二进制 LEFT/字节长度，PostgreSQL 使用字符 LEFT 与 C 排序规则，count/list 均双绑定相同前缀，保持大小写、Unicode、`%`、`_` 和反斜杠的字面语义。仓储读取成功后 `applied_filters` 按实际非空条件包含 `ingress_host`、`model_id_prefix` 和/或 `provider_ids`；三者都未筛选时不返回该对象。Web 请求日志及按Server筛选的MCP调用记录必须有精确前缀确认，且仍核对每条记录；50条可见行碰巧匹配或空页缺确认均不能报告筛选成功。确认只说明已应用该条件，不保证分页和计数同一事务快照。 Web无效Host、模型前缀或供应商集合URL保留其他筛选并停用日志读取；字段显示对应错误，可直接修正或清除。多项同时非法时分别保留错误，修正一项不会误清其他项。

`provider_ids` 是逗号分隔的供应商 ID 集合。共享规范化规则依次去除每项首尾空白、去除空项、去重，再按 JavaScript 字符串顺序排序；保留 ID 的大小写和字面内容，不查询当前供应商目录。规范化后至少1个、最多10个不同 ID，每项最长600；解码后的原始参数字符串最长6009，包含分隔逗号及空白，长度均按 UTF-16 代码单元计。省略或精确空字符串表示不筛选；非空但只有空白/逗号、超长、超过10个不同 ID、控制字符、非法UTF-16或非字符串输入均在仓储读取前返回400。重复同名 `provider_ids` query 参数也返回400，即使其中一个为空；多个 ID 应放在同一个参数内。

集合内按任一成员匹配，集合与单个 `provider_id` 以及其他条件按 AND 组合：同时传 `provider_id=p1&provider_ids=p1,p2` 只匹配 p1，传 `provider_id=p3&provider_ids=p1,p2` 得到空结果，不覆盖或移除原条件。仓储读取成功后，响应以字符串数组回显规范化集合，例如 `applied_filters: { provider_ids: ["octafuse-mcp", "octafuse-tools"] }`；与主机/前缀同时筛选时在同一对象中分别确认。Web 请求日志和工具调用“全部来源”必须收到与请求集合逐项完全一致的有序、无重复数组，即使 `data` 为空也必须确认；缺失、乱序、错误类型、少项或多项均拒绝，同时仍核对每行供应商属于集合及单个供应商交集。未请求集合时不要求新增 `provider_ids` 回显，保留旧的无集合请求/响应兼容；使用集合的旧后端若缺少确认则不能报告筛选成功。确认不保证 count/list 属于同一事务快照。

Web 工具调用 `source=all` 使用固定集合 `octafuse-mcp,octafuse-tools` 的一次服务端分页查询，进入请求日志保留该集合、日期和状态。来源切换清除不适用的工具/Server 条件并回到第一页。普通日志集合输入仅在显式应用后更新查询；清除集合只移除该条件，不清除其他范围。

列表可包含 `charged_wallet_cost`（数据库decimal字符串或有限数值）。Web 保留缺失/null为未知；永久池分量非负且不超过总收费、金额可按安全微单位表示时，才计算周期分量 `charged_cost - charged_wallet_cost`。零、极小非零值和分量都按至多6位小数展示，过小/非微单位/不一致金额不伪装为零或负周期分量。请求日志与工具/MCP记录的列表和详情使用相同规则，币种必须来自已确认配置；这表示本次请求记录的收费分配，不代表账户余额或预算扣款成功确认。

| 查询参数 | 说明 |
|----------|------|
| `page` | 默认 `1` |
| `page_size` | 默认 `20`，最大 `100` |
| `api_key_id` | 精确匹配 |
| `user_email` | 精确匹配 |
| `model_id` | 精确匹配 |
| `model_ids` | 逗号分隔，最多 30 个，匹配其中任一 `model_id` |
| `model_vendors` | 模型厂商 key（`models.vendor`，如 `openai`、`anthropic`），逗号分隔，最多 100 个。匹配当前模型目录里属于这些厂商的模型；与 `model_ids` 同时传时取并集 |
| `provider_id` | 精确匹配 |
| `ingress_host` | 实存入口 Host 精确匹配，大小写与端口保留；最长255 |
| `provider_ids` | 逗号分隔，trim/去空/去重/排序后最多10个；每项最长600，原串最长6009；与单个 `provider_id` 按交集匹配，成功响应回显集合 |
| `model_id_prefix` | 大小写敏感的 `model_id` 字面前缀，最长600；`%`、`_` 和 `\` 为普通字符 |
| `route_group` | 精确匹配 |
| `status` | 精确匹配 |
| `start_date` / `end_date` | 过滤 `created_at`（UTC，格式：`YYYY-MM-DD HH:mm:ss`） |

`kinds` 的取值：

| 取值 | 匹配的日志 |
|------|------------|
| `model` | 全部模型请求（`provider_id` 不是 `octafuse-tools` / `octafuse-mcp`，含没有 `provider_id` 的日志） |
| `model:llm`、`model:image`、`model:asr`、`model:tts`、`model:embedding` | 某一类模型请求。类型不落库，按顺序推断：`billing_kind` → `request_operation` / `upstream_operation` → 模型目录里该模型的类型 → `audio_tokens` 计费算 `asr` → 其余算 `llm`。与管理后台请求日志列表的类型标签同一套规则 |
| `tool` | 全部 REST 工具调用（`provider_id=octafuse-tools`） |
| `tool:<id>` | 某个 REST 工具，即日志的 `model_id`，如 `tool:web-search` |
| `mcp` | 全部 MCP 工具调用（`provider_id=octafuse-mcp`） |
| `mcp:<slug>` | 某个 MCP 服务（`model_id` 以 `mcp:<slug>/` 开头）。只看其中一个工具时再加 `model_id=mcp:<slug>/<tool>` |

例如 `kinds=model:image,tool:web-search,mcp:docs` 返回图像模型请求、Web Search 调用与 `docs` 服务的 MCP 调用。

`model_vendors` 与 `provider_kinds` 按当前目录解析：已删除的模型不属于任何厂商，已删除的供应商不属于任何类型，它们的历史日志只能用 `model_ids` / `provider_ids` 查。模型、供应商、类型三组条件之间是 AND，例如 `model_vendors=openai&provider_kinds=__custom__` 返回自定义供应商承接的 OpenAI 模型请求。

D1 单条语句最多 100 个绑定参数：`kinds`、`model_ids`、`model_vendors`、`provider_ids`、`provider_kinds` 的取值个数，加上按模型类型筛选时模型目录里的非 LLM 模型数，合计不能超过 85，超出返回 400。Postgres / MySQL 没有这个限制。

`data` 每条日志即 **`api_key_request_logs` 行**（读接口不 JOIN `models` / `providers`；展示名依赖写入时快照列）。**`model_name`** / **`provider_name`** 为请求当时展示名快照；**`provider_model_name`** 为上游模型 id；**`provider_key_id`** / **`provider_key_label`** / **`provider_key_fingerprint`** 为最终选用 Provider 快照（现为 **provider id / name / api_key 指纹**；0015 前旧行可能仍为历史 key 池 id）。**`request_body`** 为客户端入口侧脱敏 JSON（无提示词正文；长度有上限）。**`upstream_request_body`** 为合并路由 `custom_params` 后、与发往供应商的 wire 体结构对齐的脱敏快照（规则同 `request_body`；迁移前或旧行可能为 `null`）。**`request_protocol`**（入口）与 **`upstream_protocol`**（所选路由实际转发协议）见上文注。升级前列可能为 `null`。

### `GET /admin/request-logs/:id`

该接口供显式详情与收益候选核对使用，要求 `logs.read`。它不从列表第一页推测结果，不支持未知或重复 query；非法 ID 返回 `400`、不存在返回 `404`。返回 `{ success:true, data:{...} }` 的安全白名单，只包含已核验的身份/模型/协议、Token、金额、状态和时间字段；不返回请求正文、上游正文、原始 usage/计价审计、headers、凭据指纹或错误原文。内外层全部响应（含认证、setup/限流及错误早退）均为 `private,no-store`。旧列表接口的查询和授权保持原合同，不能把 `api_key_id` 当作 request ID。

安全详情新增可选 nullable `charged_wallet_cost`；三库有界SQL显式选择该金额字段，服务将合法SQL decimal转成JSON number。省略和null保持各自原义，非法数字返回失败，不加载或放开原始计价审计/正文。独立详情沿当前已核验币种展示收费分配。

### Shared Keys 治理与收益审核

Shared Keys 读取要求 `providers.read`，PATCH/DELETE 要求 `providers.write`；原 Console Session 和具名 Bearer 均保留业务授权。收益审核 POST（包含 dry-run）独立要求 `users.write`，用户详情与请求日志链接分别要求 `users.read`、`logs.read`。所有 Shared Keys/收益响应与外层早退为 `private,no-store`。

| 接口（前缀 `/admin`） | 合同 |
| --- | --- |
| `GET /shared-keys` | 旧 `data` 数组，有界最多 100 条；顶层 `total` 与 `truncated` 明确是否还有数据。旧 status/channelType 筛选保留；完整页面使用 overview 分页。 |
| `GET /shared-keys/overview` | 仅允许 `page`、`page_size`、`status`、`channelType`、`seller_user_id`、`search`。默认 1/20，page 最大 1,000,000、page_size 最大 100；固定 priority DESC、weight DESC、id ASC。未知/重复或非法参数在读库前 `400`。`data` 包含 items/total/page/page_size/hasMore、当前币种参考和四项 capabilities。 |
| `GET /shared-keys/:id/detail` | 单条安全详情，不读取秘密用于展示，不触发凭据懒迁移写入；不存在 `404`。 |
| `GET /shared-keys/:id/audit` | 默认 20、最大 100；仅 page_size/cursor，游标绑定 Key ID，按 created_at/id 倒序保留微秒。返回 entries/next_cursor/page_size；Key 删除后仍能读取审计。 |
| `PATCH /shared-keys/:id` | JSON `expected_revision`、必填人工 `reason` 及至少一个 sellerPriority/weight/status。优先级为 int32，权重 1–100；status 只允许 disabled，或 disabled→paused。成功返回 id/outcome/auditId，unchanged 无成功审计。 |
| `DELETE /shared-keys/:id` | JSON expected_revision/reason，成功返回 id/deleted/auditId；有历史收益保护时拒删，不能为删除而清空经济历史。 |

安全 DTO 不 spread 仓储行：掩码恒为 `••••••••`、失败仅返回有限 `failureCode`、版本为不含原凭据的 `profile_revision`；不返回 apiKey、stored fingerprint 或原始 failureReason。四种报价单位为每百万 Token，但旧报价行没有持久化币种，故 `quoteCurrency:null`、`quoteCurrencyAvailability:legacy_unrecorded`。`currentBillingCurrency` 只作当前配置参考，`currentBillingCurrencyReferenceOnly:true`；缺失/非法配置标明 missing/invalid，不伪装 USD、不重标历史或自动换汇。当前结算实现的累计收益单独标注 `earningsCurrency:USD` 与 major 单位；statisticsBasis 区分 legacy_cached_projection 和 reviewed_credited_usage，不把缓存投影当成完整历史经济证据。

revision 绑定归属/渠道/凭据身份、治理状态/验证时间/标签/优先级/权重/四报价，排除统计量和通用 updatedAt。三库在同一事务内进行完整 profile 条件变更与 `admin_shared_key_audit` 写入；版本变化为 `409`，审计失败或新表缺失拒绝写入，不能降级。审计只保留安全治理前后值、opaque revision、服务端可信主体/来源、脱敏人工原因与时间，不保存凭据材料或报价。坏密文仍可治理停用，不能先通过普通解密 getter 隐式写入或阻断；无法安全取得材料时仅写固定脱敏原因。

原始 Console subject 上限仍为 600 字符；可信治理 actor 为 `console:cinaauth:<subject>`，因此 Console actor 上限为 617，具名 API Key actor 与人工 reason 仍为 600。服务端和 Web 审计 DTO 先按原始 actor 的 kind/长度校验，再脱敏显示；不能通过截断、哈希、脱敏或客户端主体头放宽边界。D1 追加 `0075_admin_shared_key_actor_bounds.sql`、MySQL 追加 `0071_admin_shared_key_actor_bounds.sql`、Postgres 追加 `0080_admin_shared_key_actor_bounds.sql`，旧审计迁移保持原样。先完成迁移，再升级兼容长 actor 的读取端，最后升级写入端；回滚保留加宽的审计存储、历史和兼容读取端。真实 600 字符 subject 登录仍需单独核验会话与身份存储，本治理合同不代表登录链已验收。

`CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION` 默认 false，精确 true 时缺客户端 revision 返回 `428`；Console 治理请求还必须携带下面的精确主体前置，缺省为 `428 console_subject_required`。关闭保护只兼容旧无条件客户端：新服务器仍使用当前完整 profile 条件和固定 legacy 原因进行原子审计；显式提供 revision 的客户端始终需要有效人工原因。恢复仅进入 paused，不能由 Admin 直接激活。部署顺序为追加审计迁移 → 全部新 writer/客户端 → API 版本保护 → Web 入口，回滚保留审计与历史约束。

新 Web 和旧 Next 治理客户端在提交前重新读取 verified CinaAuth Console subject，并对 PATCH/DELETE 及收益发现/审核 POST 携带 `X-CinaToken-Expected-Console-Subject: encodeURIComponent(subject)`。服务端只解码一次并要求 canonical 表示，对当前已认证 principal 的 raw subject 精确比较，在任何仓储操作前拒绝失配 `403 console_subject_mismatch`；非法编码、空/过长/首尾空白/控制字符、合并重复值或 API Key principal 携此头为 `400 invalid_console_subject_precondition`。合法 Unicode、内部空格、斜杠、字面 `%HH` 保留；响应不反射 subject，actor 永远来自服务器认证，不能由此头指定。前置 GET 改善交互，真正的 Cookie 切主体约束由当前请求的服务器比较提供。未带该头的命名 Bearer 及保护关闭时的旧 Console 保持既有权限合同；收益 POST 不因版本开关要求旧客户端补头，但一旦提供就严格核验。

`POST /admin/earnings/rederive` 仅接受 since/limit/apply：since 为有效 UTC 时间，limit 1–1000、apply 0/1，未知或重复参数 `400`。仍只扫描 since 后第一页；200 和审核 409 都返回安全 candidateLogIds、range、scanComplete、reviewScope:first_page_since 及 `reviewOnly:true`、`balancesChanged:false`、`queued:false`、`evidenceRequirement:original_price_commission_owner`。apply=0 只发现候选；apply=1 在完整且零候选时 200，完整有候选为 historical_earning_evidence_required 409，不完整（即使第一页零候选）为 historical_earning_scan_incomplete 409。**没有写账、入队或补偿任务**；候选不等于漏结算。真正历史补偿需要原始 owner/报价/佣金和经济证据，不能用当前价格重放结算。

### `GET /admin/budget-audit-logs`

全库 **`user_audit_logs`** 筛选分页；左联 **`users`** 以返回用户 **`email`**（并支持按邮箱精确筛选）。路径名含 “budget” 为历史兼容，数据源已为用户级审计表。

| 查询参数 | 说明 |
|----------|------|
| `page` | 默认 `1` |
| `page_size` | 默认 `20`，最大 `100` |
| `user_id` | 精确匹配 `user_audit_logs.user_id` |
| `api_key_id` | 精确匹配 |
| `user_email` | 精确匹配（**`users.email`**，来自 JOIN） |
| `event_type` | 精确匹配（如 `usage_charge`、`period_reset`、`admin_adjust`、`key_created`、`key_revoked`、`key_deleted`、`user_created`、`user_deleted`） |
| `actor_type` | 精确匹配：`system` \| `admin` \| `service` |
| `reason_code` / `source` / `correlation_id` | 可选，精确匹配 |
| `start_date` / `end_date` | 与 **`GET /admin/request-logs`** 相同：过滤 `created_at`（`>=` / `<=`，UTC；建议格式 `YYYY-MM-DD HH:mm:ss` 或完整 ISO） |

`data` 每条为审计表列 + 来自 **`users`** 的 **`user_email`**（无关联用户时可能为 `null`）。详细语义见 [`../reference/user-audit-logs.md`](../reference/user-audit-logs.md)。

### `GET /admin/analytics/models`

| 查询参数 | 说明 |
|----------|------|
| `start_date` / `end_date` | 可选；默认约最近 7 天；开始时间最早不早于结束时间前 **180 天**（`clampAnalyticsRange`） |
| `tag` | 可选；非空时只统计带该 `model_tags.tag` 的模型 |
| `provider_id` | 可选；Provider 精确匹配 |
| `user_email` | 可选；用户邮箱精确匹配 |
| `user_id` | 可选；用户 UUID 或 `ext:` 路由（解析后过滤 `rl.user_id`） |
| `api_key_id` | 可选；API Key UUID 精确匹配 |

响应：`{ success, data: [...], tags: string[] }`（`tags` 为库内全部 distinct 标签，供筛选 UI）。

`data` 每行除用量、成本与可靠性字段外，含缓存、TTFT 与质量聚合。TTFT 来自 `api_key_request_logs.first_reasoning_token_ms` / `first_token_ms`：

| 字段 | 说明 |
|------|------|
| `cache_read_tokens` / `cache_write_tokens` | 区间内 prompt cache 读/写 token 合计 |
| `cache_hit_rate` | 缓存命中率（%）：`cache_read_tokens / input_tokens`（`input_tokens` 已含 cache 分量） |
| `avg_first_reasoning_token_ms` | 平均 TTFT (reasoning)：请求起点 → 首个 reasoning/thinking chunk |
| `avg_first_token_ms` | 平均 TTFT (content)：请求起点 → 首个 content/tool chunk |
| `avg_effective_ttft_ms` | 有效 TTFT：`AVG(COALESCE(first_reasoning_token_ms, first_token_ms))`，用户感知首响应 |
| `avg_reasoning_phase_ms` | reasoning → content 过渡阶段平均时长（两者均非空时） |
| `reasoning_ttft_rate` | 含 reasoning TTFT 的请求占比（%） |
| `content_ttft_rate` | 含 content TTFT 的请求占比（%） |
| `failover_request_count` | `upstream_failover_count > 0` 的请求数 |
| `failover_request_rate` | 上述请求数 / 总请求数 × 100，范围 0–100% |
| `stream_sample_count` | `status = success` 且 `stream_duration_ms > 0` 的样本数 |
| `stream_tokens_per_second` | 仅在上述样本上计算 `SUM(output_tokens) * 1000 / SUM(stream_duration_ms)`；无样本为 `null` |

`failover_rate` 仍是转移事件数 / 请求数 × 100，可能超过 100%。`tokens_per_second` 保留旧公式：全部输出 Token 总数 × 1000 / 全部流时长总和；分子未限定为成功且正流时长的同一组请求，因此不能作为新流式速度的替代值。新接入方应使用上表中的请求占比和流式样本字段。D1、Postgres 与 MySQL 口径一致。

活跃 Web 的模型/供应商主表、相互下钻及用户/Key模型明细接入上述四字段。兼容旧实例时，两对字段分别允许同时缺失，显示“未提供”，不从旧指标推算；只出现半对或不合法的计数/值使该响应无效。流式样本数必须为非负安全整数且不超过成功请求数，零样本对应 `null`，有样本允许速度为零。故障转移请求数不得超过请求总数，比例限0–100%；零计数要求零比例，全部请求都转移时要求100%，其他比例保留数据库精度。新主表排序将缺失/无样本值在两种方向下均置后；样本数与转移请求数紧邻指标显示，计算口径可通过键盘展开。模型/供应商 CSV 保留原28列顺序，末尾追加 `stream_tokens_per_second,stream_sample_count,failover_request_count,failover_request_rate`，未提供或 `null` 写为空，真实零值写为0。

### `GET /admin/analytics/providers`

| 查询参数 | 说明 |
|----------|------|
| `start_date` / `end_date` | 同上 |
| `tag` | 可选；非空时只统计带该 `model_tags.tag` 的模型 |
| `model_id` / `route_group` | 可选；钻取过滤 |

响应：`{ success, data: [...], tags: string[] }`；`data` 行字段与 **models** 分析相同（含上表 TTFT 与质量字段），按最终 `provider_id` 分组。未归属供应商的请求不计入；重试链中的前序失败也不拆成独立样本，因此这里的成功率不是上游逐次尝试可用率。

### `GET /admin/analytics/users`

| 查询参数 | 说明 |
|----------|------|
| `start_date` / `end_date` | 同上 |
| `email` | 可选，`user_email` **模糊**匹配（`LIKE %...%`） |

`data` 另含 `success_count`（`status = success` 的请求数）。用户按日志中的 `user_email` 聚合；`budget_*` 与 `wallet_granted` / `wallet_spent` 是关联用户当前值的各列最大值，不是所选区间的历史余额，也不保证来自唯一账号。未关联的永久额度列保留 `null`，不伪造 0。

新增兼容字段 `user_id: string | null`：仅当该邮箱组在当前区间内的**每条日志**都关联同一现存用户时返回其 ID；共享邮箱、多账号或任意未关联日志均返回 `null`，不按邮箱反查或任意选一个账号。Web 展示原始永久额度累计值，仅在有这一唯一 ID 且两列完整时计算有符号余额，保留六位微额；旧响应缺字段显示不可用。CSV 保留原16列并追加 user_id、wallet_granted、wallet_spent、wallet_balance。

### `GET /admin/analytics/keys`

按用户下 **API Key** 聚合 `api_key_request_logs`（含当前 0 用量的 Key）。删除后 `api_key_id` 被置空的历史日志归入 `api_key_id = null` 行。`spend` 以 `charged_cost` 为准，**不是** `GET /admin/keys/:id` 上的用户级 `spend`。

| 查询参数 | 说明 |
|----------|------|
| `start_date` / `end_date` | 同上 |
| `user_id` | **必填**；用户 UUID 或 `ext:` 路由 |

`data` 每行：`api_key_id`、`key_name`、`request_count`、`input_tokens`、`output_tokens`、`charged_cost`、`metered_cost`、`standard_cost`、`distinct_models`、`last_active_at`、`success_count`、`error_count`、`success_rate`。

Web 用户分析可显式展开已唯一确认账号的 Key 用量，再展开指定 Key 的模型/路由分组；后者以 `user_id` **且** `api_key_id` 查询 models 分析，日志链接保留二者及所选 UTC 范围。该范围覆盖账号在区间内的所有历史日志邮箱，区别于原邮箱模型展开；未使用 Key 保留0，null历史桶无单 Key 链接，取消等其他状态不计入 error_count。邮箱/区间/目标切换取消旧读取，权限拒绝清除新增私有视图且不自动重试；显示配置或 logs.read 不可用不扩大 analytics.read 权限。

### `GET /admin/analytics/reliability`

要求 `analytics.read`；近期错误只展示事件摘要，不暴露完整请求日志。成功和认证/权限错误响应均为 `Cache-Control: private, no-store`。

| 查询参数 | 说明 |
|----------|------|
| `start_date` / `end_date` | 同上 |

响应 `data`：`providers`（按 `provider_id`）、`modelProviders`（按 `model_id` + `provider_id`）、`recentErrors`。`recentErrors` 每项仅含 `id`、`model_id`、`provider_id`、`provider_name`、`status`、`created_at`；完整错误详情需走独立日志接口及 `logs.read` 权限。

## Preset 治理

Preset 管理端使用独立权限 `presets.read` / `presets.write`：

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /admin/presets/summaries` | `presets.read` | 安全列表投影：`{success:true,data:AdminPresetSummary[],count:number}`，含活动与归档实体 |
| `GET /admin/presets/:id/version-summaries` | `presets.read` | 安全版本投影：`{success:true,data:{presetId,versions:AdminPresetVersionSummary[],total}}`，按版本号倒序 |
| `PATCH /admin/presets/:id?view=summary` | `presets.write` | 只修改 `name`、`description`、`private | public` 可见性或 `active | archived` 状态；成功返回安全单条摘要 |
| `POST /admin/presets/:id/designate?view=summary` | `presets.write` | 请求 `{version}`，仅把活动实体指定到已存在版本；成功返回安全单条摘要 |

`AdminPresetSummary` 恰有 `id`、`workspaceId`、`ownerUserId`、`slug`、`name`、`description`、`visibility`、`status`、`designatedVersion`、`latestVersion`；`AdminPresetVersionSummary` 恰有 `id`、`version`、`createdAt`、`model: string | null`。`model` 只从有效且有界的版本配置中提取；损坏、缺失或不安全时为 `null`。上述安全投影及其错误响应不包含 `systemPrompt`、完整 `config` 或凭据，错误消息为通用文案；子路由使用 `Cache-Control: private, no-store`，外层认证的 401/403 也设为私有不缓存。`visibility: "public"` 仅表示**工作区内公开**，相同 slug 可属于不同工作区。

原有 `GET /admin/presets`、`GET /admin/presets/:id/versions` 与不带 `view=summary` 的 PATCH/POST 保持兼容，但旧 DTO 含 `systemPrompt`、完整 `config` 等内容，不能作为新 Web 管理页的普通缓存数据。PATCH 只读取允许的 metadata 字段，未知字段会被忽略；即使返回 200，也不代表 owner、workspace、slug、提示词或配置被修改。写入已提交但随后摘要重读失败时返回通用 500，客户端应按未知结果重新读取权威列表/版本，不能自动重放写请求。管理员不能借此创建预设、增加或改写历史版本；新版本必须由所有者通过用户 API 创建。控制台页面为 `/admin/presets`。

## Guardrail 与数据策略治理

Guardrail 使用独立权限 `guardrails.read` / `guardrails.write`：

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /admin/guardrails/summaries` | `guardrails.read` | 安全列表投影：`{success:true,data:AdminGuardrailSummary[],count:number,canWrite:boolean}`；`canWrite` 由服务端按当前 principal 的 `guardrails.write` 权限计算，Web 管理页据此隐藏写操作，写接口仍独立鉴权 |
| `GET /admin/guardrails`、`GET /admin/guardrails/:id/versions` | `guardrails.read` | 查看全部策略及不可变版本 |
| `GET /admin/guardrails/effective?workspace_id=...&user_id=...&api_key_id=...` | `guardrails.read` | 在复验 Workspace 成员及可选 active Key 归属后，预览有效策略、当前隐私/Endpoint subject 证据、静态可调用性、operation/output capacity、实际计费价格和有界的近 5 分钟性能；请求参数门禁与 process/isolate-local circuit 仍只在真实分发时判定，响应不暴露内部 ID、私有上游模型名、凭据或 fingerprint |
| `GET /admin/guardrails/:id/assignments` | `guardrails.read` | 查看用户/API Key 绑定 |
| `PUT /admin/guardrails/:id/assignments` | `guardrails.write` | 管理员下发强制绑定；普通用户不能覆盖或解绑 |
| `DELETE /admin/guardrails/assignments/:scopeType/:scopeId` | `guardrails.write` | 解除 scope 上的绑定 |
| `PATCH /admin/guardrails/:id`、`POST /admin/guardrails/:id/designate` | `guardrails.write` | 治理元数据、归档状态与指定版本 |

路由数据策略复用 `routes.read` / `routes.write`，控制台页面为 `/admin/data-policies`：

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /admin/data-policies` | `routes.read` | 每个 concrete route target 的 retention/training/ZDR 状态、subject 是否仍匹配及失效原因；未配置项返回保守默认值 |
| `PUT /admin/data-policies/:routeTargetId` | `routes.write` | 对当前 Route + Provider trust subject 计算 SHA-256 绑定，写入核验状态、公开 HTTPS 证据与有效期，并追加审计快照 |
| `GET /admin/data-policies/:routeTargetId/audit` | `routes.read` | 读取追加式变更历史 |

上述通过认证后由策略路由生成的列表、审计与写入成功响应使用 `Cache-Control: private, no-store`。`PUT` 返回的是刚写入的策略字段，关联模型/供应商展示字段并非权威快照；管理 UI 应重新读取列表和该目标的审计记录后再确认状态。

`verified` 必须有无凭据的 HTTPS 证据 URL 和未来有效期。核验 subject 覆盖 Provider ID、当前协议 endpoint、上游账号凭据的不可逆摘要、共享渠道类型、上游模型、协议/operation、adapter 与 `custom_params`；数据库不保存原始 subject 或新凭据。运行时重新计算并进行精确匹配，还要求 `retention_days = 0`、`training_allowed = false`、`zdr_supported = true` 才将该 route 视为 ZDR。任何 subject 变更、缺失 fingerprint、`unknown`、过期或证据缺失均 fail closed；管理端的 Route/Provider 写接口会把受影响断言置为 `unknown` 并追加失效审计。共享渠道会在选路后注入不同用户账号，当前没有逐 shared key 的数据策略证据，因此 `provider.zdr=true` 与 `data_collection=deny` 都会排除所有 `shared_channel_type` 路由，即使 route 记录本身为 `verified`。

## 提现与 NFT 铸造管理

此域读取全局 Portal 账本，权限为 `users.read` / `users.write`，不使用 Gateway 工作区或计费币种。内部 Hono 路径见下表；浏览器公开路径增加 `/api` 前缀。所有成功、验证失败、认证/授权早退及异常响应为 `Cache-Control: private, no-store`。

| 方法与内部路径 | 权限 | 合同 |
| --- | --- | --- |
| `GET /admin/withdrawals?status=...` | `users.read` | 完整合法行 `{success:true,data:WithdrawalRow[],total,meta}`；status 可省略或为 requested/processing/submitted/confirmed/failed |
| `GET /admin/nft-mints?status=...` | `users.read` | 完整合法行 `{success:true,data:NftMintRow[],total,meta}`；status 可省略或为 pending/processing/submitted/confirmed/failed |
| `POST /admin/withdrawals/process?limit=5` | `users.write` | 最多投递 1–20 个 requested/submitted 任务；默认 5，无请求体 |
| `POST /admin/nft-mints/process?limit=5` | `users.write` | 最多投递 1–20 个 pending 任务；默认 5，无请求体 |
| `POST /admin/withdrawals/:id/reject` | `users.write` | JSON 仅含 reason；调用独立原子拒绝仓储，只有安全未 claim 的 requested 行可退款 |

列表仅返回白名单字段，不包含签名材料、原始交易或 RPC 配置。提现保留 id/userId/amount/fee/netAmount/currency/walletAddress/status/tokenAmount/txHash/chainId/failureReason/createdAt/updatedAt/confirmedAt；NFT 保留 id/userId/badgeTokenId/tierName/walletAddress/status/txHash/chainId/valueSnapshot/failureReason/createdAt/confirmedAt。amountUnit 为 major；提现 currency 来源为 stored_row，NFT 快照来源为 seller_contribution_ledger，币种 USD。tokenAmount、txHash、chainId 与可空时间的 null 不被替换为 0 或虚构值。存储数据非法、重复 ID 或返回不匹配 status 的行时返回 502，不静默丢弃行。`total` 是本次完整列表行数；当前 Web 每页 20 条仅为客户端视图，并非服务器分页。

metadata 声明 scope=global_portal_ledger、两种币种来源、queueConfigured 和 processEligibleStatuses；提现另含 rejectEligibleStatus=requested。未知或重复 query 参数拒绝，limit 仅接受规范十进制 1–20。process 成功为 `{success:true,data:{queued:n},meta:{result:"queued",chainConfirmation:false}}`，仅证明队列调用返回；空批次不调用 sendBatch，队列未配置为 503。此响应不证明交易广播、确认、NFT 铸造或余额结算。失败或无法判断提交结果时不得自动重发。

新 Web 与旧 Next 共享 Screen 的每次写操作均先 fresh `/api/auth/check`，确认仍为同一 verified Console subject，然后发送 `X-CinaToken-Expected-Console-Subject`（原始可信 subject 的规范 encodeURIComponent）。服务端对任何提供的 header 都验证；不提供的旧 Console/具名 Bearer 保留原授权兼容，未获得同主体保护。header 不选择 actor 或提升权限，Bearer 权限仍逐操作校验。

拒绝要求非空、最多 500 Unicode 码点、不含控制/格式字符的 reason，正文最大实际 4096 UTF-8 bytes；重复 JSON 成员（含转义别名）、额外字段、非法 UTF-8/ID 均拒绝。仅当当前行仍 requested、tx_hash 为 NULL 且不存在持久签名 outbox 时，以一次原子状态/余额提交拒绝（D1/PG 同事务 trigger 追加 journal；MySQL 当前模型无此 journal 表，不能据此称三库 journal 已验）；processing、submitted 或存在 outbox 返回 409 `withdrawal_rejection_conflict`，缺失为 404。只有提交成功并匹配准确 ID 才返回 `{data:{withdrawalId,status:"failed",result:"rejected_and_refunded"}}`。宽 `refundWithdrawal` 保留给链上 revert 等既有调用；未知提交结果不包装为成功。

D1 每次拒绝检查实际 sqlite_master refund trigger 的完整 SQL SHA/字节数及严格 schema 查询回执，并在同一 CAS 语句绑定已验证定义；缺失0077、定义被替换/篡改或适配回执不可信时拒绝执行，避免新 API 在旧余额守卫上误报成功。这是当前退款方法的运行时前置，不代表完整原生 schema 已验。

部署此写入前必须按正式迁移链应用并验收 D1 `0077_withdrawal_balance_update_guards.sql` 与 MySQL `0075_chain_job_transactions.sql`，升级并排空旧 Admin writer，验证真实数据库 trigger、权限、历史余额/journal 及链 worker 竞争。MySQL outbox DDL 仅使拒绝谓词可执行，不意味着 Chain Worker 已支持 MySQL。资产回滚保留账本修复和兼容 reader，不反向改财务状态。当前本地 SQLite/PGlite、SQL 事务合同及 fake-repo/Queue 测试不能替代原生三库或真实链验收；两个 Web 入口默认关闭。


### Data Policies 条件保存与共享页面合同（NEXT-39）

列表增加 current_subject_fingerprint（当前 Route/Provider 信任主体 SHA-256 或 null）和 current_policy_fingerprint（实际策略完整已知字段的 SHA-256，null 表示尚无策略）。它们是保存前置条件，不含上游凭据或原始信任 JSON；列表同时返回 canWrite。旧服务器未提供这些字段时，Web保留安全读取并禁止编辑。

PUT /api/admin/data-policies/:routeTargetId 支持成对的 expected_subject_fingerprint 和 expected_policy_fingerprint。凡提供即严格校验；服务器先核客户端所见hash，再用权威原始Route、Provider和完整策略read-set在D1 batch或PG/MySQL事务提交时原子比较并追加审计。陈旧条件返回409 route_data_policy_write_conflict；非法或仅提供一个hash返回400 invalid_data_policy_precondition。比较完整当前值，不保证变更历史；A→B→A当前值再次相同时可通过。没有客户端原始凭据read-set。

CINATOKEN_ADMIN_DATA_POLICIES_REQUIRE_PRECONDITION默认false，仅精确true拒绝未提供两个条件的PUT，返回428 data_policy_precondition_required；关闭时保持旧客户端兼容。应升级全部Admin实例和客户端、排空旧无条件写端，再启保护，最后启Web入口。新增generator和Compose变量均默认false。不存在新增DDL；原生三库并发、审计失败回滚、UTC及微秒、锁等待/ACL和双平台仍须真实验收。

Presets、Guardrails、Data Policies成功写响应新增acknowledgement，含domain、operation、id；Guardrail bind/unbind另含related_id=scope_id，SDK继续核workspace/scope/version/owner等业务字段。Presets/Guardrails指定版本operation=designate，metadata/status=update，Guardrail assignment=bind/unbind，DataPolicy PUT=update。旧无header客户端保留原授权；三域所有路径收到X-CinaToken-Expected-Console-Subject时都验证其canonical编码及当前可信Console主体，读接口亦适用；鉴权/权限/bodylimit/存储早退响应同样private,no-store。

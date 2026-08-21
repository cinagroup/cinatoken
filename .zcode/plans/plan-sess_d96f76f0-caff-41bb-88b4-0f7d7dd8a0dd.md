# cinatoken 用户账户中心 + API Key 共享售卖 + CinaBadge 铸造 — 实现计划

## 0. 现状结论（探索结果）
- admin 应用仅 `/` 首页公开，其余全部要求 CinaAuth 管理员角色；`users` 是被动计费实体，**无任何普通用户自服务页面**。
- 路由模型已有 `priority`（层间 failover 顺序）+ `weight`（层内分布）；现有 `weight_priority` 策略（`packages/proxy/src/services/route-strategies/weight-priority.ts`：weight DESC、id ASC 决胜）与需求"同 priority 层内按 weight 从高到低固定排序"语义完全一致，直接复用到 key 池。
- 上游密钥为每 provider 单密钥明文（`providers.api_key`）；历史上存在过 per-provider 密钥池（migration 0015 移除），可作先例。
- cinachain 实为 **Base Sepolia（chainId 84532）**，已部署 `CinaBadge`（ERC-1155，owner-mint，位阶徽章）与 `CinaCredit`（ERC-20，owner `mintTo`）；`scripts/mint-tier-badges.mjs`、`ingress-mint.mjs` 是成熟的服务端 viem 铸造先例。
- 已确认决策：门户= admin 应用内独立分区；NFT= 复用 CinaBadge；V1 含自动提现（链上 CINA-C，法币渠道明确不在范围）；登录= 复用现有 OIDC 客户端（零 cinaauth 改动）。

## 1. 总体架构
全部改动落在 cinatoken 单仓库（**零 cinaauth / cinachain 代码改动**）：
- **门户分区**（packages/admin）：`app/account/*` 页面 + `app/api/user/[...path]/route.ts` catch-all → 新 Hono 子应用 `createUserApp()`，独立 `user_session` httpOnly Cookie。
- **core**：新表 6 张 + `providers` 加 1 列，migration `0027`（d1/postgres/mysql 三方言）+ drizzle schema×3 同步 + 仓储实现×3。
- **proxy**：共享密钥池服务 + `failover-dispatch.ts` 注入 + 失效自动禁用 + 收益并入现有计费事务。
- **链上**：viem 服务端铸造 CinaBadge / CinaCredit（Base Sepolia）。

## 2. 数据模型（migration 0027）
1. `portal_sessions`：`token_hash` PK、`subject`(cinaauth sub)、`email`、`created_at`、`expires_at`（镜像 `admin_sessions`）。
2. `shared_keys`：`id` PK、`seller_user_id`→users、`channel_type`（CHECK in `openai|anthropic|zhipu|deepseek`）、`api_key`(明文)、`key_fingerprint`、`label`、`status`(`validating|active|paused|invalid|disabled`)、`seller_priority` INT default 0（平台/管理员调节）、`weight` INT 1-100（卖家设置）、`input_price`/`output_price`/`cache_read_price`/`cache_write_price` NUMERIC(18,6)（每 1M token 要价）、`validated_at`、`last_used_at`、`failure_reason`、`served_input_tokens`/`served_output_tokens`、`earned_total`、时间戳。UNIQUE(`seller_user_id`,`key_fingerprint`)。
3. `shared_key_earnings`（收益流水，幂等）：`request_log_id` UNIQUE→`api_key_request_logs.id`、`shared_key_id`、`seller_user_id`、token 计数列、`gross_amount`/`platform_fee`/`net_amount`、`currency`、`created_at`。
4. `user_earnings`（1:1 users）：`user_id` PK、`balance`、`locked_amount`(提现中)、`lifetime_earned`、`lifetime_withdrawn`、`contribution_value`(NFT 分档依据=累计 net)、`wallet_address`、`wallet_verified_at`、`highest_badge_tier`、`updated_at`。
5. `withdrawals`：`id`、`user_id`、`amount`/`fee`/`net_amount`、`wallet_address`、`status`(`requested|processing|submitted|confirmed|failed`)、`tx_hash`、`chain_id`、`failure_reason`、时间戳；同一用户同时仅允许一笔进行中。
6. `nft_mints`：`id`、`user_id`、`badge_token_id`、`tier_name`、`wallet_address`、`tx_hash`、`chain_id`、`status`(`pending|submitted|confirmed|failed`)、`value_snapshot`、UNIQUE(`user_id`,`badge_token_id`)、时间戳。
7. `providers` 加列 `shared_channel_type` TEXT NULL：管理员将"官方渠道 provider"标记为接受共享密钥注入（openai/anthropic/zhipu/deepseek），NULL = 不参与。

约定：沿用 `docs/CONVENTIONS.md`——三目录各一份编号 SQL、`schema.pg.ts/schema.d1.ts/schema.mysql.ts` 同步、金额 `numeric(18,6)`(d1 用 real)、仓储三套 impl。

## 3. 门户认证（零 cinaauth 改动）
- 登录/注册复用 `app/api/auth/cinaauth/{login,register}`：事务 Cookie 增加 `intent: 'portal'|'admin'`；回调 `callback/route.ts` 按 intent 分流——portal 分支**不做** `hasRequiredCinatokenRole` 校验，改调标准 `GET {issuer}/api/auth/oauth2/userinfo`（任何未封禁用户可用），取 sub/email 后：upsert `users` 行（`external_system='cinaauth'`、`external_user_id=sub`，正好复用现有租户对字段）→ 写 `portal_sessions` → 签发 `user_session` Cookie（httpOnly/secure/sameSite=strict，24h）。
- 新 `packages/admin/lib/user-auth.ts`（authenticateUserRequest，兄弟 of `lib/auth.ts`）+ `app/api/user/[...path]/route.ts`（复制 admin catch-all 派发模式，注入 USER_PRINCIPAL 到 `createUserApp()`）。
- 前端：`AuthWrapper.tsx` 旁路 `pathname.startsWith('/account')`；account 段用独立 `PortalShell`/`PortalAuthWrapper`（未登录显示门户登录卡）；首页 header 加"用户中心"入口。
- 已知限制（写入文档）：门户会话不做实时角色/封禁复查（现有 bridge 仅管理员），依赖 TTL；P2 可在 cinaauth 增加无角色 bridge。

## 4. 共享 Key 池与路由（proxy）
- **渠道白名单**：新 `packages/core/src/shared-channels.ts` 常量 `openai/anthropic/zhipu/deepseek`，各绑官方 endpoint 模板（取自 `provider-import-presets.json` 的 DeepSeek/Zhipu GLM 现成 URL）；`system_config.SHARED_KEY_ENABLED_CHANNELS` 可收紧。
- **选择算法（核心需求）**：新 `packages/proxy/src/services/shared-key-pool.ts`：
  `候选 = shared_keys WHERE channel_type=provider.shared_channel_type AND status='active' AND 不在 per-key 冷却`；
  排序 `seller_priority DESC → weight DESC → id ASC`（固定确定性顺序，同 weight_priority 语义）。
- **注入点**：`failover-dispatch.ts` 尝试循环（约 288-312 行）内，若 route 的 provider 带 `shared_channel_type` → 每次尝试 clone `{...route, providerApiKey: pickedKey.api_key, providerKeyId/Label/Fingerprint: 共享密钥身份}` 再交 driver；key 依序消耗，全部不可用 → 回退 `providers.api_key` → 继续原 failover 链。`chosenRoute` 天然把 key 身份带入 `recordUsage` 计费。
- **失败处理**：上游 401/403 → 该共享 key 置 `invalid`（门户可见状态）；429/5xx → 仿 `provider-circuit-breaker` 的进程级 per-key 短冷却。
- **上架校验**：创建时后台调官方 `GET /v1/models`（四家均支持）验证，成功才置 `active`。
- **收益结算（同事务）**：`recordUsage` 识别共享 key 后：`gross = tokens/1M × 卖家单价`、`platform_fee = gross × commission`（`system_config.SHARED_KEY_COMMISSION_RATE` 默认 0.10）、`net = gross − fee`；在 `insertRequestUsageAndChargeTx` 同一事务插入 `shared_key_earnings`（UNIQUE 幂等）+ 更新 `user_earnings` + `user_audit_logs` 流水（沿用现有审计模式，金额用 `roundGatewayMoney`）。

## 5. NFT 铸造（CinaBadge）
- 一次性 setup：用 owner EOA 调 `createBadgeType` 新建 cinatoken 专点位阶（tokenId 200-203：青铜/白银/黄金/铂金，灵魂绑定；避开 billing 已占用的 100-104），脚本仿 `cinachain/scripts/setup-tier-badges.mjs`。
- 新 `packages/admin/lib/services/nft-mint-service.ts`：viem walletClient（owner key）→ `CinaBadge.mint(wallet, tokenId, 1)` → 轮询回执 → 更新 `nft_mints` 状态机。
- 触发：门户"铸造"按钮（服务端校验 `contribution_value ≥ 阈值` 且该档未铸过）；阈值 `system_config.NFT_TIER_THRESHOLDS`（默认 10/50/200/1000）。
- 钱包绑定：门户填写地址即可（奖励性质、用户无需 gas）；P2 增强 viem `verifyMessage` 签名验证。

## 6. 自动提现（链上 CINA-C，V1 自动化边界）
- 门户发起：校验 `balance ≥ amount ≥ WITHDRAWAL_MIN`、已绑钱包、无进行中提现、单日限额。
- 状态机：同事务扣 `balance` 加 `locked_amount` 插 `withdrawals(requested)` → 后台处理：viem `CinaCredit.mintTo(wallet, amount × 汇率)`（复用 ingress-mint 先例；`WITHDRAWAL_CINACREDIT_RATE` 默认 1.0）→ `submitted(tx_hash)` → 轮询回执 → `confirmed`（清 locked、计 lifetime_withdrawn）/ `failed`（金额回滚解锁）。
- **明确边界：法币渠道（银行/支付宝/微信）不在 V1**——链上 CINA-C 是自动提现唯一载体；管理员后台可监控/驳回（驳回=失败回滚）。

## 7. 门户 API 与 UI
API（`createUserApp()`，全部要求 user_session，写操作记审计）：
`GET /user/me`；`GET/POST /user/shared-keys`、`PATCH/DELETE /user/shared-keys/:id`（改价/weight/暂停；明文仅创建时回显一次）；`GET /user/earnings(+/summary)`；`GET/POST /user/withdrawals`；`GET/POST /user/wallet`；`GET /user/nft/tiers`、`POST /user/nft/mint`、`GET /user/nft/mints`；附加 `GET/POST/DELETE /user/gateway-keys`（复用 key-service 自助管理自己的网关 sk- 密钥+用量）。
UI（`app/account/*`，next-intl zh/en 起步，独立 PortalShell 无 admin 侧边栏）：
`/account` 总览（余额/贡献值/活跃 key/位阶）、`/account/keys`（上架表单：渠道下拉+密钥+单价+weight；状态与编辑）、`/account/earnings`、`/account/withdraw`（tx 链到 basescan）、`/account/nft`（位阶进度+已铸徽章+铸造）、`/account/settings`（资料跳 CinaAuth、钱包绑定）。

## 8. 管理台增强
`/gateway/shared-keys`（全部 listing：卖家/渠道/状态/累计服务量收益；调 seller_priority/weight；禁用）、`/gateway/withdrawals`（监控/驳回）、`/gateway/nft-mints`；配置页新增：佣金率、渠道白名单、位阶阈值、提现下限/汇率/日限额。对应 `/admin/shared-keys|withdrawals|nft-mints` 路由 + services。

## 9. 安全与风控
共享密钥明文存储（与 `providers.api_key` 现状一致，加密存储列为后续加固）；掩码展示（复用 `maskProviderApiKeyForAdmin`），明文不可再查看；价格边界（≤ 目录价×上限系数防倒贴、下限防倾销，system_config）；卖家自设 weight 有刷量动机 → 层间 `seller_priority` 由平台掌控；收益/提现/铸造全链路幂等 + 状态机 + 失败回滚；minter 私钥仅服务端 env secret。

## 10. 里程碑（顺序执行）
- **M1 数据层**：schema×3 + migration 0027×3 + 仓储×3 + 合同测试（仿现有 contract-test 模式）。
- **M2 门户认证**：portal_sessions + /api/user 骨架 + 登录/注册/登出 + PortalAuthWrapper/PortalShell。
- **M3 共享 Key 池**：shared-channels 常量 + 池服务 + failover 注入 + 401 禁用/冷却 + 上架校验 + 计费事务扩展（收益入账）。
- **M4 门户功能**：共享密钥管理/收益/gateway-keys 的 API + UI。
- **M5 链上**：钱包绑定 + CinaBadge 铸造服务 + CinaCredit 提现状态机 + 对应 UI + badge setup 脚本。
- **M6 管理台**：三个页面 + 配置项 + i18n（zh/en/ja/ko 补齐）。
- **M7 收尾**：单测/集成测试/smoke（scripts/smoke 增门户流程）、文档（docs/users/portal.md、operators 环境清单）、`.env.example`/docker 模板更新。

## 11. 新增环境变量
`CINACHAIN_RPC_URL`(默认 https://sepolia.base.org)、`CINACHAIN_CHAIN_ID=84532`、`CINABADGE_CONTRACT_ADDRESS=0x72cc9adb6c877d233e9843ee2d00424b9766d0cf`、`CINACREDIT_CONTRACT_ADDRESS=0x78f5aebc75b7d197b10622cccabe8429617836d7`、`CINACHAIN_MINTER_PRIVATE_KEY`；system_config 新键：`SHARED_KEY_ENABLED_CHANNELS`、`SHARED_KEY_COMMISSION_RATE`、`SHARED_KEY_PRICE_*` 边界、`NFT_TIER_THRESHOLDS`、`WITHDRAWAL_MIN/RATE/DAILY_LIMIT`。新依赖：`viem`。

## 12. 风险与边界
- Base Sepolia 为测试网，生产需按 `cinachain/contracts/DEPLOY.md` 部署主网合约并切换配置。
- CinaBadge 100-104 已被 billing 位阶占用 → 必须先用 setup 脚本创建 200+ 专属 tokenId。
- cinaauth 封禁用户在 V1 仍可登录门户（已知限制，P2 加无角色 bridge）。
- Cloudflare Workers 运行时下 viem 走 fetch http transport（可用），Node 部署无影响；测试两者覆盖。
# 用户门户（共享密钥市场 + 贡献 NFT）

普通用户的独立 Web 账户中心：`/account`。与管理台（`/gateway/*`）共用部署但会话完全隔离
（`user_session` Cookie + `portal_sessions` 表），登录走同一个 CinaAuth OIDC 客户端，但
**不要求管理员角色**（标准 `/oauth2/userinfo`，任何未封禁用户可登录）。

## 功能总览

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 总览 | `/account` | 余额、贡献值、活跃密钥、位阶进度 |
| 我的共享密钥 | `/account/keys` | 上架/暂停/删除个人官方渠道 API Key、设定 token 单价与权重 |
| 收益 | `/account/earnings` | 按请求结算的收益流水（应得 / 佣金 / 实得） |
| 提现 | `/account/withdraw` | 绑定 EVM 钱包，余额自动兑换 CINA-C（cinachain, Base Sepolia）到账 |
| 贡献 NFT | `/account/nft` | 贡献值达标后铸造 CinaBadge 灵魂绑定位阶徽章（Bronze/Silver/Gold/Platinum） |
| 设置 | `/account/settings` | 自助创建/吊销网关调用密钥（`sk-`）、资料跳转 CinaAuth |

## 共享密钥池

- **渠道白名单**：仅接受官方渠道个人 Key — `openai` / `anthropic` / `zhipu` / `deepseek`
  （`packages/core/src/shared-channels.ts`；可用 `system_config.SHARED_KEY_ENABLED_CHANNELS` 收紧）。
- **上架校验**：创建时服务端调用官方 `GET /models` 验证，2xx → `active`，401/403 → `invalid`，
  网络/5xx → 保持 `validating`（可在列表"重新校验"）。
- **路由策略（需求核心）**：调度时候选按 **seller_priority DESC → weight DESC → id ASC**
  固定确定性排序（同 `weight_priority` 语义），逐个尝试；全部不可用回退 provider 自有 key。
- **失败隔离**：用户 key 401/403 → DB 置 `invalid` 永久移出池；429/5xx → 仅该 key 复合熔断键
  短冷却，不影响 provider 自有 key 与其他卖家。
- **单价**：输入/输出每 1M token 要价（BILLING_CURRENCY 计价），受
  `SHARED_KEY_MAX_INPUT_PRICE` / `SHARED_KEY_MAX_OUTPUT_PRICE` 上限约束。

管理员在 Providers 编辑页将某 provider 的"用户共享渠道"设为对应渠道后，该 provider 的路由
即接受共享密钥池注入（可不填自有 API Key）。

## 收益与提现

- 每次请求由共享 key 服务后，`usage-tracker` 落库并结算：
  `gross = 卖家单价 × token 量`，`fee = gross × SHARED_KEY_COMMISSION_RATE`（默认 10%），
  `net` 入账 `user_earnings.balance / contribution_value / lifetime_earned`
  （幂等键 `shared_key_earnings.request_log_id`）。
- 提现（V1 自动化边界）：余额 → `CinaCredit.mintTo`（cinachain 链上 CINA-C）。
  约束：最低金额 `WITHDRAWAL_MIN_AMOUNT`、固定手续费 `WITHDRAWAL_FEE`、汇率
  `WITHDRAWAL_CINACREDIT_RATE`、单日次数 `WITHDRAWAL_DAILY_LIMIT`、同时仅一笔进行中。
  状态机 `requested → processing → submitted(tx) → confirmed / failed(退款)`；
  管理台"提现管理"可监控、驳回（仅 requested/processing）。
  **法币渠道（银行/支付宝/微信）不在 V1 范围。**
- 贡献 NFT：`contribution_value` 达到 `NFT_TIER_THRESHOLDS`（默认 10/50/200/1000 →
  CinaBadge tokenId 200-203）即可自铸；每档一次（UNIQUE(user_id, badge_token_id)）。

## 环境变量（管理/门户侧链上操作）

```
CINACHAIN_RPC_URL=https://sepolia.base.org      # 默认值
CINACHAIN_CHAIN_ID=84532                        # Base Sepolia
CINABADGE_CONTRACT_ADDRESS=0x72cc9adb6c877d233e9843ee2d00424b9766d0cf
CINACREDIT_CONTRACT_ADDRESS=0x78f5aebc75b7d197b10622cccabe8429617836d7
CINACHAIN_MINTER_PRIVATE_KEY=0x...              # owner EOA，仅服务端 secret
```

首次启用需用 owner key 创建 200-203 位阶（一次性）：
`node scripts/cinachain/setup-tier-badges.mjs`。

## 已知限制（V1）

- 门户会话不做 CinaAuth 实时封禁/角色复查（bridge 仅管理员）；依赖 24h TTL，后续可在
  cinaauth 增加无角色 bridge。
- 共享密钥明文存储（与 `providers.api_key` 现状一致）；加密存储列为后续加固。
- 卖家收益结算与请求日志插入为相邻语句而非同一事务（幂等键保证不重发；极端故障可能漏记
  单条收益，可由 request_log_id 对账补录）。
- Base Sepolia 为测试网；生产需在 cinachain 侧部署主网合约并切换上述环境变量。

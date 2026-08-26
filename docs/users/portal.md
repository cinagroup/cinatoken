# 用户门户（共享密钥市场 + 贡献 NFT）

普通用户账户中心：`/account`；管理员功能整合在同一壳层的 `/admin/*`，旧 `/gateway/*`
保留兼容。两者使用统一的 `cinatoken_session`，但权限能力由服务端生成；普通用户不获得
`admin.console`，管理员能力还需要 CinaAuth 实时角色复核。

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

## 环境变量（隔离 Chain Worker）

```
CINACHAIN_RPC_URL=https://sepolia.base.org      # 默认值
CINACHAIN_CHAIN_ID=84532                        # Base Sepolia
CINABADGE_CONTRACT_ADDRESS=0x0a32fc1302bf7765b386de5eae857c26d6c8e0ce  # 2026-08-22 合约集；消耗位阶 100-104 + 贡献位阶 105-108
CINACREDIT_CONTRACT_ADDRESS=0x22f3e0aaa4785169d2c227d37df17c168fbae85a  # CinaCreditV2（2026-08-26 部署，角色分离 + permit）
CINACHAIN_MINTER_PRIVATE_KEY=0x...              # 仅 Chain Worker secret
```

贡献位阶 105-108（Contributor Bronze/Silver/Gold/Platinum）已由 cinachain 仓库的
`setup-contributor-badges` 在链上创建（幂等，可重复执行）；本仓库的
`scripts/cinachain/setup-tier-badges.mjs` 已废弃——CinaBadge 的 ID 由合约递增分配，
重跑会在新合约上创建出 109-112 等错误位阶。tier → tokenId 映射见
`packages/admin/lib/portal-config.ts`（运行时可用 `system_config` 的
`NFT_TIER_THRESHOLDS` 覆盖，无需重部署）。

## 生产边界

- 共享密钥以 AES-GCM 加密存储；Admin 与 Proxy 必须共享同一加密 Secret。
- 收益与提现使用整数微单位和幂等账本；链上操作经 Queue 与签名交易 outbox 执行。
- Base Sepolia 为测试网；主网上线必须部署并审计主网合约、切换 chain ID 与地址，完成独立灰度。
- 完整密钥、迁移、验收和事故处置见
  [unified-console-production.md](../operators/deployment/unified-console-production.md)。

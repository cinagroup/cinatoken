-- Shared-key marketplace & portal ledger runtime config defaults.
SET search_path TO cinatoken_gateway;

INSERT INTO system_config (key, value, description, updated_at) VALUES
  ('SHARED_KEY_ENABLED_CHANNELS', '', '允许共享的官方渠道（逗号分隔 openai,anthropic,zhipu,deepseek；空=全部）', CURRENT_TIMESTAMP),
  ('SHARED_KEY_COMMISSION_RATE', '0.1', '平台佣金比例（0-0.9，对卖家应得计提）', CURRENT_TIMESTAMP),
  ('SHARED_KEY_MAX_INPUT_PRICE', '200', '卖家输入单价上限（每 1M token）', CURRENT_TIMESTAMP),
  ('SHARED_KEY_MAX_OUTPUT_PRICE', '1200', '卖家输出单价上限（每 1M token）', CURRENT_TIMESTAMP),
  ('WITHDRAWAL_MIN_AMOUNT', '10', '最低提现金额', CURRENT_TIMESTAMP),
  ('WITHDRAWAL_FEE', '0', '提现固定手续费', CURRENT_TIMESTAMP),
  ('WITHDRAWAL_CINACREDIT_RATE', '1.0', '提现兑换率：1 账户金额 = N CINA-C', CURRENT_TIMESTAMP),
  ('WITHDRAWAL_DAILY_LIMIT', '3', '单用户单日提现次数上限', CURRENT_TIMESTAMP),
  ('NFT_TIER_THRESHOLDS', '[{"badgeTokenId":200,"tierName":"Bronze","threshold":10},{"badgeTokenId":201,"tierName":"Silver","threshold":50},{"badgeTokenId":202,"tierName":"Gold","threshold":200},{"badgeTokenId":203,"tierName":"Platinum","threshold":1000}]', '贡献值 NFT 位阶（CinaBadge tokenId/名称/门槛）', CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;

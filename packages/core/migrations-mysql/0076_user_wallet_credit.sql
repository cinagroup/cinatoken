-- CinaToken integration: retain existing period grants, spent micros and reservations.
-- Permanent wallet credits start at zero; no legacy balance redistribution.
-- MySQL UNIQUE 不能用 TEXT；dedup_key 用 VARCHAR。NULL 互不相等，既有行不受影响。

ALTER TABLE users
  ADD COLUMN wallet_granted DECIMAL(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN wallet_spent DECIMAL(18, 6) NOT NULL DEFAULT 0;

ALTER TABLE user_audit_logs ADD COLUMN dedup_key VARCHAR(255) NULL;
CREATE UNIQUE INDEX ux_user_audit_dedup ON user_audit_logs (user_id, dedup_key);

ALTER TABLE api_key_request_logs
  ADD COLUMN charged_wallet_cost DECIMAL(18, 6) NOT NULL DEFAULT 0;


ALTER TABLE user_budget_reservations ADD COLUMN settled_wallet_micros BIGINT NOT NULL DEFAULT 0 CHECK (settled_wallet_micros >= 0 AND settled_wallet_micros <= settled_micros);

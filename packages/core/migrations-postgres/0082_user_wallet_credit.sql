SET search_path TO cinatoken_gateway;

-- CinaToken integration: retain existing period grants, spent micros and reservations.
-- Permanent wallet credits start at zero; no legacy balance redistribution.

ALTER TABLE users ADD COLUMN wallet_granted NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN wallet_spent NUMERIC(18, 6) NOT NULL DEFAULT 0;

ALTER TABLE user_audit_logs ADD COLUMN dedup_key TEXT NULL;
CREATE UNIQUE INDEX ux_user_audit_dedup ON user_audit_logs (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

ALTER TABLE api_key_request_logs ADD COLUMN charged_wallet_cost NUMERIC(18, 6) NOT NULL DEFAULT 0;


ALTER TABLE cinatoken_gateway.user_budget_reservations ADD COLUMN settled_wallet_micros BIGINT NOT NULL DEFAULT 0 CHECK (settled_wallet_micros >= 0 AND settled_wallet_micros <= settled_micros);

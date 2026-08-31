-- OpenRouter-compatible per-Gateway-Key spend limits.

ALTER TABLE api_keys
  ADD COLUMN limit_micros BIGINT NULL,
  ADD COLUMN limit_reset TEXT NULL,
  ADD COLUMN include_byok_in_limit BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN limit_epoch INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT api_keys_limit_micros_chk
    CHECK (limit_micros IS NULL OR (limit_micros >= 0 AND limit_micros <= 9007199254740991)),
  ADD CONSTRAINT api_keys_limit_reset_chk
    CHECK (limit_reset IS NULL OR limit_reset IN ('daily', 'weekly', 'monthly')),
  ADD CONSTRAINT api_keys_limit_epoch_chk
    CHECK (limit_epoch >= 0 AND limit_epoch <= 2147483646);

ALTER TABLE guardrail_budget_windows
  DROP CONSTRAINT guardrail_budget_windows_period_check,
  ADD CONSTRAINT guardrail_budget_windows_period_check
    CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime'));

ALTER TABLE guardrail_budget_reservations
  DROP CONSTRAINT guardrail_budget_reservations_period_check,
  DROP CONSTRAINT guardrail_budget_reservations_limit_micros_check,
  ADD CONSTRAINT guardrail_budget_reservations_period_check
    CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime')),
  ADD CONSTRAINT guardrail_budget_reservations_limit_micros_check
    CHECK (limit_micros >= 0 AND limit_micros <= 9007199254740991);

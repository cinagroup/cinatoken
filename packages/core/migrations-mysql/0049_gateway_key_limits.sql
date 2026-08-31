-- OpenRouter-compatible per-Gateway-Key spend limits.

ALTER TABLE api_keys
  ADD COLUMN limit_micros BIGINT NULL AFTER expires_at,
  ADD COLUMN limit_reset VARCHAR(16) NULL AFTER limit_micros,
  ADD COLUMN include_byok_in_limit TINYINT NOT NULL DEFAULT 0 AFTER limit_reset,
  ADD COLUMN limit_epoch INT NOT NULL DEFAULT 0 AFTER include_byok_in_limit,
  ADD CONSTRAINT api_keys_limit_micros_chk
    CHECK (limit_micros IS NULL OR limit_micros >= 0),
  ADD CONSTRAINT api_keys_limit_reset_chk
    CHECK (limit_reset IS NULL OR limit_reset IN ('daily', 'weekly', 'monthly')),
  ADD CONSTRAINT api_keys_include_byok_limit_chk
    CHECK (include_byok_in_limit IN (0, 1)),
  ADD CONSTRAINT api_keys_limit_epoch_chk
    CHECK (limit_epoch >= 0);

ALTER TABLE guardrail_budget_windows
  DROP CHECK guardrail_budget_windows_period_chk,
  ADD CONSTRAINT guardrail_budget_windows_period_chk
    CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime'));

ALTER TABLE guardrail_budget_reservations
  DROP CHECK guardrail_budget_reservations_period_chk,
  DROP CHECK guardrail_budget_reservations_amount_chk,
  ADD CONSTRAINT guardrail_budget_reservations_period_chk
    CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime')),
  ADD CONSTRAINT guardrail_budget_reservations_amount_chk CHECK (
    limit_micros >= 0 AND reserved_micros > 0 AND settled_micros >= 0
  );

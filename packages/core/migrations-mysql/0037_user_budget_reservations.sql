-- 0037: atomic ordinary-user budget reservation ledger.
-- Guardrail policy rows remain physically and semantically independent.

ALTER TABLE users
  ADD COLUMN budget_epoch BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN budget_reserved_micros BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_budget_epoch_chk
    CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991),
  ADD CONSTRAINT users_budget_reserved_micros_chk
    CHECK (budget_reserved_micros >= 0 AND budget_reserved_micros <= 9007199254740991);

CREATE TABLE user_budget_reservations (
  request_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,
  user_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  api_key_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  budget_epoch BIGINT NOT NULL,
  limit_micros BIGINT NOT NULL,
  reserved_micros BIGINT NOT NULL,
  settled_micros BIGINT NOT NULL DEFAULT 0,
  state VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'reserved',
  expires_at DATETIME(6) NOT NULL,
  dispatched_at DATETIME(6),
  terminal_at DATETIME(6),
  terminal_reason VARCHAR(128),
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT user_budget_reservations_epoch_chk
    CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991),
  CONSTRAINT user_budget_reservations_amount_chk CHECK (
    limit_micros >= 0 AND limit_micros <= 9007199254740991
    AND reserved_micros > 0 AND reserved_micros <= 9007199254740991
    AND settled_micros >= 0 AND settled_micros <= 9007199254740991
  ),
  CONSTRAINT user_budget_reservations_state_chk
    CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  CONSTRAINT user_budget_reservations_range_chk CHECK (expires_at > created_at),
  INDEX idx_user_budget_reservations_expiry (state, expires_at),
  INDEX idx_user_budget_reservations_user_epoch (user_id, budget_epoch, state),
  INDEX idx_user_budget_reservations_api_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

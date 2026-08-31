-- 0040: atomic ordinary-user budget reservation ledger.
-- Guardrail policy rows remain physically and semantically independent.

ALTER TABLE users ADD COLUMN budget_epoch BIGINT NOT NULL DEFAULT 0
  CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991);
ALTER TABLE users ADD COLUMN budget_reserved_micros BIGINT NOT NULL DEFAULT 0
  CHECK (budget_reserved_micros >= 0 AND budget_reserved_micros <= 9007199254740991);

CREATE TABLE user_budget_reservations (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  budget_epoch BIGINT NOT NULL CHECK (budget_epoch >= 0 AND budget_epoch <= 9007199254740991),
  limit_micros BIGINT NOT NULL CHECK (limit_micros >= 0 AND limit_micros <= 9007199254740991),
  reserved_micros BIGINT NOT NULL CHECK (reserved_micros > 0 AND reserved_micros <= 9007199254740991),
  settled_micros BIGINT NOT NULL DEFAULT 0 CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(request_id) BETWEEN 1 AND 128),
  CHECK (length(user_id) BETWEEN 1 AND 512),
  CHECK (length(api_key_id) BETWEEN 1 AND 512),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_user_budget_reservations_expiry
  ON user_budget_reservations(state, expires_at);
CREATE INDEX idx_user_budget_reservations_user_epoch
  ON user_budget_reservations(user_id, budget_epoch, state);
CREATE INDEX idx_user_budget_reservations_api_key
  ON user_budget_reservations(api_key_id, created_at);

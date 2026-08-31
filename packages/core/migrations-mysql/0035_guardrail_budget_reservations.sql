-- 0035: atomic Guardrail budget admission and settlement ledger.

ALTER TABLE api_key_request_logs ADD COLUMN budget_charged_micros BIGINT NULL;
ALTER TABLE api_key_request_logs ADD CONSTRAINT api_key_request_logs_budget_micros_chk
  CHECK (budget_charged_micros IS NULL OR (budget_charged_micros >= 0 AND budget_charged_micros <= 9007199254740991));
ALTER TABLE api_key_request_logs
  ADD COLUMN budget_accounted_at DATETIME(6) NULL,
  ADD COLUMN budget_accounted_effective_at DATETIME(6)
    AS (COALESCE(budget_accounted_at, created_at)) STORED;
CREATE INDEX idx_api_key_request_logs_user_budget_accounted
  ON api_key_request_logs(user_id, budget_accounted_effective_at);
CREATE INDEX idx_api_key_request_logs_key_budget_accounted
  ON api_key_request_logs(api_key_id, budget_accounted_effective_at);

CREATE TABLE guardrail_budget_windows (
  scope_type VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  scope_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  period VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  period_start DATETIME(6) NOT NULL,
  period_end DATETIME(6) NOT NULL,
  unreserved_micros BIGINT NOT NULL DEFAULT 0,
  settled_micros BIGINT NOT NULL DEFAULT 0,
  reserved_micros BIGINT NOT NULL DEFAULT 0,
  seed_request_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  seeded_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (scope_type, scope_id, period, period_start),
  CONSTRAINT guardrail_budget_windows_scope_chk CHECK (scope_type IN ('user', 'api_key')),
  CONSTRAINT guardrail_budget_windows_period_chk CHECK (period IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT guardrail_budget_windows_amount_chk CHECK (
    unreserved_micros >= 0 AND unreserved_micros <= 9007199254740991
    AND settled_micros >= 0 AND settled_micros <= 9007199254740991
    AND reserved_micros >= 0 AND reserved_micros <= 9007199254740991
  ),
  CONSTRAINT guardrail_budget_windows_range_chk CHECK (period_end > period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE guardrail_budget_reservations (
  id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,
  request_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  assignment_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  guardrail_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  guardrail_version INT NOT NULL,
  scope_type VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  scope_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  period VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  period_start DATETIME(6) NOT NULL,
  period_end DATETIME(6) NOT NULL,
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
  CONSTRAINT uk_guardrail_budget_reservation_request_assignment UNIQUE (request_id, assignment_id),
  CONSTRAINT fk_guardrail_budget_reservation_window FOREIGN KEY (
    scope_type, scope_id, period, period_start
  ) REFERENCES guardrail_budget_windows(scope_type, scope_id, period, period_start) ON DELETE RESTRICT,
  CONSTRAINT guardrail_budget_reservations_version_chk CHECK (guardrail_version >= 1),
  CONSTRAINT guardrail_budget_reservations_scope_chk CHECK (scope_type IN ('user', 'api_key')),
  CONSTRAINT guardrail_budget_reservations_period_chk CHECK (period IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT guardrail_budget_reservations_amount_chk CHECK (
    limit_micros > 0 AND limit_micros <= 9007199254740991
    AND reserved_micros > 0 AND reserved_micros <= 9007199254740991
    AND settled_micros >= 0 AND settled_micros <= 9007199254740991
  ),
  CONSTRAINT guardrail_budget_reservations_state_chk CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  CONSTRAINT guardrail_budget_reservations_range_chk CHECK (period_end > period_start),
  INDEX idx_guardrail_budget_reservations_request (request_id, state),
  INDEX idx_guardrail_budget_reservations_expiry (state, expires_at),
  INDEX idx_guardrail_budget_reservations_window (scope_type, scope_id, period, period_start, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- 0039: atomic Guardrail budget admission and settlement ledger.

ALTER TABLE api_key_request_logs ADD COLUMN budget_charged_micros BIGINT
  CHECK (budget_charged_micros IS NULL OR (budget_charged_micros >= 0 AND budget_charged_micros <= 9007199254740991));
ALTER TABLE api_key_request_logs ADD COLUMN budget_accounted_at TIMESTAMPTZ;

CREATE TABLE guardrail_budget_windows (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  unreserved_micros BIGINT NOT NULL DEFAULT 0 CHECK (unreserved_micros >= 0 AND unreserved_micros <= 9007199254740991),
  settled_micros BIGINT NOT NULL DEFAULT 0 CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  reserved_micros BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0 AND reserved_micros <= 9007199254740991),
  seed_request_id TEXT,
  seeded_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_type, scope_id, period, period_start),
  CHECK (period_end > period_start)
);

CREATE TABLE guardrail_budget_reservations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  guardrail_id TEXT NOT NULL,
  guardrail_version INTEGER NOT NULL CHECK (guardrail_version >= 1),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  limit_micros BIGINT NOT NULL CHECK (limit_micros > 0 AND limit_micros <= 9007199254740991),
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
  CONSTRAINT uk_guardrail_budget_reservation_request_assignment UNIQUE (request_id, assignment_id),
  CONSTRAINT fk_guardrail_budget_reservation_window FOREIGN KEY (
    scope_type, scope_id, period, period_start
  ) REFERENCES guardrail_budget_windows(scope_type, scope_id, period, period_start) ON DELETE RESTRICT,
  CHECK (period_end > period_start)
);

CREATE INDEX idx_guardrail_budget_reservations_request
  ON guardrail_budget_reservations(request_id, state);
CREATE INDEX idx_guardrail_budget_reservations_expiry
  ON guardrail_budget_reservations(state, expires_at);
CREATE INDEX idx_guardrail_budget_reservations_window
  ON guardrail_budget_reservations(scope_type, scope_id, period, period_start, state);
CREATE INDEX idx_api_key_request_logs_user_budget_accounted
  ON api_key_request_logs(user_id, COALESCE(budget_accounted_at, created_at));
CREATE INDEX idx_api_key_request_logs_key_budget_accounted
  ON api_key_request_logs(api_key_id, COALESCE(budget_accounted_at, created_at));

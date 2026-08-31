-- 0039: atomic Guardrail budget admission and settlement ledger.
--
-- Amounts use integer micro-units (the gateway's canonical six-decimal
-- precision). Existing request-log rows remain NULL and are conservatively
-- interpreted from charged_cost when a budget window is first seeded.

ALTER TABLE api_key_request_logs ADD COLUMN budget_charged_micros INTEGER
  CHECK (budget_charged_micros IS NULL OR (budget_charged_micros >= 0 AND budget_charged_micros <= 9007199254740991));
ALTER TABLE api_key_request_logs ADD COLUMN budget_accounted_at TEXT;

CREATE TABLE guardrail_budget_windows (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  unreserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (unreserved_micros >= 0 AND unreserved_micros <= 9007199254740991),
  settled_micros INTEGER NOT NULL DEFAULT 0 CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0 AND reserved_micros <= 9007199254740991),
  seed_request_id TEXT,
  seeded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  limit_micros INTEGER NOT NULL CHECK (limit_micros > 0 AND limit_micros <= 9007199254740991),
  reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0 AND reserved_micros <= 9007199254740991),
  settled_micros INTEGER NOT NULL DEFAULT 0 CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  dispatched_at TEXT,
  terminal_at TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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

-- D1 batch() rolls back on a trigger RAISE. Every policy reservation for one
-- request is inserted in one batch, so a failed user or API-key policy rolls
-- back the entire admission instead of leaving a partial lease behind.
CREATE TRIGGER trg_guardrail_budget_reservation_capacity
BEFORE INSERT ON guardrail_budget_reservations
BEGIN
  INSERT OR IGNORE INTO guardrail_budget_windows (
    scope_type, scope_id, period, period_start, period_end,
    unreserved_micros, settled_micros, reserved_micros, seed_request_id, seeded_at, updated_at
  ) VALUES (
    NEW.scope_type, NEW.scope_id, NEW.period, NEW.period_start, NEW.period_end,
    0, 0, 0, NEW.request_id, NEW.created_at, NEW.created_at
  );

  -- Reconcile only logs that have no reservation for this exact scope/window.
  -- Reservation settlements (including no-log forfeits) live exclusively in
  -- settled_micros, so the two sources remain additive instead of using MAX.
  UPDATE guardrail_budget_windows
  SET unreserved_micros = COALESCE((
          SELECT SUM(COALESCE(
            l.budget_charged_micros,
            CAST(ROUND(MAX(l.charged_cost, 0) * 1000000) AS INTEGER)
          ))
          FROM api_key_request_logs l
          WHERE COALESCE(l.budget_accounted_at, l.created_at) >= NEW.period_start
            AND COALESCE(l.budget_accounted_at, l.created_at) < NEW.period_end
            AND (
              (NEW.scope_type = 'user' AND l.user_id = NEW.scope_id) OR
              (NEW.scope_type = 'api_key' AND l.api_key_id = NEW.scope_id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM guardrail_budget_reservations r
              WHERE r.request_id = l.id
                AND r.scope_type = NEW.scope_type
                AND r.scope_id = NEW.scope_id
                AND r.period = NEW.period
                AND r.period_start = NEW.period_start
				AND r.state IN ('reserved', 'dispatched', 'settled', 'expired')
            )
        ), 0),
      period_end = NEW.period_end,
      updated_at = NEW.created_at
  WHERE scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND period = NEW.period
    AND period_start = NEW.period_start
    AND seed_request_id = NEW.request_id;

  SELECT (CASE
    WHEN (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id
        AND period = NEW.period
        AND period_start = NEW.period_start
    ) > NEW.limit_micros
    THEN RAISE(ABORT, 'guardrail_budget_exceeded')
  END);

  UPDATE guardrail_budget_windows
  SET reserved_micros = reserved_micros + NEW.reserved_micros,
      seed_request_id = NULL,
      updated_at = NEW.created_at
  WHERE scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND period = NEW.period
    AND period_start = NEW.period_start;
END;

CREATE TRIGGER trg_guardrail_budget_reservation_transition
BEFORE UPDATE OF state ON guardrail_budget_reservations
WHEN OLD.state <> NEW.state
BEGIN
  SELECT (CASE
    WHEN OLD.state = 'reserved' AND NEW.state IN ('dispatched', 'settled', 'released', 'expired') THEN NULL
    WHEN OLD.state = 'dispatched' AND NEW.state IN ('settled', 'expired') THEN NULL
    ELSE RAISE(ABORT, 'invalid_guardrail_budget_transition')
  END);
END;

CREATE TRIGGER trg_guardrail_budget_reservation_terminal
AFTER UPDATE OF state ON guardrail_budget_reservations
WHEN OLD.state IN ('reserved', 'dispatched')
 AND NEW.state IN ('settled', 'released', 'expired')
BEGIN
  UPDATE guardrail_budget_windows
  SET reserved_micros = reserved_micros - OLD.reserved_micros,
      settled_micros = settled_micros + NEW.settled_micros,
      updated_at = NEW.updated_at
  WHERE scope_type = OLD.scope_type
    AND scope_id = OLD.scope_id
    AND period = OLD.period
    AND period_start = OLD.period_start;
END;

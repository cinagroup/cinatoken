-- OpenRouter-compatible per-Gateway-Key spend limits.
-- Limits are integer micros; the existing Guardrail ledger provides atomic admission/settlement.

ALTER TABLE api_keys ADD COLUMN limit_micros INTEGER
  CHECK (limit_micros IS NULL OR (limit_micros >= 0 AND limit_micros <= 9007199254740991));
ALTER TABLE api_keys ADD COLUMN limit_reset TEXT
  CHECK (limit_reset IS NULL OR limit_reset IN ('daily', 'weekly', 'monthly'));
ALTER TABLE api_keys ADD COLUMN include_byok_in_limit INTEGER NOT NULL DEFAULT 0
  CHECK (include_byok_in_limit IN (0, 1));
ALTER TABLE api_keys ADD COLUMN limit_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (limit_epoch >= 0 AND limit_epoch <= 2147483646);

PRAGMA defer_foreign_keys = ON;

CREATE TABLE guardrail_budget_windows_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  unreserved_micros INTEGER NOT NULL DEFAULT 0
    CHECK (unreserved_micros >= 0 AND unreserved_micros <= 9007199254740991),
  settled_micros INTEGER NOT NULL DEFAULT 0
    CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  reserved_micros INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_micros >= 0 AND reserved_micros <= 9007199254740991),
  seed_request_id TEXT,
  seeded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, scope_type, scope_id, period, period_start),
  CHECK (period_end > period_start)
);

CREATE TABLE guardrail_budget_reservations_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  guardrail_id TEXT NOT NULL,
  guardrail_version INTEGER NOT NULL CHECK (guardrail_version >= 1),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  limit_micros INTEGER NOT NULL
    CHECK (limit_micros >= 0 AND limit_micros <= 9007199254740991),
  reserved_micros INTEGER NOT NULL
    CHECK (reserved_micros > 0 AND reserved_micros <= 9007199254740991),
  settled_micros INTEGER NOT NULL DEFAULT 0
    CHECK (settled_micros >= 0 AND settled_micros <= 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  dispatched_at TEXT,
  terminal_at TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT uk_guardrail_budget_reservation_next_request_assignment
    UNIQUE (request_id, assignment_id),
  CONSTRAINT fk_guardrail_budget_reservation_next_window FOREIGN KEY (
    workspace_id, scope_type, scope_id, period, period_start
  ) REFERENCES guardrail_budget_windows_next(
    workspace_id, scope_type, scope_id, period, period_start
  ) ON DELETE RESTRICT,
  CHECK (period_end > period_start)
);

INSERT INTO guardrail_budget_windows_next (
  workspace_id, scope_type, scope_id, period, period_start, period_end,
  unreserved_micros, settled_micros, reserved_micros,
  seed_request_id, seeded_at, updated_at
)
SELECT
  workspace_id, scope_type, scope_id, period, period_start, period_end,
  unreserved_micros, settled_micros, reserved_micros,
  seed_request_id, seeded_at, updated_at
FROM guardrail_budget_windows;

INSERT INTO guardrail_budget_reservations_next (
  id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
  scope_type, scope_id, period, period_start, period_end,
  limit_micros, reserved_micros, settled_micros, state, expires_at,
  dispatched_at, terminal_at, terminal_reason, created_at, updated_at
)
SELECT
  id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
  scope_type, scope_id, period, period_start, period_end,
  limit_micros, reserved_micros, settled_micros, state, expires_at,
  dispatched_at, terminal_at, terminal_reason, created_at, updated_at
FROM guardrail_budget_reservations;

DROP TABLE guardrail_budget_reservations;
DROP TABLE guardrail_budget_windows;

ALTER TABLE guardrail_budget_windows_next RENAME TO guardrail_budget_windows;
ALTER TABLE guardrail_budget_reservations_next RENAME TO guardrail_budget_reservations;

CREATE INDEX idx_guardrail_budget_reservations_request
  ON guardrail_budget_reservations(request_id, state);
CREATE INDEX idx_guardrail_budget_reservations_expiry
  ON guardrail_budget_reservations(state, expires_at);
CREATE INDEX idx_guardrail_budget_reservations_window
  ON guardrail_budget_reservations(
    workspace_id, scope_type, scope_id, period, period_start, state
  );

CREATE TRIGGER trg_guardrail_budget_reservation_capacity
BEFORE INSERT ON guardrail_budget_reservations
BEGIN
  SELECT (CASE
    WHEN substr(NEW.assignment_id, 1, 18) = 'gateway-key-limit:' AND NOT EXISTS (
      SELECT 1 FROM api_keys k
      WHERE NEW.assignment_id = 'gateway-key-limit:' || NEW.scope_id
        AND NEW.guardrail_id = NEW.assignment_id
        AND NEW.scope_type = 'api_key'
        AND k.id = NEW.scope_id
        AND k.workspace_id = NEW.workspace_id
        AND k.status = 'active'
        AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime(NEW.created_at))
        AND k.limit_micros IS NOT NULL
        AND k.limit_micros = NEW.limit_micros
        AND k.limit_epoch + 1 = NEW.guardrail_version
        AND COALESCE(k.limit_reset, 'lifetime') = NEW.period
        AND k.include_byok_in_limit = 0
    ) THEN RAISE(ABORT, 'gateway_key_limit_stale')
  END);

  INSERT OR IGNORE INTO guardrail_budget_windows (
    workspace_id, scope_type, scope_id, period, period_start, period_end,
    unreserved_micros, settled_micros, reserved_micros,
    seed_request_id, seeded_at, updated_at
  ) VALUES (
    NEW.workspace_id, NEW.scope_type, NEW.scope_id, NEW.period,
    NEW.period_start, NEW.period_end, 0, 0, 0,
    NEW.request_id, NEW.created_at, NEW.created_at
  );

  UPDATE guardrail_budget_windows
  SET unreserved_micros = COALESCE((
          SELECT SUM(COALESCE(
            l.budget_charged_micros,
            CAST(ROUND(MAX(l.charged_cost, 0) * 1000000) AS INTEGER)
          ))
          FROM api_key_request_logs l
          WHERE COALESCE(l.budget_accounted_at, l.created_at) >= NEW.period_start
            AND COALESCE(l.budget_accounted_at, l.created_at) < NEW.period_end
            AND EXISTS (
              SELECT 1 FROM api_keys k
              WHERE k.id = l.api_key_id AND k.workspace_id = NEW.workspace_id
            )
            AND (
              (NEW.scope_type = 'user' AND l.user_id = NEW.scope_id) OR
              (NEW.scope_type = 'api_key' AND l.api_key_id = NEW.scope_id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM guardrail_budget_reservations r
              WHERE r.request_id = l.id
                AND r.workspace_id = NEW.workspace_id
                AND r.scope_type = NEW.scope_type
                AND r.scope_id = NEW.scope_id
                AND r.period = NEW.period
                AND r.period_start = NEW.period_start
                AND r.state IN ('reserved', 'dispatched', 'settled', 'expired')
            )
        ), 0),
      period_end = NEW.period_end,
      updated_at = NEW.created_at
  WHERE workspace_id = NEW.workspace_id
    AND scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND period = NEW.period
    AND period_start = NEW.period_start
    AND seed_request_id = NEW.request_id;

  SELECT (CASE
    WHEN substr(NEW.assignment_id, 1, 18) = 'gateway-key-limit:' AND (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id
        AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id
        AND period = NEW.period
        AND period_start = NEW.period_start
    ) > NEW.limit_micros
    THEN RAISE(ABORT, 'gateway_key_limit_exceeded')
    WHEN (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id
        AND scope_type = NEW.scope_type
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
  WHERE workspace_id = NEW.workspace_id
    AND scope_type = NEW.scope_type
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
  WHERE workspace_id = OLD.workspace_id
    AND scope_type = OLD.scope_type
    AND scope_id = OLD.scope_id
    AND period = OLD.period
    AND period_start = OLD.period_start;
END;

PRAGMA defer_foreign_keys = OFF;

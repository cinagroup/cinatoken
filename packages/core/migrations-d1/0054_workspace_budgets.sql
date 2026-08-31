-- OpenRouter-shaped Workspace budgets: one strictly ordered limit per interval.
-- The Guardrail ledger is widened with a system-only Workspace scope.

CREATE TABLE workspace_budgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reset_interval TEXT NOT NULL
    CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'lifetime')),
  limit_micros INTEGER NOT NULL
    CHECK (limit_micros > 0 AND limit_micros <= 9007199254740991),
  config_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (config_epoch >= 0 AND config_epoch <= 2147483646),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_workspace_budgets_interval UNIQUE (workspace_id, reset_interval)
);

CREATE INDEX idx_workspace_budgets_workspace
  ON workspace_budgets(workspace_id);

-- Organization Management Keys previously could be issued by a local
-- Workspace admin. Force a one-time rotation after authoritative CinaAuth
-- organization-admin role mapping is enabled.
UPDATE management_api_keys
SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
WHERE account_type = 'organization' AND status = 'active';

-- Preserve request-time Workspace attribution even after a Gateway Key is removed.
ALTER TABLE api_key_request_logs
  ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;

UPDATE api_key_request_logs
SET workspace_id = (
  SELECT key.workspace_id FROM api_keys key WHERE key.id = api_key_request_logs.api_key_id
)
WHERE workspace_id IS NULL AND api_key_id IS NOT NULL;

CREATE INDEX idx_api_key_request_logs_workspace_created
  ON api_key_request_logs(workspace_id, created_at);

CREATE TRIGGER trg_api_key_request_logs_workspace_insert
BEFORE INSERT ON api_key_request_logs
BEGIN
  SELECT (CASE WHEN NEW.workspace_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_keys key
    WHERE key.id = NEW.api_key_id AND key.workspace_id = NEW.workspace_id
  ) THEN RAISE(ABORT, 'request_log_workspace_mismatch') END);
END;

CREATE TRIGGER trg_workspace_budgets_order_insert
BEFORE INSERT ON workspace_budgets
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM workspace_budgets existing
    WHERE existing.workspace_id = NEW.workspace_id
      AND (
        (
          CASE existing.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          < CASE NEW.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          AND existing.limit_micros >= NEW.limit_micros
        ) OR (
          CASE existing.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          > CASE NEW.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          AND existing.limit_micros <= NEW.limit_micros
        )
      )
  ) THEN RAISE(ABORT, 'workspace_budget_order_invalid') END);
END;

CREATE TRIGGER trg_workspace_budgets_order_update
BEFORE UPDATE OF reset_interval, limit_micros ON workspace_budgets
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM workspace_budgets existing
    WHERE existing.workspace_id = NEW.workspace_id AND existing.id <> OLD.id
      AND (
        (
          CASE existing.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          < CASE NEW.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          AND existing.limit_micros >= NEW.limit_micros
        ) OR (
          CASE existing.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          > CASE NEW.reset_interval WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END
          AND existing.limit_micros <= NEW.limit_micros
        )
      )
  ) THEN RAISE(ABORT, 'workspace_budget_order_invalid') END);
END;

PRAGMA defer_foreign_keys = ON;

CREATE TABLE guardrail_budget_windows_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key', 'workspace')),
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
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key', 'workspace')),
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
      SELECT 1 FROM api_keys key
      WHERE NEW.assignment_id = 'gateway-key-limit:' || NEW.scope_id
        AND NEW.guardrail_id = NEW.assignment_id
        AND NEW.scope_type = 'api_key'
        AND key.id = NEW.scope_id
        AND key.workspace_id = NEW.workspace_id
        AND key.status = 'active'
        AND (key.expires_at IS NULL OR datetime(key.expires_at) > datetime(NEW.created_at))
        AND key.limit_micros IS NOT NULL
        AND key.limit_micros = NEW.limit_micros
        AND key.limit_epoch + 1 = NEW.guardrail_version
        AND COALESCE(key.limit_reset, 'lifetime') = NEW.period
        AND key.include_byok_in_limit = 0
    ) THEN RAISE(ABORT, 'gateway_key_limit_stale')
    WHEN substr(NEW.assignment_id, 1, 17) = 'workspace-budget:' AND NOT EXISTS (
      SELECT 1 FROM workspace_budgets budget
      JOIN workspaces workspace ON workspace.id = budget.workspace_id
      WHERE NEW.assignment_id = 'workspace-budget:' || budget.id
        AND NEW.guardrail_id = NEW.assignment_id
        AND NEW.scope_type = 'workspace'
        AND NEW.scope_id = NEW.workspace_id
        AND budget.workspace_id = NEW.workspace_id
        AND budget.limit_micros = NEW.limit_micros
        AND budget.config_epoch + 1 = NEW.guardrail_version
        AND budget.reset_interval = NEW.period
        AND workspace.status = 'active'
    ) THEN RAISE(ABORT, 'workspace_budget_stale')
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
            log.budget_charged_micros,
            CAST(ROUND(MAX(log.charged_cost, 0) * 1000000) AS INTEGER)
          ))
          FROM api_key_request_logs log
          WHERE COALESCE(log.budget_accounted_at, log.created_at) >= NEW.period_start
            AND COALESCE(log.budget_accounted_at, log.created_at) < NEW.period_end
            AND log.workspace_id = NEW.workspace_id
            AND (
              (NEW.scope_type = 'user' AND log.user_id = NEW.scope_id) OR
              (NEW.scope_type = 'api_key' AND log.api_key_id = NEW.scope_id) OR
              (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.workspace_id)
            )
            AND NOT EXISTS (
              SELECT 1 FROM guardrail_budget_reservations reservation
              WHERE reservation.request_id = log.id
                AND reservation.workspace_id = NEW.workspace_id
                AND reservation.scope_type = NEW.scope_type
                AND reservation.scope_id = NEW.scope_id
                AND reservation.period = NEW.period
                AND reservation.period_start = NEW.period_start
                AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
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
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'gateway_key_limit_exceeded')
    WHEN substr(NEW.assignment_id, 1, 17) = 'workspace-budget:' AND (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'workspace_budget_exceeded')
    WHEN (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'guardrail_budget_exceeded')
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

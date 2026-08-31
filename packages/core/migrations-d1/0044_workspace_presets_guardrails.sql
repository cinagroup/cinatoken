-- 0044: Presets, Guardrails, assignments, and Guardrail budget ledgers are Workspace-scoped.
-- Rebuilds are required to replace legacy global UNIQUE/PRIMARY KEY constraints.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE request_presets_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  designated_version INTEGER NOT NULL DEFAULT 1,
  latest_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_request_presets_workspace_slug UNIQUE (workspace_id, slug),
  CONSTRAINT request_presets_versions_chk CHECK (
    designated_version >= 1 AND latest_version >= designated_version
  )
);

CREATE TABLE request_preset_versions_next (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES request_presets_next(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  system_prompt TEXT,
  config_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_request_preset_versions_next UNIQUE (preset_id, version)
);

INSERT INTO request_presets_next (
  id, workspace_id, owner_user_id, slug, name, description, visibility,
  status, designated_version, latest_version, created_at, updated_at
)
SELECT
  id, 'personal:' || owner_user_id, owner_user_id, slug, name, description,
  visibility, status, designated_version, latest_version, created_at, updated_at
FROM request_presets;

INSERT INTO request_preset_versions_next (
  id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at
)
SELECT id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at
FROM request_preset_versions;

DROP TABLE request_preset_versions;
DROP TABLE request_presets;
ALTER TABLE request_presets_next RENAME TO request_presets;
ALTER TABLE request_preset_versions_next RENAME TO request_preset_versions;

CREATE INDEX idx_request_presets_workspace_owner_status
  ON request_presets(workspace_id, owner_user_id, status, updated_at);
CREATE INDEX idx_request_presets_workspace_visibility_status
  ON request_presets(workspace_id, visibility, status, updated_at);
CREATE INDEX idx_request_preset_versions_preset_created
  ON request_preset_versions(preset_id, created_at);

CREATE TABLE guardrails_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  designated_version INTEGER NOT NULL DEFAULT 1,
  latest_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_guardrails_next_id_workspace UNIQUE (id, workspace_id),
  CONSTRAINT guardrails_versions_chk CHECK (
    designated_version >= 1 AND latest_version >= designated_version
  )
);

CREATE TABLE guardrail_versions_next (
  id TEXT PRIMARY KEY,
  guardrail_id TEXT NOT NULL REFERENCES guardrails_next(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  config_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_guardrail_versions_next UNIQUE (guardrail_id, version)
);

CREATE TABLE guardrail_assignments_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  guardrail_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_guardrail_assignments_next_workspace_scope
    UNIQUE (workspace_id, scope_type, scope_id),
  CONSTRAINT fk_guardrail_assignments_next_guardrail_workspace
    FOREIGN KEY (guardrail_id, workspace_id)
    REFERENCES guardrails_next(id, workspace_id) ON DELETE CASCADE
);

INSERT INTO guardrails_next (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at
)
SELECT
  id, 'personal:' || owner_user_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at
FROM guardrails;

INSERT INTO guardrail_versions_next (
  id, guardrail_id, version, config_json, created_by_user_id, created_at
)
SELECT id, guardrail_id, version, config_json, created_by_user_id, created_at
FROM guardrail_versions;

-- Legacy cross-user administrator assignments intentionally fail the composite
-- FK below instead of silently weakening enforcement. Operators must resolve
-- those rows to a single target Workspace before retrying the migration.
INSERT INTO guardrail_assignments_next (
  id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id, created_at
)
SELECT
  a.id,
  CASE a.scope_type
    WHEN 'api_key' THEN (SELECT k.workspace_id FROM api_keys k WHERE k.id = a.scope_id)
    ELSE 'personal:' || a.scope_id
  END,
  a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at
FROM guardrail_assignments a;

CREATE TABLE guardrail_budget_windows_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
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
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  limit_micros INTEGER NOT NULL
    CHECK (limit_micros > 0 AND limit_micros <= 9007199254740991),
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
  CAST(CASE w.scope_type
    WHEN 'api_key' THEN (SELECT k.workspace_id FROM api_keys k WHERE k.id = w.scope_id)
    ELSE 'personal:' || w.scope_id
  END AS TEXT),
  w.scope_type, w.scope_id, w.period, w.period_start, w.period_end,
  w.unreserved_micros, w.settled_micros, w.reserved_micros,
  w.seed_request_id, w.seeded_at, w.updated_at
FROM guardrail_budget_windows w;

INSERT INTO guardrail_budget_reservations_next (
  id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
  scope_type, scope_id, period, period_start, period_end,
  limit_micros, reserved_micros, settled_micros, state, expires_at,
  dispatched_at, terminal_at, terminal_reason, created_at, updated_at
)
SELECT
  r.id,
  COALESCE(
    (SELECT a.workspace_id FROM guardrail_assignments_next a WHERE a.id = r.assignment_id),
    CASE r.scope_type
      WHEN 'api_key' THEN (SELECT k.workspace_id FROM api_keys k WHERE k.id = r.scope_id)
      ELSE 'personal:' || r.scope_id
    END
  ),
  r.request_id, r.assignment_id, r.guardrail_id, r.guardrail_version,
  r.scope_type, r.scope_id, r.period, r.period_start, r.period_end,
  r.limit_micros, r.reserved_micros, r.settled_micros, r.state, r.expires_at,
  r.dispatched_at, r.terminal_at, r.terminal_reason, r.created_at, r.updated_at
FROM guardrail_budget_reservations r;

DROP TABLE guardrail_budget_reservations;
DROP TABLE guardrail_budget_windows;
DROP TABLE guardrail_assignments;
DROP TABLE guardrail_versions;
DROP TABLE guardrails;

ALTER TABLE guardrails_next RENAME TO guardrails;
ALTER TABLE guardrail_versions_next RENAME TO guardrail_versions;
ALTER TABLE guardrail_assignments_next RENAME TO guardrail_assignments;
ALTER TABLE guardrail_budget_windows_next RENAME TO guardrail_budget_windows;
ALTER TABLE guardrail_budget_reservations_next RENAME TO guardrail_budget_reservations;

CREATE INDEX idx_guardrails_workspace_owner_status
  ON guardrails(workspace_id, owner_user_id, status, updated_at);
CREATE INDEX idx_guardrail_versions_guardrail_created
  ON guardrail_versions(guardrail_id, created_at);
CREATE INDEX idx_guardrail_assignments_guardrail
  ON guardrail_assignments(guardrail_id, workspace_id, scope_type, scope_id);
CREATE INDEX idx_guardrail_assignments_workspace_scope
  ON guardrail_assignments(workspace_id, scope_type, scope_id);
CREATE INDEX idx_guardrail_budget_reservations_request
  ON guardrail_budget_reservations(request_id, state);
CREATE INDEX idx_guardrail_budget_reservations_expiry
  ON guardrail_budget_reservations(state, expires_at);
CREATE INDEX idx_guardrail_budget_reservations_window
  ON guardrail_budget_reservations(
    workspace_id, scope_type, scope_id, period, period_start, state
  );

CREATE TRIGGER guardrail_assignments_api_key_workspace_insert
BEFORE INSERT ON guardrail_assignments
FOR EACH ROW
WHEN NEW.scope_type = 'api_key' AND NOT EXISTS (
  SELECT 1 FROM api_keys k
  WHERE k.id = NEW.scope_id AND k.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'guardrail assignment API key workspace mismatch');
END;

CREATE TRIGGER guardrail_assignments_api_key_workspace_update
BEFORE UPDATE OF workspace_id, scope_type, scope_id ON guardrail_assignments
FOR EACH ROW
WHEN NEW.scope_type = 'api_key' AND NOT EXISTS (
  SELECT 1 FROM api_keys k
  WHERE k.id = NEW.scope_id AND k.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'guardrail assignment API key workspace mismatch');
END;

CREATE TRIGGER trg_guardrail_budget_reservation_capacity
BEFORE INSERT ON guardrail_budget_reservations
BEGIN
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

-- 0040: Presets, Guardrails, assignments, and Guardrail budgets become Workspace-scoped.
-- workspace_key is a fixed-width SHA-256 index surrogate for opaque Workspace ids.

ALTER TABLE request_presets
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL;
UPDATE request_presets
SET workspace_id = CONCAT('personal:', owner_user_id)
WHERE workspace_id IS NULL;
UPDATE request_presets
SET workspace_key = SHA2(workspace_id, 256)
WHERE workspace_key IS NULL;
ALTER TABLE request_presets
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP INDEX uk_request_presets_slug,
  DROP INDEX idx_request_presets_owner_status,
  DROP INDEX idx_request_presets_visibility_status,
  ADD CONSTRAINT fk_request_presets_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT request_presets_workspace_key_chk
    CHECK (workspace_key = SHA2(workspace_id, 256)),
  ADD UNIQUE INDEX uk_request_presets_workspace_slug (workspace_key, slug),
  ADD INDEX idx_request_presets_workspace_owner_status
    (workspace_id(191), owner_user_id, status, updated_at),
  ADD INDEX idx_request_presets_workspace_visibility_status
    (workspace_id(191), visibility, status, updated_at);

ALTER TABLE guardrails
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL;
UPDATE guardrails
SET workspace_id = CONCAT('personal:', owner_user_id)
WHERE workspace_id IS NULL;
UPDATE guardrails
SET workspace_key = SHA2(workspace_id, 256)
WHERE workspace_key IS NULL;
ALTER TABLE guardrails
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP INDEX idx_guardrails_owner_status,
  ADD CONSTRAINT fk_guardrails_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT guardrails_workspace_key_chk
    CHECK (workspace_key = SHA2(workspace_id, 256)),
  ADD UNIQUE INDEX uk_guardrails_id_workspace (id, workspace_key),
  ADD INDEX idx_guardrails_workspace_owner_status
    (workspace_id(191), owner_user_id, status, updated_at);

ALTER TABLE guardrail_assignments
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL;
UPDATE guardrail_assignments assignment
LEFT JOIN api_keys api_key
  ON assignment.scope_type = 'api_key' AND api_key.id = assignment.scope_id
SET assignment.workspace_id = CASE assignment.scope_type
  WHEN 'api_key' THEN api_key.workspace_id
  ELSE CONCAT('personal:', assignment.scope_id)
END
WHERE assignment.workspace_id IS NULL;
UPDATE guardrail_assignments
SET workspace_key = SHA2(workspace_id, 256)
WHERE workspace_key IS NULL;
ALTER TABLE guardrail_assignments
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP INDEX uk_guardrail_assignments_scope,
  DROP INDEX idx_guardrail_assignments_guardrail,
  ADD CONSTRAINT fk_guardrail_assignments_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT guardrail_assignments_workspace_key_chk
    CHECK (workspace_key = SHA2(workspace_id, 256)),
  ADD UNIQUE INDEX uk_guardrail_assignments_workspace_scope
    (workspace_key, scope_type, scope_id),
  ADD INDEX idx_guardrail_assignments_guardrail
    (guardrail_id, workspace_key, scope_type, scope_id),
  ADD INDEX idx_guardrail_assignments_workspace_scope
    (workspace_id(191), scope_type, scope_id);

CREATE TRIGGER guardrail_assignments_workspace_insert
BEFORE INSERT ON guardrail_assignments
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guardrails guardrail
    WHERE guardrail.id = NEW.guardrail_id
      AND guardrail.workspace_id = NEW.workspace_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'guardrail assignment guardrail workspace mismatch';
  END IF;
  IF NEW.scope_type = 'api_key' AND NOT EXISTS (
    SELECT 1 FROM api_keys api_key
    WHERE api_key.id = NEW.scope_id
      AND api_key.workspace_id = NEW.workspace_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'guardrail assignment API key workspace mismatch';
  END IF;
END;

CREATE TRIGGER guardrail_assignments_workspace_update
BEFORE UPDATE ON guardrail_assignments
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guardrails guardrail
    WHERE guardrail.id = NEW.guardrail_id
      AND guardrail.workspace_id = NEW.workspace_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'guardrail assignment guardrail workspace mismatch';
  END IF;
  IF NEW.scope_type = 'api_key' AND NOT EXISTS (
    SELECT 1 FROM api_keys api_key
    WHERE api_key.id = NEW.scope_id
      AND api_key.workspace_id = NEW.workspace_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'guardrail assignment API key workspace mismatch';
  END IF;
END;

ALTER TABLE guardrail_budget_windows
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL FIRST,
  ADD COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL AFTER workspace_id;
UPDATE guardrail_budget_windows window_row
LEFT JOIN api_keys api_key
  ON window_row.scope_type = 'api_key' AND api_key.id = window_row.scope_id
SET window_row.workspace_id = CASE window_row.scope_type
  WHEN 'api_key' THEN api_key.workspace_id
  ELSE CONCAT('personal:', window_row.scope_id)
END
WHERE window_row.workspace_id IS NULL;
UPDATE guardrail_budget_windows
SET workspace_key = SHA2(workspace_id, 256)
WHERE workspace_key IS NULL;
ALTER TABLE guardrail_budget_windows
  DROP PRIMARY KEY,
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD CONSTRAINT fk_guardrail_budget_windows_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT guardrail_budget_windows_workspace_key_chk
    CHECK (workspace_key = SHA2(workspace_id, 256)),
  ADD PRIMARY KEY (workspace_key, scope_type, scope_id, period, period_start),
  ADD INDEX idx_guardrail_budget_windows_workspace_scope
    (workspace_id(191), scope_type, scope_id, period, period_start);

ALTER TABLE guardrail_budget_reservations
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL AFTER id,
  ADD COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL AFTER workspace_id;
UPDATE guardrail_budget_reservations reservation
LEFT JOIN guardrail_assignments assignment
  ON assignment.id = reservation.assignment_id
LEFT JOIN api_keys api_key
  ON reservation.scope_type = 'api_key' AND api_key.id = reservation.scope_id
SET reservation.workspace_id = COALESCE(
  assignment.workspace_id,
  CASE reservation.scope_type
    WHEN 'api_key' THEN api_key.workspace_id
    ELSE CONCAT('personal:', reservation.scope_id)
  END
)
WHERE reservation.workspace_id IS NULL;
UPDATE guardrail_budget_reservations
SET workspace_key = SHA2(workspace_id, 256)
WHERE workspace_key IS NULL;
ALTER TABLE guardrail_budget_reservations
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN workspace_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP FOREIGN KEY fk_guardrail_budget_reservation_window,
  DROP INDEX idx_guardrail_budget_reservations_window,
  ADD CONSTRAINT fk_guardrail_budget_reservations_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT guardrail_budget_reservations_workspace_key_chk
    CHECK (workspace_key = SHA2(workspace_id, 256)),
  ADD CONSTRAINT fk_guardrail_budget_reservation_window FOREIGN KEY (
    workspace_key, scope_type, scope_id, period, period_start
  ) REFERENCES guardrail_budget_windows(
    workspace_key, scope_type, scope_id, period, period_start
  ) ON DELETE RESTRICT,
  ADD INDEX idx_guardrail_budget_reservations_window
    (workspace_key, scope_type, scope_id, period, period_start, state);

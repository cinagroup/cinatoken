-- 0043: Presets, Guardrails, assignments, and Guardrail budgets become Workspace-scoped.

SET search_path TO cinatoken_gateway;

ALTER TABLE request_presets ADD COLUMN workspace_id TEXT;
UPDATE request_presets SET workspace_id = 'personal:' || owner_user_id WHERE workspace_id IS NULL;
ALTER TABLE request_presets
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT fk_request_presets_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  DROP CONSTRAINT uk_request_presets_slug,
  ADD CONSTRAINT uk_request_presets_workspace_slug UNIQUE (workspace_id, slug);
DROP INDEX idx_request_presets_owner_status;
DROP INDEX idx_request_presets_visibility_status;
CREATE INDEX idx_request_presets_workspace_owner_status
  ON request_presets(workspace_id, owner_user_id, status, updated_at);
CREATE INDEX idx_request_presets_workspace_visibility_status
  ON request_presets(workspace_id, visibility, status, updated_at);

ALTER TABLE guardrails ADD COLUMN workspace_id TEXT;
UPDATE guardrails SET workspace_id = 'personal:' || owner_user_id WHERE workspace_id IS NULL;
ALTER TABLE guardrails
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT fk_guardrails_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT uk_guardrails_id_workspace UNIQUE (id, workspace_id);
DROP INDEX idx_guardrails_owner_status;
CREATE INDEX idx_guardrails_workspace_owner_status
  ON guardrails(workspace_id, owner_user_id, status, updated_at);

ALTER TABLE guardrail_assignments ADD COLUMN workspace_id TEXT;
UPDATE guardrail_assignments assignment
SET workspace_id = CASE assignment.scope_type
  WHEN 'api_key' THEN (
    SELECT api_key.workspace_id FROM api_keys api_key WHERE api_key.id = assignment.scope_id
  )
  ELSE 'personal:' || assignment.scope_id
END
WHERE workspace_id IS NULL;
ALTER TABLE guardrail_assignments
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT fk_guardrail_assignments_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_guardrail_assignments_guardrail_workspace
    FOREIGN KEY (guardrail_id, workspace_id)
    REFERENCES guardrails(id, workspace_id) ON DELETE CASCADE,
  DROP CONSTRAINT uk_guardrail_assignments_scope,
  ADD CONSTRAINT uk_guardrail_assignments_workspace_scope
    UNIQUE (workspace_id, scope_type, scope_id);
DROP INDEX idx_guardrail_assignments_guardrail;
CREATE INDEX idx_guardrail_assignments_guardrail
  ON guardrail_assignments(guardrail_id, workspace_id, scope_type, scope_id);
CREATE INDEX idx_guardrail_assignments_workspace_scope
  ON guardrail_assignments(workspace_id, scope_type, scope_id);

CREATE OR REPLACE FUNCTION enforce_guardrail_assignment_api_key_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope_type = 'api_key' AND NOT EXISTS (
    SELECT 1 FROM api_keys api_key
    WHERE api_key.id = NEW.scope_id AND api_key.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'guardrail assignment API key workspace mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guardrail_assignments_api_key_workspace
BEFORE INSERT OR UPDATE OF workspace_id, scope_type, scope_id
ON guardrail_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_guardrail_assignment_api_key_workspace();

ALTER TABLE guardrail_budget_windows ADD COLUMN workspace_id TEXT;
UPDATE guardrail_budget_windows budget_window
SET workspace_id = CASE budget_window.scope_type
  WHEN 'api_key' THEN (
    SELECT api_key.workspace_id FROM api_keys api_key WHERE api_key.id = budget_window.scope_id
  )
  ELSE 'personal:' || budget_window.scope_id
END
WHERE workspace_id IS NULL;
ALTER TABLE guardrail_budget_reservations
  DROP CONSTRAINT fk_guardrail_budget_reservation_window;
ALTER TABLE guardrail_budget_windows
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT fk_guardrail_budget_windows_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  DROP CONSTRAINT guardrail_budget_windows_pkey,
  ADD CONSTRAINT guardrail_budget_windows_pkey
    PRIMARY KEY (workspace_id, scope_type, scope_id, period, period_start);

ALTER TABLE guardrail_budget_reservations ADD COLUMN workspace_id TEXT;
UPDATE guardrail_budget_reservations reservation
SET workspace_id = COALESCE(
  (SELECT assignment.workspace_id
   FROM guardrail_assignments assignment
   WHERE assignment.id = reservation.assignment_id),
  CASE reservation.scope_type
    WHEN 'api_key' THEN (
      SELECT api_key.workspace_id FROM api_keys api_key WHERE api_key.id = reservation.scope_id
    )
    ELSE 'personal:' || reservation.scope_id
  END
)
WHERE workspace_id IS NULL;
ALTER TABLE guardrail_budget_reservations
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT fk_guardrail_budget_reservations_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_guardrail_budget_reservation_window FOREIGN KEY (
    workspace_id, scope_type, scope_id, period, period_start
  ) REFERENCES guardrail_budget_windows(
    workspace_id, scope_type, scope_id, period, period_start
  ) ON DELETE RESTRICT;
DROP INDEX idx_guardrail_budget_reservations_window;
CREATE INDEX idx_guardrail_budget_reservations_window
  ON guardrail_budget_reservations(
    workspace_id, scope_type, scope_id, period, period_start, state
  );

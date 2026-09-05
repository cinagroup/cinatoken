-- Preserve the distinction between self-service assignments and assignments
-- managed through privileged admin/Management API surfaces while retaining
-- created_by_user_id = NULL as the existing anti-override marker.

ALTER TABLE guardrail_assignments
  ADD COLUMN management_source TEXT
    CHECK (management_source IN ('admin', 'management_api'));

ALTER TABLE guardrail_assignments
  ADD COLUMN assigned_by_user_id TEXT
    REFERENCES users(id) ON DELETE SET NULL;

UPDATE guardrail_assignments
SET management_source = 'admin'
WHERE created_by_user_id IS NULL;

CREATE INDEX idx_guardrail_assignments_assigned_by
  ON guardrail_assignments(assigned_by_user_id);

CREATE INDEX idx_guardrail_assignments_management_list
  ON guardrail_assignments(workspace_id, management_source, created_at, id)
  WHERE management_source IS NOT NULL;

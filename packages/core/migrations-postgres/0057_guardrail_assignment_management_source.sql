-- Privileged assignment provenance. created_by_user_id remains NULL for every
-- admin-managed row so legacy self-service anti-override rules stay valid.

ALTER TABLE guardrail_assignments
  ADD COLUMN management_source TEXT,
  ADD COLUMN assigned_by_user_id TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT guardrail_assignments_management_source_chk
    CHECK (management_source IN ('admin', 'management_api'));

UPDATE guardrail_assignments
SET management_source = 'admin'
WHERE created_by_user_id IS NULL;

CREATE INDEX idx_guardrail_assignments_assigned_by
  ON guardrail_assignments(assigned_by_user_id);

CREATE INDEX idx_guardrail_assignments_management_list
  ON guardrail_assignments(workspace_id, management_source, created_at, id)
  WHERE management_source IS NOT NULL;

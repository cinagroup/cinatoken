-- Privileged assignment provenance. created_by_user_id remains NULL for every
-- admin-managed row so legacy self-service anti-override rules stay valid.

ALTER TABLE guardrail_assignments
  ADD COLUMN management_source VARCHAR(32) NULL,
  ADD COLUMN assigned_by_user_id VARCHAR(512) NULL,
  ADD CONSTRAINT guardrail_assignments_management_source_chk
    CHECK (management_source IN ('admin', 'management_api')),
  ADD CONSTRAINT fk_guardrail_assignments_assigned_by
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD INDEX idx_guardrail_assignments_assigned_by (assigned_by_user_id),
  ADD INDEX idx_guardrail_assignments_management_list
    (workspace_key, management_source, created_at, id);

UPDATE guardrail_assignments
SET management_source = 'admin'
WHERE created_by_user_id IS NULL;

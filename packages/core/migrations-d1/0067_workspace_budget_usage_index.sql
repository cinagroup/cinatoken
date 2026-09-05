-- 0067: bound current-period Workspace budget usage fallback reads by both
-- Workspace and the same effective accounting timestamp used by admission.

CREATE INDEX idx_api_key_request_logs_workspace_budget_accounted
  ON api_key_request_logs(workspace_id, COALESCE(budget_accounted_at, created_at));

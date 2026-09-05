-- 0063: bound current-period Workspace budget usage fallback reads by both
-- Workspace and the generated effective accounting timestamp used by admission.

CREATE INDEX idx_api_key_request_logs_workspace_budget_accounted
  ON api_key_request_logs(workspace_id, budget_accounted_effective_at);

-- OpenRouter-shaped Workspace budgets and system-only Workspace ledger scope.

CREATE TABLE workspace_budgets (
  id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,
  workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  reset_interval VARCHAR(16) NOT NULL,
  limit_micros BIGINT UNSIGNED NOT NULL,
  config_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_workspace_budgets_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_budgets_interval_chk
    CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'lifetime')),
  CONSTRAINT workspace_budgets_limit_chk CHECK (limit_micros > 0),
  CONSTRAINT workspace_budgets_epoch_chk CHECK (config_epoch <= 2147483646),
  UNIQUE INDEX uk_workspace_budgets_interval (workspace_id, reset_interval),
  INDEX idx_workspace_budgets_workspace (workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Revoke organization keys issued under the former Workspace-local admin
-- policy; authoritative CinaAuth organization admins must rotate them.
UPDATE management_api_keys
SET status = 'revoked', updated_at = UTC_TIMESTAMP(6)
WHERE account_type = 'organization' AND status = 'active';

ALTER TABLE api_key_request_logs
  ADD COLUMN workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD INDEX idx_api_key_request_logs_workspace_created (workspace_id, created_at),
  ADD CONSTRAINT fk_api_key_request_logs_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

UPDATE api_key_request_logs request_log
JOIN api_keys api_key ON api_key.id = request_log.api_key_id
SET request_log.workspace_id = api_key.workspace_id
WHERE request_log.workspace_id IS NULL;

ALTER TABLE guardrail_budget_windows
  DROP CHECK guardrail_budget_windows_scope_chk,
  ADD CONSTRAINT guardrail_budget_windows_scope_chk
    CHECK (scope_type IN ('user', 'api_key', 'workspace'));

ALTER TABLE guardrail_budget_reservations
  DROP CHECK guardrail_budget_reservations_scope_chk,
  ADD CONSTRAINT guardrail_budget_reservations_scope_chk
    CHECK (scope_type IN ('user', 'api_key', 'workspace'));

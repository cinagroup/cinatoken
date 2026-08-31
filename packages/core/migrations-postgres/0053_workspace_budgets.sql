-- OpenRouter-shaped Workspace budgets and system-only Workspace ledger scope.

CREATE TABLE workspace_budgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reset_interval TEXT NOT NULL
    CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'lifetime')),
  limit_micros BIGINT NOT NULL
    CHECK (limit_micros > 0 AND limit_micros <= 9007199254740991),
  config_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (config_epoch >= 0 AND config_epoch <= 2147483646),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_workspace_budgets_interval UNIQUE (workspace_id, reset_interval)
);

CREATE INDEX idx_workspace_budgets_workspace
  ON workspace_budgets(workspace_id);

-- Revoke organization keys issued under the former Workspace-local admin
-- policy; authoritative CinaAuth organization admins must rotate them.
UPDATE management_api_keys
SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
WHERE account_type = 'organization' AND status = 'active';

-- Immutable request-time Workspace attribution survives Gateway Key deletion.
ALTER TABLE api_key_request_logs
  ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;

UPDATE api_key_request_logs request_log
SET workspace_id = key.workspace_id
FROM api_keys key
WHERE key.id = request_log.api_key_id AND request_log.workspace_id IS NULL;

CREATE INDEX idx_api_key_request_logs_workspace_created
  ON api_key_request_logs(workspace_id, created_at);

CREATE OR REPLACE FUNCTION enforce_request_log_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_keys key
    WHERE key.id = NEW.api_key_id AND key.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'request_log_workspace_mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_api_key_request_logs_workspace
BEFORE INSERT ON api_key_request_logs
FOR EACH ROW EXECUTE FUNCTION enforce_request_log_workspace();

CREATE OR REPLACE FUNCTION enforce_workspace_budget_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM id FROM workspaces WHERE id = NEW.workspace_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM workspace_budgets existing
    WHERE existing.workspace_id = NEW.workspace_id
      AND existing.id <> NEW.id
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
  ) THEN
    RAISE EXCEPTION 'workspace_budget_order_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workspace_budgets_order
BEFORE INSERT OR UPDATE OF reset_interval, limit_micros ON workspace_budgets
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_budget_order();

ALTER TABLE guardrail_budget_windows
  DROP CONSTRAINT guardrail_budget_windows_scope_type_check,
  ADD CONSTRAINT guardrail_budget_windows_scope_type_check
    CHECK (scope_type IN ('user', 'api_key', 'workspace'));

ALTER TABLE guardrail_budget_reservations
  DROP CONSTRAINT guardrail_budget_reservations_scope_type_check,
  ADD CONSTRAINT guardrail_budget_reservations_scope_type_check
    CHECK (scope_type IN ('user', 'api_key', 'workspace'));

-- 0042: Every Gateway API key belongs to exactly one CinaToken Workspace.
-- Existing keys move deterministically to their creator's personal Default workspace.

SET search_path TO cinatoken_gateway;

ALTER TABLE api_keys
  ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE api_keys
SET workspace_id = 'personal:' || user_id
WHERE workspace_id IS NULL;

ALTER TABLE api_keys
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX idx_api_keys_workspace_created
  ON api_keys(workspace_id, created_at);
CREATE INDEX idx_api_keys_workspace_user_created
  ON api_keys(workspace_id, user_id, created_at);

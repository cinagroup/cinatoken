-- 0043: Every Gateway API key belongs to exactly one CinaToken Workspace.
-- Existing keys move deterministically to their creator's personal Default workspace.

ALTER TABLE api_keys
  ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE api_keys
SET workspace_id = 'personal:' || user_id
WHERE workspace_id IS NULL;

-- SQLite cannot promote an added column to NOT NULL in place. These triggers
-- enforce the same write contract as PostgreSQL/MySQL for every future row.
CREATE TRIGGER api_keys_workspace_required_insert
BEFORE INSERT ON api_keys
FOR EACH ROW
WHEN NEW.workspace_id IS NULL OR length(NEW.workspace_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'api_keys.workspace_id is required');
END;

CREATE TRIGGER api_keys_workspace_required_update
BEFORE UPDATE OF workspace_id ON api_keys
FOR EACH ROW
WHEN NEW.workspace_id IS NULL OR length(NEW.workspace_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'api_keys.workspace_id is required');
END;

CREATE INDEX idx_api_keys_workspace_created
  ON api_keys(workspace_id, created_at);
CREATE INDEX idx_api_keys_workspace_user_created
  ON api_keys(workspace_id, user_id, created_at);

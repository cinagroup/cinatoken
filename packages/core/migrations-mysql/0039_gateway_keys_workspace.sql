-- 0039: Every Gateway API key belongs to exactly one CinaToken Workspace.
-- Existing keys move deterministically to their creator's personal Default workspace.

ALTER TABLE api_keys
  ADD COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;

UPDATE api_keys
SET workspace_id = CONCAT('personal:', user_id)
WHERE workspace_id IS NULL;

ALTER TABLE api_keys
  MODIFY COLUMN workspace_id VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  ADD CONSTRAINT fk_api_keys_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD INDEX idx_api_keys_workspace_created (workspace_id, created_at),
  ADD INDEX idx_api_keys_workspace_user_created (workspace_id, user_id, created_at);

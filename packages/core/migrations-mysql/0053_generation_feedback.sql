-- OpenRouter-compatible structured feedback for a generation. The write path
-- uses INSERT ... SELECT so generation ownership and Management-key account
-- scope are authorized by the database statement that creates the row.

CREATE TABLE generation_feedback (
  id VARCHAR(40) PRIMARY KEY,
  generation_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  management_api_key_id VARCHAR(64) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  personal_owner_user_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  organization_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,
  category VARCHAR(32) NOT NULL,
  comment TEXT,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_generation_feedback_generation
    FOREIGN KEY (generation_id) REFERENCES api_key_request_logs(id) ON DELETE CASCADE,
  CONSTRAINT fk_generation_feedback_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_generation_feedback_management_key
    FOREIGN KEY (management_api_key_id) REFERENCES management_api_keys(id) ON DELETE CASCADE,
  CONSTRAINT fk_generation_feedback_personal_owner
    FOREIGN KEY (personal_owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_generation_feedback_organization
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT generation_feedback_id_chk
    CHECK (CHAR_LENGTH(id) = 40 AND LEFT(id, 4) = 'gfb_'),
  CONSTRAINT generation_feedback_category_chk CHECK (category IN (
    'latency', 'incoherence', 'incorrect_response', 'formatting',
    'billing', 'api_error', 'other'
  )),
  CONSTRAINT generation_feedback_comment_chk
    CHECK (comment IS NULL OR CHAR_LENGTH(comment) <= 1000),
  CONSTRAINT generation_feedback_account_owner_chk CHECK (
    (account_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (account_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id IS NOT NULL)
  ),
  INDEX idx_generation_feedback_generation_created (generation_id, created_at DESC),
  INDEX idx_generation_feedback_personal_created (personal_owner_user_id, created_at DESC),
  INDEX idx_generation_feedback_organization_created (organization_id, created_at DESC)
);

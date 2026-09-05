-- OpenRouter-compatible structured feedback for a generation. The write path
-- uses INSERT ... SELECT so generation ownership and Management-key account
-- scope are authorized by the database statement that creates the row.

CREATE TABLE generation_feedback (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL
    REFERENCES api_key_request_logs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  management_api_key_id TEXT NOT NULL
    REFERENCES management_api_keys(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL,
  personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT generation_feedback_id_chk
    CHECK (length(id) = 40 AND left(id, 4) = 'gfb_'),
  CONSTRAINT generation_feedback_category_chk CHECK (category IN (
    'latency', 'incoherence', 'incorrect_response', 'formatting',
    'billing', 'api_error', 'other'
  )),
  CONSTRAINT generation_feedback_comment_chk
    CHECK (comment IS NULL OR length(comment) <= 1000),
  CONSTRAINT generation_feedback_account_owner_chk CHECK (
    (account_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (account_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_generation_feedback_generation_created
  ON generation_feedback(generation_id, created_at DESC);
CREATE INDEX idx_generation_feedback_personal_created
  ON generation_feedback(personal_owner_user_id, created_at DESC)
  WHERE personal_owner_user_id IS NOT NULL;
CREATE INDEX idx_generation_feedback_organization_created
  ON generation_feedback(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

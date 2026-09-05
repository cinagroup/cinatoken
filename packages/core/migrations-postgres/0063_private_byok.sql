-- 0063: account-scoped private BYOK credentials.
-- Raw provider credentials are envelope-encrypted by the repository boundary;
-- delete is a soft delete that wipes the ciphertext in the same transaction.

CREATE TABLE byok_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider VARCHAR(128) NOT NULL,
  name VARCHAR(255),
  api_key_encrypted TEXT NOT NULL,
  label VARCHAR(512) NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  allowed_models_json TEXT,
  allowed_user_ids_json TEXT,
  allowed_api_key_hashes_json TEXT,
  created_by_management_key_id TEXT REFERENCES management_api_keys(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT byok_keys_provider_chk CHECK (
    provider ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  CONSTRAINT byok_keys_name_chk CHECK (name IS NULL OR length(name) BETWEEN 1 AND 255),
  CONSTRAINT byok_keys_secret_lifecycle_chk CHECK (
    (deleted_at IS NULL AND length(api_key_encrypted) BETWEEN 8 AND 131072
      AND api_key_encrypted LIKE 'enc:v2:%')
    OR
    (deleted_at IS NOT NULL AND api_key_encrypted = '' AND disabled = TRUE)
  ),
  CONSTRAINT byok_keys_label_chk CHECK (length(label) BETWEEN 3 AND 512),
  CONSTRAINT byok_keys_allowed_models_chk CHECK (
    allowed_models_json IS NULL OR (
      jsonb_typeof(allowed_models_json::jsonb) = 'array'
      AND jsonb_array_length(allowed_models_json::jsonb) <= 100
    )
  ),
  CONSTRAINT byok_keys_allowed_users_chk CHECK (
    allowed_user_ids_json IS NULL OR (
      jsonb_typeof(allowed_user_ids_json::jsonb) = 'array'
      AND jsonb_array_length(allowed_user_ids_json::jsonb) <= 100
    )
  ),
  CONSTRAINT byok_keys_allowed_gateway_keys_chk CHECK (
    allowed_api_key_hashes_json IS NULL OR (
      jsonb_typeof(allowed_api_key_hashes_json::jsonb) = 'array'
      AND jsonb_array_length(allowed_api_key_hashes_json::jsonb) BETWEEN 1 AND 100
    )
  )
);

CREATE UNIQUE INDEX uk_byok_keys_active_order
  ON byok_keys(workspace_id, provider, sort_order)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_byok_keys_workspace_created
  ON byok_keys(workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_byok_keys_runtime
  ON byok_keys(workspace_id, provider, disabled, is_fallback, sort_order)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_byok_keys_creator
  ON byok_keys(created_by_management_key_id, created_at DESC);

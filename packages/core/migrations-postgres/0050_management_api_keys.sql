-- 0050: account-scoped Management API keys. These credentials are stored in a
-- separate table so they can never authenticate an inference request.

CREATE TABLE management_api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_preview TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('personal', 'organization')),
  personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT management_api_keys_hash_chk CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT management_api_keys_name_chk CHECK (length(name) BETWEEN 1 AND 128),
  CONSTRAINT management_api_keys_account_owner_chk CHECK (
    (account_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (account_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_management_api_keys_personal_created
  ON management_api_keys(personal_owner_user_id, created_at DESC)
  WHERE personal_owner_user_id IS NOT NULL;
CREATE INDEX idx_management_api_keys_organization_created
  ON management_api_keys(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX idx_management_api_keys_status_expiry
  ON management_api_keys(status, expires_at);

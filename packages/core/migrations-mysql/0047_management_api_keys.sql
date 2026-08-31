-- 0047: account-scoped Management API keys. These credentials are stored in a
-- separate table so they can never authenticate an inference request.

CREATE TABLE management_api_keys (
  id VARCHAR(64) PRIMARY KEY,
  key_hash VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  key_preview VARCHAR(64) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  personal_owner_user_id VARCHAR(512),
  organization_id VARCHAR(255),
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at DATETIME(6),
  last_used_at DATETIME(6),
  created_by_user_id VARCHAR(512),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_management_api_keys_personal_owner
    FOREIGN KEY (personal_owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_management_api_keys_organization
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_management_api_keys_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT management_api_keys_hash_chk CHECK (
    CHAR_LENGTH(key_hash) = 71 AND key_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT management_api_keys_name_chk CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 128),
  CONSTRAINT management_api_keys_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT management_api_keys_account_type_chk CHECK (account_type IN ('personal', 'organization')),
  CONSTRAINT management_api_keys_account_owner_chk CHECK (
    (account_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (account_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id IS NOT NULL)
  ),
  INDEX idx_management_api_keys_personal_created (personal_owner_user_id, created_at DESC),
  INDEX idx_management_api_keys_organization_created (organization_id, created_at DESC),
  INDEX idx_management_api_keys_status_expiry (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

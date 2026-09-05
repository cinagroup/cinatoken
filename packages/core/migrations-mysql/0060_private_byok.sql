-- 0060: account-scoped private BYOK credentials.
-- Raw provider credentials are envelope-encrypted by the repository boundary;
-- delete is a soft delete that wipes the ciphertext in the same transaction.

CREATE TABLE byok_keys (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  provider VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(255),
  api_key_encrypted MEDIUMTEXT NOT NULL,
  label VARCHAR(512) NOT NULL,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  is_fallback TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL,
  allowed_models_json MEDIUMTEXT,
  allowed_user_ids_json MEDIUMTEXT,
  allowed_api_key_hashes_json MEDIUMTEXT,
  created_by_management_key_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  deleted_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  active_order_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN SHA2(CONCAT(
        CHAR_LENGTH(workspace_id), ':', workspace_id, ':',
        CHAR_LENGTH(provider), ':', provider, ':', sort_order
      ), 256) ELSE NULL END
    ) STORED,
  CONSTRAINT fk_byok_keys_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_byok_keys_creator
    FOREIGN KEY (created_by_management_key_id) REFERENCES management_api_keys(id) ON DELETE SET NULL,
  CONSTRAINT byok_keys_provider_chk CHECK (
    provider REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT byok_keys_name_chk CHECK (name IS NULL OR CHAR_LENGTH(name) BETWEEN 1 AND 255),
  CONSTRAINT byok_keys_secret_lifecycle_chk CHECK (
    (deleted_at IS NULL AND CHAR_LENGTH(api_key_encrypted) BETWEEN 8 AND 131072
      AND LEFT(api_key_encrypted, 7) = 'enc:v2:')
    OR
    (deleted_at IS NOT NULL AND api_key_encrypted = '' AND disabled = 1)
  ),
  CONSTRAINT byok_keys_label_chk CHECK (CHAR_LENGTH(label) BETWEEN 3 AND 512),
  CONSTRAINT byok_keys_boolean_chk CHECK (disabled IN (0, 1) AND is_fallback IN (0, 1)),
  CONSTRAINT byok_keys_sort_order_chk CHECK (sort_order BETWEEN 0 AND 99),
  CONSTRAINT byok_keys_allowed_models_chk CHECK (
    allowed_models_json IS NULL OR (
      JSON_VALID(allowed_models_json)
      AND JSON_TYPE(CAST(allowed_models_json AS JSON)) = 'ARRAY'
      AND JSON_LENGTH(allowed_models_json) <= 100
    )
  ),
  CONSTRAINT byok_keys_allowed_users_chk CHECK (
    allowed_user_ids_json IS NULL OR (
      JSON_VALID(allowed_user_ids_json)
      AND JSON_TYPE(CAST(allowed_user_ids_json AS JSON)) = 'ARRAY'
      AND JSON_LENGTH(allowed_user_ids_json) <= 100
    )
  ),
  CONSTRAINT byok_keys_allowed_gateway_keys_chk CHECK (
    allowed_api_key_hashes_json IS NULL OR (
      JSON_VALID(allowed_api_key_hashes_json)
      AND JSON_TYPE(CAST(allowed_api_key_hashes_json AS JSON)) = 'ARRAY'
      AND JSON_LENGTH(allowed_api_key_hashes_json) BETWEEN 1 AND 100
    )
  ),
  UNIQUE INDEX uk_byok_keys_active_order (active_order_key),
  INDEX idx_byok_keys_workspace_created (workspace_id, created_at DESC),
  INDEX idx_byok_keys_runtime (workspace_id, provider, disabled, is_fallback, sort_order),
  INDEX idx_byok_keys_creator (created_by_management_key_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

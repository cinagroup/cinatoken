-- 0064: private Batch API metadata and idempotent item ledger.
-- Request/response bodies are deliberately absent; they remain in private R2 objects.

CREATE TABLE batches (
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  workspace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (SHA2(workspace_id, 256)) STORED,
  user_id VARCHAR(512) NOT NULL,
  api_key_hash VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(512) NOT NULL,
  route_group VARCHAR(64) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'validating',
  completion_window VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '24h',
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idempotency_scope_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN idempotency_key_hash IS NULL THEN NULL ELSE SHA2(CONCAT(
        CHAR_LENGTH(workspace_id), ':', workspace_id, ':',
        api_key_hash, ':', idempotency_key_hash
      ), 256) END
    ) STORED,
  input_object_key VARCHAR(1024) NOT NULL,
  input_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_bytes INT UNSIGNED NOT NULL,
  result_object_key VARCHAR(1024) NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_count INT UNSIGNED NOT NULL,
  validation_next_ordinal INT UNSIGNED NOT NULL DEFAULT 0,
  validation_input_offset INT UNSIGNED NOT NULL DEFAULT 0,
  completed_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  cancelled_count INT UNSIGNED NOT NULL DEFAULT 0,
  prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  charged_cost_micros BIGINT UNSIGNED NOT NULL DEFAULT 0,
  byok_request_count INT UNSIGNED NOT NULL DEFAULT 0,
  unknown_cost_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  in_progress_at DATETIME(6) NULL,
  finalizing_at DATETIME(6) NULL,
  finalized_at DATETIME(6) NULL,
  expires_at DATETIME(6) NOT NULL,
  retention_expires_at DATETIME(6) NOT NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(6) NULL,
  attempt_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_batches_idempotency (idempotency_scope_key),
  INDEX idx_batches_workspace_created (workspace_key, created_at DESC, id DESC),
  INDEX idx_batches_status_lease (status, lease_expires_at),
  INDEX idx_batches_retention (retention_expires_at),
  CONSTRAINT fk_batches_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT fk_batches_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT batches_id_chk CHECK (
    CHAR_LENGTH(id) BETWEEN 14 AND 128 AND LEFT(id, 6) = 'batch_'
  ),
  CONSTRAINT batches_account_chk CHECK (
    CHAR_LENGTH(account_id) BETWEEN 10 AND 1024
    AND (account_id LIKE 'personal:%' OR account_id LIKE 'organization:%')
  ),
  CONSTRAINT batches_api_key_hash_chk CHECK (
    api_key_hash REGEXP '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT batches_endpoint_chk CHECK (
    endpoint IN ('/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/embeddings')
  ),
  CONSTRAINT batches_model_route_chk CHECK (
    CHAR_LENGTH(model_id) BETWEEN 1 AND 512 AND CHAR_LENGTH(route_group) BETWEEN 1 AND 64
  ),
  CONSTRAINT batches_status_chk CHECK (
    status IN ('validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')
  ),
  CONSTRAINT batches_completion_window_chk CHECK (completion_window = '24h'),
  CONSTRAINT batches_idempotency_hash_chk CHECK (
    idempotency_key_hash IS NULL OR idempotency_key_hash REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT batches_input_object_chk CHECK (
    CHAR_LENGTH(input_object_key) BETWEEN 1 AND 1024
    AND input_object_key LIKE 'v1/workspaces/%'
    AND INSTR(input_object_key, '..') = 0
    AND input_sha256 REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT batches_result_object_chk CHECK (
    (result_object_key IS NULL AND result_sha256 IS NULL)
    OR (result_object_key IS NOT NULL AND CHAR_LENGTH(result_object_key) BETWEEN 1 AND 1024
      AND INSTR(result_object_key, '..') = 0
      AND result_sha256 REGEXP '^[0-9a-f]{64}$')
  ),
  CONSTRAINT batches_counts_chk CHECK (
    request_count BETWEEN 1 AND 1000000
    AND completed_count + failed_count + cancelled_count <= request_count
    AND byok_request_count <= request_count
    AND unknown_cost_count <= request_count
  ),
  CONSTRAINT batches_validation_checkpoint_chk CHECK (
    input_bytes BETWEEN 1 AND 52428800
    AND validation_next_ordinal <= request_count
    AND validation_input_offset <= input_bytes
  ),
  CONSTRAINT batches_usage_chk CHECK (
    prompt_tokens <= 9007199254740991
    AND completion_tokens <= 9007199254740991
    AND total_tokens <= 9007199254740991
    AND total_tokens = prompt_tokens + completion_tokens
    AND charged_cost_micros <= 9007199254740991
  ),
  CONSTRAINT batches_time_range_chk CHECK (
    expires_at > created_at AND retention_expires_at > expires_at
  ),
  CONSTRAINT batches_lease_pair_chk CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND CHAR_LENGTH(lease_owner) BETWEEN 1 AND 128
      AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT batches_revision_chk CHECK (
    attempt_count <= 9007199254740991 AND revision <= 9007199254740991
  ),
  CONSTRAINT batches_error_code_chk CHECK (
    last_error_code IS NULL OR CHAR_LENGTH(last_error_code) BETWEEN 1 AND 128
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE batch_items (
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  custom_id VARCHAR(256) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  attempt_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(6) NULL,
  dispatch_started_at DATETIME(6) NULL,
  completed_at DATETIME(6) NULL,
  generation_id VARCHAR(512) NULL,
  reservation_id VARCHAR(512) NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(6) NULL,
  request_start_offset INT UNSIGNED NOT NULL,
  request_end_offset INT UNSIGNED NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_object_key VARCHAR(1024) NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_summary VARCHAR(1000) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE KEY uk_batch_items_id (id),
  UNIQUE KEY uk_batch_items_custom (batch_id, custom_id),
  INDEX idx_batch_items_status_ordinal (batch_id, status, ordinal),
  CONSTRAINT fk_batch_items_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  CONSTRAINT batch_items_id_chk CHECK (
    CHAR_LENGTH(id) BETWEEN 18 AND 128 AND LEFT(id, 10) = 'batch_req_'
  ),
  CONSTRAINT batch_items_ordinal_chk CHECK (ordinal BETWEEN 0 AND 999999),
  CONSTRAINT batch_items_custom_id_chk CHECK (CHAR_LENGTH(custom_id) BETWEEN 1 AND 256),
  CONSTRAINT batch_items_status_chk CHECK (
    status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT batch_items_attempt_revision_chk CHECK (
    attempt_count <= 9007199254740991 AND revision <= 9007199254740991
  ),
  CONSTRAINT batch_items_request_hash_chk CHECK (
    request_sha256 REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT batch_items_request_range_chk CHECK (
    request_start_offset <= 52428799
    AND request_end_offset BETWEEN 1 AND 52428800
    AND request_end_offset > request_start_offset
    AND request_end_offset - request_start_offset <= 1048578
  ),
  CONSTRAINT batch_items_result_object_chk CHECK (
    (result_object_key IS NULL AND result_sha256 IS NULL)
    OR (result_object_key IS NOT NULL AND CHAR_LENGTH(result_object_key) BETWEEN 1 AND 1024
      AND INSTR(result_object_key, '..') = 0
      AND result_sha256 REGEXP '^[0-9a-f]{64}$')
  ),
  CONSTRAINT batch_items_error_chk CHECK (
    (error_code IS NULL OR CHAR_LENGTH(error_code) BETWEEN 1 AND 128)
    AND (error_summary IS NULL OR CHAR_LENGTH(error_summary) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT batch_items_lease_pair_chk CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND CHAR_LENGTH(lease_owner) BETWEEN 1 AND 128
      AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT batch_items_dispatch_chk CHECK (
    (dispatch_started_at IS NULL AND generation_id IS NULL AND reservation_id IS NULL)
    OR (dispatch_started_at IS NOT NULL AND started_at IS NOT NULL
      AND generation_id IS NOT NULL AND CHAR_LENGTH(generation_id) BETWEEN 1 AND 512
      AND reservation_id IS NOT NULL AND CHAR_LENGTH(reservation_id) BETWEEN 1 AND 512)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

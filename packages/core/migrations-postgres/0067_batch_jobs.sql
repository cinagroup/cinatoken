-- 0067: private Batch API metadata and idempotent item ledger.
-- Request/response bodies are deliberately absent; they remain in private R2 objects.

SET search_path TO cinatoken_gateway;

CREATE TABLE batches (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 14 AND 128 AND left(id, 6) = 'batch_'),
  account_id TEXT NOT NULL
    CHECK (length(account_id) BETWEEN 10 AND 1024
      AND (account_id LIKE 'personal:%' OR account_id LIKE 'organization:%')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_hash TEXT NOT NULL
    CHECK (api_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/embeddings')),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 512),
  route_group TEXT NOT NULL CHECK (length(route_group) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'validating'
    CHECK (status IN ('validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')),
  completion_window TEXT NOT NULL DEFAULT '24h'
    CHECK (completion_window = '24h'),
  idempotency_key_hash CHAR(64)
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  input_object_key TEXT NOT NULL
    CHECK (length(input_object_key) BETWEEN 1 AND 1024
      AND input_object_key LIKE 'v1/workspaces/%'
      AND strpos(input_object_key, '..') = 0),
  input_sha256 CHAR(64) NOT NULL
    CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_bytes INTEGER NOT NULL
    CHECK (input_bytes BETWEEN 1 AND 52428800),
  result_object_key TEXT,
  result_sha256 CHAR(64)
    CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  request_count INTEGER NOT NULL
    CHECK (request_count BETWEEN 1 AND 1000000),
  validation_next_ordinal INTEGER NOT NULL DEFAULT 0,
  validation_input_offset INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  charged_cost_micros BIGINT NOT NULL DEFAULT 0,
  byok_request_count INTEGER NOT NULL DEFAULT 0,
  unknown_cost_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  in_progress_at TIMESTAMPTZ,
  finalizing_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT batches_result_object_chk CHECK (
    (result_object_key IS NULL AND result_sha256 IS NULL)
    OR (result_object_key IS NOT NULL AND length(result_object_key) BETWEEN 1 AND 1024
      AND strpos(result_object_key, '..') = 0 AND result_sha256 IS NOT NULL)
  ),
  CONSTRAINT batches_counts_chk CHECK (
    completed_count >= 0 AND failed_count >= 0 AND cancelled_count >= 0
    AND completed_count + failed_count + cancelled_count <= request_count
    AND byok_request_count BETWEEN 0 AND request_count
    AND unknown_cost_count BETWEEN 0 AND request_count
  ),
  CONSTRAINT batches_validation_checkpoint_chk CHECK (
    validation_next_ordinal BETWEEN 0 AND request_count
    AND validation_input_offset BETWEEN 0 AND input_bytes
  ),
  CONSTRAINT batches_usage_chk CHECK (
    prompt_tokens BETWEEN 0 AND 9007199254740991
    AND completion_tokens BETWEEN 0 AND 9007199254740991
    AND total_tokens BETWEEN 0 AND 9007199254740991
    AND total_tokens = prompt_tokens + completion_tokens
    AND charged_cost_micros BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT batches_time_range_chk CHECK (
    expires_at > created_at AND retention_expires_at > expires_at
  ),
  CONSTRAINT batches_lease_pair_chk CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128
      AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT batches_revision_chk CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
    AND revision BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT batches_error_code_chk CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128
  )
);

CREATE UNIQUE INDEX uk_batches_idempotency
  ON batches(workspace_id, api_key_hash, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
CREATE INDEX idx_batches_workspace_created
  ON batches(workspace_id, created_at DESC, id DESC);
CREATE INDEX idx_batches_status_lease
  ON batches(status, lease_expires_at);
CREATE INDEX idx_batches_retention
  ON batches(retention_expires_at);

CREATE TABLE batch_items (
  id TEXT NOT NULL UNIQUE
    CHECK (length(id) BETWEEN 18 AND 128 AND left(id, 10) = 'batch_req_'),
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 999999),
  custom_id TEXT NOT NULL CHECK (length(custom_id) BETWEEN 1 AND 256),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  attempt_count BIGINT NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  started_at TIMESTAMPTZ,
  dispatch_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  generation_id TEXT,
  reservation_id TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  request_start_offset INTEGER NOT NULL,
  request_end_offset INTEGER NOT NULL,
  request_sha256 CHAR(64) NOT NULL
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result_object_key TEXT,
  result_sha256 CHAR(64)
    CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  error_code TEXT,
  error_summary TEXT,
  revision BIGINT NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, custom_id),
  CONSTRAINT batch_items_result_object_chk CHECK (
    (result_object_key IS NULL AND result_sha256 IS NULL)
    OR (result_object_key IS NOT NULL AND length(result_object_key) BETWEEN 1 AND 1024
      AND strpos(result_object_key, '..') = 0 AND result_sha256 IS NOT NULL)
  ),
  CONSTRAINT batch_items_error_chk CHECK (
    (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128)
    AND (error_summary IS NULL OR length(error_summary) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT batch_items_lease_pair_chk CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128
      AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT batch_items_dispatch_chk CHECK (
    (dispatch_started_at IS NULL AND generation_id IS NULL AND reservation_id IS NULL)
    OR (dispatch_started_at IS NOT NULL AND started_at IS NOT NULL
      AND generation_id IS NOT NULL AND length(generation_id) BETWEEN 1 AND 512
      AND reservation_id IS NOT NULL AND length(reservation_id) BETWEEN 1 AND 512)
  ),
  CONSTRAINT batch_items_request_range_chk CHECK (
    request_start_offset BETWEEN 0 AND 52428799
    AND request_end_offset BETWEEN 1 AND 52428800
    AND request_end_offset > request_start_offset
    AND request_end_offset - request_start_offset <= 1048578
  )
);

CREATE INDEX idx_batch_items_status_ordinal
  ON batch_items(batch_id, status, ordinal);

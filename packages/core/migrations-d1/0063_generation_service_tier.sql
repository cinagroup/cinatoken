-- Immutable response and minimized request-context facts for Generation metadata.
-- Existing rows remain NULL because request/response-time facts are not backfillable.

ALTER TABLE api_key_request_logs ADD COLUMN service_tier TEXT
  CHECK (service_tier IS NULL OR service_tier IN ('default', 'flex', 'priority'));

ALTER TABLE api_key_request_logs ADD COLUMN finish_reason TEXT
  CHECK (finish_reason IS NULL OR finish_reason IN ('tool_calls', 'stop', 'length', 'content_filter', 'error'));

ALTER TABLE api_key_request_logs ADD COLUMN native_finish_reason TEXT
  CHECK (
    native_finish_reason IS NULL
    OR (length(native_finish_reason) BETWEEN 1 AND 128)
  );

ALTER TABLE api_key_request_logs ADD COLUMN http_referer TEXT
  CHECK (http_referer IS NULL OR length(http_referer) BETWEEN 1 AND 512);

ALTER TABLE api_key_request_logs ADD COLUMN user_agent TEXT
  CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512);

ALTER TABLE api_key_request_logs ADD COLUMN native_tokens_prompt INTEGER
  CHECK (native_tokens_prompt IS NULL OR native_tokens_prompt BETWEEN 0 AND 9007199254740991);

ALTER TABLE api_key_request_logs ADD COLUMN native_tokens_completion INTEGER
  CHECK (native_tokens_completion IS NULL OR native_tokens_completion BETWEEN 0 AND 9007199254740991);

ALTER TABLE api_key_request_logs ADD COLUMN native_tokens_cached INTEGER
  CHECK (native_tokens_cached IS NULL OR native_tokens_cached BETWEEN 0 AND 9007199254740991);

ALTER TABLE api_key_request_logs ADD COLUMN native_tokens_reasoning INTEGER
  CHECK (native_tokens_reasoning IS NULL OR native_tokens_reasoning BETWEEN 0 AND 9007199254740991);

ALTER TABLE api_key_request_logs ADD COLUMN native_tokens_completion_images INTEGER
  CHECK (native_tokens_completion_images IS NULL OR native_tokens_completion_images BETWEEN 0 AND 9007199254740991);

ALTER TABLE api_key_request_logs ADD COLUMN provider_responses TEXT
  CHECK (
    provider_responses IS NULL
    OR length(CAST(provider_responses AS BLOB)) <= 32768
  );

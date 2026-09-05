-- Immutable response and minimized request-context facts for Generation metadata.
-- Existing rows remain NULL because request/response-time facts are not backfillable.

ALTER TABLE api_key_request_logs
	ADD COLUMN service_tier VARCHAR(16) NULL,
	ADD COLUMN finish_reason VARCHAR(16) NULL,
	ADD COLUMN native_finish_reason VARCHAR(128) NULL,
	ADD COLUMN http_referer VARCHAR(512) NULL,
	ADD COLUMN user_agent VARCHAR(512) NULL,
	ADD COLUMN native_tokens_prompt BIGINT UNSIGNED NULL,
	ADD COLUMN native_tokens_completion BIGINT UNSIGNED NULL,
	ADD COLUMN native_tokens_cached BIGINT UNSIGNED NULL,
	ADD COLUMN native_tokens_reasoning BIGINT UNSIGNED NULL,
	ADD COLUMN native_tokens_completion_images BIGINT UNSIGNED NULL,
	ADD COLUMN provider_responses TEXT NULL,
	ADD CONSTRAINT api_key_request_logs_service_tier_chk
		CHECK (service_tier IS NULL OR service_tier IN ('default', 'flex', 'priority')),
	ADD CONSTRAINT api_key_request_logs_finish_reason_chk
		CHECK (finish_reason IS NULL OR finish_reason IN ('tool_calls', 'stop', 'length', 'content_filter', 'error')),
	ADD CONSTRAINT api_key_request_logs_native_finish_reason_chk
		CHECK (native_finish_reason IS NULL OR char_length(native_finish_reason) BETWEEN 1 AND 128),
	ADD CONSTRAINT api_key_request_logs_http_referer_chk
		CHECK (http_referer IS NULL OR char_length(http_referer) BETWEEN 1 AND 512),
	ADD CONSTRAINT api_key_request_logs_user_agent_chk
		CHECK (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 512),
	ADD CONSTRAINT api_key_request_logs_native_tokens_prompt_chk
		CHECK (native_tokens_prompt IS NULL OR native_tokens_prompt <= 9007199254740991),
	ADD CONSTRAINT api_key_request_logs_native_tokens_completion_chk
		CHECK (native_tokens_completion IS NULL OR native_tokens_completion <= 9007199254740991),
	ADD CONSTRAINT api_key_request_logs_native_tokens_cached_chk
		CHECK (native_tokens_cached IS NULL OR native_tokens_cached <= 9007199254740991),
	ADD CONSTRAINT api_key_request_logs_native_tokens_reasoning_chk
		CHECK (native_tokens_reasoning IS NULL OR native_tokens_reasoning <= 9007199254740991),
	ADD CONSTRAINT api_key_request_logs_native_tokens_completion_images_chk
		CHECK (native_tokens_completion_images IS NULL OR native_tokens_completion_images <= 9007199254740991),
	ADD CONSTRAINT api_key_request_logs_provider_responses_chk
		CHECK (provider_responses IS NULL OR octet_length(provider_responses) <= 32768);

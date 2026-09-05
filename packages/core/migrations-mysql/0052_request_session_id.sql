-- OpenRouter session metadata is request-scoped, optional, and never backfilled.
ALTER TABLE api_key_request_logs
  ADD COLUMN session_id VARCHAR(256) NULL,
  ADD CONSTRAINT api_key_request_logs_session_id_length_chk
    CHECK (session_id IS NULL OR CHAR_LENGTH(session_id) BETWEEN 1 AND 256);

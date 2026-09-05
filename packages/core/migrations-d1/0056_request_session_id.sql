-- OpenRouter session metadata is request-scoped, optional, and never backfilled.
ALTER TABLE api_key_request_logs ADD COLUMN session_id TEXT
  CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256);

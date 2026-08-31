-- 0051: optional Gateway Key expiry, enforced on every data-plane authentication.

ALTER TABLE api_keys ADD COLUMN expires_at TIMESTAMPTZ;

CREATE INDEX idx_api_keys_status_expiry ON api_keys(status, expires_at);

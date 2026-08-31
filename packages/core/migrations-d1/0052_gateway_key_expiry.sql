-- 0052: optional Gateway Key expiry, enforced on every data-plane authentication.

ALTER TABLE api_keys ADD COLUMN expires_at TEXT
  CHECK (
    expires_at IS NULL
    OR (
      length(expires_at) = 24
      AND substr(expires_at, 11, 1) = 'T'
      AND substr(expires_at, 24, 1) = 'Z'
      AND datetime(expires_at) IS NOT NULL
    )
  );

CREATE INDEX idx_api_keys_status_expiry ON api_keys(status, expires_at);

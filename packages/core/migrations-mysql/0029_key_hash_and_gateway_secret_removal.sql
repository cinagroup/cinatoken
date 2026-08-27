-- MySQL：补齐认证密钥哈希索引，并使新 Gateway Key 只存摘要与安全预览。

ALTER TABLE admin_api_keys
  ADD COLUMN secret_key_hash VARCHAR(80) NULL,
  ADD INDEX idx_admin_api_keys_secret_hash (secret_key_hash);

ALTER TABLE api_keys
  ADD COLUMN key_hash VARCHAR(80) NULL,
  ADD COLUMN key_preview VARCHAR(64) NULL,
  ADD UNIQUE INDEX idx_api_keys_key_hash (key_hash);

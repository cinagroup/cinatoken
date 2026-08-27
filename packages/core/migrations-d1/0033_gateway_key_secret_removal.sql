-- 0033：用户 Gateway Key 只存摘要与安全预览。
--
-- `key` 保留为 NOT NULL + UNIQUE 兼容列；新写入保存 `hashref:sha256:...`，
-- `key_preview` 仅用于 UI。旧行由认证命中时在线替换，完整批量清理须在发布验收中完成。

ALTER TABLE api_keys ADD COLUMN key_preview TEXT;

DROP INDEX IF EXISTS idx_api_keys_key_hash;
CREATE UNIQUE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

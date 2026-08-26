-- 0032：认证密钥哈希查找（审计 M2 第二/三阶段）
--
-- admin_api_keys.secret_key / api_keys.key 此前明文存库且以明文为查找索引。
-- 新增哈希列 + 索引：认证路径哈希优先查找，旧行命中后由应用惰性回填；
-- 全量回填完成后明文列可由运维清空（应用侧保留明文回退窗口）。

ALTER TABLE admin_api_keys ADD COLUMN secret_key_hash TEXT;
CREATE INDEX idx_admin_api_keys_secret_hash ON admin_api_keys(secret_key_hash);

ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

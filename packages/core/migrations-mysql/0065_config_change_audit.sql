-- Config writes from Admin are audited atomically with system_config updates.
-- Never store values, webhook URLs, request bodies, or value fingerprints here.
CREATE TABLE config_change_audit (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_key VARCHAR(255) NOT NULL,
  channel VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(1024) NOT NULL,
  outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'committed',
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_config_change_audit_created (created_at DESC, id DESC),
  INDEX idx_config_change_audit_key_created (config_key, created_at DESC),
  CONSTRAINT config_change_audit_channel_chk CHECK (channel IS NULL OR channel IN ('wecom', 'feishu')),
  CONSTRAINT config_change_audit_action_chk CHECK (action IN ('set', 'clear')),
  CONSTRAINT config_change_audit_actor_kind_chk CHECK (actor_kind IN ('console', 'admin_key')),
  CONSTRAINT config_change_audit_outcome_chk CHECK (outcome = 'committed')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lock the one permanent row before every generic/CAS/group config transaction.
CREATE TABLE system_config_write_mutex (
  id INTEGER NOT NULL PRIMARY KEY,
  CONSTRAINT system_config_write_mutex_singleton_chk CHECK (id = 1)
) ENGINE=InnoDB;
INSERT INTO system_config_write_mutex (id) VALUES (1);

-- Metadata only; no parent FK or cascade and no credential/value/hash columns.
CREATE TABLE config_group_audit (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  family VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(617) NOT NULL,
  reason VARCHAR(600) NOT NULL,
  changed_fields_json TEXT NOT NULL,
  active_before VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  active_after VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  credentials_json TEXT NOT NULL,
  revision_before_json TEXT NOT NULL,
  revision_after_json TEXT NOT NULL,
  source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  INDEX idx_config_group_audit_family_created (family, created_at DESC, id DESC),
  CONSTRAINT config_group_audit_family_chk CHECK (family IN ('web-search', 'web-fetch', 'web-deep-search', 'ai-detection')),
  CONSTRAINT config_group_audit_provider_chk CHECK (provider IS NULL OR provider IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  CONSTRAINT config_group_audit_action_chk CHECK (action IN ('save', 'save_activate', 'activate', 'legacy_save', 'reveal')),
  CONSTRAINT config_group_audit_actor_kind_chk CHECK (actor_kind IN ('console', 'admin_key')),
  CONSTRAINT config_group_audit_actor_bounds_chk CHECK (CHAR_LENGTH(actor_id) BETWEEN 1 AND CASE WHEN actor_kind = 'console' THEN 617 ELSE 600 END),
  CONSTRAINT config_group_audit_reason_bounds_chk CHECK (CHAR_LENGTH(reason) BETWEEN 1 AND 600),
  CONSTRAINT config_group_audit_active_before_chk CHECK (active_before IS NULL OR active_before IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  CONSTRAINT config_group_audit_active_after_chk CHECK (active_after IS NULL OR active_after IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  CONSTRAINT config_group_audit_source_chk CHECK (source IN ('admin_api', 'legacy_admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

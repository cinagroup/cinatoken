-- Tools group outcomes only: no config values, bodies or secret-derived hashes.
-- No parent foreign key: retain history even when a config row is removed.
CREATE TABLE config_group_audit (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('web-search', 'web-fetch', 'web-deep-search', 'ai-detection')),
  provider TEXT CHECK (provider IS NULL OR provider IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  action TEXT NOT NULL CHECK (action IN ('save', 'save_activate', 'activate', 'legacy_save', 'reveal')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('console', 'admin_key')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND CASE WHEN actor_kind = 'console' THEN 617 ELSE 600 END),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 600),
  changed_fields_json TEXT NOT NULL,
  active_before TEXT CHECK (active_before IS NULL OR active_before IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  active_after TEXT CHECK (active_after IS NULL OR active_after IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'firecrawl', 'jina', 'tencent_tms')),
  credentials_json TEXT NOT NULL,
  revision_before_json TEXT NOT NULL,
  revision_after_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin_api', 'legacy_admin')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_config_group_audit_family_created
  ON config_group_audit(family, created_at DESC, id DESC);

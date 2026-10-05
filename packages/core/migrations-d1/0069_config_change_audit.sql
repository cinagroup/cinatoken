-- Config writes from Admin are audited atomically with system_config updates.
-- Never store values, webhook URLs, request bodies, or value fingerprints here.
CREATE TABLE config_change_audit (
  id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  channel TEXT CHECK (channel IS NULL OR channel IN ('wecom', 'feishu')),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('console', 'admin_key')),
  actor_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'committed' CHECK (outcome = 'committed'),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_config_change_audit_created ON config_change_audit(created_at DESC, id DESC);
CREATE INDEX idx_config_change_audit_key_created ON config_change_audit(config_key, created_at DESC);

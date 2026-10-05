-- Migration first, then compatible readers, then writers that accept long actors.
-- Apply this entire file as one D1 migration. Wrangler owns the implicit
-- transaction and rolls back a failed migration. Do not split these statements
-- or add BEGIN/COMMIT or foreign_keys toggles. This audit table has no parent FK.
-- Preserve all 19 columns, existing checks, deleted-key history and timestamps.
-- Rollback must retain this wider storage and any committed long-actor history.
CREATE TABLE admin_shared_key_audit_actor_bound_upgrade (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('updated', 'disabled', 'restored', 'deleted')),
  change_mask INTEGER NOT NULL CHECK (change_mask BETWEEN 1 AND 15),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('console', 'api_key')),
  actor_id TEXT NOT NULL CHECK (
    (actor_kind = 'console' AND length(actor_id) BETWEEN 1 AND 617)
    OR (actor_kind = 'api_key' AND length(actor_id) BETWEEN 1 AND 600)
  ),
  source TEXT NOT NULL CHECK (source IN ('admin_api', 'legacy_admin')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 600),
  before_status TEXT NOT NULL CHECK (before_status IN ('active', 'paused', 'disabled', 'invalid', 'validating')),
  before_seller_priority INTEGER NOT NULL,
  before_weight INTEGER NOT NULL,
  before_validated INTEGER NOT NULL CHECK (before_validated IN (0, 1)),
  after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'paused', 'disabled', 'invalid', 'validating')),
  after_seller_priority INTEGER,
  after_weight INTEGER,
  after_validated INTEGER CHECK (after_validated IS NULL OR after_validated IN (0, 1)),
  before_revision TEXT NOT NULL,
  after_revision TEXT,
  created_at TEXT NOT NULL,
  CHECK ((action = 'deleted' AND after_status IS NULL AND after_seller_priority IS NULL AND after_weight IS NULL AND after_validated IS NULL AND after_revision IS NULL)
    OR (action <> 'deleted' AND after_status IS NOT NULL AND after_seller_priority IS NOT NULL AND after_weight IS NOT NULL AND after_validated IS NOT NULL AND after_revision IS NOT NULL))
);
INSERT INTO admin_shared_key_audit_actor_bound_upgrade (
  id, key_id, action, change_mask, actor_kind, actor_id, source, reason,
  before_status, before_seller_priority, before_weight, before_validated,
  after_status, after_seller_priority, after_weight, after_validated,
  before_revision, after_revision, created_at
)
SELECT id, key_id, action, change_mask, actor_kind, actor_id, source, reason,
  before_status, before_seller_priority, before_weight, before_validated,
  after_status, after_seller_priority, after_weight, after_validated,
  before_revision, after_revision, created_at
FROM admin_shared_key_audit;
DROP TABLE admin_shared_key_audit;
ALTER TABLE admin_shared_key_audit_actor_bound_upgrade RENAME TO admin_shared_key_audit;
CREATE INDEX idx_admin_shared_key_audit_key_created ON admin_shared_key_audit(key_id, created_at DESC, id DESC);

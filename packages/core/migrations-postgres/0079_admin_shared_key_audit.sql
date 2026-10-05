-- Migration first; new governance requires audit storage. Retain on rollback.
-- No parent FK, credentials, quote evidence, or financial facts.
CREATE TABLE cinatoken_gateway.admin_shared_key_audit (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('updated', 'disabled', 'restored', 'deleted')),
  change_mask INTEGER NOT NULL CHECK (change_mask BETWEEN 1 AND 15),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('console', 'api_key')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 600),
  source TEXT NOT NULL CHECK (source IN ('admin_api', 'legacy_admin')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 600),
  before_status TEXT NOT NULL CHECK (before_status IN ('active', 'paused', 'disabled', 'invalid', 'validating')),
  before_seller_priority INTEGER NOT NULL, before_weight INTEGER NOT NULL,
  before_validated INTEGER NOT NULL CHECK (before_validated IN (0, 1)),
  after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'paused', 'disabled', 'invalid', 'validating')),
  after_seller_priority INTEGER, after_weight INTEGER,
  after_validated INTEGER CHECK (after_validated IS NULL OR after_validated IN (0, 1)),
  before_revision TEXT NOT NULL, after_revision TEXT, created_at TIMESTAMPTZ NOT NULL,
  CHECK ((action = 'deleted' AND after_status IS NULL AND after_seller_priority IS NULL AND after_weight IS NULL AND after_validated IS NULL AND after_revision IS NULL)
    OR (action <> 'deleted' AND after_status IS NOT NULL AND after_seller_priority IS NOT NULL AND after_weight IS NOT NULL AND after_validated IS NOT NULL AND after_revision IS NOT NULL))
);
CREATE INDEX idx_admin_shared_key_audit_key_created ON cinatoken_gateway.admin_shared_key_audit(key_id, created_at DESC, id DESC);
CREATE INDEX idx_shared_keys_admin_order ON cinatoken_gateway.shared_keys(seller_priority DESC, weight DESC, id ASC);

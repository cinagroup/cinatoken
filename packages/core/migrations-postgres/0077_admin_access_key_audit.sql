-- Committed integration-key lifecycle and explicit reveal events only.
-- No key material, hashes, prefixes, request bodies, or secret fingerprints.
CREATE TABLE cinatoken_gateway.admin_access_key_audit (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'revealed', 'rotated', 'revoked', 'activated')),
  change_mask INTEGER NOT NULL CHECK (change_mask BETWEEN 0 AND 31),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'console'),
  actor_id TEXT NOT NULL,
  before_permissions_json TEXT,
  after_permissions_json TEXT,
  before_status TEXT CHECK (before_status IS NULL OR before_status IN ('active', 'revoked')),
  after_status TEXT CHECK (after_status IS NULL OR after_status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_admin_access_key_audit_key_created
  ON cinatoken_gateway.admin_access_key_audit(key_id, created_at DESC, id DESC);

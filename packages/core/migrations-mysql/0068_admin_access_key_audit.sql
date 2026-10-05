-- Committed integration-key lifecycle and explicit reveal events only.
-- No key material, hashes, prefixes, request bodies, or secret fingerprints.
CREATE TABLE admin_access_key_audit (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_id VARCHAR(128) NOT NULL,
  action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  change_mask SMALLINT UNSIGNED NOT NULL,
  actor_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  before_permissions_json TEXT NULL,
  after_permissions_json TEXT NULL,
  before_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  after_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_admin_access_key_audit_key_created (key_id, created_at DESC, id DESC),
  CONSTRAINT admin_access_key_audit_action_chk CHECK (action IN ('created', 'updated', 'revealed', 'rotated', 'revoked', 'activated')),
  CONSTRAINT admin_access_key_audit_mask_chk CHECK (change_mask BETWEEN 0 AND 31),
  CONSTRAINT admin_access_key_audit_actor_chk CHECK (actor_kind = 'console'),
  CONSTRAINT admin_access_key_audit_before_status_chk CHECK (before_status IS NULL OR before_status IN ('active', 'revoked')),
  CONSTRAINT admin_access_key_audit_after_status_chk CHECK (after_status IS NULL OR after_status IN ('active', 'revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

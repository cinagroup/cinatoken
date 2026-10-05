-- Migration first; new governance requires audit storage. Retain on rollback.
-- No parent FK, credentials, quote evidence, or financial facts.
CREATE TABLE admin_shared_key_audit (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  key_id VARCHAR(255) NOT NULL,
  action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  change_mask SMALLINT UNSIGNED NOT NULL,
  actor_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(600) NOT NULL,
  source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(600) NOT NULL,
  before_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  before_seller_priority INT NOT NULL, before_weight INT NOT NULL, before_validated SMALLINT NOT NULL,
  after_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin,
  after_seller_priority INT, after_weight INT, after_validated SMALLINT,
  before_revision VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  after_revision VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin,
  created_at DATETIME(6) NOT NULL,
  INDEX idx_admin_shared_key_audit_key_created(key_id, created_at DESC, id DESC),
  CONSTRAINT admin_shared_key_audit_action_chk CHECK (action IN ('updated', 'disabled', 'restored', 'deleted')),
  CONSTRAINT admin_shared_key_audit_mask_chk CHECK (change_mask BETWEEN 1 AND 15),
  CONSTRAINT admin_shared_key_audit_actor_chk CHECK (actor_kind IN ('console', 'api_key') AND CHAR_LENGTH(actor_id) BETWEEN 1 AND 600),
  CONSTRAINT admin_shared_key_audit_source_chk CHECK (source IN ('admin_api', 'legacy_admin')),
  CONSTRAINT admin_shared_key_audit_reason_chk CHECK (CHAR_LENGTH(reason) BETWEEN 1 AND 600),
  CONSTRAINT admin_shared_key_audit_before_chk CHECK (before_status IN ('active', 'paused', 'disabled', 'invalid', 'validating') AND before_validated IN (0, 1)),
  CONSTRAINT admin_shared_key_audit_after_chk CHECK ((action = 'deleted' AND after_status IS NULL AND after_seller_priority IS NULL AND after_weight IS NULL AND after_validated IS NULL AND after_revision IS NULL)
    OR (action <> 'deleted' AND after_status IS NOT NULL AND after_status IN ('active', 'paused', 'disabled', 'invalid', 'validating') AND after_seller_priority IS NOT NULL AND after_weight IS NOT NULL AND after_validated IS NOT NULL AND after_validated IN (0, 1) AND after_revision IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_shared_keys_admin_order ON shared_keys(seller_priority DESC, weight DESC, id ASC);

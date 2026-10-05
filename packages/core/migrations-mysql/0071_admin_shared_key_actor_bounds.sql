-- Migration first, reader first, writer last. Retain widened storage on rollback.
-- One atomic ALTER replaces only the actor constraint and widens its column.
-- Console principals include the 17-character console:cinaauth: prefix, while
-- named API-key actors and operator reasons retain their existing 600 limit.
ALTER TABLE admin_shared_key_audit
  DROP CHECK admin_shared_key_audit_actor_chk,
  MODIFY COLUMN actor_id VARCHAR(617) NOT NULL,
  ADD CONSTRAINT admin_shared_key_audit_actor_chk CHECK (
    (actor_kind = 'console' AND CHAR_LENGTH(actor_id) BETWEEN 1 AND 617)
    OR (actor_kind = 'api_key' AND CHAR_LENGTH(actor_id) BETWEEN 1 AND 600)
  );

-- Migration first, reader first, writer last. Retain widened storage on rollback.
-- Replace only the existing actor CHECK in one transactional ALTER. Columns,
-- deleted-key history, microseconds, audit index and runtime ACL shape are intact.
SET LOCAL lock_timeout = '2s';
ALTER TABLE cinatoken_gateway.admin_shared_key_audit
  DROP CONSTRAINT admin_shared_key_audit_actor_id_check,
  ADD CONSTRAINT admin_shared_key_audit_actor_id_check CHECK (
    (actor_kind = 'console' AND length(actor_id) BETWEEN 1 AND 617)
    OR (actor_kind = 'api_key' AND length(actor_id) BETWEEN 1 AND 600)
  );

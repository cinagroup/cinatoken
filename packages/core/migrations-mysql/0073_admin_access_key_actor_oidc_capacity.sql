-- Trusted CinaAuth Console actors contain "console:cinaauth:" (17 characters).
-- Accommodate the standard OIDC255 ASCII subject without truncating identity.
-- Preserve the original0068 charset/collation, NOT NULL and lack of a default.
-- Migration first; keep the widened column and audit history on code rollback.
-- This capacity change neither broadens actor kinds nor enables subject600 login.
ALTER TABLE admin_access_key_audit
  MODIFY COLUMN actor_id VARCHAR(272)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;

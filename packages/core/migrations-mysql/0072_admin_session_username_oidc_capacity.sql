-- CinaAuth console usernames contain the nine-character "cinaauth:" prefix.
-- OIDC Core permits a 255-character ASCII subject, requiring 264 characters.
-- Preserve the existing utf8mb4 collation, NOT NULL and absence of a default.
-- Migration first; retain the widened column and existing sessions on rollback.
-- This storage fix does not change issuer validation or enable subject600 login.
ALTER TABLE admin_sessions
  MODIFY COLUMN username VARCHAR(264)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;

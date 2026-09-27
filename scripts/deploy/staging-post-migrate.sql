-- Staging-only post-migration initialization; not a production migration.
-- Apply only after verifying the account, UUID and exact name cinatoken-staging.
-- Keep ingress closed until this result and Access protection are verified.
-- 0002 seeds a public demo key; 0023 moves it to admin_api_keys and 0024
-- removes only the old system_config row. Never revoke a rotated/custom key.
UPDATE admin_api_keys
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'legacy-master'
  AND secret_key = 'sk-dev-admin-key'
  AND status = 'active';
